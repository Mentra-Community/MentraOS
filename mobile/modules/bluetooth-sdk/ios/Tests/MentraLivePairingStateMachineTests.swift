@testable import MentraBluetoothSDK
import XCTest

/// Mirrors Android `MentraLivePairingStateMachineTest` input for input.
final class MentraLivePairingStateMachineTests: XCTestCase {
    private typealias Machine = MentraLivePairingStateMachine
    private let t0 = 1_700_000_000_000
    private let device = "MENTRA_LIVE_BLE_ABCD"

    @discardableResult
    private func enter(
        _ machine: inout Machine,
        windowId: Int? = 7,
        windowMs: Int? = 120_000,
        ownerRetained: Bool = true,
        explicit: Bool = false,
        now: Int? = nil
    ) -> MentraLivePairingTransition {
        machine.onEnteringPairingMode(
            windowMs: windowMs,
            windowId: windowId,
            ownerRetained: ownerRetained,
            explicitAttempt: explicit,
            deviceId: device,
            nowMs: now ?? t0
        )
    }

    private func pausedMachine(windowId: Int = 7) -> Machine {
        var machine = Machine()
        enter(&machine, windowId: windowId)
        return machine
    }

    private func reject(_ machine: inout Machine, _ now: Int, explicit: Bool = false) -> MentraLivePairingTransition {
        machine.onAuthRejection(secureFirmware: true, explicitAttempt: explicit, nowMs: now)
    }

    func testV4NoticePausesForTheWindowPlusMarginWithoutA300sClamp() {
        var machine = Machine()
        XCTAssertEqual(enter(&machine).effect, .pause)
        XCTAssertEqual(machine.state, .pairingMode(windowId: 7, endsAtMs: t0 + 150_000))
        XCTAssertFalse(machine.allowsAutomaticReconnect)
        XCTAssertEqual(machine.remainingPauseMs(nowMs: t0), 150_000)

        var long = Machine()
        enter(&long, windowMs: 900_000)
        XCTAssertEqual(long.state, .pairingMode(windowId: 7, endsAtMs: t0 + 930_000))
    }

    func testPublicStateMapsMatchTheTypeScriptContract() {
        XCTAssertEqual(MentraLivePairingState.normal.toMap() as NSDictionary, ["state": "normal"])
        XCTAssertEqual(MentraLivePairingState.rejected.toMap() as NSDictionary, ["state": "pairing_rejected"])
        XCTAssertEqual(
            MentraLivePairingState.pairingMode(windowId: 7, endsAtMs: t0).toMap() as NSDictionary,
            ["state": "pairing_mode", "windowId": 7, "endsAtMs": t0]
        )
    }

    func testADuplicateNoticeForTheSameWindowIsIgnored() {
        var machine = pausedMachine()
        XCTAssertEqual(enter(&machine, now: t0 + 5_000).effect, MentraLivePairingEffect.none)
        XCTAssertEqual(machine.state, .pairingMode(windowId: 7, endsAtMs: t0 + 150_000))
    }

    func testAnExplicitAttemptIsNeverPausedByTheNotice() {
        var machine = Machine()
        XCTAssertEqual(enter(&machine, explicit: true).effect, MentraLivePairingEffect.none)
        XCTAssertEqual(machine.state, .normal)
    }

    func testFlagOffFirmwareForgetsThisPhoneOnEntry() {
        var machine = Machine()
        XCTAssertEqual(enter(&machine, windowId: nil, ownerRetained: false).effect, .reject)
        XCTAssertEqual(machine.state, .rejected)

        var pairing = Machine()
        enter(&pairing, windowId: nil, ownerRetained: false, explicit: true)
        XCTAssertEqual(pairing.state, .normal)
    }

