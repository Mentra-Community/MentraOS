import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class ConnectedDeviceMatcherTests: XCTestCase {
    func testSavedIdentityTakesPrecedenceOverName() {
        let saved = Device(model: .g1, name: "Saved glasses", identifier: "ABC")
        XCTAssertTrue(ConnectedDeviceMatcher.matches(model: .g1, defaultDevice: saved, name: nil, identifier: "abc"))
        XCTAssertFalse(ConnectedDeviceMatcher.matches(model: .g1, defaultDevice: saved, name: saved.name, identifier: "OTHER"))
        XCTAssertTrue(ConnectedDeviceMatcher.matches(model: .g1, defaultDevice: saved, name: saved.name, identifier: nil))
        XCTAssertFalse(ConnectedDeviceMatcher.matches(model: .g2, defaultDevice: saved, name: saved.name, identifier: "ABC"))
    }

    func testKnownNamesAreOnlyHintsForTheirModel() {
        XCTAssertTrue(ConnectedDeviceMatcher.matches(model: .mentraLive, defaultDevice: nil, name: "MENTRA_LIVE_BLE_123", identifier: nil))
        XCTAssertTrue(ConnectedDeviceMatcher.matches(model: .mentraNex, defaultDevice: nil, name: "Nex1-123", identifier: nil))
        XCTAssertFalse(ConnectedDeviceMatcher.matches(model: .g1, defaultDevice: nil, name: "MENTRA_LIVE_BLE_123", identifier: nil))
        XCTAssertFalse(ConnectedDeviceMatcher.matches(model: .simulated, defaultDevice: nil, name: "Nex1-123", identifier: nil))
        XCTAssertFalse(ConnectedDeviceMatcher.matches(model: .mentraLive, defaultDevice: nil, name: "Headphones", identifier: nil))
        XCTAssertFalse(ConnectedDeviceMatcher.matches(model: .g1, defaultDevice: Device(model: .g1, name: ""), name: "", identifier: ""))
    }

    func testUnsupportedModelsDoNotQueryCoreBluetooth() {
        XCTAssertTrue(ConnectedDeviceMatcher.serviceUUIDs(for: .simulated).isEmpty)
        XCTAssertFalse(ConnectedDeviceMatcher.serviceUUIDs(for: .mentraLive).isEmpty)
    }
}
