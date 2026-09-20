import Foundation

/// Fixed-size sample ring with percentiles, so a long soak cannot grow memory and a single
/// outlier cannot dominate a mean.
public final class PreviewPercentileRing {
  private var samples: [Int64]
  private var count = 0
  private var index = 0

  public init(capacity: Int = 64) {
    samples = [Int64](repeating: 0, count: max(capacity, 1))
  }

  public func record(_ valueNs: Int64) {
    samples[index] = valueNs
    index = (index + 1) % samples.count
    if count < samples.count { count += 1 }
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
  }
}

/// Counters for one preview subscription.
///
/// Every drop has its own counter on purpose: "delivered fps is low" is not a finding, but
/// "delivered is low because the pacer skipped, not because the consumer was busy" is.
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

  public let pack = PreviewPercentileRing()
  public let send = PreviewPercentileRing()
  public let roundTrip = PreviewPercentileRing()

  /// Counters since the last `takeWindow`, so a 1 Hz report can show rates without the caller
  /// keeping its own deltas.
  private var windowSourceFrames = 0
  private var windowDelivered = 0
  private var windowPayloadBytes = 0
  private var windowStartNs: Int64 = 0

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

  public func onDelivered(bytes: Int) {
    delivered += 1
    windowDelivered += 1
    payloadBytes += bytes
    windowPayloadBytes += bytes
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
    guard windowStartNs > 0, nowNs > windowStartNs else {
      return Window(sourceFps: 0, deliveredFps: 0, bytesPerSecond: 0)
    }
    let seconds = Double(nowNs - windowStartNs) / 1_000_000_000.0
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
    pack.reset()
    send.reset()
    roundTrip.reset()
    windowStartNs = nowNs
    windowSourceFrames = 0
    windowDelivered = 0
    windowPayloadBytes = 0
  }
}
