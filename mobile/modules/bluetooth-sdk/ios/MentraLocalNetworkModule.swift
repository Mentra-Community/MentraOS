import ExpoModulesCore
import Foundation

/// MentraOS-internal transport for glasses-local traffic, the iOS side of Android's module of the
/// same name. The glasses Wi-Fi service joins `GlassesHotspotNetwork.shared` here, once for every
/// consumer; Mentra Call and the managed relay read the address it verified.
public final class MentraLocalNetworkModule: Module {
    private let queue = DispatchQueue(label: "com.mentra.bluetoothsdk.local-network")
    /// The join id that holds the shared network, from join until its leave finishes.
    private var hotspotOwner: String?
    private lazy var downloads = LocalDownloads { [weak self] body in self?.sendEvent("downloadProgress", body) }

    public func definition() -> ModuleDefinition {
        Name("MentraLocalNetwork")
        Events("hotspotPermissionRequired", "hotspotLost", "downloadProgress")

        // Where the glasses Wi-Fi service saves files it fetches, such as deferred photos.
        Function("cacheDirectory") { () -> String in
            FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.path ?? NSTemporaryDirectory()
        }

        // The service's timers: JS timers pause while the app is in the background.
        AsyncFunction("delay") { (ms: Int, promise: Promise) in
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(max(0, ms))) {
                promise.resolve(nil)
            }
        }

        AsyncFunction("joinHotspot") { (id: String, ssid: String, password: String, gateway: String?, purpose: String, frequency: Int?, promise: Promise) in
            self.queue.async { self.join(id: id, ssid: ssid, password: password, gateway: gateway, purpose: purpose, frequency: frequency, promise: promise) }
        }

        AsyncFunction("leaveHotspot") { (id: String, promise: Promise) in
            self.queue.async { self.leave(id: id, promise: promise) }
        }

        AsyncFunction("download") { (requestId: String, url: String, destination: String, headers: [String: String],
                                     connectionTimeoutMs: Int, readTimeoutMs: Int, promise: Promise) in
                self.downloads.start(requestId: requestId, url: url, destination: destination, headers: headers,
                                     connectionTimeoutMs: connectionTimeoutMs, readTimeoutMs: readTimeoutMs, promise: promise)
        }

        AsyncFunction("cancel") { (requestId: String) in
            self.downloads.cancel(requestId)
        }

        OnDestroy {
            self.downloads.invalidate()
            #if os(iOS)
                self.queue.async {
                    guard self.hotspotOwner != nil else { return }
                    GlassesHotspotNetwork.shared.leave { _ in }
                }
            #endif
        }
    }

    private func join(id: String, ssid: String, password: String, gateway: String?, purpose: String, frequency: Int?, promise: Promise) {
        #if os(iOS)
            guard hotspotOwner == nil else {
                promise.reject(HotspotError("Previous hotspot session has not been released")); return
            }
            guard let accessPurpose = HotspotAccessPurpose(rawValue: purpose) else {
                promise.reject(HotspotError("Invalid hotspot access purpose")); return
            }
            hotspotOwner = id
            let hotspot = GlassesHotspotNetwork.shared
            // The join waits while Local Network access is pending or denied; the caller explains it.
            hotspot.onPermissionRequired = { [weak self] systemAnswer in
                self?.sendEvent("hotspotPermissionRequired", ["id": id, "systemAnswer": systemAnswer])
            }
            hotspot.onLost = { [weak self] reason in
                self?.sendEvent("hotspotLost", ["id": id, "reason": reason])
            }
            hotspot.join(ssid: ssid, passphrase: password, gateway: gateway, frequency: frequency, purpose: accessPurpose) { result in
                switch result {
                case let .success(address): promise.resolve(address)
                case let .failure(error):
                    let failure = HotspotJoinFailure(error)
                    promise.reject(Exception(name: "HotspotJoinFailure", description: failure.message, code: failure.code))
                }
            }
        #else
            promise.reject(HotspotError("Joining the glasses hotspot needs iOS"))
        #endif
    }

    private func leave(id: String, promise: Promise) {
        #if os(iOS)
            guard hotspotOwner == id else { promise.resolve(nil); return }
            GlassesHotspotNetwork.shared.leave { result in
                self.queue.async {
                    switch result {
                    case .success:
                        if self.hotspotOwner == id { self.hotspotOwner = nil }
                        promise.resolve(nil)
                    case let .failure(error): promise.reject(error)
                    }
                }
            }
        #else
            promise.resolve(nil)
        #endif
    }
}

/// HTTP GETs to the glasses written straight to a file, with Android's `download` contract:
/// a non-2xx status fails, `downloadProgress` reports the status and headers before the first
/// body byte and then every chunk, and the result is `{statusCode, bytesWritten, headers}`.
private final class LocalDownloads: NSObject, URLSessionDataDelegate {
    private final class Transfer {
        let requestId: String
        let destination: URL
        let promise: Promise
        var file: FileHandle?
        var statusCode = 0
        var headers: [String: String] = [:]
        var contentLength: Int64 = -1
        var bytesWritten: Int64 = 0
        var failure: String?
        var connectTimer: DispatchWorkItem?

