@testable import MentraBluetoothSDK
import XCTest

@MainActor
final class DeviceManagerReconnectTests: XCTestCase {
    private let requests = ["should_send_lc3", "should_send_pcm", "should_send_transcript", "local_stt_fallback_active"]

    private func withRecordingDevice(_ body: (DeviceManager, DeviceStore) -> Void) {
        let manager = DeviceManager.shared
        let store = DeviceStore.shared
        let saved = ["bluetooth", "glasses"].map { ($0, store.store.getCategory($0)) }
        let previousDevice = manager.sgc
        let previousController = manager.controller
        defer {
            manager.sgc = previousDevice
            manager.controller = previousController
            for (category, values) in saved {
                for key in store.store.getCategory(category).keys where values[key] == nil {
                    store.store.remove(category, key)
                }
                for (key, value) in values {
                    store.set(category, key, value)
                }
            }
        }
        manager.controller = nil
        manager.sgc = ReconnectRecordingDevice()
        for key in requests {
            store.set("bluetooth", key, false)
        }
        store.set("bluetooth", "micEnabled", false)
        store.set("bluetooth", "micRanking", [MicTypes.GLASSES_CUSTOM])
        store.set("glasses", "micEnabled", false)
        store.set("glasses", "fullyBooted", false)
        body(manager, store)
    }

    func testReconnectRestoresUnchangedAudioRequests() {
        for request in requests {
            withRecordingDevice { manager, store in
                store.apply("bluetooth", request, true)
                XCTAssertEqual(store.get("bluetooth", "micEnabled") as? Bool, true)
                manager.disconnect()
                XCTAssertEqual(store.get("bluetooth", request) as? Bool, true)
                XCTAssertEqual(store.get("bluetooth", "micEnabled") as? Bool, false)
                let reconnected = ReconnectRecordingDevice()
                manager.sgc = reconnected
                store.set("glasses", "micEnabled", false)

                // Replaying the same consumer request is deduplicated.
                store.apply("bluetooth", request, true)
                XCTAssertEqual(store.get("bluetooth", "micEnabled") as? Bool, false)
                store.apply("glasses", "fullyBooted", true)

                XCTAssertEqual(store.get("bluetooth", "micEnabled") as? Bool, true, request)
                XCTAssertEqual(reconnected.micChanges, [true], request)
                XCTAssertEqual(store.get("bluetooth", "currentMic") as? String, MicTypes.GLASSES_CUSTOM, request)
            }
        }
    }

    func testReconnectWithoutAudioRequestsLeavesMicOff() {
        withRecordingDevice { manager, store in
            manager.disconnect()
            let reconnected = ReconnectRecordingDevice()
            manager.sgc = reconnected
            store.apply("glasses", "fullyBooted", true)
            XCTAssertEqual(store.get("bluetooth", "micEnabled") as? Bool, false)
            XCTAssertEqual(store.get("bluetooth", "currentMic") as? String, "")
            XCTAssertTrue(reconnected.micChanges.isEmpty)
        }
    }
}

@MainActor
private final class ReconnectRecordingDevice: SGCManager {
    var type = "Reconnect test glasses"
    let hasMic = true
    let showConnectionConfirmation = false
    var micChanges: [Bool] = []

    func clearSceneElements(_: [String]) async {}
    func sendTextWall(_: String) async {}
    func applySceneFrame(_: SceneFrame) async {}
    func clearDisplay() {}

    func setMicEnabled(_ enabled: Bool) {
        micChanges.append(enabled)
        DeviceStore.shared.set("glasses", "micEnabled", enabled)
    }

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
