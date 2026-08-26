import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class MentraLivePairingAdvertisementTests: XCTestCase {
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
