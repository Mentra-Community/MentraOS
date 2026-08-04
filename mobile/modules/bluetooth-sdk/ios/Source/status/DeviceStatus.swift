import Foundation

public struct WifiScanResult: CustomStringConvertible {
    public let ssid: String
    public let requiresPassword: Bool
    public let signalStrength: Int
    public let frequency: Int?

    public init(ssid: String, requiresPassword: Bool, signalStrength: Int, frequency: Int? = nil) {
        self.ssid = ssid
        self.requiresPassword = requiresPassword
        self.signalStrength = signalStrength
        self.frequency = frequency
    }

    init(values: [String: Any]) {
        ssid = stringValue(values, "ssid") ?? ""
        requiresPassword = boolValue(values, "requiresPassword") ?? false
        signalStrength = intValue(values["signalStrength"]) ?? -1
        frequency = intValue(values["frequency"])
    }

    var dictionary: [String: Any] {
        var values: [String: Any] = [
            "ssid": ssid,
            "requiresPassword": requiresPassword,
            "signalStrength": signalStrength,
        ]
        if let frequency {
            values["frequency"] = frequency
        }
        return values
    }

    public var description: String {
        "WifiScanResult(ssid: \(ssid), signalStrength: \(signalStrength))"
    }
}

public enum GlassesConnectionState: String, CustomStringConvertible, Equatable {
    case disconnected = "DISCONNECTED"
    case scanning = "SCANNING"
    case connecting = "CONNECTING"
    case bonding = "BONDING"
    case connected = "CONNECTED"

    public init(_ value: String?) {
        self = Self.fromValue(value) ?? .disconnected
    }

    public static func fromValue(_ value: String?) -> GlassesConnectionState? {
        guard let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
              !normalized.isEmpty
        else {
            return nil
        }
        return Self(rawValue: normalized)
    }

    public var isConnected: Bool {
        self == .connected
    }

    public var isBusy: Bool {
        self == .scanning || self == .connecting || self == .bonding
    }

    func statusValues(connected: Bool, fullyBooted: Bool) -> [String: Any] {
        if self == .connected || connected || fullyBooted {
            return ["state": "connected", "fullyBooted": fullyBooted]
        }
        switch self {
        case .scanning:
            return ["state": "scanning"]
        case .connecting:
            return ["state": "connecting"]
        case .bonding:
            return ["state": "bonding"]
        case .connected:
            return ["state": "connected", "fullyBooted": fullyBooted]
        case .disconnected:
            return ["state": "disconnected"]
        }
    }

    public var description: String {
        rawValue
    }
}

struct GlassesStatus: CustomStringConvertible {
    let values: [String: Any]

    func applying(_ update: GlassesStatusUpdate) -> GlassesStatus {
        GlassesStatus(values: values.merging(update.values) { _, new in new })
    }

    func withBattery(level: Int, charging: Bool) -> GlassesStatus {
        applying(GlassesStatusUpdate(values: ["batteryLevel": level, "charging": charging]))
    }

    func withWifi(_ wifi: WifiStatus) -> GlassesStatus {
        applying(GlassesStatusUpdate(values: wifi.storeValues))
    }

    func withHotspot(_ hotspot: HotspotStatus) -> GlassesStatus {
        applying(GlassesStatusUpdate(values: hotspot.storeValues))
    }

    func disconnected() -> GlassesStatus {
        applying(GlassesStatusUpdate(values: [
            "connected": false,
            "connectionState": "DISCONNECTED",
            "fullyBooted": false,
            "batteryLevel": -1,
            "charging": false,
            "hotspotEnabled": false,
            "hotspotGatewayIp": "",
            "hotspotPassword": "",
            "hotspotSsid": "",
            "wifiConnected": false,
            "wifiSsid": "",
            "wifiLocalIp": "",
            "signalStrength": -1,
            "signalStrengthUpdatedAt": 0,
        ]))
    }

    var fullyBooted: Bool {
        boolValue(values, "fullyBooted") ?? false
    }

