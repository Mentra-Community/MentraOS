import Foundation

/// A frame-level speech detector, e.g. Silero through sherpa-onnx.
///
/// It owns its own hangover: once speaking, it keeps answering `true` until it has heard the
/// configured minimum silence, and it answers `false` until speech has lasted long enough.
protocol SpeechActivityClassifier: AnyObject {
    /// Analyze exactly `SpeechActivityTracker.frameSamples` samples (16 kHz mono, [-1, 1]) and
    /// return whether speech is detected after this frame.
    func isSpeech(afterAccepting frame: [Float]) -> Bool
}

/// A reported change in phone-side speech activity.
struct SpeechActivityTransition: Equatable {
    let speaking: Bool
    /// 0 while speaking; on a silence transition, how long the audio has been silent.
    let silentForMs: Int
}

/// Turns 16 kHz mono s16le PCM chunks of any size into 512-sample frames, checks every frame,
/// and reports transitions only. Fills gaps in incoming audio with silence in real time, because
/// Mentra Live's loudness gate stops sending audio when it's quiet.
///
/// Not thread-safe: the caller serializes all calls.
final class SpeechActivityTracker {
    static let sampleRate = 16000
    static let frameSamples = 512
    static let defaultMinSilenceMs = 300
    /// Audio missing for this long counts as silence and is filled in.
    static let gapFillAfterMs: Int64 = 100

    private static let samplesPerMs = Int64(sampleRate / 1000)

    let minSilenceMs: Int
    private let classifier: SpeechActivityClassifier
    private var frame: [Float] = []
    private var carry: UInt8?
    private var detecting = false
    private var lastAudioAtMs: Int64?
    private var gapFilledSamples: Int64 = 0

    /// The last state reported. Starts silent; nothing is reported until speech is heard.
    private(set) var speaking = false
    /// Samples analyzed so far, real and filled. For diagnostics and tests.
    private(set) var analyzedSamples: Int64 = 0
    private(set) var filledSamples: Int64 = 0

    init(classifier: SpeechActivityClassifier, minSilenceMs: Int = SpeechActivityTracker.defaultMinSilenceMs) {
        self.classifier = classifier
        self.minSilenceMs = max(0, minSilenceMs)
        frame.reserveCapacity(Self.frameSamples)
    }

    /// Filling only matters while speech is reported or the detector still hears it; silence fed
    /// to a silent detector can't produce a transition.
    var needsGapFill: Bool {
        lastAudioAtMs != nil && (speaking || detecting)
    }

    /// When the next gap-fill check is due, or nil when none is needed.
    func nextGapFillDueMs(nowMs: Int64) -> Int64? {
        guard needsGapFill, let lastAudioAtMs else { return nil }
        let due = lastAudioAtMs + Self.gapFillAfterMs
        return due > nowMs ? due : nowMs + Int64(Self.frameSamples * 1000 / Self.sampleRate)
    }

    func accept(_ pcm: Data, nowMs: Int64) -> [SpeechActivityTransition] {
        guard !pcm.isEmpty else { return [] }
        lastAudioAtMs = nowMs
        gapFilledSamples = 0
        var transitions: [SpeechActivityTransition] = []
        pcm.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            var index = 0
            if let low = carry {
                appendSample(low: low, high: bytes[0], into: &transitions)
                carry = nil
                index = 1
            }
            while index + 1 < bytes.count {
                appendSample(low: bytes[index], high: bytes[index + 1], into: &transitions)
                index += 2
            }
            if index < bytes.count {
                carry = bytes[index]
            }
        }
        return transitions
    }

    /// Feed silence for the time no audio has arrived, once that exceeds `gapFillAfterMs`.
    func fillGap(nowMs: Int64) -> [SpeechActivityTransition] {
        guard let lastAudioAtMs, nowMs - lastAudioAtMs >= Self.gapFillAfterMs else { return [] }
        let targetSamples = (nowMs - lastAudioAtMs) * Self.samplesPerMs
        var transitions: [SpeechActivityTransition] = []
        // A half-received sample is lost with the gap.
        carry = nil
        while needsGapFill {
            let missing = Self.frameSamples - frame.count
            guard gapFilledSamples + Int64(missing) <= targetSamples else { break }
            frame.append(contentsOf: repeatElement(0, count: missing))
            gapFilledSamples += Int64(missing)
            filledSamples += Int64(missing)
            analyzeFrame(into: &transitions)
        }
        return transitions
    }

    private func appendSample(low: UInt8, high: UInt8, into transitions: inout [SpeechActivityTransition]) {
        frame.append(Float(Int16(bitPattern: UInt16(low) | UInt16(high) << 8)) / 32768)
        if frame.count == Self.frameSamples {
            analyzeFrame(into: &transitions)
        }
    }

    private func analyzeFrame(into transitions: inout [SpeechActivityTransition]) {
        detecting = classifier.isSpeech(afterAccepting: frame)
        analyzedSamples += Int64(frame.count)
        frame.removeAll(keepingCapacity: true)
        if detecting, !speaking {
            speaking = true
            transitions.append(SpeechActivityTransition(speaking: true, silentForMs: 0))
        } else if !detecting, speaking {
            // The detector only turns off after `minSilenceMs` of silence.
            speaking = false
            transitions.append(SpeechActivityTransition(speaking: false, silentForMs: minSilenceMs))
        }
    }
}

