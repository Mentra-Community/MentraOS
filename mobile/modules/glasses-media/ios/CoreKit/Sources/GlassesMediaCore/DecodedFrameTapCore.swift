import Foundation

/// Which pipeline decoded a frame offered to the tap.
///
/// Two decoders can run at once: a Teams call with Direct link off decodes the glasses stream for
/// ACS while the managed relay decodes the same stream to republish it. A sink names the one it
/// wants, so the picture on screen is always the one its lease was granted for.
public enum DecodedFrameProducer: String, Sendable {
    /// The decoder feeding the phone-native ACS meeting.
    case acs
    /// The decoder inside the managed glasses-to-Cloudflare relay.
    case relay
}

/// The frame-agnostic half of `DecodedFrameTap`: sink ownership, failure isolation and metrics.
///
/// The call owns the decoder; a preview sink is a guest. `offer` never lets a thrown error reach
/// the decoder thread, and with no sink attached and telemetry off it costs one uncontended lock
/// around a single reference load (Swift has no portable atomics for iOS 15).
/// A frame from a producer the sink did not ask for costs that same load plus one comparison.
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
        /// The only producer whose frames reach the sink and the metrics.
        let producer: DecodedFrameProducer
        init(sink: ((Frame) throws -> Void)?, onSinkError: ((Error) -> Void)?, producer: DecodedFrameProducer) {
            self.sink = sink
            self.onSinkError = onSinkError
            self.producer = producer
        }
    }

    private let stateLock = NSLock()
    /// Replaced wholesale, never mutated, so `offer` reads one reference under a short lock.
    private var state: State?
    private var generation: UInt64 = 0
    private var sink: ((Frame) throws -> Void)?
    private var onSinkError: ((Error) -> Void)?
    /// With no sink, telemetry measures the ACS call, as it did before producers existed.
    private var producer: DecodedFrameProducer = .acs
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

    /// Install the sink for one producer's frames and return the generation that owns it.
    /// `onSinkError` runs on the decoder thread after a thrown error has been caught and counted;
    /// it must only schedule work.
    @discardableResult
    public func attach(
        _ sink: @escaping (Frame) throws -> Void,
        producer: DecodedFrameProducer,
        onSinkError: ((Error) -> Void)? = nil
    ) -> UInt64 {
        stateLock.lock()
        defer { stateLock.unlock() }
        generation &+= 1
        self.sink = sink
        self.onSinkError = onSinkError
        self.producer = producer
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
        producer = .acs
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
        state = (sink == nil && !telemetryEnabled)
            ? nil
            : State(sink: sink, onSinkError: onSinkError, producer: producer)
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

    /// The managed relay's per-frame fan-out: the publisher first, the preview second.
    ///
    /// `publish` has returned before the preview is consulted, so nothing a preview does can
    /// delay, reorder or drop a frame on its way to the publisher. The preview's own share is
    /// `offer`, which contains a throwing sink and returns without doing real work.
    public func relay(_ frame: Frame, publish: (Frame) -> Void) {
        publish(frame)
        offer(frame, from: .relay)
    }

    /// Called on the decoder thread by the pipeline that decoded `frame`: the ACS source just
    /// before the frame goes to ACS, the relay just after it goes to the publisher.
    ///
    /// A frame from any producer other than the attached one is dropped here, uncounted, so a
    /// second decoder running beside the wanted one can neither reach the sink nor skew its metrics.
    public func offer(_ frame: Frame, from producer: DecodedFrameProducer) {
        stateLock.lock()
        let current = state
        stateLock.unlock()
        guard let current, current.producer == producer else { return }

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
