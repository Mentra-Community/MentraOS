//
//  Simulated.swift
//  AOS
//
//  Created by Matthew Fosse on 10/7/25.
//

@MainActor
class Simulated: SGCManager {
    init() {
        GlassesStore.shared.apply("glasses", "fullyBooted", true)
        GlassesStore.shared.apply("glasses", "connected", true)
        GlassesStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTED)
        GlassesStore.shared.apply("glasses", "micEnabled", false)
        GlassesStore.shared.apply("glasses", "btcConnected", false)
    }

    // MARK: - Device Information

    var type: String = DeviceTypes.SIMULATED
    var ready: Bool = true
    var connectionState: String = ConnTypes.CONNECTED

    var appVersion: String = ""
    var buildNumber: String = ""
    var deviceModel: String = ""
    var androidVersion: String = ""
    var otaVersionUrl: String = ""
    var firmwareVersion: String = ""
    var btMacAddress: String = ""
    var serialNumber: String = ""
    var style: String = ""
    var color: String = ""

    // MARK: - Hardware Status

    var hasMic: Bool = false
    var batteryLevel: Int = 100
    var headUp: Bool = false
    var micEnabled: Bool = false

    // MARK: - Case Status

    var caseOpen: Bool = false
    var caseRemoved: Bool = false
    var caseCharging: Bool = false
    var caseBatteryLevel: Int = -1

    // MARK: - Network Status

    var wifiSsid: String = ""
    var wifiConnected: Bool = false
    var wifiLocalIp: String = ""
    var hotspotEnabled: Bool = false
    var hotspotSsid: String = ""
    var hotspotPassword: String = ""
    var hotspotGatewayIp: String = ""

    // MARK: - Audio Control

    func setMicEnabled(_: Bool) {
        Bridge.log("setMicEnabled")
    }

    func sortMicRanking(list: [String]) -> [String] {
        return list
    }

    // MARK: - Messaging

    func sendJson(_: [String: Any], wakeUp _: Bool, requireAck _: Bool) {
        Bridge.log("sendJson")
    }

    // MARK: - Camera & Media

    func requestPhoto(_: String, appId _: String, size _: String?, webhookUrl _: String?, authToken _: String?, compress _: String?, silent _: Bool) {
        Bridge.log("requestPhoto")
    }

    func startRtmpStream(_: [String: Any]) {
        Bridge.log("startRtmpStream")
    }

    func stopRtmpStream() {
        Bridge.log("stopRtmpStream")
    }

    func sendRtmpKeepAlive(_: [String: Any]) {
        Bridge.log("sendRtmpKeepAlive")
    }

    func startBufferRecording() {
        Bridge.log("startBufferRecording")
    }

    func stopBufferRecording() {
        Bridge.log("stopBufferRecording")
    }

    func saveBufferVideo(requestId _: String, durationSeconds _: Int) {
        Bridge.log("saveBufferVideo")
    }

    func startVideoRecording(requestId _: String, save _: Bool, silent _: Bool) {
        Bridge.log("startVideoRecording")
    }

    func stopVideoRecording(requestId _: String) {
        Bridge.log("stopVideoRecording")
    }

    // MARK: - Button Settings

    func sendButtonPhotoSettings() {
        Bridge.log("sendButtonPhotoSettings")
    }

    func sendButtonModeSetting() {
        Bridge.log("sendButtonModeSetting")
    }

    func sendButtonVideoRecordingSettings() {
        Bridge.log("sendButtonVideoRecordingSettings")
    }

    func sendButtonCameraLedSetting() {
        Bridge.log("sendButtonCameraLedSetting")
    }

    func sendButtonMaxRecordingTime() {}

    // MARK: - Display Control

    func setBrightness(_: Int, autoMode _: Bool) {
        Bridge.log("setBrightness")
    }

    func clearDisplay() {
        Bridge.log("clearDisplay")
    }

    func sendTextWall(_: String) {
        Bridge.log("sendTextWall")
    }

    func sendDoubleTextWall(_: String, _: String) {
        Bridge.log("sendDoubleTextWall")
    }

    func displayBitmap(base64ImageData _: String) async -> Bool {
        Bridge.log("displayBitmap")
        return false
    }

    func showDashboard() {
        Bridge.log("showDashboard")
    }

    func setDashboardPosition(_: Int, _: Int) {
        Bridge.log("setDashboardPosition")
    }

    // MARK: - Device Control

    func setHeadUpAngle(_: Int) {
        Bridge.log("setHeadUpAngle")
    }

    func getBatteryStatus() {
        Bridge.log("getBatteryStatus")
    }

    func setSilentMode(_: Bool) {
        Bridge.log("setSilentMode")
    }

    func exit() {
        Bridge.log("exit")
    }

    func sendShutdown() {
        Bridge.log("sendShutdown - not supported on Simulated")
    }

    func sendReboot() {
        Bridge.log("sendReboot - not supported on Simulated")
    }

    func sendRgbLedControl(requestId: String, packageName _: String?, action _: String, color _: String?, ontime _: Int, offtime _: Int, count _: Int) {
        Bridge.log("sendRgbLedControl - not supported on Simulated")
        Bridge.sendRgbLedControlResponse(requestId: requestId, success: false, error: "device_not_supported")
    }

    // MARK: - Connection Management

    func disconnect() {
        Bridge.log("disconnect")
    }

    func forget() {
        Bridge.log("forget")
    }

    func findCompatibleDevices() {
        Bridge.log("findCompatibleDevices")
    }

    func connectById(_: String) {
        Bridge.log("connectById")
    }

    func getConnectedBluetoothName() -> String? {
        return nil
    }

    func cleanup() {
        Bridge.log("cleanup")
    }

    // MARK: - Network Management

    func requestWifiScan() {
        Bridge.log("requestWifiScan")
    }

    func sendWifiCredentials(_: String, _: String) {
        Bridge.log("sendWifiCredentials")
    }

    func forgetWifiNetwork(_ ssid: String) {
        Bridge.log("forgetWifiNetwork: \(ssid)")
    }

    func sendHotspotState(_: Bool) {
        Bridge.log("sendHotspotState")
    }

    func sendUserEmailToGlasses(_ email: String) {
        Bridge.log("sendUserEmailToGlasses: \(email)")
    }

    func sendOtaStart() {
        Bridge.log("sendOtaStart")
    }

    // MARK: - Gallery

    func queryGalleryStatus() {
        Bridge.log("queryGalleryStatus")
    }

    func sendGalleryMode() {
        Bridge.log("sendGalleryMode")
    }

    // MARK: - Version Info

    func requestVersionInfo() {
        Bridge.log("requestVersionInfo - not supported on Simulated")
    }
}