    var connected: Bool {
        boolValue(values, "connected") ?? false
    }

    var micEnabled: Bool {
        boolValue(values, "micEnabled") ?? false
    }

    var voiceActivityDetectionEnabled: Bool {
        boolValue(values, "voiceActivityDetectionEnabled") ?? BluetoothSdkDefaults.voiceActivityDetectionEnabled
    }

    var connectionState: GlassesConnectionState {
        GlassesConnectionState(stringValue(values, "connectionState"))
    }

    var bluetoothClassicConnected: Bool {
        boolValue(values, "bluetoothClassicConnected") ?? false
    }

    var signalStrength: Int {
        intValue(values["signalStrength"]) ?? -1
    }

    var signalStrengthUpdatedAt: Int {
        intValue(values["signalStrengthUpdatedAt"]) ?? 0
    }

    var deviceModel: String {
        stringValue(values, "deviceModel") ?? ""
    }

    var androidVersion: String {
        stringValue(values, "androidVersion") ?? ""
    }

    var firmwareVersion: String {
        stringValue(values, "firmwareVersion") ?? ""
    }

    var besFirmwareVersion: String {
        stringValue(values, "besFirmwareVersion") ?? ""
    }

    var mtkFirmwareVersion: String {
        stringValue(values, "mtkFirmwareVersion") ?? ""
    }

    var bluetoothMacAddress: String {
        stringValue(values, "bluetoothMacAddress") ?? ""
    }

    var leftMacAddress: String {
        stringValue(values, "leftMacAddress") ?? ""
    }

    var rightMacAddress: String {
        stringValue(values, "rightMacAddress") ?? ""
    }

    var macAddress: String {
        stringValue(values, "macAddress") ?? ""
    }

    var buildNumber: String {
        stringValue(values, "buildNumber") ?? ""
    }

    var otaVersionUrl: String {
        stringValue(values, "otaVersionUrl") ?? ""
    }

    var appVersion: String {
        stringValue(values, "appVersion") ?? ""
    }

    var bluetoothName: String {
        stringValue(values, "bluetoothName") ?? ""
    }

    var serialNumber: String {
        stringValue(values, "serialNumber") ?? ""
    }

    var style: String {
        stringValue(values, "style") ?? ""
    }

    var color: String {
        stringValue(values, "color") ?? ""
    }

    var wifi: WifiStatus {
        WifiStatus.fromStoreValues(values) ?? .disconnected
    }

    var hotspot: HotspotStatus {
        HotspotStatus.fromStoreValues(values) ?? .disabled
    }

    var dictionary: [String: Any] {
        Self.dictionary(from: values)
    }

    var batteryLevel: Int {
        intValue(values["batteryLevel"]) ?? -1
    }

    var charging: Bool {
        boolValue(values, "charging") ?? false
    }

    var caseBatteryLevel: Int {
        intValue(values["caseBatteryLevel"]) ?? -1
    }

    var caseCharging: Bool {
        boolValue(values, "caseCharging") ?? false
    }

    var caseOpen: Bool {
        boolValue(values, "caseOpen") ?? true
    }

    var caseRemoved: Bool {
        boolValue(values, "caseRemoved") ?? true
    }

    var headUp: Bool {
        boolValue(values, "headUp") ?? false
    }

    var controllerConnected: Bool {
        boolValue(values, "controllerConnected") ?? false
    }

    var controllerFullyBooted: Bool {
        boolValue(values, "controllerFullyBooted") ?? false
    }

    var controllerMacAddress: String {
        stringValue(values, "controllerMacAddress") ?? ""
    }

    var controllerBatteryLevel: Int {
        intValue(values["controllerBatteryLevel"]) ?? -1
    }

    var controllerSignalStrength: Int {
        intValue(values["controllerSignalStrength"]) ?? -1
    }

    var ringSignalStrength: Int {
        intValue(values["ringSignalStrength"]) ?? -1
    }

    var description: String {
        values.description
    }

