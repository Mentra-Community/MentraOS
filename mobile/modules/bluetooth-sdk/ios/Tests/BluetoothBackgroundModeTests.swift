@testable import MentraBluetoothSDK
import XCTest

final class BluetoothBackgroundModeTests: XCTestCase {
    func testDetectsDeclaredBluetoothCentral() {
        XCTAssertTrue(
            BluetoothBackgroundMode.isDeclared(in: ["UIBackgroundModes": ["audio", "bluetooth-central"]])
        )
    }

    func testMissingModeIsReportedOnIOS() {
        #if os(iOS)
            XCTAssertFalse(BluetoothBackgroundMode.isDeclared(in: nil))
            XCTAssertFalse(BluetoothBackgroundMode.isDeclared(in: [:]))
            XCTAssertFalse(BluetoothBackgroundMode.isDeclared(in: ["UIBackgroundModes": ["audio"]]))
        #else
            XCTAssertTrue(BluetoothBackgroundMode.isDeclared(in: nil))
        #endif
    }

    func testWarningPointsToTheDocs() {
        XCTAssertTrue(BluetoothBackgroundMode.missingWarning.contains("bluetooth-central"))
        XCTAssertTrue(BluetoothBackgroundMode.missingWarning.contains("#background-operation"))
    }
}
