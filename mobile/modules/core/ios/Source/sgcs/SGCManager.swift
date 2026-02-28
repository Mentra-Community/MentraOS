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
        compress: String?, silent: Bool
    )
    func startRtmpStream(_ message: [String: Any])
    func stopRtmpStream()
    func sendRtmpKeepAlive(_ message: [String: Any])
    func startBufferRecording()
    func stopBufferRecording()
    func saveBufferVideo(requestId: String, durationSeconds: Int)
    func startVideoRecording(requestId: String, save: Bool, silent: Bool)
    func stopVideoRecording(requestId: String)

    // MARK: - Button Settings

    func sendButtonPhotoSettings()
    func sendButtonModeSetting()
    func sendButtonVideoRecordingSettings()
    func sendButtonMaxRecordingTime()
    func sendButtonCameraLedSetting()

    // MARK: - Display Control

    func setBrightness(_ level: Int, autoMode: Bool)
    func clearDisplay()
    func sendTextWall(_ text: String)
    func sendDoubleTextWall(_ top: String, _ bottom: String)
    func displayBitmap(base64ImageData: String) async -> Bool
    func showDashboard()
    func setDashboardPosition(_ height: Int, _ depth: Int)

    // MARK: - Device Control

    func setHeadUpAngle(_ angle: Int)
    func getBatteryStatus()
    func setSilentMode(_ enabled: Bool)
    func exit()
    func sendShutdown()
    func sendReboot()
    func sendRgbLedControl(
        requestId: String, packageName: String?, action: String, color: String?, ontime: Int,
        offtime: Int, count: Int
    )

    // MARK: - Connection Management

    func disconnect()
    func forget()
    func findCompatibleDevices()
    func connectById(_ id: String)
    func getConnectedBluetoothName() -> String?
    func cleanup()

    // MARK: - Network Management

    func requestWifiScan()
    func sendWifiCredentials(_ ssid: String, _ password: String)
    func forgetWifiNetwork(_ ssid: String)
    func sendHotspotState(_ enabled: Bool)
    func sendOtaStart()

    // MARK: - User Context (for crash reporting)

    func sendUserEmailToGlasses(_ email: String)

    // MARK: - Gallery

    func queryGalleryStatus()
    func sendGalleryMode()

    // MARK: - Version Info

    func requestVersionInfo()
}

// doesn't seem to work for concurrency reasons :(
// we can make read-only getters for convienence though:
extension SGCManager {
    // MARK: - Default GlassesStore-backed property implementations

    var fullyBooted: Bool { GlassesStore.shared.get("glasses", "fullyBooted") as? Bool ?? false }

    var connected: Bool { GlassesStore.shared.get("glasses", "connected") as? Bool ?? false }

    var appVersion: String { GlassesStore.shared.get("glasses", "appVersion") as? String ?? "" }

    var buildNumber: String { GlassesStore.shared.get("glasses", "buildNumber") as? String ?? "" }

    var deviceModel: String { GlassesStore.shared.get("glasses", "deviceModel") as? String ?? "" }

    var androidVersion: String { GlassesStore.shared.get("glasses", "androidVersion") as? String ?? "" }

    var otaVersionUrl: String { GlassesStore.shared.get("glasses", "otaVersionUrl") as? String ?? "" }

    var firmwareVersion: String { GlassesStore.shared.get("glasses", "fwVersion") as? String ?? "" }

    var btMacAddress: String { GlassesStore.shared.get("glasses", "btMacAddress") as? String ?? "" }

    var serialNumber: String { GlassesStore.shared.get("glasses", "serialNumber") as? String ?? "" }

    var style: String { GlassesStore.shared.get("glasses", "style") as? String ?? "" }

    var color: String { GlassesStore.shared.get("glasses", "color") as? String ?? "" }

    var micEnabled: Bool { GlassesStore.shared.get("glasses", "micEnabled") as? Bool ?? false }

    var batteryLevel: Int { GlassesStore.shared.get("glasses", "batteryLevel") as? Int ?? -1 }

    var headUp: Bool { GlassesStore.shared.get("glasses", "headUp") as? Bool ?? false }

    var charging: Bool { GlassesStore.shared.get("glasses", "charging") as? Bool ?? false }

    var caseOpen: Bool { GlassesStore.shared.get("glasses", "caseOpen") as? Bool ?? true }

    var caseRemoved: Bool { GlassesStore.shared.get("glasses", "caseRemoved") as? Bool ?? true }

    var caseCharging: Bool { GlassesStore.shared.get("glasses", "caseCharging") as? Bool ?? false }

    var caseBatteryLevel: Int { GlassesStore.shared.get("glasses", "caseBatteryLevel") as? Int ?? -1 }

    var wifiSsid: String { GlassesStore.shared.get("glasses", "wifiSsid") as? String ?? "" }

    var wifiConnected: Bool { GlassesStore.shared.get("glasses", "wifiConnected") as? Bool ?? false }

    var wifiLocalIp: String { GlassesStore.shared.get("glasses", "wifiLocalIp") as? String ?? "" }

    var hotspotEnabled: Bool { GlassesStore.shared.get("glasses", "hotspotEnabled") as? Bool ?? false }

    var hotspotSsid: String { GlassesStore.shared.get("glasses", "hotspotSsid") as? String ?? "" }

    var hotspotPassword: String { GlassesStore.shared.get("glasses", "hotspotPassword") as? String ?? "" }

    var hotspotGatewayIp: String { GlassesStore.shared.get("glasses", "hotspotGatewayIp") as? String ?? "" }
}
