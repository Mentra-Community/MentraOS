import XCTest
@testable import AcsAudioPolicy

final class AcsAudioPolicyTests: XCTestCase {
  func testTwelveStates() {
    let rows: [(AudioSourceKind, ActiveStreamKind, Bool, Bool, Bool, PhysicalMuteAction)] = [
      (.glasses, .virtual, false, true, false, .leaveAlone),
      (.glasses, .virtual, true, false, false, .leaveAlone),
      (.glasses, .local, false, false, false, .mute),
      (.glasses, .local, true, false, false, .mute),
      (.glasses, .none, false, false, false, .leaveAlone),
      (.glasses, .none, true, false, false, .leaveAlone),
      (.phone, .local, false, false, false, .unmute),
      (.phone, .local, true, false, false, .mute),
      (.phone, .virtual, false, false, true, .leaveAlone),
      (.phone, .virtual, true, false, false, .leaveAlone),
      (.phone, .none, false, false, false, .leaveAlone),
      (.phone, .none, true, false, false, .leaveAlone),
    ]
    XCTAssertEqual(rows.count, 12)
    for row in rows {
      let decision = AcsAudioPolicy.decide(desired: row.0, active: row.1, userMuted: row.2)
      XCTAssertEqual(decision.glassesPcmEnabled, row.3, "\(row)")
      XCTAssertEqual(decision.phonePcmEnabled, row.4, "\(row)")
      XCTAssertEqual(decision.physicalMute, row.5, "\(row)")
    }
  }

  func testCartesianInvariants() {
    for desired in AudioSourceKind.allCases {
      for active in ActiveStreamKind.allCases {
        for userMuted in [false, true] {
          let decision = AcsAudioPolicy.decide(desired: desired, active: active, userMuted: userMuted)
          if decision.glassesPcmEnabled {
            XCTAssertEqual(active, .virtual)
            XCTAssertEqual(desired, .glasses)
            XCTAssertFalse(userMuted)
          }
          if decision.phonePcmEnabled {
            XCTAssertEqual(active, .virtual)
            XCTAssertEqual(desired, .phone)
            XCTAssertFalse(userMuted)
          }
          if decision.physicalMute == .unmute {
            XCTAssertEqual(active, .local)
            XCTAssertEqual(desired, .phone)
            XCTAssertFalse(userMuted)
          }
        }
      }
    }
  }

  func testPlanJoinMatrix() {
    for desired in AudioSourceKind.allCases {
      for userMuted in [false, true] {
        for flag in [false, true] {
          let plan = AcsAudioPolicy.planJoin(
            desired: desired,
            userMuted: userMuted,
            glassesRequiresUnmutedTransport: flag
          )
          XCTAssertTrue(plan.armVirtual)
          if desired == .phone {
            XCTAssertFalse(plan.transportMuted)
          } else if flag {
            XCTAssertFalse(plan.transportMuted)
          } else {
            XCTAssertEqual(plan.transportMuted, userMuted)
          }
        }
      }
    }
  }

  func testParseSourceAllowlist() {
    XCTAssertEqual(AcsAudioPolicy.parseSource("glasses"), .glasses)
    XCTAssertEqual(AcsAudioPolicy.parseSource("phone"), .phone)
    XCTAssertNil(AcsAudioPolicy.parseSource("bluetooth"))
    XCTAssertNil(AcsAudioPolicy.parseSource(nil))
  }

  func testCallGuardNullIsFailure() {
    let missing: String? = nil
    switch CallGuard.require(missing) {
    case .success:
      XCTFail("null call must not succeed")
    case .failure:
      break
    }
  }
}

final class FakeScheduler: PolicyScheduler {
  struct Job {
    var atMs: Int
    var task: () -> Void
  }

  var nowMs = 0
  private var jobs: [Job] = []

  func schedule(delayMs: Int, task: @escaping () -> Void) {
    jobs.append(Job(atMs: nowMs + delayMs, task: task))
  }

  func cancelPending() {
    jobs.removeAll()
  }

  func advanceTo(_ targetMs: Int) {
    while let nextIndex = jobs.enumerated().filter({ $0.element.atMs <= targetMs }).min(by: { $0.element.atMs < $1.element.atMs })?.offset {
      let next = jobs.remove(at: nextIndex)
      nowMs = next.atMs
      next.task()
    }
    nowMs = targetMs
  }
}

final class FakeController: AudioStreamController {
  var active: ActiveStreamKind = .none
  var physicallyMuted: Bool? = true
  var glassesPcmEnabled = false
  var phonePcmEnabled = false
  var muteResult: Result<Void, Error> = .success(())
  var unmuteResult: Result<Void, Error> = .success(())
  var stopResult: Result<Void, Error> = .success(())
  var muteSetsFlag = true
  var muteCalls = 0
  var unmuteCalls = 0
  var stopCalls = 0

  func readActive() -> ActiveStreamKind { active }
  func isPhysicallyMuted() -> Bool? { physicallyMuted }
  func setGlassesPcmEnabled(_ enabled: Bool) { glassesPcmEnabled = enabled }
  func setPhonePcmEnabled(_ enabled: Bool) { phonePcmEnabled = enabled }
  func mutePhysical() -> Result<Void, Error> {
    muteCalls += 1
    if case .success = muteResult, muteSetsFlag { physicallyMuted = true }
    return muteResult
  }
  func unmutePhysical() -> Result<Void, Error> {
    unmuteCalls += 1
    if case .success = unmuteResult { physicallyMuted = false }
    return unmuteResult
  }
  func stopActive() -> Result<Void, Error> {
    stopCalls += 1
    if case .success = stopResult { active = .none }
    return stopResult
  }
}

