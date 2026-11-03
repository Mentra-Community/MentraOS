import AVFoundation
import Foundation
import os

enum PcmStreamError: LocalizedError, Equatable {
    case invalidArgument(String)
    case closed
    case notOpen(String)
    case aborted
    case native(String)

    var errorDescription: String? {
        switch self {
        case let .invalidArgument(message), let .native(message):
            return message
        case .closed:
            return "PCM stream is closed"
        case let .notOpen(streamId):
            return "pcm stream \(streamId) is not open"
        case .aborted:
            return "aborted"
        }
    }
}

/// When a stream starts playing: once `jitterMs` of audio is queued, or when it is closed with
/// less than that, so a sound shorter than the cushion still plays. Same range as Android.
struct PcmJitterGate: Equatable {
    static let defaultJitterMs = 500
    static let minimumJitterMs = 80

    let jitterMs: Int
    let startFrames: Int64

    init(jitterMs requested: Int?, sampleRate: Int) {
        let jitterMs = min(max(requested ?? Self.defaultJitterMs, Self.minimumJitterMs), Self.defaultJitterMs)
        self.jitterMs = jitterMs
        startFrames = max(1, Int64(sampleRate) * Int64(jitterMs) / 1000)
    }

    func shouldStart(queuedFrames: Int64, closing: Bool) -> Bool {
        guard queuedFrames > 0 else { return false }
        return closing || queuedFrames >= startFrames
    }
}

/// Holds back an odd trailing byte so every chunk handed on is whole 16-bit samples.
struct PcmByteCarry {
    private var pending: UInt8?

    var hasPendingByte: Bool {
        pending != nil
    }

    mutating func align(_ chunk: Data) -> Data {
        var bytes = Data()
        bytes.reserveCapacity(chunk.count + 1)
        if let pending {
            bytes.append(pending)
            self.pending = nil
        }
        bytes.append(chunk)
        if !bytes.count.isMultiple(of: 2) {
            pending = bytes.removeLast()
        }
        return bytes
    }
}

/// Destination for PCM fetched by `PcmUrlLoader`.
protocol PcmStreamSink: AnyObject {
    /// Queue whole s16le samples; suspends while the backlog is above the backpressure ceiling.
    func write(data: Data) async throws -> Int64
    /// Play out what is queued, then end. Returns the played duration in ms.
    func close() async throws -> Int64
    func abort() async
}

/// Low-latency, bounded live PCM playback for `speaker.createStream()`.
///
/// Input is signed 16-bit little-endian mono PCM. Chunks are converted to the
/// float format AVAudioEngine renders natively, scheduled on an
/// AVAudioPlayerNode, and accounted when they reach the output device. The
/// serial state queue keeps writes, completion callbacks, interruption
/// recovery, close, and abort deterministic without blocking Expo's module
/// queue.
///
/// Nothing starts until `jitterMs` of audio is queued or the stream is closed,
/// so a prewarmed stream holds no output route. A stream that hasn't received
/// audio when the audio output changes or the session is interrupted is
/// abandoned: it may point at a stale output, and its next write fails with
/// "not open" so the caller reopens on the current route.
final class PcmStreamPlayer: PcmStreamSink, @unchecked Sendable {
    private let logger = Logger(subsystem: "com.mentra.pcm-stream", category: "playback")
    private static let backpressureCeilingMs: Int64 = 2000
    private static let maximumBacklogMs: Int64 = 10000

    private let streamId: String
    private let sampleRate: Int
    private let gate: PcmJitterGate
    private let stateQueue: DispatchQueue
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format: AVAudioFormat

    /// Called once, on the state queue, when the stream abandons itself after a route change or
    /// interruption before any audio arrived. State queue only.
    private var onAbandoned: (() -> Void)?

    private var queuedFrames: Int64 = 0
    private var playedFrames: Int64 = 0
    private var writtenFrames: Int64 = 0
    private var playbackStarted = false
    /// Buffers written before playback starts; scheduled together when it does.
    private var heldBuffers: [(buffer: AVAudioPCMBuffer, frames: Int)] = []
    private var closing = false
    private var aborted = false
    private var abandoned = false
    private var finished = false
    private var terminalError: Error?
    private var writeWaiters: [CheckedContinuation<Int64, Error>] = []
    private var closeWaiters: [CheckedContinuation<Int64, Error>] = []
    private var observers: [NSObjectProtocol] = []