    static func dictionary(from values: [String: Any]) -> [String: Any] {
        var dictionary = values
        dictionary["connection"] = GlassesConnectionState(stringValue(values, "connectionState")).statusValues(
            connected: boolValue(values, "connected") ?? false,
            fullyBooted: boolValue(values, "fullyBooted") ?? false
        )
        dictionary.removeValue(forKey: "connected")
        dictionary.removeValue(forKey: "fullyBooted")
        dictionary.removeValue(forKey: "connectionState")
        dictionary["wifi"] = (WifiStatus.fromStoreValues(values) ?? .disconnected).values
        dictionary["hotspot"] = (HotspotStatus.fromStoreValues(values) ?? .disabled).values
        dictionary.removeValue(forKey: "wifiConnected")
        dictionary.removeValue(forKey: "wifiSsid")
        dictionary.removeValue(forKey: "wifiLocalIp")
        dictionary.removeValue(forKey: "hotspotEnabled")
        dictionary.removeValue(forKey: "hotspotSsid")
        dictionary.removeValue(forKey: "hotspotPassword")
        dictionary.removeValue(forKey: "hotspotGatewayIp")
        return dictionary
    }

    static func updateDictionary(from values: [String: Any]) -> [String: Any] {
        var dictionary = values
        if hasAnyKey(values, "connection", "connected", "fullyBooted", "connectionState") {
            dictionary["connection"] = (values["connection"] as? [String: Any])
                ?? GlassesConnectionState(stringValue(values, "connectionState")).statusValues(
                    connected: boolValue(values, "connected") ?? false,
                    fullyBooted: boolValue(values, "fullyBooted") ?? false
                )
            dictionary.removeValue(forKey: "connected")
            dictionary.removeValue(forKey: "fullyBooted")
            dictionary.removeValue(forKey: "connectionState")
        }
        if hasAnyKey(values, "wifi", "wifiConnected", "wifiSsid", "wifiLocalIp") {
            let wifi = (values["wifi"] as? [String: Any]).flatMap(WifiStatus.init(values:))
                ?? WifiStatus.fromStoreValues(values)
            if let wifi {
                dictionary["wifi"] = wifi.values
            }
            dictionary.removeValue(forKey: "wifiConnected")
            dictionary.removeValue(forKey: "wifiSsid")
            dictionary.removeValue(forKey: "wifiLocalIp")
        }
        if hasAnyKey(values, "hotspot") {
            if let hotspot = (values["hotspot"] as? [String: Any]).flatMap(HotspotStatus.init(values:)) {
                dictionary["hotspot"] = hotspot.values
            }
        } else if hasAnyKey(values, "hotspotEnabled", "hotspotSsid", "hotspotPassword", "hotspotGatewayIp") {
            if let hotspot = HotspotStatus.fromStoreValues(values) {
                dictionary["hotspot"] = hotspot.values
            }
            dictionary.removeValue(forKey: "hotspotEnabled")
            dictionary.removeValue(forKey: "hotspotSsid")
            dictionary.removeValue(forKey: "hotspotPassword")
            dictionary.removeValue(forKey: "hotspotGatewayIp")
        }
        return dictionary
    }
}

public struct VersionInfoResult: CustomStringConvertible {
    public let androidVersion: String
    public let firmwareVersion: String
    public let besFirmwareVersion: String
    public let mtkFirmwareVersion: String
    public let buildNumber: String
    public let systemTimeMs: Int?
    public let otaVersionUrl: String
    public let appVersion: String

    init(status: GlassesStatus) {
        androidVersion = status.androidVersion
        firmwareVersion = status.firmwareVersion
        besFirmwareVersion = status.besFirmwareVersion
        mtkFirmwareVersion = status.mtkFirmwareVersion
        buildNumber = status.buildNumber
        systemTimeMs = intValue(status.values["systemTimeMs"])
        otaVersionUrl = status.otaVersionUrl
        appVersion = status.appVersion
    }

