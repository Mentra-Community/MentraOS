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

    func testConnectOptionsEnableTransportBridgingByDefault() {
        XCTAssertTrue(ConnectOptions().enableTransportBridging)
    }

    func testConnectOptionsCanEnableTransportBridging() {
        XCTAssertTrue(ConnectOptions(enableTransportBridging: true).enableTransportBridging)
    }

    #if os(macOS)
        func testCoreBluetoothOptionsOmitAncsOnMacOS() {
            XCTAssertNil(MentraLiveConnectionOptions.coreBluetoothOptions(requiresAncs: true))
        }

        func testCoreBluetoothOptionsOmitTransportBridgingOnMacOS() {
            XCTAssertNil(MentraLiveConnectionOptions.coreBluetoothOptions(
                requiresAncs: true,
                enableTransportBridging: true
            ))
        }
    #else
        func testCoreBluetoothOptionsRequireAncsWhenEnabled() {
            let options = MentraLiveConnectionOptions.coreBluetoothOptions(requiresAncs: true)

            XCTAssertEqual(options?.count, 1)
            XCTAssertEqual(options?[CBConnectPeripheralOptionRequiresANCS] as? Bool, true)
            XCTAssertNil(options?[CBConnectPeripheralOptionEnableTransportBridgingKey])
        }

        func testCoreBluetoothOptionsKeepAncsWhenTransportBridgingIsExplicitlyOff() {
            let options = MentraLiveConnectionOptions.coreBluetoothOptions(
                requiresAncs: true,
                enableTransportBridging: false
            )

            XCTAssertEqual(options?.count, 1)
            XCTAssertEqual(options?[CBConnectPeripheralOptionRequiresANCS] as? Bool, true)
        }

        func testCoreBluetoothOptionsContainBothWhenAncsAndTransportBridgingAreEnabled() {
            let options = MentraLiveConnectionOptions.coreBluetoothOptions(
                requiresAncs: true,
                enableTransportBridging: true
            )

            XCTAssertEqual(options?.count, 2)
            XCTAssertEqual(options?[CBConnectPeripheralOptionRequiresANCS] as? Bool, true)
            XCTAssertEqual(options?[CBConnectPeripheralOptionEnableTransportBridgingKey] as? Bool, true)
        }

        func testCoreBluetoothOptionsContainOnlyTransportBridgingWhenAncsIsDisabled() {
            let options = MentraLiveConnectionOptions.coreBluetoothOptions(
                requiresAncs: false,
                enableTransportBridging: true
            )

            XCTAssertEqual(options?.count, 1)
            XCTAssertEqual(options?[CBConnectPeripheralOptionEnableTransportBridgingKey] as? Bool, true)
            XCTAssertNil(options?[CBConnectPeripheralOptionRequiresANCS])
        }
    #endif

    func testCoreBluetoothOptionsAreOmittedWhenAncsIsDisabled() {
        XCTAssertNil(MentraLiveConnectionOptions.coreBluetoothOptions(requiresAncs: false))
    }

    func testCoreBluetoothOptionsAreOmittedWhenNeitherOptionIsSet() {
        XCTAssertNil(MentraLiveConnectionOptions.coreBluetoothOptions(
            requiresAncs: false,
            enableTransportBridging: false
        ))
    }
}