final class AudioPolicyApplierTests: XCTestCase {
  func testNoneNoneVirtualOpensOnThirdObservation() {
    let controller = FakeController()
    let scheduler = FakeScheduler()
    let applier = AudioPolicyApplier(controller: controller, scheduler: scheduler)
    controller.active = .none
    _ = applier.apply(desired: .glasses, userMuted: false, reason: "join")
    XCTAssertFalse(controller.glassesPcmEnabled)
    scheduler.advanceTo(50)
    XCTAssertFalse(controller.glassesPcmEnabled)
    controller.active = .virtual
    scheduler.advanceTo(100)
    XCTAssertTrue(controller.glassesPcmEnabled)
    XCTAssertFalse(controller.phonePcmEnabled)
    XCTAssertEqual(applier.lastSafety(), .safe)
    XCTAssertEqual(controller.unmuteCalls, 0)
  }

  func testNoneNoneVirtualOpensPhonePcmOnThirdObservation() {
    let controller = FakeController()
    let scheduler = FakeScheduler()
    let applier = AudioPolicyApplier(controller: controller, scheduler: scheduler)
    controller.active = .none
    _ = applier.apply(desired: .phone, userMuted: false, reason: "join")
    XCTAssertFalse(controller.phonePcmEnabled)
    scheduler.advanceTo(50)
    XCTAssertFalse(controller.phonePcmEnabled)
    controller.active = .virtual
    scheduler.advanceTo(100)
    XCTAssertTrue(controller.phonePcmEnabled)
    XCTAssertFalse(controller.glassesPcmEnabled)
    XCTAssertEqual(applier.lastSafety(), .safe)
    XCTAssertEqual(controller.unmuteCalls, 0)
  }

  func testMuteFailureEscalatesToStop() {
    let controller = FakeController()
    let scheduler = FakeScheduler()
    let applier = AudioPolicyApplier(controller: controller, scheduler: scheduler)
    controller.active = .local
    controller.physicallyMuted = false
    controller.muteResult = .failure(CallMissingError())
    let safety = applier.apply(desired: .phone, userMuted: true, reason: "set-muted")
    XCTAssertEqual(controller.stopCalls, 1)
    XCTAssertEqual(controller.active, .none)
    XCTAssertEqual(safety, .safe)
  }

  func testApplyTwiceDoesNotRepeatUnmute() {
    let controller = FakeController()
    let scheduler = FakeScheduler()
    let applier = AudioPolicyApplier(controller: controller, scheduler: scheduler)
    controller.active = .local
    controller.physicallyMuted = true
    _ = applier.apply(desired: .phone, userMuted: false, reason: "join")
    _ = applier.apply(desired: .phone, userMuted: false, reason: "call-connected")
    XCTAssertEqual(controller.unmuteCalls, 1)
  }
}

final class FakeGlassesMediaSource: GlassesMediaSource {
  var started: [SourceConfig] = []
  var restarted: [SourceConfig] = []
  var stopped = 0
  var pcmDeliveryEnabled = true
  var pcmHandler: ((Data, Int, Int) -> Void)?
  private(set) var state: SourceState = .idle

  func start(config: SourceConfig) {
    started.append(config)
    state = .live
  }

  func restart(config: SourceConfig) {
    restarted.append(config)
    start(config: config)
  }

  func stop() {
    stopped += 1
    state = .idle
  }

  func setPcmDeliveryEnabled(_ enabled: Bool) {
    pcmDeliveryEnabled = enabled
  }

  func emitPcm(_ data: Data) {
    guard pcmDeliveryEnabled, state == .live else { return }
    pcmHandler?(data, 16_000, 1)
  }
}

final class GlassesMediaSourceTests: XCTestCase {
  func testControllerStartRestartStopAndPcmGate() {
    let source = FakeGlassesMediaSource()
    var pcm: [Data] = []
    source.pcmHandler = { data, _, _ in pcm.append(data) }
    let controller = GlassesMediaController { source }
    XCTAssertEqual(controller.state, .idle)
    controller.attach(config: SourceConfig(url: "https://example.com/whep"))
    XCTAssertEqual(source.started.map(\.url), ["https://example.com/whep"])
    XCTAssertEqual(controller.state, .live)
    source.emitPcm(Data([1, 2, 3, 4]))
    XCTAssertEqual(pcm.count, 1)
    controller.setPcmDeliveryEnabled(false)
    source.emitPcm(Data([9, 9]))
    XCTAssertEqual(pcm.count, 1)
    controller.restart(config: SourceConfig(url: "https://example.com/whep-2"))
    XCTAssertEqual(source.restarted.map(\.url), ["https://example.com/whep-2"])
    controller.stop()
    XCTAssertEqual(controller.state, .idle)
  }

  func testCapturePolicyMatchesAcsSource() {
    XCTAssertTrue(CapturePolicy.captureGlassesMic(.glasses))
    XCTAssertFalse(CapturePolicy.captureGlassesMic(.phone))
  }
}
