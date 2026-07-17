import AVFoundation
import Foundation

private enum PcmStreamError: LocalizedError {
    case invalidArgument(String)
    case closed
    case native(String)

    var errorDescription: String? {
        switch self {
        case let .invalidArgument(message), let .native(message):
            return message
        case .closed:
            return "PCM stream is closed"
        }
    }
}

/// Low-latency, bounded live PCM playback for `speaker.createStream()`.
///
/// Input is signed 16-bit little-endian mono PCM. Chunks are converted to the
/// float format AVAudioEngine renders natively, scheduled on an
/// AVAudioPlayerNode, and accounted when they reach the output device. The
/// serial state queue keeps writes, completion callbacks, interruption
/// recovery, close, and abort deterministic without blocking Expo's module
/// queue.
final class PcmStreamPlayer: @unchecked Sendable {
    private static let backpressureCeilingMs: Int64 = 2000
    private static let maximumBacklogMs: Int64 = 10000

    private let streamId: String
    private let sampleRate: Int
    private let stateQueue: DispatchQueue
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format: AVAudioFormat

    private var queuedFrames: Int64 = 0
    private var playedFrames: Int64 = 0
    private var closing = false
    private var aborted = false
    private var finished = false
    private var terminalError: Error?
    private var writeWaiters: [CheckedContinuation<Int64, Error>] = []
    private var closeWaiters: [CheckedContinuation<Int64, Error>] = []
    private var observers: [NSObjectProtocol] = []

    init(streamId: String, sampleRate: Int, channels: Int, volume: Float) throws {
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
        stateQueue = DispatchQueue(label: "com.mentra.pcm-stream.\(streamId)")

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        player.volume = min(max(volume, 0), 1)
        engine.prepare()
        try engine.start()
        player.play()
        installAudioSessionObservers()
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    func write(base64: String) async throws -> Int64 {
        guard let data = Data(base64Encoded: base64), !data.isEmpty else {
            throw PcmStreamError.invalidArgument("PCM chunk is empty or invalid base64")
        }
        guard data.count.isMultiple(of: 2) else {
            throw PcmStreamError.invalidArgument(
                "PCM chunk length \(data.count) is not aligned to a 2-byte frame"
            )
        }

        return try await withCheckedThrowingContinuation { continuation in
            stateQueue.async { [self] in
                do {
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
                    queuedFrames += Int64(frameCount)
                    player.scheduleBuffer(
                        buffer,
                        completionCallbackType: .dataPlayedBack
                    ) { [weak self] _ in
                        self?.stateQueue.async {
                            self?.didPlay(frameCount: frameCount)
                        }
                    }
                    resumePlaybackIfNeeded()
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
                }
            }
        }
    }

    func abort() async {
        await withCheckedContinuation { continuation in
            stateQueue.async { [self] in
                if !aborted {
                    aborted = true
                    finished = true
                    player.stop()
                    engine.stop()
                    queuedFrames = 0
                    let error = PcmStreamError.closed
                    writeWaiters.forEach { $0.resume(throwing: error) }
                    writeWaiters.removeAll()
                    closeWaiters.forEach { $0.resume(returning: durationMs) }
                    closeWaiters.removeAll()
                    removeAudioSessionObservers()
                }
                continuation.resume()
            }
        }
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

        let bytes = [UInt8](data)
        for index in 0 ..< frameCount {
            let bits = UInt16(bytes[index * 2]) | (UInt16(bytes[index * 2 + 1]) << 8)
            channel[index] = Float(Int16(bitPattern: bits)) / 32768.0
        }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        return buffer
    }

    private func didPlay(frameCount: Int) {
        guard !aborted, terminalError == nil else { return }
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

    private func resumePlaybackIfNeeded() {
        guard !finished, terminalError == nil else { return }
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
        queuedFrames = 0
        writeWaiters.forEach { $0.resume(throwing: error) }
        writeWaiters.removeAll()
        closeWaiters.forEach { $0.resume(throwing: error) }
        closeWaiters.removeAll()
        removeAudioSessionObservers()
    }

    private func installAudioSessionObservers() {
        let center = NotificationCenter.default
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
            ) { [weak self] _ in
                self?.stateQueue.asyncAfter(deadline: .now() + 0.1) {
                    self?.resumePlaybackIfNeeded()
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
    }

    private func removeAudioSessionObservers() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
    }

    private func handleInterruption(_ notification: Notification) {
        guard
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }

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
}

/// Process-wide registry matching the Android PCM stream bridge contract.
enum PcmStreamManager {
    private static let lock = NSLock()
    private static var players: [String: PcmStreamPlayer] = [:]

    static func open(
        streamId: String,
        sampleRate: Int,
        channels: Int,
        volume: Float
    ) throws {
        let player = try PcmStreamPlayer(
            streamId: streamId,
            sampleRate: sampleRate,
            channels: channels,
            volume: volume
        )
        lock.lock()
        let previous = players.updateValue(player, forKey: streamId)
        lock.unlock()
        if let previous {
            Task { await previous.abort() }
        }
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

    static func abort(streamId: String) async {
        guard let player = optionalRemove(streamId: streamId) else { return }
        await player.abort()
    }

    static func abortAll() async {
        let active = takeAll()
        for player in active {
            await player.abort()
        }
    }

    private static func lookup(streamId: String) throws -> PcmStreamPlayer {
        lock.lock()
        defer { lock.unlock() }
        guard let player = players[streamId] else {
            throw PcmStreamError.closed
        }
        return player
    }

    private static func optionalRemove(streamId: String) -> PcmStreamPlayer? {
        lock.lock()
        defer { lock.unlock() }
        return players.removeValue(forKey: streamId)
    }

    private static func removeIfCurrent(streamId: String, player: PcmStreamPlayer) {
        lock.lock()
        defer { lock.unlock() }
        if players[streamId] === player {
            players.removeValue(forKey: streamId)
        }
    }

    private static func takeAll() -> [PcmStreamPlayer] {
        lock.lock()
        defer { lock.unlock() }
        let active = Array(players.values)
        players.removeAll()
        return active
    }
}
