import CoreBluetooth
@testable import MentraBluetoothSDK
import XCTest

final class MentraLiveConnectionOptionsTests: XCTestCase {
    func testConnectOptionsRequireAncsByDefault() {
        XCTAssertTrue(ConnectOptions().requiresAncs)
    }

    func testConnectOptionsCanDisableAncsRequirement() {
        XCTAssertFalse(ConnectOptions(requiresAncs: false).requiresAncs)
    }

    func testCoreBluetoothOptionsRequireAncsWhenEnabled() {
        let options = MentraLiveConnectionOptions.coreBluetoothOptions(requiresAncs: true)

        XCTAssertEqual(options?.count, 1)
        XCTAssertEqual(options?[CBConnectPeripheralOptionRequiresANCS] as? Bool, true)
    }

    func testCoreBluetoothOptionsAreOmittedWhenAncsIsDisabled() {
        XCTAssertNil(MentraLiveConnectionOptions.coreBluetoothOptions(requiresAncs: false))
    }
}
