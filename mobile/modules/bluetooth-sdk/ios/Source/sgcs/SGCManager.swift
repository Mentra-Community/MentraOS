import Foundation

@MainActor
protocol SGCManager {
    // MARK: - hard coded device properties:

    var type: String { get set }
    var hasMic: Bool { get }

    // MARK: - Audio Control

    func setMicEnabled(_ enabled: Bool)
    func sortMicRanking(list: [String]) -> [String]

    // MARK: - Messaging

    func sendJson(_ jsonOriginal: [String: Any], wakeUp: Bool, requireAck: Bool)

    // MARK: - Camera & Media

    func requestPhoto(
        _ requestId: String, appId: String, size: String?, webhookUrl: String?, authToken: String?,
        compress: String?, flash: Bool, sound: Bool, exposureTimeNs: Double?, iso: Int?
    )
    func startStream(_ message: [String: Any])
    func stopStream()
    func sendStreamKeepAlive(_ message: [String: Any])
    func startVideoRecording(requestId: String, save: Bool, flash: Bool, sound: Bool)
    func stopVideoRecording(requestId: String)

    // MARK: - Button Settings

    func sendButtonPhotoSettings()
    func sendButtonVideoRecordingSettings()
    func sendButtonMaxRecordingTime()
    func sendButtonCameraLedSetting()
    func sendCameraFovSetting()

    // MARK: - Display Control

    func setBrightness(_ level: Int, autoMode: Bool)
    func clearDisplay()
    func sendTextWall(_ text: String)
    func sendDoubleTextWall(_ top: String, _ bottom: String)
    func displayBitmap(base64ImageData: String) async -> Bool
    func showDashboard()
    func setDashboardPosition(_ height: Int, _ depth: Int)
    /// Default implementation sends both via [setDashboardPosition]; Nex overrides to one protobuf.
    func setDashboardHeightOnly(_ height: Int)
    func setDashboardDepthOnly(_ depth: Int)

    // MARK: - Dashboard Menu

    func setDashboardMenu(_ items: [[String: Any]])

    // MARK: - Device Control

    func setHeadUpAngle(_ angle: Int)
    func getBatteryStatus()
    func setSilentMode(_ enabled: Bool)
    func exit()
    func sendShutdown()
    func sendReboot()
    func sendRgbLedControl(
        requestId: String, packageName: String?, action: String, color: String?, onDurationMs: Int,
        offDurationMs: Int, count: Int
    )

    // MARK: - Connection Management

    func disconnect()
    func forget()
    func findCompatibleDevices()
    func stopScan()
    func connectById(_ id: String)
    func getConnectedBluetoothName() -> String?
    func connectController()
    func disconnectController()
    func cleanup()
    func ping()
    func dbg1()
    func dbg2()

    // MARK: - Network Management

    func requestWifiScan()
    func sendWifiCredentials(_ ssid: String, _ password: String)
    func forgetWifiNetwork(_ ssid: String)
    func sendHotspotState(_ enabled: Bool)
    func sendOtaStart()
    func sendOtaQueryStatus()

    // MARK: - User Context (for crash reporting)

    func sendUserEmailToGlasses(_ email: String)

    // MARK: - Incident Reporting

    func sendIncidentId(_ incidentId: String, apiBaseUrl: String?)

    // MARK: - Gallery

    func queryGalleryStatus()
    func sendGalleryMode()

    // MARK: - Voice Activity Detection

    func sendVoiceActivityDetectionSetting()

    // MARK: - Version Info

    func requestVersionInfo()
}

/// doesn't seem to work for concurrency reasons :(
/// we can make read-only getters for convienence though:
extension SGCManager {
    // MARK: - Dashboard (default: combined wire format; Nex implements single-field)

    func setDashboardHeightOnly(_ height: Int) {
        let d = DeviceStore.shared.get("bluetooth", "dashboard_depth") as? Int ?? 2
        setDashboardPosition(height, d)
    }