    init(streamId: String, sampleRate: Int, channels: Int, volume: Float, jitterMs: Int? = nil) throws {
        guard !streamId.isEmpty else {
            throw PcmStreamError.invalidArgument("streamId is required")
        }
        guard [16000, 24000, 48000].contains(sampleRate) else {
            throw PcmStreamError.invalidArgument("unsupported PCM sample rate \(sampleRate)")
        }
        guard channels == 1 else {
            throw PcmStreamError.invalidArgument("only mono PCM is supported")
        }
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(sampleRate),
            channels: 1,
            interleaved: false
        ) else {
            throw PcmStreamError.native("failed to create PCM playback format")
        }

        self.streamId = streamId
        self.sampleRate = sampleRate
        self.format = format
        gate = PcmJitterGate(jitterMs: jitterMs, sampleRate: sampleRate)
        stateQueue = DispatchQueue(label: "com.mentra.pcm-stream.\(streamId)")

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        player.volume = min(max(volume, 0), 1)
        engine.prepare()
        // An empty prewarmed stream must not start playback or microphone gating.
        installAudioSessionObservers()
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    /// Set the handler `onAbandoned` calls. Must not be called from the state queue.
    func setAbandonHandler(_ handler: @escaping () -> Void) {
        stateQueue.sync { onAbandoned = handler }
    }

    func write(base64: String) async throws -> Int64 {
        guard let data = Data(base64Encoded: base64), !data.isEmpty else {
            throw PcmStreamError.invalidArgument("PCM chunk is empty or invalid base64")
        }
        return try await write(data: data)
    }