    init(values: [String: Any]) {
        androidVersion = stringValue(values, "androidVersion", "android_version") ?? ""
        firmwareVersion = stringValue(values, "firmwareVersion", "firmware_version") ?? ""
        besFirmwareVersion = stringValue(values, "besFirmwareVersion", "bes_fw_version") ?? ""
        mtkFirmwareVersion = stringValue(values, "mtkFirmwareVersion", "mtk_fw_version") ?? ""
        buildNumber = stringValue(values, "buildNumber", "build_number") ?? ""
        systemTimeMs = intValue(values["systemTimeMs"]) ?? intValue(values["system_time_ms"])
        otaVersionUrl = stringValue(values, "otaVersionUrl", "ota_version_url") ?? ""
        appVersion = stringValue(values, "appVersion", "app_version") ?? ""
    }

    public var dictionary: [String: Any] {
        var values: [String: Any] = [
            "androidVersion": androidVersion,
            "firmwareVersion": firmwareVersion,
            "besFirmwareVersion": besFirmwareVersion,
            "mtkFirmwareVersion": mtkFirmwareVersion,
            "buildNumber": buildNumber,
            "otaVersionUrl": otaVersionUrl,
            "appVersion": appVersion,
        ]
        if let systemTimeMs {
            values["systemTimeMs"] = systemTimeMs
        }
        return values
    }

    public var description: String {
        "VersionInfoResult(buildNumber: \(buildNumber), appVersion: \(appVersion))"
    }
}

struct BluetoothStatus: CustomStringConvertible {
    let values: [String: Any]

    init(values: [String: Any]) {
        self.values = Self.normalized(values)
    }

    private static func normalized(_ values: [String: Any]) -> [String: Any] {
        var normalizedValues = values
        if let searchResults = values["searchResults"] as? [[String: Any]] {
            normalizedValues["searchResults"] = searchResults.compactMap { Device(values: $0)?.dictionary }
        }
        if let galleryMode = boolValue(values, "gallery_mode") {
            normalizedValues["galleryModeEnabled"] = galleryMode
            normalizedValues.removeValue(forKey: "gallery_mode")
        }
        return normalizedValues
    }

    func applying(_ update: BluetoothStatusUpdate) -> BluetoothStatus {
        BluetoothStatus(values: values.merging(update.values) { _, new in new })
    }

    func withDefaultDevice(_ device: Device?) -> BluetoothStatus {
        applying(BluetoothStatusUpdate(values: [
            "default_wearable": device?.model.deviceType ?? "",
            "device_name": device?.name ?? "",
            "device_address": device?.identifier ?? "",
        ]))
    }

    var searching: Bool {
        boolValue(values, "searching") ?? false
    }

    var searchingController: Bool {
        boolValue(values, "searchingController") ?? false
    }

    var systemMicUnavailable: Bool {
        boolValue(values, "systemMicUnavailable") ?? false
    }

    var micEnabled: Bool {
        boolValue(values, "micEnabled") ?? false
    }

    var currentMic: String {
        stringValue(values, "currentMic") ?? ""
    }

    var micRanking: [String] {
        stringListValue(values, "micRanking")
    }

    /// Nearby glasses in stable discovery order. Existing entries keep their array position as
    /// details refresh; new glasses append at the end, and removals should not reorder remaining entries.
    var searchResults: [Device] {
        dictionaryListValue(values, "searchResults").compactMap(Device.init(values:))
    }

    var wifiScanResults: [WifiScanResult] {
        dictionaryListValue(values, "wifiScanResults").map(WifiScanResult.init(values:))
    }

    var lastLog: [String] {
        stringListValue(values, "lastLog")
    }

    var otherBtConnected: Bool {
        boolValue(values, "otherBtConnected") ?? false
    }

    var defaultWearable: String {
        stringValue(values, "default_wearable") ?? ""
    }

    var pendingWearable: String {
        stringValue(values, "pending_wearable") ?? ""
    }

    var deviceName: String {
        stringValue(values, "device_name") ?? ""
    }

    var deviceAddress: String {
        stringValue(values, "device_address") ?? ""
    }

    var defaultController: String {
        stringValue(values, "default_controller") ?? ""
    }

