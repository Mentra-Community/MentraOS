import Foundation

/// One HTTP GET whose raw s16le mono body is written into a `PcmStreamSink` as it arrives.
///
/// All state is touched only on the loader's serial queue, which is also the URLSession
/// delegate queue. Settles exactly once: with the played duration after the sink drained, or
/// with an error.
final class PcmUrlPlayback: @unchecked Sendable {
    fileprivate let sink: PcmStreamSink
    fileprivate let queue: DispatchQueue
    fileprivate var task: URLSessionDataTask?
    fileprivate var carry = PcmByteCarry()
    fileprivate var pending = Data()
    fileprivate var writing = false
    fileprivate var suspended = false
    fileprivate var bodyComplete = false
    fileprivate var bodyError: Error?
    fileprivate var closing = false
    fileprivate var result: Result<Int64, Error>?
    fileprivate var waiters: [CheckedContinuation<Int64, Error>] = []
    fileprivate var onSettled: (() -> Void)?

    /// Times the transfer was paused for backpressure. For diagnostics and tests.
    private(set) var suspensions = 0

    fileprivate init(sink: PcmStreamSink, queue: DispatchQueue) {
        self.sink = sink
        self.queue = queue
    }

    /// Wait for the body to finish playing. Throws `PcmStreamError.aborted` after `cancel()`.
    func wait() async throws -> Int64 {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                if let result = self.result {
                    continuation.resume(with: result)
                } else {
                    self.waiters.append(continuation)
                }
            }
        }
    }

    /// Stop downloading and settle with "aborted". The caller stops the sink.
    func cancel() {
        queue.async {
            self.settle(.failure(PcmStreamError.aborted))
        }
    }

    // MARK: Queue only

    fileprivate func settle(_ outcome: Result<Int64, Error>) {
        guard result == nil else { return }
        result = outcome
        if let task, task.state != .completed {
            task.cancel()
        }
        pending.removeAll()
        let pendingWaiters = waiters
        waiters.removeAll()
        pendingWaiters.forEach { $0.resume(with: outcome) }
        let callback = onSettled
        onSettled = nil
        callback?()
    }

    fileprivate func receive(_ data: Data, highWaterBytes: Int) {
        guard result == nil else { return }
        pending.append(carry.align(data))
        if pending.count > highWaterBytes, !suspended, let task {
            task.suspend()
            suspended = true
            suspensions += 1
        }
        pump()
    }

    fileprivate func complete(error: Error?) {
        guard result == nil else { return }
        bodyComplete = true
        bodyError = error
        // A trailing half sample left in `carry` can't be played and is dropped.
        pump()
    }

    /// Hand pending audio to the sink one write at a time. The sink's write suspends while its
    /// backlog is above its ceiling; meanwhile `pending` fills, and past the high-water mark the
    /// transfer is paused until the next write takes it. Once the body is complete and
    /// everything is written, close the sink.
    fileprivate func pump() {
        guard result == nil, !writing, !closing else { return }
        if !pending.isEmpty {
            let chunk = pending
            pending = Data()
            writing = true
            if suspended, let task {
                task.resume()
                suspended = false
            }
            Task {
                do {
                    _ = try await self.sink.write(data: chunk)
                    self.queue.async {
                        self.writing = false
                        self.pump()
                    }
                } catch {
                    self.queue.async { self.settle(.failure(error)) }
                }
            }
            return
        }
        guard bodyComplete else { return }
        closing = true
        let failure = bodyError
        Task {
            // A dropped connection still ends cleanly: what arrived plays out, then the error.
            let outcome: Result<Int64, Error>
            do {
                let duration = try await self.sink.close()
                outcome = failure.map { .failure($0) } ?? .success(duration)
            } catch {
                outcome = .failure(failure ?? error)
            }
            self.queue.async { self.settle(outcome) }
        }
    }
}

/// Shared URLSession for `pcmStreamPlayUrl`. Requests reuse connections, which matters when a
/// spoken answer arrives as one request per sentence.
final class PcmUrlLoader: NSObject, URLSessionDataDelegate {
    static let shared = PcmUrlLoader()

    /// Pause the transfer when this much audio is waiting for the sink (about 1.3 s at 24 kHz).
    static let defaultHighWaterBytes = 64 * 1024

    private static let compressedContentTypes = ["audio/mpeg", "audio/mp3", "audio/aac", "audio/ogg", "audio/opus", "audio/webm"]

    let queue = DispatchQueue(label: "com.mentra.pcm-url", qos: .userInitiated)
    private let highWaterBytes: Int
    private let configuration: URLSessionConfiguration
    private lazy var session: URLSession = {
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        delegateQueue.underlyingQueue = queue
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }()

    // Queue only.
    private var playbacks: [Int: PcmUrlPlayback] = [:]

    init(configuration: URLSessionConfiguration = PcmUrlLoader.defaultConfiguration(), highWaterBytes: Int = PcmUrlLoader.defaultHighWaterBytes) {
        self.configuration = configuration
        self.highWaterBytes = max(2, highWaterBytes)
        super.init()
    }

    static func defaultConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.default
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        // Speech is useless late: fail a stalled response instead of waiting a minute.
        configuration.timeoutIntervalForRequest = 20
        configuration.waitsForConnectivity = false
        return configuration
    }

    /// Start fetching `url` into `sink`. Never blocks the caller.
    func start(url: URL, sink: PcmStreamSink) -> PcmUrlPlayback {
        let playback = PcmUrlPlayback(sink: sink, queue: queue)
        queue.async {
            guard playback.result == nil else { return } // Cancelled before it started.
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            let task = self.session.dataTask(with: request)
            playback.task = task
            self.playbacks[task.taskIdentifier] = playback
            playback.onSettled = { [weak self] in
                self?.playbacks.removeValue(forKey: task.taskIdentifier)
            }
            task.resume()
        }
        return playback
    }

    // MARK: URLSessionDataDelegate (on `queue`)

    func urlSession(
        _: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let playback = playbacks[dataTask.taskIdentifier] else {
            completionHandler(.cancel)
            return
        }
        if let http = response as? HTTPURLResponse, !(200 ..< 300).contains(http.statusCode) {
            completionHandler(.cancel)
            playback.settle(.failure(PcmStreamError.native("http_error: PCM stream request failed with HTTP \(http.statusCode)")))
            return
        }
        if let type = response.mimeType?.lowercased(), Self.compressedContentTypes.contains(type) {
            completionHandler(.cancel)
            playback.settle(.failure(PcmStreamError.native("unsupported_format: PCM stream URL returned \(type), not raw PCM")))
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        playbacks[dataTask.taskIdentifier]?.receive(data, highWaterBytes: highWaterBytes)
    }

    func urlSession(_: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let playback = playbacks[task.taskIdentifier] else { return }
        let failure = error.map { PcmStreamError.native("network_error: PCM stream download failed: \($0.localizedDescription)") as Error }
        playback.complete(error: failure)
    }

    func urlSession(
        _: URLSession,
        dataTask _: URLSessionDataTask,
        willCacheResponse _: CachedURLResponse,
        completionHandler: @escaping (CachedURLResponse?) -> Void
    ) {
        completionHandler(nil)
    }
}