    func write(data: Data) async throws -> Int64 {
        guard !data.isEmpty else {
            throw PcmStreamError.invalidArgument("PCM chunk is empty")
        }
        guard data.count.isMultiple(of: 2) else {
            throw PcmStreamError.invalidArgument(
                "PCM chunk length \(data.count) is not aligned to a 2-byte frame"
            )
        }

        return try await withCheckedThrowingContinuation { continuation in
            stateQueue.async { [self] in
                do {
                    if abandoned { throw PcmStreamError.notOpen(streamId) }
                    if let terminalError { throw terminalError }
                    guard !closing && !aborted else { throw PcmStreamError.closed }

                    let frameCount = data.count / 2
                    let nextBacklog = bufferedMs(frames: queuedFrames + Int64(frameCount))
                    guard nextBacklog <= Self.maximumBacklogMs else {
                        throw PcmStreamError.invalidArgument(
                            "PCM backlog exceeds \(Self.maximumBacklogMs)ms; producer is not throttling"
                        )
                    }

                    let buffer = try makeBuffer(data: data, frameCount: frameCount)
                    if writtenFrames == 0 {
                        logger.info("PCM_PLAYBACK first_write frames=\(frameCount) sampleRate=\(self.sampleRate) jitterMs=\(self.gate.jitterMs)")
                    }
                    writtenFrames += Int64(frameCount)
                    queuedFrames += Int64(frameCount)
                    if playbackStarted {
                        schedule(buffer, frames: frameCount)
                        resumePlaybackIfNeeded()
                    } else {
                        heldBuffers.append((buffer, frameCount))
                        startPlaybackIfReady()
                    }
                    if let terminalError { throw terminalError }

                    let current = bufferedMs(frames: queuedFrames)
                    if current <= Self.backpressureCeilingMs {
                        continuation.resume(returning: current)
                    } else {
                        writeWaiters.append(continuation)
                    }
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func close() async throws -> Int64 {
        try await withCheckedThrowingContinuation { continuation in
            stateQueue.async { [self] in
                if let terminalError {
                    continuation.resume(throwing: terminalError)
                    return
                }
                if aborted {
                    continuation.resume(returning: durationMs)
                    return
                }
                closing = true
                if queuedFrames == 0 {
                    finishClose(extra: continuation)
                } else {
                    closeWaiters.append(continuation)
                    // Audio shorter than the jitter cushion starts now.
                    startPlaybackIfReady()
                }
            }
        }
    }

    func abort() async {
        await withCheckedContinuation { continuation in
            stateQueue.async { [self] in
                abortOnStateQueue()
                continuation.resume()
            }
        }
    }

    private func abortOnStateQueue() {
        guard !aborted else { return }
        logger.info("PCM_PLAYBACK abort writtenFrames=\(self.writtenFrames) playedFrames=\(self.playedFrames) queuedFrames=\(self.queuedFrames)")
        aborted = true
        finished = true
        player.stop()
        engine.stop()
        heldBuffers.removeAll()
        queuedFrames = 0
        let error: PcmStreamError = abandoned ? .notOpen(streamId) : .closed
        writeWaiters.forEach { $0.resume(throwing: error) }
        writeWaiters.removeAll()
        closeWaiters.forEach { $0.resume(returning: durationMs) }
        closeWaiters.removeAll()
        removeAudioSessionObservers()
    }

    /// A stream that never received audio must not survive a route change: it would play on
    /// the old route. Returns true when the stream was abandoned.
    private func abandonIfUnwritten(reason: String) -> Bool {
        guard writtenFrames == 0, !aborted, !finished else { return false }
        logger.info("PCM_PLAYBACK abandon_unwritten reason=\(reason)")
        abandoned = true
        abortOnStateQueue()
        let callback = onAbandoned
        onAbandoned = nil
        callback?()
        return true
    }

    private var durationMs: Int64 {
        bufferedMs(frames: playedFrames)
    }

    private func bufferedMs(frames: Int64) -> Int64 {
        max(0, frames) * 1000 / Int64(sampleRate)
    }

    private func makeBuffer(data: Data, frameCount: Int) throws -> AVAudioPCMBuffer {
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(frameCount)
        ), let channel = buffer.floatChannelData?[0] else {
            throw PcmStreamError.native("failed to allocate PCM audio buffer")
        }

        data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            for index in 0 ..< frameCount {
                let bits = UInt16(bytes[index * 2]) | (UInt16(bytes[index * 2 + 1]) << 8)
                channel[index] = Float(Int16(bitPattern: bits)) / 32768.0
            }
        }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        return buffer
    }

    private func schedule(_ buffer: AVAudioPCMBuffer, frames frameCount: Int) {
        player.scheduleBuffer(
            buffer,
            completionCallbackType: .dataPlayedBack
        ) { [weak self] _ in
            self?.stateQueue.async {
                self?.didPlay(frameCount: frameCount)
            }
        }
    }

    /// Start once the jitter cushion is queued, or on close with whatever is queued.
    private func startPlaybackIfReady() {
        guard !playbackStarted, !finished, terminalError == nil,
              gate.shouldStart(queuedFrames: queuedFrames, closing: closing)
        else { return }
        do {
            if !engine.isRunning {
                try engine.start()
            }
        } catch {
            fail(PcmStreamError.native("PCM playback start failed: \(error.localizedDescription)"))
            return
        }
        playbackStarted = true
        logger.info("PCM_PLAYBACK start queuedMs=\(self.bufferedMs(frames: self.queuedFrames)) closing=\(self.closing)")
        let held = heldBuffers
        heldBuffers.removeAll()
        for entry in held {
            schedule(entry.buffer, frames: entry.frames)
        }
        player.play()
    }

    private func didPlay(frameCount: Int) {
        guard !aborted, terminalError == nil else { return }
        if playedFrames == 0 {
            let rate = sampleRate
            logger.info("PCM_PLAYBACK first_played frames=\(frameCount) sampleRate=\(rate)")
        }
        queuedFrames = max(0, queuedFrames - Int64(frameCount))
        playedFrames += Int64(frameCount)

        if bufferedMs(frames: queuedFrames) <= Self.backpressureCeilingMs {
            let current = bufferedMs(frames: queuedFrames)
            writeWaiters.forEach { $0.resume(returning: current) }
            writeWaiters.removeAll()
        }
        if closing && queuedFrames == 0 {
            finishClose()
        }
    }

    private func finishClose(extra: CheckedContinuation<Int64, Error>? = nil) {
        guard !finished else {
            extra?.resume(returning: durationMs)
            return
        }
        finished = true
        player.stop()
        engine.stop()
        removeAudioSessionObservers()
        let result = durationMs
        writeWaiters.forEach { $0.resume(throwing: PcmStreamError.closed) }
        writeWaiters.removeAll()
        closeWaiters.forEach { $0.resume(returning: result) }
        closeWaiters.removeAll()
        extra?.resume(returning: result)
    }

    /// Restart output that already started, e.g. after an interruption or route change.
    /// Never starts a stream that hasn't started; the jitter gate does that.
    private func resumePlaybackIfNeeded() {
        guard playbackStarted, !finished, terminalError == nil else { return }
        do {
            if !engine.isRunning {
                try engine.start()
            }
            if !player.isPlaying {
                player.play()
            }
        } catch {
            fail(PcmStreamError.native("PCM playback restart failed: \(error.localizedDescription)"))
        }
    }

    private func fail(_ error: Error) {
        guard terminalError == nil && !aborted else { return }
        terminalError = error
        finished = true
        player.stop()
        engine.stop()
        heldBuffers.removeAll()
        queuedFrames = 0
        writeWaiters.forEach { $0.resume(throwing: error) }
        writeWaiters.removeAll()
        closeWaiters.forEach { $0.resume(throwing: error) }
        closeWaiters.removeAll()
        removeAudioSessionObservers()
    }

    private func installAudioSessionObservers() {
        let center = NotificationCenter.default
        #if os(macOS)
        observers.append(center.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            self?.stateQueue.async {
                guard let self, !self.abandonIfUnwritten(reason: "configuration_change") else { return }
                // A device change invalidates scheduled buffers. Reject pending writes/close
                // instead of leaving callers waiting for callbacks that cannot arrive.
                self.fail(PcmStreamError.native("Audio device changed; reopen the PCM stream"))
            }
        })
        #else
        observers.append(
            center.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: nil,
                queue: nil
            ) { [weak self] notification in
                self?.stateQueue.async {
                    self?.handleInterruption(notification)
                }
            }
        )
        observers.append(
            center.addObserver(
                forName: AVAudioSession.routeChangeNotification,
                object: nil,
                queue: nil
            ) { [weak self] notification in
                let outputChanged = Self.outputsChanged(notification)
                self?.stateQueue.async {
                    guard let self else { return }
                    if outputChanged, self.abandonIfUnwritten(reason: "route_change") { return }
                    self.stateQueue.asyncAfter(deadline: .now() + 0.1) {
                        self.resumePlaybackIfNeeded()
                    }
                }
            }
        )
        observers.append(
            center.addObserver(
                forName: AVAudioSession.mediaServicesWereResetNotification,
                object: nil,
                queue: nil
            ) { [weak self] _ in
                self?.stateQueue.async {
                    self?.fail(PcmStreamError.native("iOS audio services reset; reopen the PCM stream"))
                }
            }
        )
        #endif
    }