    var pendingController: String {
        stringValue(values, "pending_controller") ?? ""
    }

    var controllerDeviceName: String {
        stringValue(values, "controller_device_name") ?? ""
    }

    var screenDisabled: Bool {
        boolValue(values, "screen_disabled") ?? false
    }

    var preferredMic: String {
        stringValue(values, "preferred_mic") ?? "auto"
    }

    var sensingEnabled: Bool {
        boolValue(values, "sensing_enabled") ?? true
    }

    var powerSavingMode: Bool {
        boolValue(values, "power_saving_mode") ?? false
    }

    var brightness: Int {
        intValue(values["brightness"]) ?? 50
    }

    var autoBrightness: Bool {
        boolValue(values, "auto_brightness") ?? true
    }

    var dashboardHeight: Int {
        intValue(values["dashboard_height"]) ?? 4
    }

    var dashboardDepth: Int {
        intValue(values["dashboard_depth"]) ?? 2
    }

    var headUpAngle: Int {
        intValue(values["head_up_angle"]) ?? 30
    }

    var contextualDashboard: Bool {
        boolValue(values, "contextual_dashboard") ?? true
    }

    var galleryModeEnabled: Bool {
        boolValue(values, "gallery_mode") ?? boolValue(values, "galleryModeEnabled") ?? true
    }

    var buttonPhotoSize: ButtonPhotoSize {
        ButtonPhotoSize(rawValue: stringValue(values, "button_photo_size") ?? "") ?? .medium
    }

    var buttonMaxRecordingTime: Int {
        intValue(values["button_max_recording_time"]) ?? 10
    }

    var buttonVideoWidth: Int {
        intValue(values["button_video_width"]) ?? 1280
    }

    var buttonVideoHeight: Int {
        intValue(values["button_video_height"]) ?? 720
    }

    var buttonVideoFrameRate: Int {
        intValue(values["button_video_fps"]) ?? 30
    }

    var shouldSendPcm: Bool {
        boolValue(values, "should_send_pcm") ?? false
    }

    var shouldSendLc3: Bool {
        boolValue(values, "should_send_lc3") ?? false
    }

    var shouldSendTranscript: Bool {
        boolValue(values, "should_send_transcript") ?? false
    }

    var localSttFallbackActive: Bool {
        boolValue(values, "local_stt_fallback_active") ?? false
    }

    var shouldSendBootingMessage: Bool {
        boolValue(values, "shouldSendBootingMessage") ?? true
    }

    var defaultDevice: Device? {
        guard !defaultWearable.isEmpty else { return nil }
        return Device(
            model: DeviceModel.fromDeviceType(defaultWearable),
            name: deviceName,
            identifier: deviceAddress.isEmpty ? nil : deviceAddress
        )
    }

    var description: String {
        values.description
    }
}

struct GlassesStatusUpdate: CustomStringConvertible {
    let values: [String: Any]

    var fullyBooted: Bool? {
        optionalBoolValue(values, "fullyBooted")
    }

    var connected: Bool? {
        optionalBoolValue(values, "connected")
    }

    var micEnabled: Bool? {
        optionalBoolValue(values, "micEnabled")
    }

    var voiceActivityDetectionEnabled: Bool? {
        optionalBoolValue(values, "voiceActivityDetectionEnabled")
    }

    var connectionState: GlassesConnectionState? {
        GlassesConnectionState.fromValue(optionalStringValue(values, "connectionState"))
    }

    var bluetoothClassicConnected: Bool? {
        optionalBoolValue(values, "bluetoothClassicConnected")
    }

    var signalStrength: Int? {
        optionalIntValue(values, "signalStrength")
    }

    var signalStrengthUpdatedAt: Int? {
        optionalIntValue(values, "signalStrengthUpdatedAt")
    }

    var deviceModel: String? {
        optionalStringValue(values, "deviceModel")
    }

    var androidVersion: String? {
        optionalStringValue(values, "androidVersion")
    }

    var firmwareVersion: String? {
        optionalStringValue(values, "firmwareVersion")
    }

