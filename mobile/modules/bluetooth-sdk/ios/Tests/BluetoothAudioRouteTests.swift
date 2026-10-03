@testable import MentraBluetoothSDK
import XCTest

final class BluetoothAudioRouteTests: XCTestCase {
    func testRecognizesIPhoneProfiles() {
        for port in ["BluetoothHFP", "BluetoothA2DPOutput"] {
            XCTAssertTrue(BluetoothAudioRoute.matches(
                name: "Mentra_Live_03BE", portType: port, target: "03BE", isIOSAppOnMac: false
            ))
        }
    }

    func testRecognizesObservedMacTransportOnlyOnMac() {
        XCTAssertTrue(BluetoothAudioRoute.matches(
            name: "Mentra_Live_03BE", portType: "Bluetooth", target: "mentra_live_03be", isIOSAppOnMac: true
        ))
        XCTAssertFalse(BluetoothAudioRoute.matches(
            name: "Mentra_Live_03BE", portType: "Bluetooth", target: "03BE", isIOSAppOnMac: false
        ))
    }

    func testRejectsDifferentGlassesAndMissingIdentity() {
        for target in ["023B", ""] {
            XCTAssertFalse(BluetoothAudioRoute.matches(
                name: "Mentra_Live_03BE", portType: "Bluetooth", target: target, isIOSAppOnMac: true
            ))
        }
    }

    func testRejectsNonBluetoothDeviceWithMatchingName() {
        for port in ["Speaker", "USBAudio", "BuiltInMic", ""] {
            XCTAssertFalse(BluetoothAudioRoute.matches(
                name: "Mentra_Live_03BE", portType: port, target: "03BE", isIOSAppOnMac: true
            ))
        }
    }
}
