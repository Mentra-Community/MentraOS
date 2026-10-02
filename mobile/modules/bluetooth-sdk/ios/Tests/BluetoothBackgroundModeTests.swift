@testable import MentraBluetoothSDK
import XCTest

final class BluetoothBackgroundModeTests: XCTestCase {
    func testDetectsDeclaredBluetoothCentral() {
        XCTAssertTrue(
            BluetoothBackgroundMode.declaresBluetoothCentral(
                ["UIBackgroundModes": ["audio", "bluetooth-central"]]
            )
        )
    }

    func testReportsMissingOrMalformedBackgroundModes() {
        XCTAssertFalse(BluetoothBackgroundMode.declaresBluetoothCentral(nil))
        XCTAssertFalse(BluetoothBackgroundMode.declaresBluetoothCentral([:]))
        XCTAssertFalse(BluetoothBackgroundMode.declaresBluetoothCentral(["UIBackgroundModes": ["audio"]]))
        XCTAssertFalse(
            BluetoothBackgroundMode.declaresBluetoothCentral(["UIBackgroundModes": "bluetooth-central"])
        )
    }

    func testMacOSHasNoBackgroundModeRequirement() {
        #if os(macOS)
            XCTAssertTrue(BluetoothBackgroundMode.isDeclared(in: nil))
        #endif
    }

    func testWarningPointsToTheDocs() {
        XCTAssertTrue(BluetoothBackgroundMode.missingWarning.contains("bluetooth-central"))
        XCTAssertTrue(BluetoothBackgroundMode.missingWarning.contains("#background-operation"))
    }
}