    func testPairingModeEndedResumesEarlyForTheMatchingWindowOnly() {
        var machine = pausedMachine()
        XCTAssertEqual(machine.onPairingModeEnded(reason: "timeout", windowId: 8).effect, MentraLivePairingEffect.none)
        XCTAssertTrue(machine.isPaused)
        XCTAssertEqual(machine.onPairingModeEnded(reason: "paired", windowId: 7).effect, .resume)
        XCTAssertEqual(machine.state, .normal)
        // The connected phone was admitted, so there is nothing to verify.
        XCTAssertNil(machine.endedWindowId)
    }

    func testAClearedAdvertisementFlagResumesEarlyAfterTheGrace() {
        var machine = pausedMachine()
        // An advertisement from before the window opened can still be in flight.
        let early = machine.onAdvertisement(pairingMode: false, ownerChanged: false, generation: 6, nowMs: t0 + 1_000)
        XCTAssertEqual(early.effect, MentraLivePairingEffect.none)
        XCTAssertTrue(machine.isPaused)
        XCTAssertEqual(
            machine.onAdvertisement(pairingMode: true, ownerChanged: false, generation: 7, nowMs: t0 + 20_000).effect,
            MentraLivePairingEffect.none
        )
        let cleared = machine.onAdvertisement(pairingMode: false, ownerChanged: false, generation: 7, nowMs: t0 + 60_000)
        XCTAssertEqual(cleared.effect, .resume)
        XCTAssertEqual(machine.state, .normal)
        XCTAssertEqual(machine.endedWindowId, 7)
    }

    func testTheDeadlineResumes() {
        var machine = pausedMachine()
        XCTAssertEqual(machine.onTick(nowMs: t0 + 149_999).effect, MentraLivePairingEffect.none)
        XCTAssertEqual(machine.onTick(nowMs: t0 + 150_000).effect, .resume)
        XCTAssertTrue(machine.allowsAutomaticReconnect)
        XCTAssertTrue(machine.awaitingTakeoverCheck)
    }

    func testOwnerChangedForTheEndedWindowRejectsOnTheFirstFailedVerification() {
        var machine = pausedMachine()
        machine.onTick(nowMs: t0 + 150_000)
        machine.onAdvertisement(pairingMode: false, ownerChanged: true, generation: 7, nowMs: t0 + 151_000)
        XCTAssertTrue(machine.verificationArmed)
        XCTAssertFalse(machine.awaitingTakeoverCheck)
        XCTAssertEqual(reject(&machine, t0 + 152_000).effect, .reject)
        XCTAssertEqual(machine.state, .rejected)
    }

    func testOwnerChangedCarriedOnTheFlagClearingAdvertisementArmsTheVerification() {
        var machine = pausedMachine()
        let cleared = machine.onAdvertisement(pairingMode: false, ownerChanged: true, generation: 7, nowMs: t0 + 60_000)
        XCTAssertEqual(cleared.effect, .resume)
        XCTAssertTrue(machine.verificationArmed)
    }

    func testASpoofedOwnerChangedBitFollowedByASuccessfulReconnectDoesNotStrandThePhone() {
        var machine = pausedMachine()
        machine.onTick(nowMs: t0 + 150_000)
        machine.onAdvertisement(pairingMode: false, ownerChanged: true, generation: 7, nowMs: t0 + 151_000)
        XCTAssertTrue(machine.verificationArmed)
        machine.onSessionReady(explicitAttempt: false)
        XCTAssertEqual(machine.state, .normal)
        XCTAssertFalse(machine.verificationArmed)
        // The same bit again arms nothing: exactly one verification per window.
        machine.onAdvertisement(pairingMode: false, ownerChanged: true, generation: 7, nowMs: t0 + 200_000)
        XCTAssertFalse(machine.verificationArmed)
        XCTAssertEqual(reject(&machine, t0 + 201_000).effect, MentraLivePairingEffect.none)
        XCTAssertEqual(machine.state, .normal)
    }

