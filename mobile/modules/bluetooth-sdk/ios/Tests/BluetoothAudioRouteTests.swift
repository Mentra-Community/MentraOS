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

    // MARK: - Profile observation

    private func profiles(
        outputs: [(name: String, portType: String)] = [],
        inputs: [(name: String, portType: String)]? = [],
        isIOSAppOnMac: Bool = false
    ) -> BluetoothAudioRoute.ProfileObservation {
        BluetoothAudioRoute.observeProfiles(
            outputs: outputs, inputs: inputs, target: "03BE", isIOSAppOnMac: isIOSAppOnMac
        )
    }

    func testActiveA2dpOutputIsConnectedAndRouted() {
        let result = profiles(outputs: [(name: "Mentra_Live_03BE", portType: "BluetoothA2DPOutput")], inputs: nil)
        XCTAssertEqual(result, .init(profilesConnected: true, audioRouted: true))
    }

    func testHfpInputOnlyIsConnectedButNotRouted() {
        let result = profiles(
            outputs: [(name: "Speaker", portType: "Speaker")],
            inputs: [(name: "Mentra_Live_03BE", portType: "BluetoothHFP")]
        )
        XCTAssertEqual(result, .init(profilesConnected: true, audioRouted: false))
    }

    func testNoMatchIsNeitherConnectedNorRouted() {
        let result = profiles(
            outputs: [(name: "Speaker", portType: "Speaker")],
            inputs: [(name: "iPhone Microphone", portType: "MicrophoneBuiltIn")]
        )
        XCTAssertEqual(result, .init(profilesConnected: false, audioRouted: false))
        XCTAssertEqual(profiles(), .init(profilesConnected: false, audioRouted: false))
    }

    func testNilInputsDoNotHideActiveOutputAndAreNotAMatch() {
        XCTAssertEqual(
            profiles(outputs: [(name: "Speaker", portType: "Speaker")], inputs: nil),
            .init(profilesConnected: false, audioRouted: false)
        )
        XCTAssertEqual(
            profiles(outputs: [(name: "Mentra_Live_03BE", portType: "BluetoothHFP")], inputs: nil),
            .init(profilesConnected: true, audioRouted: true)
        )
    }

    func testOtherDevicesDoNotMatch() {
        let result = profiles(
            outputs: [(name: "Mentra_Live_023B", portType: "BluetoothA2DPOutput")],
            inputs: [(name: "Mentra_Live_023B", portType: "BluetoothHFP")]
        )
        XCTAssertEqual(result, .init(profilesConnected: false, audioRouted: false))
    }

    func testIdentityAndTransportBothRequiredForInputsAndOutputs() {
        let result = profiles(
            outputs: [(name: "Mentra_Live_03BE", portType: "USBAudio")],
            inputs: [(name: "Mentra_Live_03BE", portType: "BluetoothA2DPOutput")]
        )
        XCTAssertEqual(result, .init(profilesConnected: false, audioRouted: false))
    }

    func testIOSOnMacBluetoothPortIsRoutedOnlyOnMac() {
        let output = [(name: "Mentra_Live_03BE", portType: "Bluetooth")]
        XCTAssertEqual(
            profiles(outputs: output, isIOSAppOnMac: true),
            .init(profilesConnected: true, audioRouted: true)
        )
        XCTAssertEqual(
            profiles(outputs: output, isIOSAppOnMac: false),
            .init(profilesConnected: false, audioRouted: false)
        )
    }

    func testEmptyTargetNeverMatches() {
        let result = BluetoothAudioRoute.observeProfiles(
            outputs: [(name: "Mentra_Live_03BE", portType: "BluetoothA2DPOutput")],
            inputs: [(name: "Mentra_Live_03BE", portType: "BluetoothHFP")],
            target: "", isIOSAppOnMac: false
        )
        XCTAssertEqual(result, .init(profilesConnected: false, audioRouted: false))
    }
}
