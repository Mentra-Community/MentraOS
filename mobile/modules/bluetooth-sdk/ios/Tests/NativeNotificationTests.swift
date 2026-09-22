@testable import MentraBluetoothSDK
import XCTest

final class NativeNotificationTests: XCTestCase {
    func testDisableIsExplicitAndQuietModeDoesNotEnablePopups() {
        let bytes = G2NotificationProto.notificationCtrl(magicRandom: 7, notifEnable: 0, autoDispEnable: 0, dispTime: 10, avoidDisturbEnable: 1)
        XCTAssertEqual(bytes, Data([0x08, 1, 0x10, 7, 0x1A, 8, 0x08, 0, 0x10, 0, 0x18, 10, 0x28, 1]))
    }

    func testConfigRejectsInvalidDurationBeforeEncoding() {
        XCTAssertThrowsError(try NativeNotificationConfig(durationSeconds: 0).validate())
        XCTAssertThrowsError(try NativeNotificationConfig(durationSeconds: 31).validate())
        XCTAssertNoThrow(try NativeNotificationConfig(durationSeconds: 30).validate())
    }

    func testAncsRejectsPhoneSideFiltering() {
        XCTAssertThrowsError(try NativeNotificationConfig(blockedApps: ["com.example"]).validateForAncs())
        XCTAssertNoThrow(try NativeNotificationConfig(blockedApps: []).validateForAncs())
    }
}