    func testOwnerChangedForAnotherWindowOrStillInPairingModeArmsNothing() {
        var other = pausedMachine()
        other.onTick(nowMs: t0 + 150_000)
        other.onAdvertisement(pairingMode: false, ownerChanged: true, generation: 9, nowMs: t0 + 151_000)
        XCTAssertFalse(other.verificationArmed)

        var stillPairing = pausedMachine()
        stillPairing.onAdvertisement(pairingMode: true, ownerChanged: true, generation: 7, nowMs: t0 + 60_000)
        XCTAssertFalse(stillPairing.verificationArmed)

        // Without a window this phone paused for, the bit is not this phone's business.
        var idle = Machine()
        idle.onAdvertisement(pairingMode: false, ownerChanged: true, generation: 7, nowMs: t0)
        XCTAssertFalse(idle.verificationArmed)
    }

    func testAVerificationThatFailsWithoutAnAuthVerdictFallsBackToTheStreak() {
        var machine = pausedMachine()
        machine.onTick(nowMs: t0 + 150_000)
        machine.onAdvertisement(pairingMode: false, ownerChanged: true, generation: 7, nowMs: t0 + 151_000)
        machine.onConnectAttemptFailed()
        XCTAssertFalse(machine.verificationArmed)
        XCTAssertEqual(reject(&machine, t0 + 160_000).effect, MentraLivePairingEffect.none)
        XCTAssertEqual(machine.state, .normal)
    }

    func testWithoutTheBitThreeRejectionsSpanningTheMinimumReject() {
        var machine = Machine()
        XCTAssertEqual(reject(&machine, t0).effect, MentraLivePairingEffect.none)
        XCTAssertEqual(reject(&machine, t0 + 20_000).effect, MentraLivePairingEffect.none)
        XCTAssertEqual(reject(&machine, t0 + MentraLiveOwnerRejectionStreak.minSpanMs).effect, .reject)
        XCTAssertEqual(machine.state, .rejected)
    }

    func testRejectionsDuringThePauseOrWhileThePairingAdvertIsFreshNeverCount() {
        var machine = pausedMachine()
        // The intentional disconnect and every 0x14/auth refusal inside the window.
        var now = t0
        for _ in 0 ..< 6 {
            XCTAssertEqual(reject(&machine, now).effect, MentraLivePairingEffect.none)
            now += 20_000
        }
        XCTAssertTrue(machine.isPaused)

        var advertising = Machine()
        for i in 0 ..< 6 {
            let at = t0 + i * 20_000
            advertising.onAdvertisement(pairingMode: true, ownerChanged: false, generation: 3, nowMs: at)
            XCTAssertEqual(reject(&advertising, at + 1_000).effect, MentraLivePairingEffect.none)
        }
        XCTAssertEqual(advertising.state, .normal)
        // The streak starts fresh once pairing mode is no longer advertised.
        advertising.onAdvertisement(pairingMode: false, ownerChanged: false, generation: 3, nowMs: t0 + 200_000)
        XCTAssertEqual(reject(&advertising, t0 + 200_500).effect, MentraLivePairingEffect.none)
        XCTAssertEqual(advertising.state, .normal)
    }

    func testLegacyFirmwareAndExplicitAttemptsNeverCount() {
        var machine = Machine()
        var now = t0
        for _ in 0 ..< 6 {
            machine.onAuthRejection(secureFirmware: false, explicitAttempt: false, nowMs: now)
            _ = reject(&machine, now + 1, explicit: true)
            now += 20_000
        }
        XCTAssertEqual(machine.state, .normal)
    }

    func testOnlyAnExplicitPairOrAForgetClearsARejection() {
        var machine = Machine()
        enter(&machine, windowId: nil, ownerRetained: false)
        machine.onSessionReady(explicitAttempt: false)
        XCTAssertEqual(machine.state, .rejected)
        machine.onPairingModeEnded(reason: "timeout", windowId: 1)
        machine.onTick(nowMs: t0 + 1_000_000)
        machine.onAdvertisement(pairingMode: false, ownerChanged: false, generation: 1, nowMs: t0 + 1_000_000)
        // A later pairing mode does not lift it either.
        enter(&machine, windowId: nil, ownerRetained: false, now: t0 + 2_000_000)
        XCTAssertEqual(machine.state, .rejected)
        XCTAssertTrue(machine.onSessionReady(explicitAttempt: true).stateChanged)
        XCTAssertEqual(machine.state, .normal)

        var forgotten = Machine()
        enter(&forgotten, windowId: nil, ownerRetained: false)
        forgotten.onForget()
        XCTAssertEqual(forgotten.state, .normal)
        XCTAssertEqual(forgotten.deviceId, "")
    }