    func setDashboardDepthOnly(_ depth: Int) {
        let h = DeviceStore.shared.get("bluetooth", "dashboard_height") as? Int ?? 4
        setDashboardPosition(h, depth)
    }

    // MARK: - Dashboard Menu (default no-op — only G2 supports this)

    func setDashboardMenu(_: [[String: Any]]) {}

    // MARK: - Voice Activity Detection (default no-op — Mentra Live supports this)

    func sendVoiceActivityDetectionSetting() {}

    // MARK: - Default DeviceStore-backed property implementations

    var fullyBooted: Bool {
        DeviceStore.shared.get("glasses", "fullyBooted") as? Bool ?? false
    }

    var connected: Bool {
        DeviceStore.shared.get("glasses", "connected") as? Bool ?? false
    }

    var appVersion: String {
        DeviceStore.shared.get("glasses", "appVersion") as? String ?? ""
    }

    var buildNumber: String {
        DeviceStore.shared.get("glasses", "buildNumber") as? String ?? ""
    }

    var deviceModel: String {
        DeviceStore.shared.get("glasses", "deviceModel") as? String ?? ""
    }

    var androidVersion: String {
        DeviceStore.shared.get("glasses", "androidVersion") as? String ?? ""
    }

    var otaVersionUrl: String {
        DeviceStore.shared.get("glasses", "otaVersionUrl") as? String ?? ""
    }

    var firmwareVersion: String {
        DeviceStore.shared.get("glasses", "firmwareVersion") as? String ?? ""
    }

    var bluetoothMacAddress: String {
        DeviceStore.shared.get("glasses", "bluetoothMacAddress") as? String ?? ""
    }

    var serialNumber: String {
        DeviceStore.shared.get("glasses", "serialNumber") as? String ?? ""
    }

    var style: String {
        DeviceStore.shared.get("glasses", "style") as? String ?? ""
    }

    var color: String {
        DeviceStore.shared.get("glasses", "color") as? String ?? ""
    }

    var micEnabled: Bool {
        DeviceStore.shared.get("glasses", "micEnabled") as? Bool ?? false
    }

    var voiceActivityDetectionEnabled: Bool {
        DeviceStore.shared.get("glasses", "voiceActivityDetectionEnabled") as? Bool ?? true
    }

    var batteryLevel: Int {
        DeviceStore.shared.get("glasses", "batteryLevel") as? Int ?? -1
    }

    var headUp: Bool {
        DeviceStore.shared.get("glasses", "headUp") as? Bool ?? false
    }

    var charging: Bool {
        DeviceStore.shared.get("glasses", "charging") as? Bool ?? false
    }

    var caseOpen: Bool {
        DeviceStore.shared.get("glasses", "caseOpen") as? Bool ?? true
    }

    var caseRemoved: Bool {
        DeviceStore.shared.get("glasses", "caseRemoved") as? Bool ?? true
    }

    var caseCharging: Bool {
        DeviceStore.shared.get("glasses", "caseCharging") as? Bool ?? false
    }

    var caseBatteryLevel: Int {
        DeviceStore.shared.get("glasses", "caseBatteryLevel") as? Int ?? -1
    }

    var wifiSsid: String {
        DeviceStore.shared.get("glasses", "wifiSsid") as? String ?? ""
    }

    var wifiConnected: Bool {
        DeviceStore.shared.get("glasses", "wifiConnected") as? Bool ?? false
    }

    var wifiLocalIp: String {
        DeviceStore.shared.get("glasses", "wifiLocalIp") as? String ?? ""
    }

    var hotspotEnabled: Bool {
        DeviceStore.shared.get("glasses", "hotspotEnabled") as? Bool ?? false
    }

    var hotspotSsid: String {
        DeviceStore.shared.get("glasses", "hotspotSsid") as? String ?? ""
    }

    var hotspotPassword: String {
        DeviceStore.shared.get("glasses", "hotspotPassword") as? String ?? ""
    }

    var hotspotGatewayIp: String {
        DeviceStore.shared.get("glasses", "hotspotGatewayIp") as? String ?? ""
    }
}
