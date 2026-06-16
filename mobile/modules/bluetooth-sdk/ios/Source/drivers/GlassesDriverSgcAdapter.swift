//
//  GlassesDriverSgcAdapter.swift
//  Bridges a public GlassesDriver onto the internal SGCManager so the rest of
//  the app (DeviceManager, etc.) is unchanged. Public commands delegate to the
//  driver; app-internal/no-op members are supplied here. Mirror of the Android
//  GlassesDriverSgcAdapter.kt. See docs/device-driver-contract.md §5.
//

import Foundation

@MainActor
class GlassesDriverSgcAdapter: SGCManager {
    private let driver: GlassesDriver
    private let host: DeviceHost

    var type: String
    var hasMic: Bool

    init(driver: GlassesDriver, host: DeviceHost) {
        self.driver = driver
        self.host = host
        self.type = driver.deviceType
        self.hasMic = driver.capabilities.hasMic
        host.reset()
        driver.start(host)
    }

    // MARK: - Audio
    func setMicEnabled(_ enabled: Bool) { driver.setMicEnabled(enabled) }
    func sortMicRanking(list: [String]) -> [String] { driver.sortMicRanking(list: list) }
    func setImuEnabled(_ enabled: Bool) async { await driver.setImuEnabled(enabled) }

    // MARK: - Messaging
    func sendJson(_: [String: Any], wakeUp _: Bool, requireAck _: Bool) {}

    // MARK: - Camera & media
    func requestPhoto(_ requestId: String, appId: String, size: String?, webhookUrl: String?, authToken: String?, compress: String?, flash: Bool, save: Bool, sound: Bool, exposureTimeNs: Double?, iso: Int?) {
        driver.requestPhoto(requestId, appId: appId, size: size, webhookUrl: webhookUrl, authToken: authToken, compress: compress, flash: flash, save: save, sound: sound, exposureTimeNs: exposureTimeNs, iso: iso)
    }
    func startStream(_ message: [String: Any]) { driver.startStream(message) }
    func stopStream() { driver.stopStream() }
    func sendStreamKeepAlive(_ message: [String: Any]) { driver.sendStreamKeepAlive(message) }
    func startVideoRecording(requestId: String, save: Bool, flash: Bool, sound: Bool) {
        driver.startVideoRecording(requestId: requestId, save: save, flash: flash, sound: sound)
    }
    func stopVideoRecording(requestId: String) { driver.stopVideoRecording(requestId: requestId) }

    // MARK: - Button settings (app-internal config; no-op)
    func sendButtonPhotoSettings() {}
    func sendButtonVideoRecordingSettings() {}
    func sendButtonMaxRecordingTime() {}
    func sendButtonCameraLedSetting() {}
    func sendCameraFovSetting() {}

    // MARK: - Display
    func setBrightness(_ level: Int, autoMode: Bool) { driver.setBrightness(level, autoMode: autoMode) }
    func clearDisplay() { driver.clearDisplay() }
    func sendTextWall(_ text: String) async { await driver.sendTextWall(text) }
    func sendDoubleTextWall(_ top: String, _ bottom: String) async { await driver.sendDoubleTextWall(top, bottom) }
    func displayBitmap(base64ImageData: String, x: Int32?, y: Int32?, width: Int32?, height: Int32?) async -> Bool {
        await driver.displayBitmap(base64ImageData: base64ImageData, x: x, y: y, width: width, height: height)
    }
    func showDashboard() { driver.showDashboard() }
    func setDashboardPosition(_ height: Int, _ depth: Int) { driver.setDashboardPosition(height, depth) }

    // MARK: - Device control
    func setHeadUpAngle(_ angle: Int) { driver.setHeadUpAngle(angle) }
    func getBatteryStatus() { driver.getBatteryStatus() }
    func setSilentMode(_ enabled: Bool) { driver.setSilentMode(enabled) }
    func exit() { driver.clearDisplay() }
    func sendShutdown() { driver.sendShutdown() }
    func sendReboot() { driver.sendReboot() }
    func sendRgbLedControl(requestId: String, packageName: String?, action: String, color: String?, onDurationMs: Int, offDurationMs: Int, count: Int) {
        driver.sendRgbLedControl(requestId: requestId, packageName: packageName, action: action, color: color, onDurationMs: onDurationMs, offDurationMs: offDurationMs, count: count)
    }

    // MARK: - Connection management
    func disconnect() { driver.disconnect() }
    func forget() { driver.disconnect() }
    func findCompatibleDevices() { driver.findCompatibleDevices() }
    func stopScan() { driver.stopScan() }
    func connectById(_ id: String) { driver.connectById(id) }
    func connectController() {}
    func disconnectController() {}
    func getConnectedBluetoothName() -> String? { driver.getConnectedName() }
    func cleanup() { driver.cleanup() }
    func ping() { driver.ping() }
    func dbg1() {}
    func dbg2() {}

    // MARK: - Network management
    func requestWifiScan() { driver.requestWifiScan() }
    func sendWifiCredentials(_ ssid: String, _ password: String) { driver.sendWifiCredentials(ssid, password) }
    func forgetWifiNetwork(_ ssid: String) { driver.forgetWifiNetwork(ssid) }
    func sendHotspotState(_ enabled: Bool) { driver.sendHotspotState(enabled) }
    func sendOtaStart() {}
    func sendOtaQueryStatus() {}
    func sendUserEmailToGlasses(_: String) {}
    func sendIncidentId(_: String, apiBaseUrl _: String?) {}

    // MARK: - Gallery / version
    func queryGalleryStatus() {}
    func sendGalleryMode() {}
    func requestVersionInfo() { driver.requestVersionInfo() }
}