/// Runs a `SpeechActivityTracker` on its own queue while enabled. Enabling creates the classifier
/// (loads the model); disabling drops it. Audio is accepted from any thread.
final class SpeechActivityMonitor: @unchecked Sendable {
    struct Event: Equatable {
        let speaking: Bool
        let silentForMs: Int
        /// Unix epoch milliseconds.
        let timestamp: Int64
    }

    enum MonitorError: LocalizedError {
        case modelUnavailable

        var errorDescription: String? {
            "Could not load the speech activity model"
        }
    }

    private let queue: DispatchQueue
    private let makeClassifier: (_ minSilenceMs: Int) -> SpeechActivityClassifier?
    private let emit: (Event) -> Void
    private let monotonicMs: () -> Int64
    private let epochMs: () -> Int64

    private let lock = NSLock()
    private var enabled = false
    private var generation: UInt64 = 0

    // Queue only.
    private var tracker: SpeechActivityTracker?
    private var trackerGeneration: UInt64 = 0
    private var gapCheckScheduled = false

    init(
        queue: DispatchQueue = DispatchQueue(label: "com.mentra.speech-activity", qos: .userInitiated),
        makeClassifier: @escaping (_ minSilenceMs: Int) -> SpeechActivityClassifier?,
        emit: @escaping (Event) -> Void,
        monotonicMs: @escaping () -> Int64 = { Int64(ProcessInfo.processInfo.systemUptime * 1000) },
        epochMs: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.queue = queue
        self.makeClassifier = makeClassifier
        self.emit = emit
        self.monotonicMs = monotonicMs
        self.epochMs = epochMs
    }

    var isEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return enabled
    }

    /// Whether a classifier (model) is currently held. Queue-serialized; for tests.
    func hasClassifier() -> Bool {
        queue.sync { tracker != nil }
    }

    /// Enable with `minSilenceMs` (default 300), or disable and release the model. Enabling
    /// again replaces the detector, so a new `minSilenceMs` takes effect. Throws when the model
    /// can't be loaded.
    func setEnabled(_ value: Bool, minSilenceMs: Int?) async throws {
        let token = beginDemandChange(enabled: value)
        let silence = max(0, minSilenceMs ?? SpeechActivityTracker.defaultMinSilenceMs)
        let loaded: Bool = await withCheckedContinuation { continuation in
            queue.async {
                // Release before loading a replacement, so two models are never held.
                self.tracker = nil
                guard value, self.isCurrent(token) else {
                    continuation.resume(returning: true)
                    return
                }
                guard let classifier = self.makeClassifier(silence) else {
                    continuation.resume(returning: false)
                    return
                }
                if self.isCurrent(token) {
                    self.tracker = SpeechActivityTracker(classifier: classifier, minSilenceMs: silence)
                    self.trackerGeneration = token
                }
                continuation.resume(returning: true)
            }
        }
        if !loaded {
            disableIfCurrent(token)
            throw MonitorError.modelUnavailable
        }
    }

    private func beginDemandChange(enabled value: Bool) -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        generation &+= 1
        enabled = value
        return generation
    }

    private func disableIfCurrent(_ token: UInt64) {
        lock.lock()
        defer { lock.unlock() }
        if generation == token { enabled = false }
    }

    func accept(_ pcm: Data) {
        guard !pcm.isEmpty, isEnabled else { return }
        let now = monotonicMs()
        queue.async {
            guard let tracker = self.tracker, self.isCurrent(self.trackerGeneration) else { return }
            self.report(tracker.accept(pcm, nowMs: now))
            self.scheduleGapCheck()
        }
    }

    /// Run the gap-fill check now. Queue-serialized; for tests.
    func checkGapNow() {
        queue.sync {
            guard let tracker = self.tracker else { return }
            self.report(tracker.fillGap(nowMs: self.monotonicMs()))
        }
    }

    private func isCurrent(_ token: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return enabled && generation == token
    }

    /// Queue only. At most one check is pending; it always works on the current tracker.
    private func scheduleGapCheck() {
        guard !gapCheckScheduled, let tracker, let due = tracker.nextGapFillDueMs(nowMs: monotonicMs()) else { return }
        gapCheckScheduled = true
        let delayMs = max(1, due - monotonicMs())
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(delayMs))) { [weak self] in
            guard let self else { return }
            self.gapCheckScheduled = false
            guard let current = self.tracker, self.isCurrent(self.trackerGeneration) else { return }
            self.report(current.fillGap(nowMs: self.monotonicMs()))
            self.scheduleGapCheck()
        }
    }

    /// Queue only.
    private func report(_ transitions: [SpeechActivityTransition]) {
        for transition in transitions {
            emit(Event(speaking: transition.speaking, silentForMs: transition.silentForMs, timestamp: epochMs()))
        }
    }
}
