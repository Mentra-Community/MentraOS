#if os(macOS)
    import CoreAudio
    @testable import MentraBluetoothSDK
    import XCTest

    final class MacAudioDevicesTests: XCTestCase {
        private let devices = [
            MacAudioDevice(id: 1, name: "Internal", transport: kAudioDeviceTransportTypeBuiltIn, hasInput: true),
            MacAudioDevice(id: 2, name: "Headset A", transport: kAudioDeviceTransportTypeBluetooth, hasInput: true),
            MacAudioDevice(id: 3, name: "Headset B", transport: kAudioDeviceTransportTypeBluetoothLE, hasInput: true),
            MacAudioDevice(id: 4, name: "Speakers", transport: kAudioDeviceTransportTypeBluetooth, hasInput: false),
        ]

        func testBluetoothUsesSelectedInputRegardlessOfEnumerationOrder() {
            for mode in [MicTypes.BLUETOOTH, MicTypes.BLUETOOTH_CLASSIC] {
                for inputs in [devices, devices.reversed()] {
                    XCTAssertEqual(MacAudioDevice.input(for: mode, devices: inputs, defaultInput: 3), 3)
                    XCTAssertEqual(MacAudioDevice.input(for: mode, devices: inputs, defaultInput: 2), 2)
                    XCTAssertNil(MacAudioDevice.input(for: mode, devices: inputs, defaultInput: 1))
                    XCTAssertNil(MacAudioDevice.input(for: mode, devices: inputs, defaultInput: 4))
                    XCTAssertNil(MacAudioDevice.input(for: mode, devices: inputs, defaultInput: nil))
                }
            }
        }

        func testInternalModeNeverFallsBackToBluetooth() {
            XCTAssertEqual(MacAudioDevice.input(for: MicTypes.PHONE_INTERNAL, devices: devices, defaultInput: 3), 1)
            XCTAssertNil(MacAudioDevice.input(for: MicTypes.PHONE_INTERNAL, devices: Array(devices.dropFirst()), defaultInput: 3))
            XCTAssertNil(MacAudioDevice.input(for: "invalid", devices: devices, defaultInput: 1))
        }
    }
#endif
