import Foundation

/// One-frame credit and an absolute frame-rate schedule.
///
/// The failure this exists to prevent is a preview that keeps accepting frames a slow consumer
/// has not drawn yet: latency grows without bound and the wearer watches the past. So exactly one
/// frame may be in the pipeline at a time, and a frame is only admitted when the wall clock says
/// its slot is due. A slow consumer therefore lowers delivered fps; it never builds a queue.
///
/// The schedule is absolute (`nextDue += period`) rather than "wait one period after finishing",
/// which would add the consumer's latency to every interval and quietly halve the frame rate.
public enum PreviewAdmission: Equatable, Sendable {
  case admit(sequence: UInt32)
  /// Not yet due under the frame-rate schedule.
  case skipPacing
  /// A previous frame is still being packed or is still unacknowledged.
  case skipBusy
  /// Production is stopped, or no authenticated consumer holds credit.
  case notRunning
}

public enum PreviewAckResult: Equatable, Sendable {
  /// The acknowledgement matched the outstanding frame; the round trip is in nanoseconds.
  case accepted(roundTripNs: Int64)
  /// From a previous generation, a previous frame, or arriving with nothing outstanding.
  case stale
}

public final class PreviewPacer {
  private enum State: Equatable {
    case idle
    case packing(sequence: UInt32)
    case awaitingAck(sequence: UInt32, sentAtNs: Int64)
  }

  /// Default ack deadline. Generous next to a 15 fps period: this is the "the consumer is gone"
  /// line, not a pacing knob, and tripping it stops the subscription rather than minting credit.
  public static let defaultAckTimeoutNs: Int64 = 2_000_000_000

  public private(set) var generation: UInt32 = 0
  public private(set) var isRunning = false
  /// Set once a consumer has authenticated for the current document. Credit does not exist before.
  public private(set) var consumerReady = false

  private var state: State = .idle
  private var sequence: UInt32 = 0
  private var periodNs: Int64
  private var nextDueNs: Int64 = 0
  private let ackTimeoutNs: Int64

  public init(targetFps: Int, ackTimeoutNs: Int64 = PreviewPacer.defaultAckTimeoutNs) {
    periodNs = PreviewPacer.period(forFps: targetFps)
    self.ackTimeoutNs = ackTimeoutNs
  }

  public static func period(forFps fps: Int) -> Int64 {
    Int64(1_000_000_000 / max(fps, 1))
  }

  public var outstandingFrames: Int { state == .idle ? 0 : 1 }

  public func setTargetFps(_ fps: Int, nowNs: Int64) {
    periodNs = PreviewPacer.period(forFps: fps)
    nextDueNs = nowNs
  }

  /// A consumer authenticated for the current document. Only now can a frame be admitted.
  public func setConsumerReady(_ ready: Bool) {
    consumerReady = ready
    if !ready { state = .idle }
  }

  public func start(nowNs: Int64) {
    isRunning = true
    state = .idle
    nextDueNs = nowNs
  }

  /// Halt production. The transport and the consumer's authentication survive this by design, so
  /// a later `start` does not need another handshake.
  public func stop() {
    isRunning = false
    state = .idle
  }

  /// A new document invalidates every outstanding frame and every credit the old page held.
  @discardableResult
  public func beginGeneration() -> UInt32 {
    generation &+= 1
    sequence = 0
    state = .idle
    consumerReady = false
    return generation
  }

  public func admit(nowNs: Int64) -> PreviewAdmission {
    guard isRunning, consumerReady else { return .notRunning }
    guard state == .idle else { return .skipBusy }
    if nowNs < nextDueNs { return .skipPacing }
    advanceSchedule(nowNs: nowNs)
    sequence &+= 1
    state = .packing(sequence: sequence)
    return .admit(sequence: sequence)
  }

  /// The worker finished with an admitted frame. `sent == false` covers the diagnostic modes that
  /// never reach the transport, which return their own credit immediately.
  public func onPacked(sequence: UInt32, sent: Bool, nowNs: Int64) {
    guard case let .packing(pending) = state, pending == sequence else { return }
    state = sent ? .awaitingAck(sequence: sequence, sentAtNs: nowNs) : .idle
  }

  public func onAck(generation ackGeneration: UInt32, sequence ackSequence: UInt32, nowNs: Int64) -> PreviewAckResult {
    guard ackGeneration == generation,
          case let .awaitingAck(pending, sentAtNs) = state,
          pending == ackSequence
    else { return .stale }
    state = .idle
    return .accepted(roundTripNs: nowNs - sentAtNs)
  }

  /// True when the outstanding frame has gone unacknowledged past the deadline. The caller stops
  /// the subscription; it must not hand out a replacement credit.
  public func hasAckTimedOut(nowNs: Int64) -> Bool {
    guard case let .awaitingAck(_, sentAtNs) = state else { return false }
    return nowNs - sentAtNs > ackTimeoutNs
  }

  private func advanceSchedule(nowNs: Int64) {
    nextDueNs += periodNs
    // More than a whole period late (a stall, a thermal dip, a backgrounded app): resync instead
    // of trying to catch up, which would emit a burst the consumer never asked for.
    if nextDueNs <= nowNs { nextDueNs = nowNs + periodNs }
  }
}
