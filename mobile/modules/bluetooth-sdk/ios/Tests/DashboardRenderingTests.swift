@testable import MentraBluetoothSDK
import XCTest

@MainActor
final class DashboardRenderingTests: XCTestCase {
    private func setupDashboard() -> (DeviceManager, PausedDisplay) {
        let manager = DeviceManager()
        let display = PausedDisplay()
        manager.sgc = display
        DeviceStore.shared.apply("glasses", "fullyBooted", true)
        DeviceStore.shared.apply("glasses", "headUp", true)
        DeviceStore.shared.apply("bluetooth", "contextual_dashboard", true)
        DeviceStore.shared.apply("bluetooth", "screen_disabled", false)
        manager.sceneStates[1] = SceneFrame(appId: "test", epoch: 1, replay: false, elements: [SceneElement(id: "old", type: "text", x: 0, y: 0, w: 100, h: 30, text: "old", data: nil, border: 0, radius: 0, change: "created", contentHash: "old")], removed: [])
        return (manager, display)
    }

    func testSetterWaitsForCleanupAndLatestContentWins() async {
        let (manager, display) = setupDashboard()
        var firstReturned = false
        let first = Task {
            await manager.setDashboardContent("old")
            firstReturned = true
        }
        await fulfillment(of: [display.cleanupStarted], timeout: 2)
        XCTAssertFalse(firstReturned)
        XCTAssertTrue(display.texts.isEmpty)

        let secondStarted = XCTestExpectation(description: "second setter started")
        let second = Task {
            secondStarted.fulfill()
            await manager.setDashboardContent("new")
        }
        await fulfillment(of: [secondStarted], timeout: 2)
        display.finishCleanup()
        await first.value
        await second.value
        XCTAssertFalse(display.texts.isEmpty)
        XCTAssertTrue(display.texts.allSatisfy { $0.hasSuffix("new") })
        XCTAssertEqual(display.cleanupCount, 1)
    }

    func testHeadDownDuringCleanupRendersMainView() async {
        let (manager, display) = setupDashboard()
        manager.viewStates[0].text = "main view"
        let update = Task { await manager.setDashboardContent("dashboard") }
        await fulfillment(of: [display.cleanupStarted], timeout: 2)
        DeviceStore.shared.apply("glasses", "headUp", false)
        display.finishCleanup()
        await update.value
        XCTAssertEqual(display.texts, ["main view"])
    }

    func testSceneArrivingDuringCleanupReplacesText() async {
        let (manager, display) = setupDashboard()
        let update = Task { await manager.setDashboardContent("old") }
        await fulfillment(of: [display.cleanupStarted], timeout: 2)
        manager.displayEvent([
            "view": "dashboard",
            "scene": ["appId": "new-scene", "sceneEpoch": 2, "elements": [[String: Any]]()],
        ])
        display.finishCleanup()
        await update.value
        await manager.sendCurrentState().value
        XCTAssertTrue(display.texts.isEmpty)
        XCTAssertFalse(display.scenes.isEmpty)
        XCTAssertTrue(display.scenes.allSatisfy { $0.appId == "new-scene" })
    }
}

@MainActor
private final class PausedDisplay: SGCManager {
    var type = "Test display"
    let hasMic = false
    let cleanupStarted = XCTestExpectation(description: "cleanup suspended")
    var cleanupCount = 0
    var texts: [String] = []
    var scenes: [SceneFrame] = []
    private var continuation: CheckedContinuation<Void, Never>?

    func clearSceneElements(_: [String]) async {
        cleanupCount += 1
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            cleanupStarted.fulfill()
        }
    }

    func finishCleanup() {
        continuation?.resume()
        continuation = nil
    }

    func sendTextWall(_ text: String) async {
        texts.append(text)
    }

    func applySceneFrame(_ frame: SceneFrame) async {
        scenes.append(frame)
    }

    func clearDisplay() {}

    // Unused device capabilities for the display test double.
    func setMicEnabled(_: Bool) {}
    func sortMicRanking(list: [String]) -> [String] {
        list
    }

    func sendJson(_: [String: Any], wakeUp _: Bool, requireAck _: Bool) {}
    func requestPhoto(_: PhotoRequest) {}
    func startStream(_: [String: Any]) {}
    func stopStream() {}
    func sendStreamKeepAlive(_: [String: Any]) {}
    func startVideoRecording(requestId _: String, save _: Bool, sound _: Bool) {}
    func stopVideoRecording(requestId _: String) {}
    func sendButtonPhotoSettings() {}
    func sendButtonVideoRecordingSettings() {}
    func sendCameraFovSetting() {}
    func sendButtonMaxRecordingTime() {}
    func setBrightness(_: Int, autoMode _: Bool) {}
    func sendText(_: String) async {}
    func sendDoubleTextWall(_: String, _: String) async {}
    func displayBitmap(base64ImageData _: String, x _: Int32?, y _: Int32?, width _: Int32?, height _: Int32?) async -> Bool {
        false
    }

    func showDashboard() {}
    func setDashboardPosition(_: Int, _: Int) {}
    func setHeadUpAngle(_: Int) {}
    func getBatteryStatus() {}
    func setSilentMode(_: Bool) {}
    func exit() {}
    func sendShutdown() {}
    func sendReboot() {}
    func sendRgbLedControl(requestId _: String, packageName _: String?, action _: String, color _: String?, onDurationMs _: Int, offDurationMs _: Int, count _: Int) {}
    func disconnect() {}
    func forget() {}
    func findCompatibleDevices() {}
    func stopScan() {}
    func connectById(_: String) {}
    func getConnectedBluetoothName() -> String? {
        nil
    }

    func cleanup() {}
    func ping() {}
    func dbg1() {}
    func dbg2() {}
    func connectController() {}
    func disconnectController() {}
    func requestWifiScan(scanId _: String?) {}
    func sendWifiCredentials(_: String, _: String) {}
    func forgetWifiNetwork(_: String) {}
    func sendHotspotState(_: Bool) {}
    func sendUserEmailToGlasses(_: String) {}
    func sendOtaStart(otaVersionUrl _: String?) {}
    func sendOtaQueryStatus() {}
    func queryGalleryStatus() {}
    func sendGalleryMode() {}
    func requestVersionInfo() {}
    func sendIncidentId(_: String, apiBaseUrl _: String?) {}
}
