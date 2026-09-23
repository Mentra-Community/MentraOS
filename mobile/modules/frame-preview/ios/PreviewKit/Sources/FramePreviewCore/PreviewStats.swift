import Foundation

/// One ring's shape, produced by a single sort.
public struct PreviewDistribution: Equatable, Sendable {
  public let p50: Double
  public let p95: Double
  public let p99: Double
  public let max: Double
  public let count: Int

  public static let empty = PreviewDistribution(p50: 0, p95: 0, p99: 0, max: 0, count: 0)
}

/// Fixed-size sample ring with percentiles and a running maximum.
///
/// The capacity is part of the claim being made. At 30 fps a 64-sample ring only describes the
/// last two seconds, so a p95 read off it after a ten-minute soak is a two-second p95 wearing a
/// ten-minute label. 2048 samples is a little over a minute at 30 fps, which is the shortest run
/// the experiment reports on.
///
/// `maxMs` is deliberately not windowed: the worst frame of the run is the one that shows up as a
/// visible hitch, and a ring that has already lapped would have thrown it away.
public final class PreviewPercentileRing {
  private var samples: [Int64]
  private var count = 0
  private var index = 0
  private var maxNs: Int64 = 0

  public init(capacity: Int = 2048) {
    samples = [Int64](repeating: 0, count: max(capacity, 1))
  }

  public var sampleCount: Int { count }

  public var maxMs: Double { Double(maxNs) / 1_000_000.0 }

  public func record(_ valueNs: Int64) {
    samples[index] = valueNs
    index = (index + 1) % samples.count
    if count < samples.count { count += 1 }
    if valueNs > maxNs { maxNs = valueNs }
  }

  /// Every percentile from one sort.
  ///
  /// Reading p50, p95 and p99 as three separate calls sorts the ring three times, and the
  /// reporter reads seven rings every second. At 30 fps that is tens of thousands of needless
  /// comparisons per second on the same queue that packs frames — the measurement showing up
  /// inside the thing being measured.
  public func distribution() -> PreviewDistribution {
    guard count > 0 else { return .empty }
    let sorted = samples.prefix(count).sorted()
    func at(_ quantile: Double) -> Double {
      let position = Int((Double(sorted.count - 1) * quantile).rounded())
      return Double(sorted[min(max(position, 0), sorted.count - 1)]) / 1_000_000.0
    }
    return PreviewDistribution(p50: at(0.5), p95: at(0.95), p99: at(0.99), max: maxMs, count: count)
  }

  public func percentileMs(_ quantile: Double) -> Double {
    guard count > 0 else { return 0 }
    let sorted = samples.prefix(count).sorted()
    let position = Int((Double(sorted.count - 1) * quantile).rounded())
    let clamped = min(max(position, 0), sorted.count - 1)
    return Double(sorted[clamped]) / 1_000_000.0
  }

  public func reset() {
    count = 0
    index = 0
    maxNs = 0
  }
}

/// Counters for one preview subscription.
///
/// Every drop has its own counter on purpose: "delivered fps is low" is not a finding, but
/// "delivered is low because the pacer skipped, not because the consumer was busy" is.
///
/// The timing rings are split finer than they strictly need to be for the same reason. A single
/// `sendMs` would average an enqueue that returns immediately together with a copy that has not
/// happened yet, and the two platforms would then be reporting different things under one name.
public final class PreviewStats {
  public private(set) var sourceFrames: Int = 0
  public private(set) var admitted: Int = 0
  public private(set) var skippedPacing: Int = 0
  public private(set) var skippedBusy: Int = 0
  public private(set) var delivered: Int = 0
  public private(set) var payloadBytes: Int = 0
  public private(set) var ackTimeouts: Int = 0
  public private(set) var staleAcks: Int = 0
  public private(set) var unsupportedFormat: Int = 0
  public private(set) var transportErrors: Int = 0
  public private(set) var packFailures: Int = 0
  /// Frames refused on the decoder thread because the worker had not finished the previous one.
  /// Counted separately from `skippedBusy` so a decoder-side refusal is not confused with a
  /// consumer-side one; they have different fixes.
  public private(set) var preDispatchDrops: Int = 0
  /// The pack worker wanted a send buffer and both were still held by the transport.
  public private(set) var slotStarved: Int = 0

  /// Producing the source frame. Only the synthetic source pays this; a real decoder hands over
  /// a buffer it has already made. Kept apart from `pack` so a slow test pattern cannot be read
  /// as a slow pipeline.
  public let generate = PreviewPercentileRing()
  public let pack = PreviewPercentileRing()
  /// Time to hand the frame to the transport. On iOS this returns before the copy completes.
  public let sendEnqueue = PreviewPercentileRing()
  /// Time until the transport reports it is finished with our buffer. The honest send cost.
  public let sendComplete = PreviewPercentileRing()
  public let roundTrip = PreviewPercentileRing()
  /// Admission to the first instruction of the pack worker: the handoff cost, not the work.
  public let admitToPack = PreviewPercentileRing()
  /// Gap between consecutive delivered frames. Mean fps hides a 30/100 ms alternation; this does not.
  public let deliveryGap = PreviewPercentileRing()

