@testable import MentraBluetoothSDK
import XCTest

/// Table tests for the iOS audio-setup rules (Android reports `not_applicable` while ready).
final class GlassesAudioSetupPolicyTests: XCTestCase {
    private typealias Policy = GlassesAudioSetupPolicy
    private let t0 = 1_000_000

    private func inputs(
        ready: Bool = true,
        report: (a2dp: Bool, hfp: Bool)? = nil,
        phone: Bool = false,
        phase: GlassesAudioSetupPhase = .reconnect,
        startedAt: Int? = nil
    ) -> GlassesAudioSetupInputs {
        GlassesAudioSetupInputs(
            sessionReady: ready,
            glassesReportsClassicLink: report != nil,
            glassesA2dp: report?.a2dp ?? false,
            glassesHfp: report?.hfp ?? false,
            phoneAudioUp: phone,
            phase: phase,
            phaseStartedAtMs: startedAt ?? t0
        )
    }

    private func state(_ inputs: GlassesAudioSetupInputs, at offsetMs: Int) -> GlassesAudioSetupState {
        Policy.decide(inputs, nowMs: t0 + offsetMs).state
    }

    func testConstantsMatchTheContract() {
        XCTAssertEqual(Policy.pairingAutoAudioWaitMs, 8000)
        XCTAssertEqual(Policy.reconnectAudioGraceMs, 10000)
    }

    func testNoSessionIsIdle() {
        XCTAssertEqual(
            Policy.decide(inputs(ready: false, report: (true, true), phone: true), nowMs: t0),
            GlassesAudioSetupDecision(state: .idle, nextDeadlineMs: nil)
        )
    }

    func testPairingWithAutoAudioWaitsEightSecondsThenNeedsTheUser() {
        let pairing = inputs(phase: .pairing(autoAudio: true))
        XCTAssertEqual(
            Policy.decide(pairing, nowMs: t0),
            GlassesAudioSetupDecision(state: .connecting, nextDeadlineMs: t0 + 8000)
        )
        XCTAssertEqual(state(pairing, at: 7999), .connecting)
        XCTAssertEqual(state(pairing, at: 8000), .needsUserConnectInSettings)
    }

    func testPairingWithoutAutoAudioNeedsTheUserAtOnce() {
        XCTAssertEqual(
            Policy.decide(inputs(phase: .pairing(autoAudio: false)), nowMs: t0),
            GlassesAudioSetupDecision(state: .needsUserConnectInSettings, nextDeadlineMs: nil)
        )
    }

    func testReconnectWaitsTenSecondsThenNeedsTheUser() {
        let reconnect = inputs(phase: .reconnect)
        XCTAssertEqual(
            Policy.decide(reconnect, nowMs: t0 + 1000),
            GlassesAudioSetupDecision(state: .connecting, nextDeadlineMs: t0 + 10000)
        )
        XCTAssertEqual(state(reconnect, at: 9999), .connecting)
        XCTAssertEqual(state(reconnect, at: 10000), .needsUserConnectInSettings)
    }

    func testEitherAudioSourceIsEnoughInEveryPhase() {
        for phase in [GlassesAudioSetupPhase.pairing(autoAudio: true), .pairing(autoAudio: false), .reconnect] {
            for offset in [0, 30000] {
                XCTAssertEqual(state(inputs(phone: true, phase: phase), at: offset), .connected, "phone \(phase)")
                XCTAssertEqual(state(inputs(report: (true, false), phase: phase), at: offset), .connected, "a2dp \(phase)")
                XCTAssertEqual(state(inputs(report: (false, true), phase: phase), at: offset), .connected, "hfp \(phase)")
            }
        }
        XCTAssertEqual(Policy.decide(inputs(phone: true), nowMs: t0).nextDeadlineMs, nil)
    }

    func testAGlassesReportOfBothLinksDownNeverShortensTheWait() {
        let down = inputs(report: (false, false), phase: .pairing(autoAudio: true))
        XCTAssertEqual(state(down, at: 1), .connecting)
        XCTAssertEqual(Policy.decide(down, nowMs: t0 + 1).nextDeadlineMs, t0 + 8000)
        XCTAssertEqual(state(inputs(report: (false, false), phase: .reconnect), at: 9000), .connecting)
    }

    func testABothDownReportDoesNotVetoThePhone() {
        XCTAssertEqual(state(inputs(report: (false, false), phone: true), at: 0), .connected)
    }

    func testTheGlassesReportArrivingBeforeThePhoneSignals() {
        var tracker = GlassesAudioSetupTracker()
        tracker.startPhase(.pairing(autoAudio: true), nowMs: t0)
        tracker.classicLink(a2dp: true, hfp: true)
        XCTAssertEqual(tracker.evaluate(sessionReady: true, phoneAudioUp: false, nowMs: t0 + 100).state, .connected)
        // The phone's route catches up later: still connected, nothing to re-arm.
        XCTAssertEqual(
            tracker.evaluate(sessionReady: true, phoneAudioUp: true, nowMs: t0 + 900),
            GlassesAudioSetupDecision(state: .connected, nextDeadlineMs: nil)
        )
    }

    func testTheGlassesReportArrivingAfterThePhoneSignals() {
        var tracker = GlassesAudioSetupTracker()
        tracker.startPhase(.reconnect, nowMs: t0)
        XCTAssertEqual(tracker.evaluate(sessionReady: true, phoneAudioUp: true, nowMs: t0 + 100).state, .connected)
        // The glasses then report both down (for example A2DP closing while HFP reconnects).
        // The phone still sees audio, so the state stays connected.
        tracker.classicLink(a2dp: false, hfp: false)
        XCTAssertEqual(tracker.evaluate(sessionReady: true, phoneAudioUp: true, nowMs: t0 + 200).state, .connected)
    }

