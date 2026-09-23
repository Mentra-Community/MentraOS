import Foundation

/// The frame-agnostic half of `DecodedFrameTap`: sink ownership, failure isolation and metrics.
///
/// The call owns the decoder; a preview sink is a guest. `offer` never lets a thrown error reach
/// the decoder thread, and with no sink attached and telemetry off it costs one uncontended lock
/// around a single reference load (Swift has no portable atomics for iOS 15).
/// Swift runtime traps (force-unwraps, bounds failures) are process failures and cannot be caught
/// here; the preview prevents them by validating geometry before touching memory.
public final class DecodedFrameTapCore<Frame> {
    /// A snapshot of decoder-thread observations, drained by the reader.
    public struct Metrics {
        public let framesOffered: Int
        public let framesWithSink: Int
        public let offerTotalNs: Int64
        public let offerMaxNs: Int64
        public let cadenceSamples: Int
        public let cadenceTotalNs: Int64
        public let cadenceMaxNs: Int64
        public let sinkExceptions: Int
        /// Frames the ACS sender accepted, recorded at its call sites after `offer`.
        public let acsFramesSent: Int

        /// Mean time inside `offer` over every timed frame, with or without a sink.
        public var offerMeanUs: Double {
            framesOffered > 0 ? Double(offerTotalNs) / Double(framesOffered) / 1000.0 : 0
        }

        public var offerMaxUs: Double { Double(offerMaxNs) / 1000.0 }

        public var cadenceMeanMs: Double {
            cadenceSamples > 0 ? Double(cadenceTotalNs) / Double(cadenceSamples) / 1_000_000.0 : 0
        }

        public var cadenceMaxMs: Double { Double(cadenceMaxNs) / 1_000_000.0 }
    }

    private final class State {
        let sink: ((Frame) throws -> Void)?
        let onSinkError: ((Error) -> Void)?
        init(sink: ((Frame) throws -> Void)?, onSinkError: ((Error) -> Void)?) {
            self.sink = sink
            self.onSinkError = onSinkError
        }
    }

    private let stateLock = NSLock()
    /// Replaced wholesale, never mutated, so `offer` reads one reference under a short lock.
    private var state: State?
    private var generation: UInt64 = 0
    private var sink: ((Frame) throws -> Void)?
    private var onSinkError: ((Error) -> Void)?
    public private(set) var telemetryEnabled = false

    private let metricsLock = NSLock()
    private var framesOffered = 0
    private var framesWithSink = 0
    private var offerTotalNs: Int64 = 0
    private var offerMaxNs: Int64 = 0
    private var cadenceSamples = 0
    private var cadenceTotalNs: Int64 = 0
    private var cadenceMaxNs: Int64 = 0
    private var sinkExceptions = 0
    private var acsFramesSent = 0
    private var lastOfferAtNs: Int64 = 0

    private let clock: () -> Int64

    public init(clock: @escaping () -> Int64 = { Int64(DispatchTime.now().uptimeNanoseconds) }) {
        self.clock = clock
    }

    /// Install the sink and return the generation that owns it. `onSinkError` runs on the decoder
    /// thread after a thrown error has been caught and counted; it must only schedule work.
    @discardableResult
    public func attach(_ sink: @escaping (Frame) throws -> Void, onSinkError: ((Error) -> Void)? = nil) -> UInt64 {
        stateLock.lock()
        defer { stateLock.unlock() }
        generation &+= 1
        self.sink = sink
        self.onSinkError = onSinkError
        publishLocked()
        return generation
    }

    /// Remove the sink only if it is still the one `generation` installed.
    @discardableResult
    public func detach(generation: UInt64) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard generation == self.generation, sink != nil else { return false }
        sink = nil
        onSinkError = nil
        publishLocked()
        return true
    }

    public func isCurrent(generation: UInt64) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return generation == self.generation && sink != nil
    }

    public var hasSink: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return sink != nil
    }

    /// Collect cadence and offer cost even with no sink, so preview off/on can be compared.
    public func setTelemetryEnabled(_ enabled: Bool) {
        stateLock.lock()
        defer { stateLock.unlock() }
        telemetryEnabled = enabled
        publishLocked()
    }

    private func publishLocked() {
        let wasCollecting = state != nil
        state = (sink == nil && !telemetryEnabled) ? nil : State(sink: sink, onSinkError: onSinkError)
        if !wasCollecting, state != nil {
            // The first gap after collection resumes would span the whole idle period.
            metricsLock.lock()
            lastOfferAtNs = 0
            metricsLock.unlock()
        }
    }

    /// Read and clear the accumulated observations. Called about once a second by the reporter.
    public func drainMetrics() -> Metrics {
        metricsLock.lock()
        defer { metricsLock.unlock() }
        let snapshot = Metrics(
            framesOffered: framesOffered,
            framesWithSink: framesWithSink,
            offerTotalNs: offerTotalNs,
            offerMaxNs: offerMaxNs,
            cadenceSamples: cadenceSamples,
            cadenceTotalNs: cadenceTotalNs,
            cadenceMaxNs: cadenceMaxNs,
            sinkExceptions: sinkExceptions,
            acsFramesSent: acsFramesSent
        )
        framesOffered = 0
        framesWithSink = 0
        offerTotalNs = 0
        offerMaxNs = 0
        cadenceSamples = 0
        cadenceTotalNs = 0
        cadenceMaxNs = 0
        sinkExceptions = 0
        acsFramesSent = 0
        return snapshot
    }

    /// The ACS sender accepted a frame. Counted under the same gate as `offer`.
    public func recordAcsSend() {
        stateLock.lock()
        let collecting = state != nil
        stateLock.unlock()
        guard collecting else { return }
        metricsLock.lock()
        acsFramesSent += 1
        metricsLock.unlock()
    }

    /// Called on the decoder thread, immediately before the frame goes to ACS.
    public func offer(_ frame: Frame) {
        stateLock.lock()
        let current = state
        stateLock.unlock()
        guard let current else { return }

        let started = clock()
        var failure: Error?
        if let sink = current.sink {
            do {
                try sink(frame)
            } catch {
                failure = error
            }
        }
        let elapsed = clock() - started

        metricsLock.lock()
        framesOffered += 1
        if lastOfferAtNs > 0 {
            let gap = started - lastOfferAtNs
            cadenceSamples += 1
            cadenceTotalNs += gap
            if gap > cadenceMaxNs { cadenceMaxNs = gap }
        }
        lastOfferAtNs = started
        offerTotalNs += elapsed
        if elapsed > offerMaxNs { offerMaxNs = elapsed }
        if current.sink != nil { framesWithSink += 1 }
        if failure != nil { sinkExceptions += 1 }
        metricsLock.unlock()

        if let failure {
            current.onSinkError?(failure)
        }
    }
}
