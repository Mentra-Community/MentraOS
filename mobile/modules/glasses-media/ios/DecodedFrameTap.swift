import CoreVideo
import Foundation

/// A second, optional consumer of decoded glasses video, sitting beside the ACS sender.
///
/// The call owns this pipeline; the preview is a guest. So `offer` never blocks, never throws
/// into its caller, and never does real work — a sink may only decide whether it wants the frame,
/// retain it, and schedule bounded work elsewhere. A preview that crashes, stalls, or falls
/// behind must cost the call nothing.
///
/// Detach is generation-checked because sessions overlap: a call ending late must not tear down
/// the subscription a newer call already installed.
///
/// ## Why the metrics live here
///
/// Every other counter in the experiment describes the preview. These describe the call, which is
/// the thing the decision actually turns on. Crucially the cadence counters run whether or not a
/// sink is installed: the question is what the decoder was doing *before* the preview attached,
/// and a counter that only ticks while attached cannot answer it. The cost of that is one
/// timestamp and one subtraction on the decode thread with no sink present.
public final class DecodedFrameTap {
  public static let shared = DecodedFrameTap()

  /// A snapshot of decoder-thread observations, drained by the reader.
  ///
  /// Sums rather than a percentile ring because this type cannot depend on the preview module,
  /// and because the two questions here are "is the mean cost negligible" and "was there ever a
  /// bad one" — a mean and a max answer both.
  public struct Metrics {
    public let framesOffered: Int
    public let framesWithSink: Int
    public let offerTotalNs: Int64
    public let offerMaxNs: Int64
    public let cadenceSamples: Int
    public let cadenceTotalNs: Int64
    public let cadenceMaxNs: Int64

    public var offerMeanUs: Double {
      framesWithSink > 0 ? Double(offerTotalNs) / Double(framesWithSink) / 1000.0 : 0
    }

    public var offerMaxUs: Double { Double(offerMaxNs) / 1000.0 }

    public var cadenceMeanMs: Double {
      cadenceSamples > 0 ? Double(cadenceTotalNs) / Double(cadenceSamples) / 1_000_000.0 : 0
    }

    public var cadenceMaxMs: Double { Double(cadenceMaxNs) / 1_000_000.0 }
  }

  private let lock = NSLock()
  private var sink: ((CVPixelBuffer) -> Void)?
  private var generation: UInt64 = 0

  private var framesOffered = 0
  private var framesWithSink = 0
  private var offerTotalNs: Int64 = 0
  private var offerMaxNs: Int64 = 0
  private var cadenceSamples = 0
  private var cadenceTotalNs: Int64 = 0
  private var cadenceMaxNs: Int64 = 0
  private var lastOfferAtNs: Int64 = 0

  public init() {}

  /// Install the preview sink and return the generation that owns it.
  @discardableResult
  public func attach(_ sink: @escaping (CVPixelBuffer) -> Void) -> UInt64 {
    lock.lock()
    defer { lock.unlock() }
    generation &+= 1
    self.sink = sink
    return generation
  }

  /// Remove the sink only if it is still the one this generation installed.
  public func detach(generation: UInt64) {
    lock.lock()
    defer { lock.unlock() }
    guard generation == self.generation else { return }
    sink = nil
  }

  public var hasSink: Bool {
    lock.lock()
    defer { lock.unlock() }
    return sink != nil
  }

  /// Read and clear the accumulated observations. Called about once a second by the reporter.
  public func drainMetrics() -> Metrics {
    lock.lock()
    defer {
      framesOffered = 0
      framesWithSink = 0
      offerTotalNs = 0
      offerMaxNs = 0
      cadenceSamples = 0
      cadenceTotalNs = 0
      cadenceMaxNs = 0
      lock.unlock()
    }
    return Metrics(
      framesOffered: framesOffered,
      framesWithSink: framesWithSink,
      offerTotalNs: offerTotalNs,
      offerMaxNs: offerMaxNs,
      cadenceSamples: cadenceSamples,
      cadenceTotalNs: cadenceTotalNs,
      cadenceMaxNs: cadenceMaxNs
    )
  }

  /// Called on the decoder's thread, immediately before the frame goes to ACS.
  public func offer(_ buffer: CVPixelBuffer) {
    let started = Int64(DispatchTime.now().uptimeNanoseconds)

    lock.lock()
    let sink = self.sink
    framesOffered += 1
    if lastOfferAtNs > 0 {
      let gap = started - lastOfferAtNs
      cadenceSamples += 1
      cadenceTotalNs += gap
      if gap > cadenceMaxNs { cadenceMaxNs = gap }
    }
    lastOfferAtNs = started
    lock.unlock()

    guard let sink else { return }
    sink(buffer)

    let elapsed = Int64(DispatchTime.now().uptimeNanoseconds) - started
    lock.lock()
    framesWithSink += 1
    offerTotalNs += elapsed
    if elapsed > offerMaxNs { offerMaxNs = elapsed }
    lock.unlock()
  }
}
