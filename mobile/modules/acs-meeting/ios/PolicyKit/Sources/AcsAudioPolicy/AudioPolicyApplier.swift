public protocol AudioStreamController {
  func readActive() -> ActiveStreamKind
  func isPhysicallyMuted() -> Bool?
  func setGlassesPcmEnabled(_ enabled: Bool)
  func mutePhysical() -> Result<Void, Error>
  func unmutePhysical() -> Result<Void, Error>
  func stopActive() -> Result<Void, Error>
}

public protocol PolicyScheduler: AnyObject {
  func schedule(delayMs: Int, task: @escaping () -> Void)
  func cancelPending()
}

public final class AudioPolicyApplier {
  public static let convergeDelaysMs = [50, 100, 200, 400, 800, 1600]

  private let controller: AudioStreamController
  private let scheduler: PolicyScheduler
  private let log: (String) -> Void
  private var generation: UInt64 = 0
  private var lastDecision: AudioPolicyDecision?
  private var lastSafetyValue: AudioSafety = .degraded

  public init(controller: AudioStreamController, scheduler: PolicyScheduler, log: @escaping (String) -> Void = { _ in }) {
    self.controller = controller
    self.scheduler = scheduler
    self.log = log
  }

  public func lastSafety() -> AudioSafety { lastSafetyValue }

  @discardableResult
  public func apply(desired: AudioSourceKind, userMuted: Bool, reason: String) -> AudioSafety {
    generation += 1
    scheduler.cancelPending()
    return runApply(desired: desired, userMuted: userMuted, reason: reason, gen: generation, force: false, armConvergence: true)
  }

  public func reset() {
    generation += 1
    scheduler.cancelPending()
    lastDecision = nil
    lastSafetyValue = .degraded
  }

  @discardableResult
  private func runApply(
    desired: AudioSourceKind,
    userMuted: Bool,
    reason: String,
    gen: UInt64,
    force: Bool,
    armConvergence: Bool
  ) -> AudioSafety {
    guard gen == generation else { return lastSafetyValue }
    let active = controller.readActive()
    let decision = AcsAudioPolicy.decide(desired: desired, active: active, userMuted: userMuted)
    let outcome = applyDecision(decision, force: force)
    guard gen == generation else { return lastSafetyValue }

    let after = controller.readActive()
    let expected = AcsAudioPolicy.expectedStream(desired)
    let safety = safetyOf(desired: desired, active: after, outcome: outcome)
    lastDecision = decision
    lastSafetyValue = safety
    log(
      "audio policy reason=\(reason) source=\(desired) userMuted=\(userMuted) active=\(after) expected=\(expected) glassesPcm=\(decision.glassesPcmEnabled) mute=\(decision.physicalMute) safety=\(safety)"
    )

    if after == expected {
      scheduler.cancelPending()
    } else if armConvergence && gen == generation {
      self.armConvergence(desired: desired, userMuted: userMuted, gen: gen, expected: expected)
    }
    return lastSafetyValue
  }

  private func armConvergence(desired: AudioSourceKind, userMuted: Bool, gen: UInt64, expected: ActiveStreamKind) {
    for (index, delayMs) in Self.convergeDelaysMs.enumerated() {
      scheduler.schedule(delayMs: delayMs) { [weak self] in
        guard let self, gen == self.generation else { return }
        let isLast = index == Self.convergeDelaysMs.count - 1
        _ = self.runApply(
          desired: desired,
          userMuted: userMuted,
          reason: "converge-\(delayMs)ms",
          gen: gen,
          force: true,
          armConvergence: false
        )
        if isLast && gen == self.generation && self.controller.readActive() != expected {
          self.log("audio policy convergence timed out source=\(desired) expected=\(expected) holding silence")
          self.lastSafetyValue = .degraded
        }
      }
    }
  }

  private func applyDecision(_ decision: AudioPolicyDecision, force: Bool) -> EffectOutcome {
    let previous = lastDecision
    let skipPcm = !force && previous?.glassesPcmEnabled == decision.glassesPcmEnabled
    let skipMute = !force && previous?.physicalMute == decision.physicalMute
    if !skipPcm {
      controller.setGlassesPcmEnabled(decision.glassesPcmEnabled)
    }
    if skipMute { return .none }

    switch decision.physicalMute {
    case .leaveAlone:
      return .none
    case .unmute:
      let result = controller.unmutePhysical()
      let unmuted = controller.isPhysicallyMuted()
      let failed = result.isFailure || unmuted == true
      return EffectOutcome(unmuteAttempted: true, unmuteFailed: failed)
    case .mute:
      let result = controller.mutePhysical()
      let muted = controller.isPhysicallyMuted()
      let muteFailed = result.isFailure || muted == false
      if !muteFailed { return EffectOutcome(muteAttempted: true) }
      let stop = controller.stopActive()
      let stopped = controller.readActive() == .none
      return EffectOutcome(
        muteAttempted: true,
        muteFailed: true,
        stopAttempted: true,
        stopFailed: stop.isFailure || !stopped
      )
    }
  }

  private func safetyOf(desired: AudioSourceKind, active: ActiveStreamKind, outcome: EffectOutcome) -> AudioSafety {
    if outcome.stopFailed { return .unsafe }
    if outcome.stopAttempted { return .safe }
    if outcome.unmuteFailed { return .degraded }
    if active != AcsAudioPolicy.expectedStream(desired) { return .degraded }
    return .safe
  }
}

private struct EffectOutcome {
  var muteAttempted = false
  var muteFailed = false
  var unmuteAttempted = false
  var unmuteFailed = false
  var stopAttempted = false
  var stopFailed = false
  static let none = EffectOutcome()
}

private extension Result {
  var isFailure: Bool {
    if case .failure = self { return true }
    return false
  }
}
