//
//  Simulated.swift
//  AOS
//
//  Created by Matthew Fosse on 10/7/25.
//

import Foundation

@MainActor
class Simulated: SGCManager {
    fileprivate var displayEvents = [SimulatedDisplayEvent]()

    init() {
        DeviceStore.shared.apply("glasses", "fullyBooted", true)
        DeviceStore.shared.apply("glasses", "connected", true)
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTED)
        DeviceStore.shared.apply("glasses", "micEnabled", false)
        DeviceStore.shared.apply(
            "glasses",
            "voiceActivityDetectionEnabled",
            BluetoothSdkDefaults.voiceActivityDetectionEnabled
        )
        DeviceStore.shared.apply("glasses", "bluetoothClassicConnected", false)
        DeviceStore.shared.apply("glasses", "bluetoothClassicProfilesConnected", false)
        DeviceStore.shared.apply("glasses", "bluetoothAudioRouted", false)
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
    var bluetoothMacAddress: String = ""
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

    func uploadPhoto(_ request: PhotoRequest) {
        Bridge.log("uploadPhoto save=\(request.save) sound=\(request.sound)")
    }

    func startStream(_: [String: Any]) {
        Bridge.log("startStream")
    }

    func stopStream() {
        Bridge.log("stopStream")
    }

    func sendStreamKeepAlive(_: [String: Any]) {
        Bridge.log("sendStreamKeepAlive")
    }

    func startVideoRecording(requestId _: String, save _: Bool, sound _: Bool) {
        Bridge.log("startVideoRecording")
    }

    func stopVideoRecording(requestId _: String) {
        Bridge.log("stopVideoRecording")
    }

    // MARK: - Button Settings

    func sendButtonPhotoSettings() {
        Bridge.log("sendButtonPhotoSettings")
    }

    func sendButtonVideoRecordingSettings() {
        Bridge.log("sendButtonVideoRecordingSettings")
    }

    func sendCameraFovSetting() {
        Bridge.log("sendCameraFovSetting")
    }

    func sendButtonMaxRecordingTime() {}

    // MARK: - Display Control

    func setBrightness(_: Int, autoMode _: Bool) {
        Bridge.log("setBrightness")
    }

    func clearDisplay() {
        Bridge.log("clearDisplay")
        displayEvents.append(SimulatedDisplayEvent(kind: .clear))
    }

    func sendText(_ text: String) async {
        Bridge.log("sendText")
        displayEvents.append(SimulatedDisplayEvent(kind: .text, text: text))
    }

    func sendTextWall(_ text: String) async {
        Bridge.log("sendTextWall")
        displayEvents.append(SimulatedDisplayEvent(kind: .textWall, text: text))
    }

    func sendDoubleTextWall(_ top: String, _ bottom: String) async {
        Bridge.log("sendDoubleTextWall")
        displayEvents.append(
            SimulatedDisplayEvent(kind: .doubleTextWall, top: top, bottom: bottom)
        )
    }

    func displayBitmap(base64ImageData: String, x _: Int32?, y _: Int32?, width _: Int32?, height _: Int32?) async -> Bool {
        Bridge.log("displayBitmap")
        displayEvents.append(
            SimulatedDisplayEvent(kind: .bitmap, base64ImageData: base64ImageData)
        )
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

    func sendRgbLedControl(requestId: String, packageName _: String?, action _: String, color _: String?, onDurationMs _: Int, offDurationMs _: Int, count _: Int) {
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

    func stopScan() {
        Bridge.log("stopScan")
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

    func ping() {
        Bridge.log("ping")
    }

    func dbg1() {}
    func dbg2() {}
    func connectController() {}
    func disconnectController() {}

    // MARK: - Network Management

    func requestWifiScan(scanId _: String?) {
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

    func sendOtaStart(otaVersionUrl: String?) {
        Bridge.log("sendOtaStart")
    }

    func sendOtaQueryStatus() {
        Bridge.log("sendOtaQueryStatus")
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

    func sendIncidentId(_: String, apiBaseUrl _: String?) {}

    /// Returns a public scriptable handle bound to this simulated manager.
    func snapshot() -> SimulatedGlasses {
        return SimulatedGlassesSnapshot(simulated: self)
    }
}

@MainActor
private struct SimulatedGlassesSnapshot: SimulatedGlasses {
    private let simulated: Simulated

    init(simulated: Simulated) {
        self.simulated = simulated
    }

    func displayTranscript() -> [SimulatedDisplayEvent] {
        simulated.displayEvents
    }

    func clearDisplayTranscript() {
        simulated.displayEvents.removeAll()
    }

    func injectMicPcm(_ pcm: Data) {
        Bridge.sendMicPcm(pcm, source: MicTypes.GLASSES_CUSTOM)
    }

    func injectTouch(_ gesture: TouchGesture) {
        Bridge.sendTouchEvent(
            deviceModel: DeviceTypes.SIMULATED,
            gestureName: gesture.rawValue,
            timestamp: Int64(Date().timeIntervalSince1970 * 1000)
        )
    }

    func injectHeadUp(_ headUp: Bool) {
        Bridge.sendHeadUp(headUp)
    }

    func simulateDisconnect() {
        DeviceStore.shared.apply("glasses", "connected", false)
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
    }

    func simulateReconnect() {
        DeviceStore.shared.apply("glasses", "connected", true)
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTED)
        DeviceStore.shared.apply("glasses", "fullyBooted", true)
    }
}
