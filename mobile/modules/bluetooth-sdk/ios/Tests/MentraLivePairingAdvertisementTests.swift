import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class MentraLivePairingAdvertisementTests: XCTestCase {
    func testKnownConnectUsesThePeripheralFoundDuringPairing() {
        XCTAssertEqual(
            MentraLiveKnownConnectRoute.decide(
                bluetoothPoweredOn: false,
                hasCachedPeripheral: true,
                hasSavedIdentifier: true,
                systemConnectedMatch: true
            ),
            .waitForPower
        )
        XCTAssertEqual(
            MentraLiveKnownConnectRoute.decide(
                bluetoothPoweredOn: true,
                hasCachedPeripheral: true,
                hasSavedIdentifier: true,
                systemConnectedMatch: false
            ),
            .cachedPeripheral
        )
        XCTAssertEqual(
            MentraLiveKnownConnectRoute.decide(
                bluetoothPoweredOn: true,
                hasCachedPeripheral: false,
                hasSavedIdentifier: true,
                systemConnectedMatch: false
            ),
            .savedIdentifier
        )
        XCTAssertEqual(
            MentraLiveKnownConnectRoute.decide(
                bluetoothPoweredOn: true,
                hasCachedPeripheral: false,
                hasSavedIdentifier: false,
                systemConnectedMatch: true
            ),
            .alreadyConnected
        )
        XCTAssertEqual(
            MentraLiveKnownConnectRoute.decide(
                bluetoothPoweredOn: true,
                hasCachedPeripheral: false,
                hasSavedIdentifier: false,
                systemConnectedMatch: false
            ),
            .scan
        )
    }

    func testConnectedPairingRecoveryRequiresExplicitPendingTarget() {
        XCTAssertFalse(
            MentraLivePendingPairingTarget.matches(
                connectedName: "MENTRA_LIVE_BLE_OWNER",
                connectedIdentifier: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
                pendingName: "",
                pendingIdentifier: ""
            )
        )
        XCTAssertTrue(
            MentraLivePendingPairingTarget.matches(
                connectedName: "MENTRA_LIVE_BLE_TARGET",
                connectedIdentifier: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
                pendingName: "MENTRA_LIVE_BLE_TARGET",
                pendingIdentifier: ""
            )
        )
        XCTAssertTrue(
            MentraLivePendingPairingTarget.matches(
                connectedName: "MENTRA_LIVE_BLE_TARGET",
                connectedIdentifier: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
                pendingName: "OTHER",
                pendingIdentifier: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
            )
        )
        XCTAssertFalse(
            MentraLivePendingPairingTarget.matches(
                connectedName: "MENTRA_LIVE_BLE_TARGET",
                connectedIdentifier: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
                pendingName: "MENTRA_LIVE_BLE_TARGET",
                pendingIdentifier: "11111111-2222-3333-4444-555555555555"
            )
        )
    }

    func testConnectedPairingRecoveryRequiresActiveGattConnection() {
        XCTAssertFalse(
            MentraLivePendingPairingTarget.shouldRecover(
                isConnected: false,
                connectedName: "MENTRA_LIVE_BLE_TARGET",
                connectedIdentifier: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
                pendingName: "MENTRA_LIVE_BLE_TARGET",
                pendingIdentifier: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
            )
        )
        XCTAssertTrue(
            MentraLivePendingPairingTarget.shouldRecover(
                isConnected: true,
                connectedName: "MENTRA_LIVE_BLE_TARGET",
                connectedIdentifier: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
                pendingName: "MENTRA_LIVE_BLE_TARGET",
                pendingIdentifier: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
            )
        )
    }

    func testConnectionCallbackPolicyRejectsPairingYieldAndStaleAttempts() {
        XCTAssertFalse(
            MentraLiveConnectionAttemptPolicy.shouldAcceptDidConnect(
                pairingYieldActive: true,
                matchesActiveAttempt: true
            )
        )
        XCTAssertFalse(
            MentraLiveConnectionAttemptPolicy.shouldAcceptDidConnect(
                pairingYieldActive: false,
                matchesActiveAttempt: false
            )
        )
        XCTAssertTrue(
            MentraLiveConnectionAttemptPolicy.shouldAcceptDidConnect(
                pairingYieldActive: false,
                matchesActiveAttempt: true
            )
        )
    }

    func testParsesMarkedSecurePairingAdvertisement() {
        let result = MentraLivePairingAdvertisement.parse(
            coreBluetoothManufacturerData: securePayload(pairingFlag: 1)
        )

        XCTAssertEqual(result?.pairingCode, "1234")
        XCTAssertEqual(result?.pairingMode, true)
    }

    func testParsesMarkedOwnedAdvertisement() {
        let result = MentraLivePairingAdvertisement.parse(
            coreBluetoothManufacturerData: securePayload(pairingFlag: 0)
        )

        XCTAssertEqual(result?.pairingCode, "1234")
        XCTAssertEqual(result?.pairingMode, false)
    }

    func testRejectsLegacyPayloadThatMatchesOldVersionCapabilityHeuristic() {
        var payload = legacyPayload()
        payload[2 + 5] = 0
        payload[2 + 6] = 1
        payload[2 + 7] = 1
        payload[2 + 8] = 0x34
        payload[2 + 9] = 0x12

        XCTAssertNil(
            MentraLivePairingAdvertisement.parse(coreBluetoothManufacturerData: payload)
        )
    }

    func testRejectsUnmarkedFirstGenerationSecureTrailer() {
        var payload = securePayload(pairingFlag: 1)
        payload[2 + 10] = 0x11
        payload[2 + 11] = 0x22

        XCTAssertNil(
            MentraLivePairingAdvertisement.parse(coreBluetoothManufacturerData: payload)
        )
    }

    func testRejectsEveryLegacyVersionAndCapabilityCombination() {
        for version in UInt8.min ... UInt8.max {
            for capability in UInt8.min ... UInt8.max {
                var payload = legacyPayload()
                payload[2 + 5] = 1
                payload[2 + 6] = version
                payload[2 + 7] = capability
                payload[2 + 10] = 0x4D
                // Offset 11 is padding in the legacy format, so it cannot contain the second
                // non-zero marker byte.
                payload[2 + 11] = 0
                XCTAssertNil(
                    MentraLivePairingAdvertisement.parse(coreBluetoothManufacturerData: payload)
                )
            }
        }
    }

    func testCapabilityFlagDoesNotConfirmOwnership() {
        XCTAssertFalse(MentraLiveConnectionAttemptPolicy.pairingInfoConfirmsOwner(ownerCommitted: false))
        XCTAssertTrue(MentraLiveConnectionAttemptPolicy.pairingInfoConfirmsOwner(ownerCommitted: true))
    }

    func testOnlySecureFirmwareOutsideExplicitPairingRejectsAnOwner() {
        typealias Policy = MentraLiveConnectionAttemptPolicy
        XCTAssertTrue(Policy.isOwnerRejection(isAuthFailure: true, explicitPairing: false, secureFirmware: true))
        XCTAssertFalse(Policy.isOwnerRejection(isAuthFailure: true, explicitPairing: true, secureFirmware: true))
        XCTAssertFalse(Policy.isOwnerRejection(isAuthFailure: true, explicitPairing: false, secureFirmware: false))
        XCTAssertFalse(Policy.isOwnerRejection(isAuthFailure: false, explicitPairing: false, secureFirmware: true))
    }

    func testASingleRejectionDoesNotStandDown() {
        var streak = MentraLiveOwnerRejectionStreak()
        XCTAssertFalse(streak.record(nowMs: 0))
    }

    func testQuickRejectionsWaitForTheStreakToSpanAboutAMinute() {
        var streak = MentraLiveOwnerRejectionStreak()
        XCTAssertFalse(streak.record(nowMs: 0))
        XCTAssertFalse(streak.record(nowMs: 3_000))
        // Third attempt, but a glasses reboot also rejects for a few seconds.
        XCTAssertFalse(streak.record(nowMs: 8_000))
        XCTAssertFalse(streak.record(nowMs: 24_000))
        XCTAssertTrue(streak.record(nowMs: MentraLiveOwnerRejectionStreak.minSpanMs))
    }

    func testASuccessfulSessionEndsTheStreak() {
        var streak = MentraLiveOwnerRejectionStreak()
        _ = streak.record(nowMs: 0)
        _ = streak.record(nowMs: 10_000)
        streak.reset()
        XCTAssertFalse(streak.record(nowMs: 50_000))
        XCTAssertFalse(streak.record(nowMs: 60_000))
    }

    func testRejectionsFarApartAreNotOneStreak() {
        var streak = MentraLiveOwnerRejectionStreak()
        _ = streak.record(nowMs: 0)
        _ = streak.record(nowMs: 10_000)
        _ = streak.record(nowMs: 20_000)
        let later = 20_000 + MentraLiveOwnerRejectionStreak.streakGapMs + 1
        XCTAssertFalse(streak.record(nowMs: later))
        XCTAssertFalse(streak.record(nowMs: later + 10_000))
        XCTAssertFalse(streak.record(nowMs: later + 20_000))
    }

    func testOneAttemptReportingTwiceCountsOnce() {
        var streak = MentraLiveOwnerRejectionStreak()
        let span = MentraLiveOwnerRejectionStreak.minSpanMs
        // didFailToConnect then didDisconnect for each of two attempts.
        XCTAssertFalse(streak.record(nowMs: 0))
        XCTAssertFalse(streak.record(nowMs: 400))
        XCTAssertFalse(streak.record(nowMs: span))
        XCTAssertFalse(streak.record(nowMs: span + 400))
        // A genuine third attempt completes the streak.
        XCTAssertTrue(streak.record(nowMs: span + 10_000))
    }

    func testEnteringPairingModeYieldsOnlyWhenTheOwnerWasRetained() {
        typealias Policy = MentraLiveConnectionAttemptPolicy
        XCTAssertTrue(Policy.shouldYieldOnEnteringPairingMode(ownerRetained: true))
        // Absent or false keeps the 3.3 stand-down.
        XCTAssertFalse(Policy.shouldYieldOnEnteringPairingMode(ownerRetained: false))
    }

    func testYieldCoversTheAbsoluteWindow() {
        typealias Policy = MentraLiveConnectionAttemptPolicy
        XCTAssertEqual(Policy.yieldMs(windowMs: 120_000), 300_000)
        XCTAssertEqual(Policy.yieldMs(windowMs: 900_000), 300_000)
        XCTAssertEqual(Policy.yieldMs(windowMs: 5_000), 300_000)
    }

    func testRejectionsDuringAYieldAreNotRecorded() {
        typealias Policy = MentraLiveConnectionAttemptPolicy
        XCTAssertFalse(Policy.shouldRecordOwnerRejection(yieldActive: true))
        XCTAssertTrue(Policy.shouldRecordOwnerRejection(yieldActive: false))
    }

    func testYieldRejectionsNeverBuildAStreakThatStandsDown() {
        var streak = MentraLiveOwnerRejectionStreak()
        var standDown = false
        var now = 0
        // Rejections spanning well past the stand-down thresholds, all inside the yield.
        for _ in 0 ..< 6 {
            if MentraLiveConnectionAttemptPolicy.shouldRecordOwnerRejection(yieldActive: true) {
                standDown = standDown || streak.record(nowMs: now)
            }
            now += 60_000
        }
        XCTAssertFalse(standDown)
        // The first rejection after the yield starts a fresh streak.
        XCTAssertFalse(streak.record(nowMs: now))
    }

    func testAwaitingConfirmSuspendsTheSecurePairingWait() {
        typealias Policy = MentraLiveConnectionAttemptPolicy
        XCTAssertFalse(Policy.shouldRunSecurePairingWait(awaitingConfirm: true))
        XCTAssertTrue(Policy.shouldRunSecurePairingWait(awaitingConfirm: false))
    }

    func testSuccessfulConfirmRearmsThePairingWaitButRefusalDoesNot() {
        typealias Policy = MentraLiveConnectionAttemptPolicy
        XCTAssertTrue(Policy.shouldRearmSecurePairingWaitAfterConfirm(ok: true))
        XCTAssertFalse(Policy.shouldRearmSecurePairingWaitAfterConfirm(ok: false))
    }

    private func legacyPayload() -> Data {
        var data = Data(repeating: 0, count: 29)
        data[0] = 0x22
        data[1] = 0xB8
        return data
    }

    private func securePayload(pairingFlag: UInt8) -> Data {
        var data = legacyPayload()
        data[2 + 5] = pairingFlag
        data[2 + 6] = 2
        data[2 + 7] = 1
        data[2 + 8] = 0x34
        data[2 + 9] = 0x12
        data[2 + 10] = 0x4D
        data[2 + 11] = 0x50
        return data
    }
}