    func testAPauseSurvivesARestartWithTheSameWindowId() {
        let persisted = pausedMachine(windowId: 42).persisted()
        var restored = Machine()
        XCTAssertEqual(restored.restore(values: persisted, savedDeviceId: device, nowMs: t0 + 30_000).effect, .pause)
        XCTAssertEqual(restored.state, .pairingMode(windowId: 42, endsAtMs: t0 + 150_000))
        XCTAssertEqual(restored.remainingPauseMs(nowMs: t0 + 30_000), 120_000)
    }

    func testAPauseThatEndedWhileTheAppWasAwayStillVerifiesTheTakeover() {
        let persisted = pausedMachine(windowId: 42).persisted()
        var restored = Machine()
        let transition = restored.restore(values: persisted, savedDeviceId: device, nowMs: t0 + 400_000)
        XCTAssertEqual(transition.effect, MentraLivePairingEffect.none)
        XCTAssertEqual(restored.state, .normal)
        XCTAssertEqual(restored.endedWindowId, 42)
        restored.onAdvertisement(pairingMode: false, ownerChanged: true, generation: 42, nowMs: t0 + 401_000)
        XCTAssertTrue(restored.verificationArmed)
    }

    func testAnImplausibleRestoredDeadlineDoesNotPause() {
        var persisted = pausedMachine().persisted()
        persisted[Machine.keyEndsAtMs] = t0 + 10_000_000
        var restored = Machine()
        restored.restore(values: persisted, savedDeviceId: device, nowMs: t0)
        XCTAssertEqual(restored.state, .normal)
    }

    func testARejectionSurvivesARestart() {
        var machine = Machine()
        enter(&machine, windowId: nil, ownerRetained: false)
        var restored = Machine()
        let transition = restored.restore(values: machine.persisted(), savedDeviceId: device, nowMs: t0 + 86_400_000)
        XCTAssertEqual(transition.effect, .reject)
        XCTAssertEqual(restored.state, .rejected)
    }

    func testRestoreIgnoresUnknownKeysAndMalformedValues() {
        let values: [String: Any] = [
            Machine.keyDeviceId: device,
            Machine.keyState: "pairing_mode",
            Machine.keyWindowId: "not a number",
            Machine.keyEndsAtMs: t0 + 60_000,
            "pairing_v9_future_key": "whatever",
            "unrelated": 12,
        ]
        var restored = Machine()
        restored.restore(values: values, savedDeviceId: device, nowMs: t0)
        XCTAssertEqual(restored.state, .normal)

        var future = Machine()
        future.restore(values: [Machine.keyState: "pairing_v9_state"], savedDeviceId: device, nowMs: t0)
        XCTAssertEqual(future.state, .normal)
    }

    func testARecordForOtherGlassesDoesNotApply() {
        let persisted = pausedMachine().persisted()
        var restored = Machine()
        restored.restore(values: persisted, savedDeviceId: "MENTRA_LIVE_BLE_OTHER", nowMs: t0 + 1_000)
        XCTAssertEqual(restored.state, .normal)
        XCTAssertEqual(restored.deviceId, "MENTRA_LIVE_BLE_OTHER")

        var bound = Machine()
        enter(&bound, windowId: nil, ownerRetained: false)
        XCTAssertTrue(bound.bindDevice("MENTRA_LIVE_BLE_OTHER").stateChanged)
        XCTAssertEqual(bound.state, .normal)
    }

