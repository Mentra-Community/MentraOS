@testable import MentraBluetoothSDK
import XCTest

final class BluetoothAudioRouteTests: XCTestCase {
    func testObservationSeparatesAbsentBluetoothFromWrongTarget() {
        let builtIn = BluetoothAudioRoute.observe(
            outputs: [(name: "MacBook Speakers", portType: "Speaker")], target: "03BE", isIOSAppOnMac: true
        )
        let wrongTarget = BluetoothAudioRoute.observe(
            outputs: [(name: "Mentra_Live_023B", portType: "Bluetooth")], target: "03BE", isIOSAppOnMac: true
        )
        XCTAssertEqual(builtIn, .init(bluetoothOutputCount: 0, targetNameOutputCount: 0, matchingOutputCount: 0))
        XCTAssertEqual(wrongTarget, .init(bluetoothOutputCount: 1, targetNameOutputCount: 0, matchingOutputCount: 0))
    }

    func testObservationKeepsIdentityAndTransportSeparate() {
        let matching = BluetoothAudioRoute.observe(
            outputs: [(name: "Mentra_Live_03BE", portType: "Bluetooth")], target: "03BE", isIOSAppOnMac: true
        )
        let usb = BluetoothAudioRoute.observe(
            outputs: [(name: "Mentra_Live_03BE", portType: "USBAudio")], target: "03BE", isIOSAppOnMac: true
        )
        let missingTarget = BluetoothAudioRoute.observe(
            outputs: [(name: "Mentra_Live_03BE", portType: "Bluetooth")], target: "", isIOSAppOnMac: true
        )
        XCTAssertEqual(matching, .init(bluetoothOutputCount: 1, targetNameOutputCount: 1, matchingOutputCount: 1))
        XCTAssertEqual(usb, .init(bluetoothOutputCount: 0, targetNameOutputCount: 1, matchingOutputCount: 0))
        XCTAssertEqual(missingTarget, .init(bluetoothOutputCount: 1, targetNameOutputCount: 0, matchingOutputCount: 0))
    }

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