    private func removeAudioSessionObservers() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
    }

    #if !os(macOS)
    /// Whether a route change moved the output. The engine resets the session category before
    /// every playback, which posts a route change that leaves the output where it was; a
    /// prewarmed stream must survive that.
    private static func outputsChanged(_ notification: Notification) -> Bool {
        guard let previous = notification.userInfo?[AVAudioSessionRouteChangePreviousRouteKey]
            as? AVAudioSessionRouteDescription
        else { return true }
        let signature = { (route: AVAudioSessionRouteDescription) in
            route.outputs.map { "\($0.portType.rawValue)#\($0.uid)" }
        }
        return signature(previous) != signature(AVAudioSession.sharedInstance().currentRoute)
    }

    private func handleInterruption(_ notification: Notification) {
        guard
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }

        if abandonIfUnwritten(reason: "interruption") { return }
        switch type {
        case .began:
            player.pause()
        case .ended:
            // A close may be waiting for queued buffers to drain. Resume that
            // drain too; otherwise an interruption that begins just before
            // close leaves its continuation suspended indefinitely.
            if !aborted, !finished {
                resumePlaybackIfNeeded()
            }
        @unknown default:
            break
        }
    }
    #endif
}

/// Process-wide registry matching the Android PCM stream bridge contract.
enum PcmStreamManager {
    private static let lock = NSLock()
    private static var players: [String: PcmStreamPlayer] = [:]
    private static var urlPlaybacks: [String: PcmUrlPlayback] = [:]

