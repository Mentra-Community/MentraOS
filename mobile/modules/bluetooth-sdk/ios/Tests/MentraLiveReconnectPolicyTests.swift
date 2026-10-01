@testable import MentraBluetoothSDK
import XCTest

final class MentraLiveReconnectPolicyTests: XCTestCase {
    private func decide(
        isKilled: Bool = false,
        pairingYieldActive: Bool = false,
        bluetoothPoweredOn: Bool = true,
        peripheralName: String? = "Mentra_Live_D910",
        savedDeviceName: String? = "Mentra_Live_D910"
    ) -> Bool {
        MentraLiveConnectionAttemptPolicy.shouldReconnectDirectly(
            isKilled: isKilled,
            pairingYieldActive: pairingYieldActive,
            bluetoothPoweredOn: bluetoothPoweredOn,
            peripheralName: peripheralName,
            savedDeviceName: savedDeviceName
        )
    }

    func testRemembersLostGlassesWithPendingConnect() {
        XCTAssertTrue(decide())
    }

    func testDoesNotReconnectAfterUserDisconnectOrKill() {
        XCTAssertFalse(decide(isKilled: true))
    }

    func testYieldsToAnotherPhonePairing() {
        XCTAssertFalse(decide(pairingYieldActive: true))
    }

    func testFallsBackWhenBluetoothIsOff() {
        XCTAssertFalse(decide(bluetoothPoweredOn: false))
    }

    func testDoesNotReconnectForgottenOrDifferentGlasses() {
        XCTAssertFalse(decide(savedDeviceName: nil))
        XCTAssertFalse(decide(savedDeviceName: "Mentra_Live_023B"))
        XCTAssertFalse(decide(peripheralName: nil))
        XCTAssertFalse(decide(peripheralName: "", savedDeviceName: ""))
    }
}