  /// Start of run to first delivered frame, and to its acknowledgement. A slow cold start is
  /// invisible in steady-state fps but very visible to someone opening the panel.
  public private(set) var firstDeliveredLatencyMs: Double = 0
  public private(set) var firstAckLatencyMs: Double = 0

  // Optionals rather than a zero sentinel. A monotonic clock reading of exactly zero is unlikely
  // on a device but trivial in a test, and "not yet set" and "set to zero" have to stay distinct
  // or the first gap of every run goes unrecorded.
  private var runStartNs: Int64?
  private var lastDeliveredAtNs: Int64?
  private var hasFirstDelivered = false
  private var hasFirstAck = false

  /// Counters since the last `takeWindow`, so a 1 Hz report can show rates without the caller
  /// keeping its own deltas.
  private var windowSourceFrames = 0
  private var windowDelivered = 0
  private var windowPayloadBytes = 0
  private var windowStartNs: Int64?

  public init() {}

  public func onSourceFrame() { sourceFrames += 1; windowSourceFrames += 1 }
  public func onAdmitted() { admitted += 1 }
  public func onSkippedPacing() { skippedPacing += 1 }
  public func onSkippedBusy() { skippedBusy += 1 }
  public func onAckTimeout() { ackTimeouts += 1 }
  public func onStaleAck() { staleAcks += 1 }
  public func onUnsupportedFormat() { unsupportedFormat += 1 }
  public func onTransportError() { transportErrors += 1 }
  public func onPackFailure() { packFailures += 1 }
  public func onPreDispatchDrop() { preDispatchDrops += 1 }
  public func onSlotStarved() { slotStarved += 1 }

  /// Mark the beginning of a run so the first-frame latencies have an origin.
  ///
  /// This also restarts the rate window. Without that, the first second after a stop/start would
  /// be averaged over however long the preview sat idle and report a frame rate near zero.
  public func onRunStart(nowNs: Int64) {
    runStartNs = nowNs
    lastDeliveredAtNs = nil
    hasFirstDelivered = false
    hasFirstAck = false
    firstDeliveredLatencyMs = 0
    firstAckLatencyMs = 0
    windowStartNs = nowNs
    windowSourceFrames = 0
    windowDelivered = 0
    windowPayloadBytes = 0
  }

  public func onDelivered(bytes: Int, nowNs: Int64) {
    delivered += 1
    windowDelivered += 1
    payloadBytes += bytes
    windowPayloadBytes += bytes
    if let last = lastDeliveredAtNs {
      deliveryGap.record(nowNs - last)
    }
    lastDeliveredAtNs = nowNs
    if !hasFirstDelivered, let start = runStartNs {
      hasFirstDelivered = true
      firstDeliveredLatencyMs = Double(nowNs - start) / 1_000_000.0
    }
  }

  public func onAckAccepted(roundTripNs: Int64, nowNs: Int64) {
    roundTrip.record(roundTripNs)
    if !hasFirstAck, let start = runStartNs {
      hasFirstAck = true
      firstAckLatencyMs = Double(nowNs - start) / 1_000_000.0
    }
  }

  public struct Window {
    public let sourceFps: Double
    public let deliveredFps: Double
    public let bytesPerSecond: Double
  }

  /// Read and restart the rate window. Returns zeros for the first call of a subscription.
  public func takeWindow(nowNs: Int64) -> Window {
    defer {
      windowStartNs = nowNs
      windowSourceFrames = 0
      windowDelivered = 0
      windowPayloadBytes = 0
    }
    guard let start = windowStartNs, nowNs > start else {
      return Window(sourceFps: 0, deliveredFps: 0, bytesPerSecond: 0)
    }
    let seconds = Double(nowNs - start) / 1_000_000_000.0
    return Window(
      sourceFps: Double(windowSourceFrames) / seconds,
      deliveredFps: Double(windowDelivered) / seconds,
      bytesPerSecond: Double(windowPayloadBytes) / seconds
    )
  }

  public func reset(nowNs: Int64) {
    sourceFrames = 0
    admitted = 0
    skippedPacing = 0
    skippedBusy = 0
    delivered = 0
    payloadBytes = 0
    ackTimeouts = 0
    staleAcks = 0
    unsupportedFormat = 0
    transportErrors = 0
    packFailures = 0
    preDispatchDrops = 0
    slotStarved = 0
    generate.reset()
    pack.reset()
    sendEnqueue.reset()
    sendComplete.reset()
    roundTrip.reset()
    admitToPack.reset()
    deliveryGap.reset()
    firstDeliveredLatencyMs = 0
    firstAckLatencyMs = 0
    hasFirstDelivered = false
    hasFirstAck = false
    runStartNs = nowNs
    lastDeliveredAtNs = nil
    windowStartNs = nowNs
    windowSourceFrames = 0
    windowDelivered = 0
    windowPayloadBytes = 0
  }
}
