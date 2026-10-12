import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class NimoDeviceCommandsTests: XCTestCase {
    func testSystemEnglishAndFactoryResetMatchFirmwareWireCommands() {
        func hex(_ bytes: Data) -> String {
            bytes.map { String(format: "%02X", $0) }.joined()
        }
        XCTAssertEqual(hex(NimoFrameCodec.encodeFrame(cmd: NimoProtocol.CMD_SET_PARAMETER,
                                                      key: NimoProtocol.SET_SYSTEM_LANGUAGE, payload: Data([NimoProtocol.LANGUAGE_ENGLISH]))),
                       "BF020500702500000324010001")
        XCTAssertEqual(hex(NimoFrameCodec.encodeFrame(cmd: NimoProtocol.CMD_CONTROL_FACTORY,
                                                      key: NimoProtocol.FACTORY_RECOVER, payload: Data())), "BF0204005358000008030000")
    }
}
