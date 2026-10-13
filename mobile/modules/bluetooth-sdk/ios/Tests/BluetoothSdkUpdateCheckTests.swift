@testable import MentraBluetoothSDK
import XCTest

final class BluetoothSdkUpdateCheckTests: XCTestCase {
    /// Collects values handed to `@Sendable` callbacks from the check's queue.
    private final class Recorder<Value>: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: [Value] = []

        var values: [Value] {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }

        func append(_ value: Value) {
            lock.lock()
            stored.append(value)
            lock.unlock()
        }
    }

    private final class CheckBox: @unchecked Sendable {
        var check: BluetoothSdkUpdateCheck?
    }

    private func result(
        _ status: String,
        latest: String? = "3.2.1",
        minimum: String? = nil
    ) -> BluetoothSdkUpdateCheckResult {
        BluetoothSdkUpdateCheckResult(status: status, channel: "latest", latestVersion: latest, minimumSupportedVersion: minimum)
    }

    func testParsesTheCoreResponseTreatingNullAndBlankVersionsAsUnknown() {
        let parsed = BluetoothSdkUpdateCheckResult.parse(
            #"{"status":"update_available","channel":"dev","latestVersion":"3.3.0-dev.821","minimumSupportedVersion":null}"#
        )
        XCTAssertEqual(
            parsed,
            BluetoothSdkUpdateCheckResult(status: "update_available", channel: "dev", latestVersion: "3.3.0-dev.821", minimumSupportedVersion: nil)
        )
        XCTAssertNil(BluetoothSdkUpdateCheckResult.parse(#"{"status":"current","latestVersion":""}"#)?.latestVersion)
        XCTAssertNotNil(BluetoothSdkUpdateCheckResult.parse(#"{"status":"current","latestVersion":""}"#))
        XCTAssertNil(BluetoothSdkUpdateCheckResult.parse("<html>502</html>"))
    }

    func testBannerNamesInstalledAndLatestVersionsAndTheSurfaceUpdateCommand() throws {
        let reactNative = try XCTUnwrap(BluetoothSdkUpdateNotice.banner(installedVersion: "3.1.0", result: result("update_available"), surface: "react_native"))
        XCTAssertTrue(reactNative.contains("MENTRA BLUETOOTH SDK UPDATE AVAILABLE"))
        XCTAssertTrue(reactNative.contains("Installed: 3.1.0"))
        XCTAssertTrue(reactNative.contains("Latest: 3.2.1"))
        XCTAssertTrue(reactNative.contains("bun add @mentra/bluetooth-sdk@3.2.1"))
        XCTAssertFalse(reactNative.contains("NO LONGER SUPPORTED"))
        XCTAssertTrue(reactNative.hasPrefix("=================================================================="))
        XCTAssertTrue(reactNative.hasSuffix("=================================================================="))

        let ios = try XCTUnwrap(BluetoothSdkUpdateNotice.banner(installedVersion: "3.1.0", result: result("update_available"), surface: "ios"))
        XCTAssertTrue(ios.contains("MentraBluetoothSDK Swift package at 3.2.1"))
        let android = try XCTUnwrap(BluetoothSdkUpdateNotice.banner(installedVersion: "3.1.0", result: result("update_available"), surface: "android"))
        XCTAssertTrue(android.contains("com.mentraglass:bluetooth-sdk:3.2.1"))
    }

    func testUnsupportedVersionGetsTheStrongerBanner() throws {
        let banner = try XCTUnwrap(BluetoothSdkUpdateNotice.banner(
            installedVersion: "3.0.5",
            result: result("unsupported", minimum: "3.1.0"),
            surface: "ios"
        ))
        XCTAssertTrue(banner.contains("MENTRA BLUETOOTH SDK 3.0.5 IS NO LONGER SUPPORTED"))
        XCTAssertTrue(banner.contains("known issues"))
    }

    func testNoBannerWhenCurrentUnknownOrNoLatestVersionToPointAt() {
        XCTAssertNil(BluetoothSdkUpdateNotice.banner(installedVersion: "3.2.1", result: result("current"), surface: "ios"))
        XCTAssertNil(BluetoothSdkUpdateNotice.banner(installedVersion: "3.2.1", result: result("unknown", latest: nil), surface: "ios"))
        XCTAssertNil(BluetoothSdkUpdateNotice.banner(installedVersion: "3.2.1", result: result("update_available", latest: nil), surface: "ios"))
    }

    func testSurfaceFollowsTheIntegration() {
        XCTAssertEqual(BluetoothSdkUpdateCheck.surface(forAnalyticsSurface: "react_native"), "react_native")
        XCTAssertEqual(BluetoothSdkUpdateCheck.surface(forAnalyticsSurface: "ios"), "ios")
        XCTAssertEqual(BluetoothSdkUpdateCheck.surface(forAnalyticsSurface: "macos"), "ios")
    }

    func testRequestIdentifiesTheInstallAppAndSdk() throws {
        let check = BluetoothSdkUpdateCheck(surface: "react_native", sdkVersion: "3.1.0", transport: { _, completion in completion(nil) }) { _, _ in }
        let body = check.requestBody()
        let installId = try XCTUnwrap(body["install_id"] as? String)
        XCTAssertEqual(installId, BluetoothSdkInstallId.get())
        XCTAssertTrue(installId.hasPrefix("mentra-bt-sdk-"))
        XCTAssertEqual(body["app_identifier"] as? String, Bundle.main.bundleIdentifier ?? "")
        XCTAssertEqual(body["sdk_version"] as? String, "3.1.0")
        XCTAssertEqual(body["sdk_platform"] as? String, "ios")
        XCTAssertEqual(body["sdk_surface"] as? String, "react_native")
        XCTAssertNotNil(body["app_build_type"])
        XCTAssertNotNil(body["app_install_source"])
        XCTAssertTrue(JSONSerialization.isValidJSONObject(body))
    }

    func testOutOfDateSdkPrintsTheBannerOnceAtStartAndStopsOnClose() throws {
        let notices = Recorder<String>()
        let sentBodies = Recorder<Data>()
        let check = BluetoothSdkUpdateCheck(
            surface: "ios",
            sdkVersion: "3.1.0",
            transport: { body, completion in
                sentBodies.append(body)
                completion(Data(#"{"status":"update_available","channel":"latest","latestVersion":"3.2.1","minimumSupportedVersion":null}"#.utf8))
            }
        ) { banner, _ in notices.append(banner) }
        check.start()
        BluetoothSdkUpdateCheck.awaitIdle()
        XCTAssertEqual(notices.values.count, 1)
        XCTAssertTrue(notices.values.first?.contains("Latest: 3.2.1") == true)
        let sentBody = try XCTUnwrap(sentBodies.values.first)
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: sentBody) as? [String: Any])
        XCTAssertEqual(sent["sdk_version"] as? String, "3.1.0")
        check.stop()
    }

    func testFailuresAndUnknownVersionsAreSilent() {
        let notices = Recorder<String>()
        let calls = Recorder<Bool>()
        let checks = [
            BluetoothSdkUpdateCheck(surface: "ios", sdkVersion: "3.1.0", transport: { _, completion in completion(nil) }) { banner, _ in notices.append(banner) },
            BluetoothSdkUpdateCheck(surface: "ios", sdkVersion: "3.1.0", transport: { _, completion in completion(Data("<html>502</html>".utf8)) }) { banner, _ in notices.append(banner) },
            BluetoothSdkUpdateCheck(surface: "ios", sdkVersion: "unknown", transport: { _, completion in calls.append(true); completion(nil) }) { banner, _ in notices.append(banner) },
            BluetoothSdkUpdateCheck(surface: "ios", sdkVersion: nil, transport: { _, completion in calls.append(true); completion(nil) }) { banner, _ in notices.append(banner) },
        ]
        checks.forEach { $0.start() }
        BluetoothSdkUpdateCheck.awaitIdle()
        XCTAssertTrue(notices.values.isEmpty)
        XCTAssertTrue(calls.values.isEmpty)
    }

    func testCheckStoppedBeforeTheResponseArrivesPrintsNothing() {
        let notices = Recorder<String>()
        let box = CheckBox()
        let check = BluetoothSdkUpdateCheck(
            surface: "ios",
            sdkVersion: "3.1.0",
            transport: { _, completion in
                box.check?.stop()
                completion(Data(#"{"status":"update_available","latestVersion":"3.2.1"}"#.utf8))
            }
        ) { banner, _ in notices.append(banner) }
        box.check = check
        check.start()
        BluetoothSdkUpdateCheck.awaitIdle()
        XCTAssertTrue(notices.values.isEmpty)
    }
}