    func testTheLegacyStandDownPhaseMigratesToRejected() {
        var restored = Machine()
        let transition = restored.restore(
            values: [Machine.legacyRejectionPhaseKey: "waiting"],
            savedDeviceId: device,
            nowMs: t0
        )
        XCTAssertEqual(transition.effect, .reject)
        XCTAssertEqual(restored.state, .rejected)
    }
}

/// The persisted record through real UserDefaults, as a process restart sees it.
@MainActor
final class MentraLivePairingStateStoreTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!
    private let device = "MENTRA_LIVE_BLE_ABCD"

    override func setUp() async throws {
        suiteName = "MentraLivePairingStateStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    private func restartedStore(nowMs: Int) -> (MentraLivePairingStateStore, MentraLivePairingTransition?) {
        let store = MentraLivePairingStateStore(defaults: defaults, publishes: false)
        let transition = store.ensureRestored(savedDeviceId: device, nowMs: nowMs)
        return (store, transition)
    }

    func testAPauseAndItsWindowIdSurviveARestart() {
        let now = MentraLivePairingStateStore.nowMs()
        let (first, _) = restartedStore(nowMs: now)
        first.update("test") {
            $0.onEnteringPairingMode(
                windowMs: 120_000, windowId: 42, ownerRetained: true, explicitAttempt: false,
                deviceId: self.device, nowMs: now
            )
        }

        let (second, transition) = restartedStore(nowMs: now + 10_000)
        XCTAssertEqual(transition?.effect, .pause)
        XCTAssertEqual(second.state, .pairingMode(windowId: 42, endsAtMs: now + 150_000))
        XCTAssertEqual(second.remainingPauseMs(nowMs: now + 10_000), 140_000)
        // A second restore in the same process does not re-run.
        XCTAssertNil(second.ensureRestored(savedDeviceId: device, nowMs: now + 10_000))
    }

    func testARejectionSurvivesARestartAndOnlyForgetClearsIt() {
        let now = MentraLivePairingStateStore.nowMs()
        let (first, _) = restartedStore(nowMs: now)
        first.update("test") {
            $0.onEnteringPairingMode(
                windowMs: nil, windowId: nil, ownerRetained: false, explicitAttempt: false,
                deviceId: self.device, nowMs: now
            )
        }
        let (second, transition) = restartedStore(nowMs: now + 86_400_000)
        XCTAssertEqual(transition?.effect, .reject)
        XCTAssertTrue(second.isRejected)
        second.update("forget") { $0.onForget() }
        let (third, _) = restartedStore(nowMs: now + 86_400_001)
        XCTAssertEqual(third.state, .normal)
        XCTAssertNil(defaults.dictionary(forKey: MentraLivePairingStateStore.defaultsKey))
    }

    func testRollbackToleranceKeepsUnknownKeysAndMigratesTheLegacyStandDown() {
        defaults.set(["pairing_v9_future_key": "kept"], forKey: MentraLivePairingStateStore.defaultsKey)
        defaults.set("waiting", forKey: MentraLivePairingStateMachine.legacyRejectionPhaseKey)
        defaults.set(5, forKey: "mentra_live_previous_owner_rejection_generation")
        defaults.set(123, forKey: "mentra_live_pairing_yield_until_wall_ms")

        let (store, transition) = restartedStore(nowMs: MentraLivePairingStateStore.nowMs())
        XCTAssertEqual(transition?.effect, .reject)
        XCTAssertTrue(store.isRejected)
        for key in MentraLivePairingStateMachine.legacyKeys {
            XCTAssertNil(defaults.object(forKey: key), key)
        }
        let record = defaults.dictionary(forKey: MentraLivePairingStateStore.defaultsKey)
        XCTAssertEqual(record?["pairing_v9_future_key"] as? String, "kept")
        XCTAssertEqual(record?[MentraLivePairingStateMachine.keyState] as? String, "pairing_rejected")
    }
}