    func testAReportAfterNeedsUserMovesToConnected() {
        var tracker = GlassesAudioSetupTracker()
        tracker.startPhase(.pairing(autoAudio: false), nowMs: t0)
        XCTAssertEqual(tracker.evaluate(sessionReady: true, phoneAudioUp: false, nowMs: t0).state, .needsUserConnectInSettings)
        tracker.classicLink(a2dp: false, hfp: true)
        XCTAssertEqual(tracker.evaluate(sessionReady: true, phoneAudioUp: false, nowMs: t0 + 60000).state, .connected)
    }

    func testLosingAudioAfterConnectedStartsTheReconnectWaitAgain() {
        var tracker = GlassesAudioSetupTracker()
        tracker.startPhase(.pairing(autoAudio: false), nowMs: t0)
        XCTAssertEqual(tracker.evaluate(sessionReady: true, phoneAudioUp: true, nowMs: t0 + 500).state, .connected)

        let lostAt = t0 + 60000
        XCTAssertEqual(
            tracker.evaluate(sessionReady: true, phoneAudioUp: false, nowMs: lostAt),
            GlassesAudioSetupDecision(state: .connecting, nextDeadlineMs: lostAt + 10000)
        )
        XCTAssertEqual(tracker.phase, .reconnect)
        XCTAssertEqual(tracker.phaseStartedAtMs, lostAt)
        XCTAssertEqual(tracker.evaluate(sessionReady: true, phoneAudioUp: false, nowMs: lostAt + 9999).state, .connecting)
        XCTAssertEqual(
            tracker.evaluate(sessionReady: true, phoneAudioUp: false, nowMs: lostAt + 10000).state,
            .needsUserConnectInSettings
        )
    }

    func testPairingProtocolGlassesNeverAskTheUserAfterSetup() {
        var tracker = GlassesAudioSetupTracker()
        tracker.startPhase(.reconnect, nowMs: t0)
        tracker.classicLink(a2dp: true, hfp: true)
        XCTAssertEqual(tracker.evaluate(sessionReady: true, phoneAudioUp: false, nowMs: t0).state, .connected)
        tracker.classicLink(a2dp: false, hfp: false)
        XCTAssertEqual(
            tracker.evaluate(sessionReady: true, phoneAudioUp: false, nowMs: t0 + 3_600_000),
            GlassesAudioSetupDecision(state: .connecting, nextDeadlineMs: nil)
        )
    }

    func testPairingProtocolGlassesStillAskWhenAudioNeverCameUpAfterPairing() {
        let pairing = inputs(report: (false, false), phase: .pairing(autoAudio: true))
        XCTAssertEqual(state(pairing, at: 7999), .connecting)
        XCTAssertEqual(state(pairing, at: 8000), .needsUserConnectInSettings)
    }

    func testASessionDropIsIdleAndForgetsTheGlassesReport() {
        var tracker = GlassesAudioSetupTracker()
        tracker.startPhase(.reconnect, nowMs: t0)
        tracker.classicLink(a2dp: true, hfp: false)
        XCTAssertEqual(tracker.evaluate(sessionReady: true, phoneAudioUp: false, nowMs: t0).state, .connected)

        tracker.endSession()
        XCTAssertEqual(
            tracker.evaluate(sessionReady: false, phoneAudioUp: false, nowMs: t0 + 1000),
            GlassesAudioSetupDecision(state: .idle, nextDeadlineMs: nil)
        )
        XCTAssertFalse(tracker.glassesReportsClassicLink)

        // The next session has not reported its link yet.
        tracker.startPhase(.reconnect, nowMs: t0 + 2000)
        XCTAssertEqual(tracker.evaluate(sessionReady: true, phoneAudioUp: false, nowMs: t0 + 2000).state, .connecting)
    }

    func testMapEncodingMatchesTheContract() {
        XCTAssertEqual(GlassesAudioSetupState.idle.toMap() as NSDictionary, ["state": "idle"])
        XCTAssertEqual(GlassesAudioSetupState.notApplicable.toMap() as NSDictionary, ["state": "not_applicable"])
        XCTAssertEqual(GlassesAudioSetupState.connecting.toMap() as NSDictionary, ["state": "connecting"])
        XCTAssertEqual(GlassesAudioSetupState.connected.toMap() as NSDictionary, ["state": "connected"])
        XCTAssertEqual(
            GlassesAudioSetupState.needsUserConnectInSettings.toMap() as NSDictionary,
            ["state": "needs_user", "action": "connect_in_settings"]
        )
        for state in [GlassesAudioSetupState.idle, .notApplicable, .connecting, .connected, .needsUserConnectInSettings] {
            XCTAssertEqual(GlassesAudioSetupState(map: state.toMap()), state)
        }
        XCTAssertNil(GlassesAudioSetupState(map: ["state": "unknown"]))
        XCTAssertNil(GlassesAudioSetupState(map: nil))
    }

    func testModelsWithoutADriverRuleAreNotApplicableWhileReady() {
        XCTAssertEqual(GlassesAudioSetupState.modelDefault(ready: true), .notApplicable)
        XCTAssertEqual(GlassesAudioSetupState.modelDefault(ready: false), .idle)
    }
}