    var besFirmwareVersion: String? {
        optionalStringValue(values, "besFirmwareVersion")
    }

    var mtkFirmwareVersion: String? {
        optionalStringValue(values, "mtkFirmwareVersion")
    }

    var bluetoothMacAddress: String? {
        optionalStringValue(values, "bluetoothMacAddress")
    }

    var leftMacAddress: String? {
        optionalStringValue(values, "leftMacAddress")
    }

    var rightMacAddress: String? {
        optionalStringValue(values, "rightMacAddress")
    }

    var macAddress: String? {
        optionalStringValue(values, "macAddress")
    }

    var buildNumber: String? {
        optionalStringValue(values, "buildNumber")
    }

    var otaVersionUrl: String? {
        optionalStringValue(values, "otaVersionUrl")
    }

    var appVersion: String? {
        optionalStringValue(values, "appVersion")
    }

    var bluetoothName: String? {
        optionalStringValue(values, "bluetoothName")
    }

    var serialNumber: String? {
        optionalStringValue(values, "serialNumber")
    }

    var style: String? {
        optionalStringValue(values, "style")
    }

    var color: String? {
        optionalStringValue(values, "color")
    }

    var wifi: WifiStatus? {
        if let wifi = values["wifi"] as? [String: Any] {
            return WifiStatus(values: wifi)
        }
        if hasAnyKey(values, "wifiConnected", "wifiSsid", "wifiLocalIp") {
            return WifiStatus.fromStoreValues(values)
        }
        return nil
    }

    var hotspot: HotspotStatus? {
        if let hotspot = values["hotspot"] as? [String: Any] {
            return HotspotStatus(values: hotspot)
        }
        if hasAnyKey(values, "hotspotEnabled", "hotspotSsid", "hotspotPassword", "hotspotGatewayIp") {
            return HotspotStatus.fromStoreValues(values)
        }
        return nil
    }

    var dictionary: [String: Any] {
        GlassesStatus.updateDictionary(from: values)
    }

    var batteryLevel: Int? {
        optionalIntValue(values, "batteryLevel")
    }

    var charging: Bool? {
        optionalBoolValue(values, "charging")
    }

    var caseBatteryLevel: Int? {
        optionalIntValue(values, "caseBatteryLevel")
    }

    var caseCharging: Bool? {
        optionalBoolValue(values, "caseCharging")
    }

    var caseOpen: Bool? {
        optionalBoolValue(values, "caseOpen")
    }

    var caseRemoved: Bool? {
        optionalBoolValue(values, "caseRemoved")
    }

    var headUp: Bool? {
        optionalBoolValue(values, "headUp")
    }

    var controllerConnected: Bool? {
        optionalBoolValue(values, "controllerConnected")
    }

    var controllerFullyBooted: Bool? {
        optionalBoolValue(values, "controllerFullyBooted")
    }

    var controllerMacAddress: String? {
        optionalStringValue(values, "controllerMacAddress")
    }

    var controllerBatteryLevel: Int? {
        optionalIntValue(values, "controllerBatteryLevel")
    }

    var controllerSignalStrength: Int? {
        optionalIntValue(values, "controllerSignalStrength")
    }

    var ringSignalStrength: Int? {
        optionalIntValue(values, "ringSignalStrength")
    }

    var description: String {
        values.description
    }
}

struct BluetoothStatusUpdate: CustomStringConvertible {
    let values: [String: Any]

    init(values: [String: Any]) {
        var normalizedValues = values
        if let searchResults = values["searchResults"] as? [[String: Any]] {
            normalizedValues["searchResults"] = searchResults.compactMap { Device(values: $0)?.dictionary }
        }
        if let galleryMode = optionalBoolValue(values, "gallery_mode") {
            normalizedValues["galleryModeEnabled"] = galleryMode
            normalizedValues.removeValue(forKey: "gallery_mode")
        }
        self.values = normalizedValues
    }

    var searching: Bool? {
        optionalBoolValue(values, "searching")
    }

    var searchingController: Bool? {
        optionalBoolValue(values, "searchingController")
    }