    @discardableResult
    static func open(
        streamId: String,
        sampleRate: Int,
        channels: Int,
        volume: Float,
        jitterMs: Int? = nil
    ) throws -> PcmStreamPlayer {
        let player = try PcmStreamPlayer(
            streamId: streamId,
            sampleRate: sampleRate,
            channels: channels,
            volume: volume,
            jitterMs: jitterMs
        )
        player.setAbandonHandler { [weak player] in
            guard let player else { return }
            removeIfCurrent(streamId: streamId, player: player)
        }
        lock.lock()
        let previous = players.updateValue(player, forKey: streamId)
        let previousPlayback = urlPlaybacks.removeValue(forKey: streamId)
        lock.unlock()
        previousPlayback?.cancel()
        if let previous {
            Task { await previous.abort() }
        }
        return player
    }

    static func write(streamId: String, base64: String) async throws -> Int64 {
        let player = try lookup(streamId: streamId)
        return try await player.write(base64: base64)
    }

    static func close(streamId: String) async throws -> Int64 {
        let player = try lookup(streamId: streamId)
        do {
            let duration = try await player.close()
            removeIfCurrent(streamId: streamId, player: player)
            return duration
        } catch {
            removeIfCurrent(streamId: streamId, player: player)
            throw error
        }
    }

    /// Open `streamId` and play the raw s16le mono body of `url` as it downloads. Resolves with
    /// the played duration once the whole body has played.
    static func playUrl(
        streamId: String,
        url rawUrl: String,
        sampleRate: Int,
        volume: Float,
        jitterMs: Int?
    ) async throws -> Int64 {
        guard let url = URL(string: rawUrl), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            throw PcmStreamError.invalidArgument("PCM stream URL must be http(s)")
        }
        let player = try open(
            streamId: streamId,
            sampleRate: sampleRate,
            channels: 1,
            volume: volume,
            jitterMs: jitterMs
        )
        let playback = PcmUrlLoader.shared.start(url: url, sink: player)
        if !register(playback, streamId: streamId, player: player) {
            playback.cancel()
        }
        do {
            let duration = try await playback.wait()
            removeUrlPlaybackIfCurrent(streamId: streamId, playback: playback)
            removeIfCurrent(streamId: streamId, player: player)
            return duration
        } catch {
            removeUrlPlaybackIfCurrent(streamId: streamId, playback: playback)
            if removeIfCurrent(streamId: streamId, player: player) {
                await player.abort()
            }
            throw error
        }
    }

    static func abort(streamId: String) async {
        let (playback, player) = take(streamId: streamId)
        // Cancel first so a URL playback rejects with "aborted", not a write error.
        playback?.cancel()
        await player?.abort()
    }

    static func abortAll() async {
        let (playbacks, active) = takeAll()
        playbacks.forEach { $0.cancel() }
        for player in active {
            await player.abort()
        }
    }

    /// `open` cleared any earlier playback for this id; only a racing open can have replaced
    /// the player since, and that one owns the id now.
    private static func register(_ playback: PcmUrlPlayback, streamId: String, player: PcmStreamPlayer) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard players[streamId] === player else { return false }
        urlPlaybacks[streamId] = playback
        return true
    }

    private static func take(streamId: String) -> (PcmUrlPlayback?, PcmStreamPlayer?) {
        lock.lock()
        defer { lock.unlock() }
        return (urlPlaybacks.removeValue(forKey: streamId), players.removeValue(forKey: streamId))
    }

    private static func takeAll() -> ([PcmUrlPlayback], [PcmStreamPlayer]) {
        lock.lock()
        defer { lock.unlock() }
        let result = (Array(urlPlaybacks.values), Array(players.values))
        urlPlaybacks.removeAll()
        players.removeAll()
        return result
    }

    private static func lookup(streamId: String) throws -> PcmStreamPlayer {
        lock.lock()
        defer { lock.unlock() }
        guard let player = players[streamId] else {
            throw PcmStreamError.notOpen(streamId)
        }
        return player
    }

    @discardableResult
    private static func removeIfCurrent(streamId: String, player: PcmStreamPlayer) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard players[streamId] === player else { return false }
        players.removeValue(forKey: streamId)
        return true
    }

    private static func removeUrlPlaybackIfCurrent(streamId: String, playback: PcmUrlPlayback) {
        lock.lock()
        defer { lock.unlock() }
        if urlPlaybacks[streamId] === playback {
            urlPlaybacks.removeValue(forKey: streamId)
        }
    }
}
