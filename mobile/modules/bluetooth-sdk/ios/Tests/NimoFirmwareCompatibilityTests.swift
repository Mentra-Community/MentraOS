import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class NimoFirmwareCompatibilityTests: XCTestCase {
    private let known = "FW-VERSION-v0.1.1.1-20260827164351-537cf1-dirty-Debug"

    func testBundledCompatibilityRequiresFullAndPackedIdentity() throws {
        let suite = "nimo-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let policy = NimoFirmwareCompatibility(deviceId: "one-device", defaults: defaults)
        XCTAssertTrue(policy.allows(fullVersion: known, packedVersion: "0.1.1.1"))
        XCTAssertFalse(policy.allows(fullVersion: known, packedVersion: "0.1.0.14"))
        XCTAssertFalse(policy.allows(fullVersion: "FW-VERSION-v0.1.1.1-other-build", packedVersion: "0.1.1.1"))
        XCTAssertFalse(policy.allows(fullVersion: "FW-VERSION-v0.2.0.0-newer", packedVersion: "0.2.0.0"))
        XCTAssertFalse(policy.allows(fullVersion: "", packedVersion: ""))
    }

    func testVerifiedHostPolicySurvivesRestartOnlyForItsDevice() throws {
        let suite = "nimo-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let full = "FW-VERSION-v0.1.2.0-approved-build"
        let metadata = ["manifestSha256": String(repeating: "a", count: 64),
                        "compatibleFirmware": "[{\"fullVersion\":\"\(full)\",\"packedVersion\":\"0.1.2.0\"}]"]
        try NimoFirmwareCompatibility(deviceId: "one", defaults: defaults).configure(metadata)
        XCTAssertTrue(NimoFirmwareCompatibility(deviceId: "one", defaults: defaults).allows(fullVersion: full, packedVersion: "0.1.2.0"))
        XCTAssertFalse(NimoFirmwareCompatibility(deviceId: "another", defaults: defaults).allows(fullVersion: full, packedVersion: "0.1.2.0"))
    }

    func testInvalidPolicyCannotEnableUnknownFirmware() throws {
        let suite = "nimo-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let policy = NimoFirmwareCompatibility(deviceId: "one", defaults: defaults)
        for json in ["{}", "[{}]", "[{\"fullVersion\":\"FW-VERSION-v0.1.2.0-build\",\"packedVersion\":\"0.1.1.1\"}]",
                     "[{\"fullVersion\":\"FW-VERSION-v0.1.2.4096-build\",\"packedVersion\":\"0.1.2.4096\"}]"]
        {
            XCTAssertThrowsError(try policy.configure(["manifestSha256": String(repeating: "a", count: 64), "compatibleFirmware": json]))
        }
        XCTAssertThrowsError(try policy.configure(["manifestSha256": "", "compatibleFirmware": "[]"]))
        XCTAssertTrue(policy.allows(fullVersion: known, packedVersion: "0.1.1.1"))
    }

    func testConnectionQueriesRemainAvailableButNormalDeviceCommandsAreRestricted() {
        XCTAssertTrue(NimoFirmwareCompatibility.permitsBeforeCompatibility(command: NimoProtocol.CMD_GET_PARAMETER, key: NimoProtocol.GET_VERSION))
        XCTAssertTrue(NimoFirmwareCompatibility.permitsBeforeCompatibility(command: NimoProtocol.CMD_SET_PARAMETER, key: NimoProtocol.SET_TIME))
        XCTAssertTrue(NimoFirmwareCompatibility.permitsBeforeCompatibility(command: NimoProtocol.CMD_SET_PARAMETER, key: NimoProtocol.SET_PHONE_TYPE))
        XCTAssertFalse(NimoFirmwareCompatibility.permitsBeforeCompatibility(command: NimoProtocol.CMD_SET_PARAMETER, key: NimoProtocol.SET_BRIGHTNESS))
        XCTAssertFalse(NimoFirmwareCompatibility.permitsBeforeCompatibility(command: NimoProtocol.CMD_CONTROL_INSTRUCTION, key: NimoProtocol.CTRL_UPDATE_CONTENT))
    }

    func testRecoveryDiscoveryUsesNativeIdentityWithoutAPairingName() {
        let target = NimoConnectionTarget.recovery("retained-uuid")
        XCTAssertTrue(target.matches(deviceId: "retained-uuid", name: nil))
        XCTAssertTrue(target.matches(deviceId: "retained-uuid", name: "NIMO renamed"))
        XCTAssertFalse(target.matches(deviceId: "other-uuid", name: "NIMO renamed"))
        XCTAssertFalse(NimoConnectionTarget.recovery("").matches(deviceId: "", name: "NIMO"))
    }

    func testOrdinaryPairingStillRequiresSelectedMainDeviceName() {
        XCTAssertFalse(NimoConnectionTarget.pairing("NOT_SET").matches(deviceId: "uuid", name: "NIMO 1"))
        XCTAssertFalse(NimoConnectionTarget.pairing("NIMO 1").matches(deviceId: "uuid", name: nil))
        XCTAssertFalse(NimoConnectionTarget.pairing("NIMO 1").matches(deviceId: "uuid", name: "NIMO 2"))
        XCTAssertTrue(NimoConnectionTarget.pairing("NIMO 1").matches(deviceId: "uuid", name: "NIMO 1"))
        XCTAssertFalse(NimoConnectionTarget.pairing("NIMO 1_ble").matches(deviceId: "uuid", name: "NIMO 1_ble"))
    }
}