    var systemMicUnavailable: Bool? {
        optionalBoolValue(values, "systemMicUnavailable")
    }

    var micEnabled: Bool? {
        optionalBoolValue(values, "micEnabled")
    }

    var currentMic: String? {
        optionalStringValue(values, "currentMic")
    }

    var micRanking: [String]? {
        optionalStringListValue(values, "micRanking")
    }

    /// Nearby glasses in stable discovery order when included in an update. Existing entries keep their
    /// array position as details refresh; new glasses append at the end, and removals should not reorder
    /// remaining entries.
    var searchResults: [Device]? {
        optionalDictionaryListValue(values, "searchResults")?.compactMap(Device.init(values:))
    }

    var wifiScanResults: [WifiScanResult]? {
        optionalDictionaryListValue(values, "wifiScanResults")?.map(WifiScanResult.init(values:))
    }

    var lastLog: [String]? {
        optionalStringListValue(values, "lastLog")
    }

    var otherBtConnected: Bool? {
        optionalBoolValue(values, "otherBtConnected")
    }

    var defaultWearable: String? {
        optionalStringValue(values, "default_wearable")
    }

    var pendingWearable: String? {
        optionalStringValue(values, "pending_wearable")
    }

    var deviceName: String? {
        optionalStringValue(values, "device_name")
    }

    var deviceAddress: String? {
        optionalStringValue(values, "device_address")
    }

    var defaultController: String? {
        optionalStringValue(values, "default_controller")
    }

    var pendingController: String? {
        optionalStringValue(values, "pending_controller")
    }

    var controllerDeviceName: String? {
        optionalStringValue(values, "controller_device_name")
    }

    var screenDisabled: Bool? {
        optionalBoolValue(values, "screen_disabled")
    }

    var preferredMic: String? {
        optionalStringValue(values, "preferred_mic")
    }

    var sensingEnabled: Bool? {
        optionalBoolValue(values, "sensing_enabled")
    }

    var powerSavingMode: Bool? {
        optionalBoolValue(values, "power_saving_mode")
    }

    var brightness: Int? {
        optionalIntValue(values, "brightness")
    }

    var autoBrightness: Bool? {
        optionalBoolValue(values, "auto_brightness")
    }

    var dashboardHeight: Int? {
        optionalIntValue(values, "dashboard_height")
    }

    var dashboardDepth: Int? {
        optionalIntValue(values, "dashboard_depth")
    }

    var headUpAngle: Int? {
        optionalIntValue(values, "head_up_angle")
    }

    var contextualDashboard: Bool? {
        optionalBoolValue(values, "contextual_dashboard")
    }

    var galleryModeEnabled: Bool? {
        optionalBoolValue(values, "gallery_mode") ?? optionalBoolValue(values, "galleryModeEnabled")
    }

    var buttonPhotoSize: ButtonPhotoSize? {
        optionalStringValue(values, "button_photo_size").map { ButtonPhotoSize(normalizedRawValue: $0) }
    }

    var buttonMaxRecordingTime: Int? {
        optionalIntValue(values, "button_max_recording_time")
    }

    var buttonVideoWidth: Int? {
        optionalIntValue(values, "button_video_width")
    }

    var buttonVideoHeight: Int? {
        optionalIntValue(values, "button_video_height")
    }

    var buttonVideoFrameRate: Int? {
        optionalIntValue(values, "button_video_fps")
    }

    var shouldSendPcm: Bool? {
        optionalBoolValue(values, "should_send_pcm")
    }

    var shouldSendLc3: Bool? {
        optionalBoolValue(values, "should_send_lc3")
    }

    var shouldSendTranscript: Bool? {
        optionalBoolValue(values, "should_send_transcript")
    }

    var localSttFallbackActive: Bool? {
        optionalBoolValue(values, "local_stt_fallback_active")
    }

    var shouldSendBootingMessage: Bool? {
        optionalBoolValue(values, "shouldSendBootingMessage")
    }

    var description: String {
        values.description
    }
}