        init(requestId: String, destination: URL, promise: Promise) {
            self.requestId = requestId; self.destination = destination; self.promise = promise
        }
    }

    private let progress: ([String: Any]) -> Void
    private let delegateQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "com.mentra.bluetoothsdk.local-download"
        return queue
    }()

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }()

    private let lock = NSLock()
    private var tasks: [String: URLSessionDataTask] = [:]
    private var transfers: [Int: Transfer] = [:]

    init(progress: @escaping ([String: Any]) -> Void) {
        self.progress = progress
    }

    func start(requestId: String, url: String, destination: String, headers: [String: String],
               connectionTimeoutMs: Int, readTimeoutMs: Int, promise: Promise)
    {
        guard let source = URL(string: url), source.scheme == "http" || source.scheme == "https" else {
            promise.reject("ERR_LOCAL_DOWNLOAD", "Invalid download URL"); return
        }
        var request = URLRequest(url: source)
        request.httpMethod = "GET"
        // URLSession's request timeout is an idle timeout between packets: Android's read timeout.
        request.timeoutInterval = TimeInterval(max(1, readTimeoutMs)) / 1000
        headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
        let task = session.dataTask(with: request)
        let transfer = Transfer(requestId: requestId, destination: URL(fileURLWithPath: destination), promise: promise)
        // Android's connect timeout: no response headers by then fails the download.
        let timer = DispatchWorkItem { [weak self, weak task] in
            guard let self, let task else { return }
            self.delegateQueue.addOperation {
                guard let transfer = self.transfers[task.taskIdentifier], transfer.statusCode == 0 else { return }
                transfer.failure = "Connection timed out"
                task.cancel()
            }
        }
        transfer.connectTimer = timer
        lock.lock()
        tasks.removeValue(forKey: requestId)?.cancel()
        tasks[requestId] = task
        lock.unlock()
        delegateQueue.addOperation {
            self.transfers[task.taskIdentifier] = transfer
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(max(1, connectionTimeoutMs)), execute: timer)
            task.resume()
        }
    }

    func cancel(_ requestId: String) {
        lock.lock()
        let task = tasks.removeValue(forKey: requestId)
        lock.unlock()
        task?.cancel()
    }

    func invalidate() {
        session.invalidateAndCancel()
    }

    func urlSession(_: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void)
    {
        guard let transfer = transfers[dataTask.taskIdentifier] else { completionHandler(.cancel); return }
        transfer.connectTimer?.cancel()
        guard let http = response as? HTTPURLResponse else {
            transfer.failure = "Not an HTTP response"; completionHandler(.cancel); return
        }
        transfer.statusCode = http.statusCode
        guard (200 ... 299).contains(http.statusCode) else {
            transfer.failure = "HTTP \(http.statusCode)"; completionHandler(.cancel); return
        }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let key = key as? String { headers[key] = "\(value)" }
        }
        transfer.headers = headers
        transfer.contentLength = http.expectedContentLength
        do {
            try FileManager.default.createDirectory(at: transfer.destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard FileManager.default.createFile(atPath: transfer.destination.path, contents: nil) else {
                throw HotspotError("Could not create \(transfer.destination.lastPathComponent)")
            }
            transfer.file = try FileHandle(forWritingTo: transfer.destination)
        } catch {
            transfer.failure = error.localizedDescription; completionHandler(.cancel); return
        }
        progress([
            "requestId": transfer.requestId,
            "bytesWritten": 0,
            "contentLength": transfer.contentLength,
            "statusCode": transfer.statusCode,
            "headers": headers,
        ])
        completionHandler(.allow)
    }

    func urlSession(_: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let transfer = transfers[dataTask.taskIdentifier], let file = transfer.file, transfer.failure == nil else { return }
        do {
            try file.write(contentsOf: data)
        } catch {
            transfer.failure = error.localizedDescription
            dataTask.cancel()
            return
        }
        transfer.bytesWritten += Int64(data.count)
        progress(["requestId": transfer.requestId, "bytesWritten": transfer.bytesWritten, "contentLength": transfer.contentLength])
    }

    func urlSession(_: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let transfer = transfers.removeValue(forKey: task.taskIdentifier) else { return }
        transfer.connectTimer?.cancel()
        try? transfer.file?.close()
        lock.lock()
        if tasks[transfer.requestId] === task { tasks.removeValue(forKey: transfer.requestId) }
        lock.unlock()
        if let message = transfer.failure ?? error?.localizedDescription {
            transfer.promise.reject("ERR_LOCAL_DOWNLOAD", message)
        } else {
            transfer.promise.resolve([
                "statusCode": transfer.statusCode,
                "bytesWritten": transfer.bytesWritten,
                "headers": transfer.headers,
            ])
        }
    }
}
