import CoreVideo
import Foundation

/// A second, optional consumer of decoded glasses video, sitting beside whoever decoded it: the
/// ACS sender, or the managed relay's publisher.
///
/// The call owns this pipeline; the preview is a guest. `offer` never blocks, never lets a thrown
/// error reach its caller, and never does real work — a sink may only decide whether it wants the
/// frame, retain it, and schedule bounded work elsewhere. The logic lives in
/// `DecodedFrameTapCore` so it can be unit tested without CoreVideo.
///
/// Detach is generation-checked because sessions overlap: a call ending late must not tear down
/// the subscription a newer call already installed.
public final class DecodedFrameTap {
    public static let shared = DecodedFrameTap()

    public typealias Metrics = DecodedFrameTapCore<CVPixelBuffer>.Metrics

    private let core = DecodedFrameTapCore<CVPixelBuffer>()

    public init() {}

    /// Install the preview sink for one producer's frames and return the generation that owns it.
    @discardableResult
    public func attach(
        _ sink: @escaping (CVPixelBuffer) throws -> Void,
        producer: DecodedFrameProducer,
        onSinkError: ((Error) -> Void)? = nil
    ) -> UInt64 {
        core.attach(sink, producer: producer, onSinkError: onSinkError)
    }

    /// Remove the sink only if it is still the one this generation installed.
    @discardableResult
    public func detach(generation: UInt64) -> Bool {
        core.detach(generation: generation)
    }

    public func isCurrent(generation: UInt64) -> Bool {
        core.isCurrent(generation: generation)
    }

    public var hasSink: Bool { core.hasSink }

    /// Collect cadence, offer cost and the ACS send count even with no sink attached.
    public func setTelemetryEnabled(_ enabled: Bool) {
        core.setTelemetryEnabled(enabled)
    }

    public var telemetryEnabled: Bool { core.telemetryEnabled }

    /// Read and clear the accumulated observations. Called about once a second by the reporter.
    public func drainMetrics() -> Metrics {
        core.drainMetrics()
    }

    /// The ACS sender accepted a frame. Called by acs-meeting right after a successful send.
    public func recordAcsSend() {
        core.recordAcsSend()
    }

    /// The managed relay's per-frame fan-out: hand `buffer` to the publisher, then offer it to a
    /// preview attached for relay frames. The buffer is only borrowed; a sink that wants it past
    /// this call retains it.
    public func relay(_ buffer: CVPixelBuffer, publish: (CVPixelBuffer) -> Void) {
        core.relay(buffer, publish: publish)
    }

    /// Called on the decoder's thread by the pipeline that decoded `buffer`. Only frames from the
    /// producer the sink attached for are delivered; the rest are dropped without being counted.
    public func offer(_ buffer: CVPixelBuffer, from producer: DecodedFrameProducer) {
        core.offer(buffer, from: producer)
    }
}
