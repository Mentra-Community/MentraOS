import CoreBluetooth
import Foundation

private func intValue(_ value: Any?) -> Int? {
    if let int = value as? Int { return int }
    if let double = value as? Double { return Int(double) }
    if let number = value as? NSNumber { return number.intValue }
    return nil
}

private func stringValue(_ values: [String: Any], _ keys: String...) -> String? {
    stringValue(values, keys)
}

private func stringValue(_ values: [String: Any], _ keys: [String]) -> String? {
    for key in keys {
        if let value = values[key] as? String {
            return value
        }
    }
    return nil
}

private func boolValue(_ values: [String: Any], _ keys: String...) -> Bool? {
    boolValue(values, keys)
}

private func boolValue(_ values: [String: Any], _ keys: [String]) -> Bool? {
    for key in keys {
        if let value = values[key] as? Bool { return value }
        if let value = values[key] as? NSNumber { return value.boolValue }
    }
    return nil
}

private func hasAnyKey(_ values: [String: Any], _ keys: String...) -> Bool {
    hasAnyKey(values, keys)
}

private func hasAnyKey(_ values: [String: Any], _ keys: [String]) -> Bool {
    keys.contains { values.keys.contains($0) }
}

private func optionalStringValue(_ values: [String: Any], _ keys: String...) -> String? {
    hasAnyKey(values, keys) ? (stringValue(values, keys) ?? "") : nil
}

private func nonEmptyStringValue(_ values: [String: Any], _ keys: String...) -> String? {
    for key in keys {
        guard let value = values[key] as? String else { continue }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return value
        }
    }
    return nil
}

private func optionalIntValue(_ values: [String: Any], _ keys: String...) -> Int? {
    guard hasAnyKey(values, keys) else { return nil }
    for key in keys {
        if let value = intValue(values[key]) { return value }
    }
    return nil
}

private func optionalBoolValue(_ values: [String: Any], _ keys: String...) -> Bool? {
    hasAnyKey(values, keys) ? (boolValue(values, keys) ?? false) : nil
}

private func stringListValue(_ values: [String: Any], _ key: String) -> [String] {
    values[key] as? [String] ?? []
}

private func optionalStringListValue(_ values: [String: Any], _ key: String) -> [String]? {
    values.keys.contains(key) ? stringListValue(values, key) : nil
}

private func dictionaryListValue(_ values: [String: Any], _ key: String) -> [[String: Any]] {
    values[key] as? [[String: Any]] ?? []
}

private func optionalDictionaryListValue(_ values: [String: Any], _ key: String) -> [[String: Any]]? {
    values.keys.contains(key) ? dictionaryListValue(values, key) : nil
}

private func putIfNotNil(_ map: inout [String: Any], _ key: String, _ value: Any?) {
    if let value {
        map[key] = value
    }
}

public struct MentraBluetoothSDKConfiguration {
    public static let `default` = MentraBluetoothSDKConfiguration()

    public init() {}
}

public enum MentraDeviceModel: String {
    case g1
    case g2
    case mentraLive
    case mentraNex
    case mach1
    case z100
    case frame
    case simulated
    case r1

    public var deviceType: String {
        switch self {
        case .g1:
            DeviceTypes.G1
        case .g2:
            DeviceTypes.G2
        case .mentraLive:
            DeviceTypes.LIVE
        case .mentraNex:
            DeviceTypes.NEX
        case .mach1:
            DeviceTypes.MACH1
        case .z100:
            DeviceTypes.Z100
        case .frame:
            DeviceTypes.FRAME
        case .simulated:
            DeviceTypes.SIMULATED
        case .r1:
            ControllerTypes.R1
        }
    }

    public static func fromDeviceType(_ deviceType: String?) -> MentraDeviceModel {
        switch deviceType {
        case DeviceTypes.G1:
            .g1
        case DeviceTypes.G2:
            .g2
        case DeviceTypes.LIVE:
            .mentraLive
        case DeviceTypes.NEX:
            .mentraNex
        case DeviceTypes.MACH1:
            .mach1
        case DeviceTypes.Z100:
            .z100
        case DeviceTypes.FRAME:
            .frame
        case DeviceTypes.SIMULATED:
            .simulated
        case ControllerTypes.R1:
            .r1
        default:
            .mentraLive
        }
    }
}

public struct MentraDevice: Identifiable, Equatable, CustomStringConvertible {
    public let model: MentraDeviceModel
    public let name: String
    public let identifier: String?
    public let rssi: Int?
    public let id: String

    public init(
        model: MentraDeviceModel,
        name: String,
        identifier: String? = nil,
        rssi: Int? = nil,
        id: String? = nil
    ) {
        self.model = model
        self.name = name
        self.identifier = identifier
        self.rssi = rssi
        self.id = id ?? identifier.flatMap { $0.isEmpty ? nil : $0 } ?? "\(model.deviceType):\(name)"
    }

    public var description: String {
        "MentraDevice(model: \(model), name: \(name))"
    }

    var dictionary: [String: Any] {
        var values: [String: Any] = [
            "id": id,
            "model": model.deviceType,
            "name": name,
        ]
        if let identifier, !identifier.isEmpty {
            values["address"] = identifier
        }
        if let rssi {
            values["rssi"] = rssi
        }
        return values
    }

    init?(values: [String: Any]) {
        guard let model = stringValue(values, "model", "deviceModel", "device_model") else { return nil }
        guard let name = stringValue(values, "name", "deviceName", "device_name") else { return nil }
        let identifier = stringValue(values, "address", "deviceAddress", "device_address").flatMap { $0.isEmpty ? nil : $0 }
        let rssi = intValue(values["rssi"]) ?? intValue(values["signalStrength"]) ?? intValue(values["signal_strength"])
        self.init(
            model: MentraDeviceModel.fromDeviceType(model),
            name: name,
            identifier: identifier,
            rssi: rssi,
            id: stringValue(values, "id")
        )
    }
}

public struct MentraConnectOptions {
    public let saveAsDefault: Bool
    public let cancelExistingConnectionAttempt: Bool

    public init(saveAsDefault: Bool = true, cancelExistingConnectionAttempt: Bool = true) {
        self.saveAsDefault = saveAsDefault
        self.cancelExistingConnectionAttempt = cancelExistingConnectionAttempt
    }
}

public struct MentraWifiScanResult: CustomStringConvertible {
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
        requiresPassword = boolValue(values, "requiresPassword", "requires_password", "auth_required") ?? false
        signalStrength = intValue(values["signalStrength"] ?? values["signal_strength"] ?? values["rssi"]) ?? -1
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
        "MentraWifiScanResult(ssid: \(ssid), signalStrength: \(signalStrength))"
    }
}

public struct MentraGlassesStatus: CustomStringConvertible {
    let values: [String: Any]

    init(values: [String: Any]) {
        self.values = values
    }

    public func applying(_ update: MentraGlassesStatusUpdate) -> MentraGlassesStatus {
        MentraGlassesStatus(values: values.merging(update.values) { _, new in new })
    }

    public func withBattery(level: Int, charging: Bool) -> MentraGlassesStatus {
        applying(MentraGlassesStatusUpdate(values: ["batteryLevel": level, "charging": charging]))
    }

    public func withWifi(_ wifi: MentraWifiStatus) -> MentraGlassesStatus {
        applying(MentraGlassesStatusUpdate(values: wifi.storeValues))
    }

    public func withHotspot(enabled: Bool, ssid: String, password: String, gatewayIp: String) -> MentraGlassesStatus {
        applying(MentraGlassesStatusUpdate(values: [
            "hotspotEnabled": enabled,
            "hotspotSsid": ssid,
            "hotspotPassword": password,
            "hotspotGatewayIp": gatewayIp,
        ]))
    }

    public func disconnected() -> MentraGlassesStatus {
        applying(MentraGlassesStatusUpdate(values: [
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

    public var fullyBooted: Bool { boolValue(values, "fullyBooted") ?? false }
    public var connected: Bool { boolValue(values, "connected") ?? false }
    public var micEnabled: Bool { boolValue(values, "micEnabled") ?? false }
    public var connectionState: String { stringValue(values, "connectionState") ?? "disconnected" }
    public var btcConnected: Bool { boolValue(values, "btcConnected") ?? false }
    public var signalStrength: Int { intValue(values["signalStrength"]) ?? -1 }
    public var signalStrengthUpdatedAt: Int { intValue(values["signalStrengthUpdatedAt"]) ?? 0 }
    public var deviceModel: String { stringValue(values, "deviceModel") ?? "" }
    public var androidVersion: String { stringValue(values, "androidVersion") ?? "" }
    public var firmwareVersion: String { stringValue(values, "firmwareVersion", "fwVersion") ?? "" }
    public var besFirmwareVersion: String { stringValue(values, "besFwVersion", "besFirmwareVersion") ?? "" }
    public var mtkFirmwareVersion: String { stringValue(values, "mtkFwVersion", "mtkFirmwareVersion") ?? "" }
    public var btMacAddress: String { stringValue(values, "btMacAddress") ?? "" }
    public var leftMacAddress: String { stringValue(values, "leftMacAddress") ?? "" }
    public var rightMacAddress: String { stringValue(values, "rightMacAddress") ?? "" }
    public var macAddress: String { stringValue(values, "macAddress") ?? "" }
    public var buildNumber: String { stringValue(values, "buildNumber") ?? "" }
    public var otaVersionUrl: String { stringValue(values, "otaVersionUrl") ?? "" }
    public var appVersion: String { stringValue(values, "appVersion") ?? "" }
    public var bluetoothName: String { stringValue(values, "bluetoothName") ?? "" }
    public var serialNumber: String { stringValue(values, "serialNumber") ?? "" }
    public var style: String { stringValue(values, "style") ?? "" }
    public var color: String { stringValue(values, "color") ?? "" }
    public var wifi: MentraWifiStatus { MentraWifiStatus(values: values) }
    public var dictionary: [String: Any] { Self.dictionary(from: values) }
    public var batteryLevel: Int { intValue(values["batteryLevel"]) ?? -1 }
    public var charging: Bool { boolValue(values, "charging") ?? false }
    public var caseBatteryLevel: Int { intValue(values["caseBatteryLevel"]) ?? -1 }
    public var caseCharging: Bool { boolValue(values, "caseCharging") ?? false }
    public var caseOpen: Bool { boolValue(values, "caseOpen") ?? true }
    public var caseRemoved: Bool { boolValue(values, "caseRemoved") ?? true }
    public var hotspotEnabled: Bool { boolValue(values, "hotspotEnabled") ?? false }
    public var hotspotSsid: String { stringValue(values, "hotspotSsid") ?? "" }
    public var hotspotPassword: String { stringValue(values, "hotspotPassword") ?? "" }
    public var hotspotGatewayIp: String { stringValue(values, "hotspotGatewayIp", "hotspotLocalIp") ?? "" }
    public var headUp: Bool { boolValue(values, "headUp") ?? false }
    public var controllerConnected: Bool { boolValue(values, "controllerConnected") ?? false }
    public var controllerFullyBooted: Bool { boolValue(values, "controllerFullyBooted") ?? false }
    public var controllerMacAddress: String { stringValue(values, "controllerMacAddress") ?? "" }
    public var controllerBatteryLevel: Int { intValue(values["controllerBatteryLevel"]) ?? -1 }
    public var controllerSignalStrength: Int { intValue(values["controllerSignalStrength"]) ?? -1 }
    public var ringSignalStrength: Int { intValue(values["ringSignalStrength"]) ?? -1 }

    public var description: String {
        values.description
    }

    static func dictionary(from values: [String: Any]) -> [String: Any] {
        var dictionary = values
        dictionary["wifi"] = MentraWifiStatus(values: values).values
        dictionary.removeValue(forKey: "wifiConnected")
        dictionary.removeValue(forKey: "wifiSsid")
        dictionary.removeValue(forKey: "wifiLocalIp")
        return dictionary
    }

    static func updateDictionary(from values: [String: Any]) -> [String: Any] {
        var dictionary = values
        if hasAnyKey(values, "wifi", "wifiConnected", "wifiSsid", "wifiLocalIp") {
            dictionary["wifi"] = MentraWifiStatus(values: values).values
            dictionary.removeValue(forKey: "wifiConnected")
            dictionary.removeValue(forKey: "wifiSsid")
            dictionary.removeValue(forKey: "wifiLocalIp")
        }
        return dictionary
    }
}

public struct MentraBluetoothStatus: CustomStringConvertible {
    let values: [String: Any]

    init(values: [String: Any]) {
        self.values = Self.normalized(values)
    }

    private static func normalized(_ values: [String: Any]) -> [String: Any] {
        var normalizedValues = values
        if let searchResults = values["searchResults"] as? [[String: Any]] {
            normalizedValues["searchResults"] = searchResults.compactMap { MentraDevice(values: $0)?.dictionary }
        }
        return normalizedValues
    }

    public func applying(_ update: MentraBluetoothStatusUpdate) -> MentraBluetoothStatus {
        MentraBluetoothStatus(values: values.merging(update.values) { _, new in new })
    }

    public func withDefaultDevice(_ device: MentraDevice?) -> MentraBluetoothStatus {
        applying(MentraBluetoothStatusUpdate(values: [
            "default_wearable": device?.model.deviceType ?? "",
            "device_name": device?.name ?? "",
            "device_address": device?.identifier ?? "",
        ]))
    }

    public var searching: Bool { boolValue(values, "searching") ?? false }
    public var searchingController: Bool { boolValue(values, "searchingController") ?? false }
    public var systemMicUnavailable: Bool { boolValue(values, "systemMicUnavailable") ?? false }
    public var micEnabled: Bool { boolValue(values, "micEnabled") ?? false }
    public var currentMic: String { stringValue(values, "currentMic") ?? "" }
    public var micRanking: [String] { stringListValue(values, "micRanking") }
    public var searchResults: [MentraDevice] {
        dictionaryListValue(values, "searchResults").compactMap(MentraDevice.init(values:))
    }
    public var wifiScanResults: [MentraWifiScanResult] {
        dictionaryListValue(values, "wifiScanResults").map(MentraWifiScanResult.init(values:))
    }
    public var lastLog: [String] { stringListValue(values, "lastLog") }
    public var otherBtConnected: Bool { boolValue(values, "otherBtConnected") ?? false }
    public var defaultWearable: String { stringValue(values, "default_wearable") ?? "" }
    public var pendingWearable: String { stringValue(values, "pending_wearable") ?? "" }
    public var deviceName: String { stringValue(values, "device_name") ?? "" }
    public var deviceAddress: String { stringValue(values, "device_address") ?? "" }
    public var defaultController: String { stringValue(values, "default_controller") ?? "" }
    public var pendingController: String { stringValue(values, "pending_controller") ?? "" }
    public var controllerDeviceName: String { stringValue(values, "controller_device_name") ?? "" }
    public var screenDisabled: Bool { boolValue(values, "screen_disabled") ?? false }
    public var preferredMic: String { stringValue(values, "preferred_mic") ?? "auto" }
    public var sensingEnabled: Bool { boolValue(values, "sensing_enabled") ?? true }
    public var powerSavingMode: Bool { boolValue(values, "power_saving_mode") ?? false }
    public var brightness: Int { intValue(values["brightness"]) ?? 50 }
    public var autoBrightness: Bool { boolValue(values, "auto_brightness") ?? true }
    public var dashboardHeight: Int { intValue(values["dashboard_height"]) ?? 4 }
    public var dashboardDepth: Int { intValue(values["dashboard_depth"]) ?? 2 }
    public var headUpAngle: Int { intValue(values["head_up_angle"]) ?? 30 }
    public var contextualDashboard: Bool { boolValue(values, "contextual_dashboard") ?? true }
    public var galleryModeAuto: Bool { boolValue(values, "gallery_mode") ?? false }
    public var buttonPhotoSize: MentraButtonPhotoSize {
        MentraButtonPhotoSize(rawValue: stringValue(values, "button_photo_size") ?? "") ?? .medium
    }
    public var buttonCameraLed: Bool { boolValue(values, "button_camera_led") ?? true }
    public var buttonMaxRecordingTime: Int { intValue(values["button_max_recording_time"]) ?? 10 }
    public var buttonVideoWidth: Int { intValue(values["button_video_width"]) ?? 1280 }
    public var buttonVideoHeight: Int { intValue(values["button_video_height"]) ?? 720 }
    public var buttonVideoFps: Int { intValue(values["button_video_fps"]) ?? 30 }
    public var shouldSendPcm: Bool { boolValue(values, "should_send_pcm") ?? false }
    public var shouldSendLc3: Bool { boolValue(values, "should_send_lc3") ?? false }
    public var shouldSendTranscript: Bool { boolValue(values, "should_send_transcript") ?? false }
    public var bypassVad: Bool { boolValue(values, "bypass_vad") ?? false }
    public var offlineCaptionsRunning: Bool { boolValue(values, "offline_captions_running") ?? false }
    public var localSttFallbackActive: Bool { boolValue(values, "local_stt_fallback_active") ?? false }
    public var shouldSendBootingMessage: Bool { boolValue(values, "shouldSendBootingMessage") ?? true }

    public var defaultDevice: MentraDevice? {
        guard !defaultWearable.isEmpty else { return nil }
        return MentraDevice(
            model: MentraDeviceModel.fromDeviceType(defaultWearable),
            name: deviceName,
            identifier: deviceAddress.isEmpty ? nil : deviceAddress
        )
    }

    public var description: String {
        values.description
    }
}

public struct MentraGlassesStatusUpdate: CustomStringConvertible {
    let values: [String: Any]

    init(values: [String: Any]) {
        self.values = values
    }

    public var fullyBooted: Bool? { optionalBoolValue(values, "fullyBooted") }
    public var connected: Bool? { optionalBoolValue(values, "connected") }
    public var micEnabled: Bool? { optionalBoolValue(values, "micEnabled") }
    public var connectionState: String? { optionalStringValue(values, "connectionState") }
    public var btcConnected: Bool? { optionalBoolValue(values, "btcConnected") }
    public var signalStrength: Int? { optionalIntValue(values, "signalStrength") }
    public var signalStrengthUpdatedAt: Int? { optionalIntValue(values, "signalStrengthUpdatedAt") }
    public var deviceModel: String? { optionalStringValue(values, "deviceModel") }
    public var androidVersion: String? { optionalStringValue(values, "androidVersion") }
    public var firmwareVersion: String? { optionalStringValue(values, "firmwareVersion", "fwVersion") }
    public var besFirmwareVersion: String? { optionalStringValue(values, "besFwVersion", "besFirmwareVersion") }
    public var mtkFirmwareVersion: String? { optionalStringValue(values, "mtkFwVersion", "mtkFirmwareVersion") }
    public var btMacAddress: String? { optionalStringValue(values, "btMacAddress") }
    public var leftMacAddress: String? { optionalStringValue(values, "leftMacAddress") }
    public var rightMacAddress: String? { optionalStringValue(values, "rightMacAddress") }
    public var macAddress: String? { optionalStringValue(values, "macAddress") }
    public var buildNumber: String? { optionalStringValue(values, "buildNumber") }
    public var otaVersionUrl: String? { optionalStringValue(values, "otaVersionUrl") }
    public var appVersion: String? { optionalStringValue(values, "appVersion") }
    public var bluetoothName: String? { optionalStringValue(values, "bluetoothName") }
    public var serialNumber: String? { optionalStringValue(values, "serialNumber") }
    public var style: String? { optionalStringValue(values, "style") }
    public var color: String? { optionalStringValue(values, "color") }
    public var wifi: MentraWifiStatus? {
        hasAnyKey(values, "wifi", "wifiConnected", "wifiSsid", "wifiLocalIp") ? MentraWifiStatus(values: values) : nil
    }
    public var dictionary: [String: Any] { MentraGlassesStatus.updateDictionary(from: values) }
    public var batteryLevel: Int? { optionalIntValue(values, "batteryLevel") }
    public var charging: Bool? { optionalBoolValue(values, "charging") }
    public var caseBatteryLevel: Int? { optionalIntValue(values, "caseBatteryLevel") }
    public var caseCharging: Bool? { optionalBoolValue(values, "caseCharging") }
    public var caseOpen: Bool? { optionalBoolValue(values, "caseOpen") }
    public var caseRemoved: Bool? { optionalBoolValue(values, "caseRemoved") }
    public var hotspotEnabled: Bool? { optionalBoolValue(values, "hotspotEnabled") }
    public var hotspotSsid: String? { optionalStringValue(values, "hotspotSsid") }
    public var hotspotPassword: String? { optionalStringValue(values, "hotspotPassword") }
    public var hotspotGatewayIp: String? { optionalStringValue(values, "hotspotGatewayIp", "hotspotLocalIp") }
    public var headUp: Bool? { optionalBoolValue(values, "headUp") }
    public var controllerConnected: Bool? { optionalBoolValue(values, "controllerConnected") }
    public var controllerFullyBooted: Bool? { optionalBoolValue(values, "controllerFullyBooted") }
    public var controllerMacAddress: String? { optionalStringValue(values, "controllerMacAddress") }
    public var controllerBatteryLevel: Int? { optionalIntValue(values, "controllerBatteryLevel") }
    public var controllerSignalStrength: Int? { optionalIntValue(values, "controllerSignalStrength") }
    public var ringSignalStrength: Int? { optionalIntValue(values, "ringSignalStrength") }

    public var description: String {
        values.description
    }
}

public struct MentraBluetoothStatusUpdate: CustomStringConvertible {
    let values: [String: Any]

    init(values: [String: Any]) {
        var normalizedValues = values
        if let searchResults = values["searchResults"] as? [[String: Any]] {
            normalizedValues["searchResults"] = searchResults.compactMap { MentraDevice(values: $0)?.dictionary }
        }
        self.values = normalizedValues
    }

    public var searching: Bool? { optionalBoolValue(values, "searching") }
    public var searchingController: Bool? { optionalBoolValue(values, "searchingController") }
    public var systemMicUnavailable: Bool? { optionalBoolValue(values, "systemMicUnavailable") }
    public var micEnabled: Bool? { optionalBoolValue(values, "micEnabled") }
    public var currentMic: String? { optionalStringValue(values, "currentMic") }
    public var micRanking: [String]? { optionalStringListValue(values, "micRanking") }
    public var searchResults: [MentraDevice]? {
        optionalDictionaryListValue(values, "searchResults")?.compactMap(MentraDevice.init(values:))
    }
    public var wifiScanResults: [MentraWifiScanResult]? {
        optionalDictionaryListValue(values, "wifiScanResults")?.map(MentraWifiScanResult.init(values:))
    }
    public var lastLog: [String]? { optionalStringListValue(values, "lastLog") }
    public var otherBtConnected: Bool? { optionalBoolValue(values, "otherBtConnected") }
    public var defaultWearable: String? { optionalStringValue(values, "default_wearable") }
    public var pendingWearable: String? { optionalStringValue(values, "pending_wearable") }
    public var deviceName: String? { optionalStringValue(values, "device_name") }
    public var deviceAddress: String? { optionalStringValue(values, "device_address") }
    public var defaultController: String? { optionalStringValue(values, "default_controller") }
    public var pendingController: String? { optionalStringValue(values, "pending_controller") }
    public var controllerDeviceName: String? { optionalStringValue(values, "controller_device_name") }
    public var screenDisabled: Bool? { optionalBoolValue(values, "screen_disabled") }
    public var preferredMic: String? { optionalStringValue(values, "preferred_mic") }
    public var sensingEnabled: Bool? { optionalBoolValue(values, "sensing_enabled") }
    public var powerSavingMode: Bool? { optionalBoolValue(values, "power_saving_mode") }
    public var brightness: Int? { optionalIntValue(values, "brightness") }
    public var autoBrightness: Bool? { optionalBoolValue(values, "auto_brightness") }
    public var dashboardHeight: Int? { optionalIntValue(values, "dashboard_height") }
    public var dashboardDepth: Int? { optionalIntValue(values, "dashboard_depth") }
    public var headUpAngle: Int? { optionalIntValue(values, "head_up_angle") }
    public var contextualDashboard: Bool? { optionalBoolValue(values, "contextual_dashboard") }
    public var galleryModeAuto: Bool? { optionalBoolValue(values, "gallery_mode") }
    public var buttonPhotoSize: MentraButtonPhotoSize? {
        optionalStringValue(values, "button_photo_size").flatMap(MentraButtonPhotoSize.init(rawValue:))
    }
    public var buttonCameraLed: Bool? { optionalBoolValue(values, "button_camera_led") }
    public var buttonMaxRecordingTime: Int? { optionalIntValue(values, "button_max_recording_time") }
    public var buttonVideoWidth: Int? { optionalIntValue(values, "button_video_width") }
    public var buttonVideoHeight: Int? { optionalIntValue(values, "button_video_height") }
    public var buttonVideoFps: Int? { optionalIntValue(values, "button_video_fps") }
    public var shouldSendPcm: Bool? { optionalBoolValue(values, "should_send_pcm") }
    public var shouldSendLc3: Bool? { optionalBoolValue(values, "should_send_lc3") }
    public var shouldSendTranscript: Bool? { optionalBoolValue(values, "should_send_transcript") }
    public var bypassVad: Bool? { optionalBoolValue(values, "bypass_vad") }
    public var offlineCaptionsRunning: Bool? { optionalBoolValue(values, "offline_captions_running") }
    public var localSttFallbackActive: Bool? { optionalBoolValue(values, "local_stt_fallback_active") }
    public var shouldSendBootingMessage: Bool? { optionalBoolValue(values, "shouldSendBootingMessage") }

    public var description: String {
        values.description
    }
}

public struct MentraDisplayTextRequest {
    public let text: String
    public let x: Int
    public let y: Int
    public let size: Int

    public init(text: String, x: Int = 0, y: Int = 0, size: Int = 24) {
        self.text = text
        self.x = x
        self.y = y
        self.size = size
    }

    var dictionary: [String: Any] {
        [
            "text": text,
            "x": x,
            "y": y,
            "size": size,
        ]
    }
}

public struct MentraDisplayEventRequest {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }
}

public struct MentraDashboardPositionRequest {
    public let height: Int
    public let depth: Int

    public init(height: Int, depth: Int) {
        self.height = height
        self.depth = depth
    }
}

public struct MentraDashboardMenuItem {
    public let title: String
    public let packageName: String
    public let values: [String: Any]

    public init(title: String, packageName: String, values: [String: Any] = [:]) {
        self.title = title
        self.packageName = packageName
        self.values = values
    }

    var dictionary: [String: Any] {
        values.merging(["title": title, "packageName": packageName]) { _, new in new }
    }
}

public enum MentraGalleryMode {
    case auto
    case manual
}

public enum MentraPhotoSize: String {
    case small
    case medium
    case large
    case full
}

public enum MentraButtonPhotoSize: String {
    case small
    case medium
    case large
}

public enum MentraPhotoCompression: String {
    case none
    case medium
    case heavy
}

public struct MentraButtonPhotoSettings {
    public let size: MentraButtonPhotoSize

    public init(size: MentraButtonPhotoSize) {
        self.size = size
    }
}

public struct MentraButtonVideoRecordingSettings {
    public let width: Int
    public let height: Int
    public let fps: Int

    public init(width: Int, height: Int, fps: Int) {
        self.width = width
        self.height = height
        self.fps = fps
    }
}

public enum MentraCameraFov {
    case standard
    case wide

    var value: [String: Int] {
        switch self {
        case .standard:
            ["fov": 118, "roi_position": 0]
        case .wide:
            ["fov": 118, "roi_position": 0]
        }
    }
}

public struct MentraMicConfiguration {
    public let sendPcmData: Bool
    public let sendTranscript: Bool
    public let bypassVad: Bool
    public let sendLc3Data: Bool

    public init(
        sendPcmData: Bool,
        sendTranscript: Bool,
        bypassVad: Bool,
        sendLc3Data: Bool = false
    ) {
        self.sendPcmData = sendPcmData
        self.sendTranscript = sendTranscript
        self.bypassVad = bypassVad
        self.sendLc3Data = sendLc3Data
    }
}

public enum MentraMicPreference: String {
    case auto
    case phone
    case glasses
    case bluetooth
}

public struct MentraPhotoRequest {
    public let requestId: String
    public let appId: String
    public let size: MentraPhotoSize
    public let webhookUrl: String?
    public let authToken: String?
    public let compress: MentraPhotoCompression?
    public let flash: Bool
    public let sound: Bool

    public init(
        requestId: String,
        appId: String,
        size: MentraPhotoSize,
        webhookUrl: String? = nil,
        authToken: String? = nil,
        compress: MentraPhotoCompression? = nil,
        flash: Bool,
        sound: Bool
    ) {
        self.requestId = requestId
        self.appId = appId
        self.size = size
        self.webhookUrl = webhookUrl
        self.authToken = authToken
        self.compress = compress
        self.flash = flash
        self.sound = sound
    }
}

public struct MentraStreamVideoConfig {
    public let width: Int?
    public let height: Int?
    public let bitrate: Int?
    public let frameRate: Int?

    public init(
        width: Int? = nil,
        height: Int? = nil,
        bitrate: Int? = nil,
        frameRate: Int? = nil
    ) {
        self.width = width
        self.height = height
        self.bitrate = bitrate
        self.frameRate = frameRate
    }

    var dictionary: [String: Any] {
        var values: [String: Any] = [:]
        if let width { values["width"] = width }
        if let height { values["height"] = height }
        if let bitrate { values["bitrate"] = bitrate }
        if let frameRate { values["frameRate"] = frameRate }
        return values
    }

    init?(values: [String: Any]?) {
        guard let values else { return nil }
        self.init(
            width: intValue(values["width"] ?? values["w"]),
            height: intValue(values["height"] ?? values["h"]),
            bitrate: intValue(values["bitrate"] ?? values["br"]),
            frameRate: intValue(values["frameRate"] ?? values["fr"])
        )
    }
}

public struct MentraStreamAudioConfig {
    public let bitrate: Int?
    public let sampleRate: Int?
    public let echoCancellation: Bool?
    public let noiseSuppression: Bool?

    public init(
        bitrate: Int? = nil,
        sampleRate: Int? = nil,
        echoCancellation: Bool? = nil,
        noiseSuppression: Bool? = nil
    ) {
        self.bitrate = bitrate
        self.sampleRate = sampleRate
        self.echoCancellation = echoCancellation
        self.noiseSuppression = noiseSuppression
    }

    var dictionary: [String: Any] {
        var values: [String: Any] = [:]
        if let bitrate { values["bitrate"] = bitrate }
        if let sampleRate { values["sampleRate"] = sampleRate }
        if let echoCancellation { values["echoCancellation"] = echoCancellation }
        if let noiseSuppression { values["noiseSuppression"] = noiseSuppression }
        return values
    }

    init?(values: [String: Any]?) {
        guard let values else { return nil }
        self.init(
            bitrate: intValue(values["bitrate"] ?? values["br"]),
            sampleRate: intValue(values["sampleRate"] ?? values["sr"]),
            echoCancellation: values["echoCancellation"] as? Bool ?? values["ec"] as? Bool,
            noiseSuppression: values["noiseSuppression"] as? Bool ?? values["ns"] as? Bool
        )
    }
}

public struct MentraStreamRequest {
    public let streamUrl: String
    public let streamId: String
    public let keepAlive: Bool
    public let keepAliveIntervalSeconds: Int
    public let flash: Bool
    public let sound: Bool
    public let video: MentraStreamVideoConfig?
    public let audio: MentraStreamAudioConfig?
    public let extraValues: [String: Any]

    public init(
        streamUrl: String,
        streamId: String = "",
        keepAlive: Bool = true,
        keepAliveIntervalSeconds: Int = 15,
        flash: Bool = true,
        sound: Bool = true,
        video: MentraStreamVideoConfig? = nil,
        audio: MentraStreamAudioConfig? = nil,
        extraValues: [String: Any] = [:]
    ) {
        self.streamUrl = streamUrl
        self.streamId = streamId
        self.keepAlive = keepAlive
        self.keepAliveIntervalSeconds = keepAliveIntervalSeconds
        self.flash = flash
        self.sound = sound
        self.video = video
        self.audio = audio
        self.extraValues = extraValues
    }

    init(values: [String: Any]) {
        self.init(
            streamUrl: values["streamUrl"] as? String
                ?? values["rtmpUrl"] as? String
                ?? values["srtUrl"] as? String
                ?? values["whipUrl"] as? String
                ?? "",
            streamId: values["streamId"] as? String ?? "",
            keepAlive: values["keepAlive"] as? Bool ?? true,
            keepAliveIntervalSeconds: intValue(values["keepAliveIntervalSeconds"]) ?? 15,
            flash: values["flash"] as? Bool ?? true,
            sound: values["sound"] as? Bool ?? true,
            video: MentraStreamVideoConfig(values: (values["video"] ?? values["v"]) as? [String: Any]),
            audio: MentraStreamAudioConfig(values: (values["audio"] ?? values["a"]) as? [String: Any]),
            extraValues: values
        )
    }

    public var values: [String: Any] {
        var values = extraValues
        values["type"] = "start_stream"
        values["streamUrl"] = streamUrl
        values["streamId"] = streamId
        values["keepAlive"] = keepAlive
        values["keepAliveIntervalSeconds"] = keepAliveIntervalSeconds
        values["flash"] = flash
        values["sound"] = sound
        if let videoValues = video?.dictionary, !videoValues.isEmpty {
            values["video"] = videoValues
        }
        if let audioValues = audio?.dictionary, !audioValues.isEmpty {
            values["audio"] = audioValues
        }
        return values
    }
}

public struct MentraStreamKeepAliveRequest {
    public let streamId: String
    public let ackId: String
    public let extraValues: [String: Any]

    public init(streamId: String, ackId: String, extraValues: [String: Any] = [:]) {
        self.streamId = streamId
        self.ackId = ackId
        self.extraValues = extraValues
    }

    init(values: [String: Any]) {
        self.init(
            streamId: values["streamId"] as? String ?? "",
            ackId: values["ackId"] as? String ?? "",
            extraValues: values
        )
    }

    public var values: [String: Any] {
        var values = extraValues
        values["type"] = "keep_stream_alive"
        values["streamId"] = streamId
        values["ackId"] = ackId
        return values
    }
}

public enum MentraRgbLedAction: String {
    case on
    case off
}

public enum MentraRgbLedColor: String {
    case red
    case green
    case blue
    case orange
    case white
}

public struct MentraRgbLedRequest {
    public let requestId: String
    public let packageName: String?
    public let action: MentraRgbLedAction
    public let color: MentraRgbLedColor?
    public let ontime: Int
    public let offtime: Int
    public let count: Int

    public init(
        requestId: String,
        packageName: String?,
        action: MentraRgbLedAction,
        color: MentraRgbLedColor?,
        ontime: Int,
        offtime: Int,
        count: Int
    ) {
        self.requestId = requestId
        self.packageName = packageName
        self.action = action
        self.color = color
        self.ontime = ontime
        self.offtime = offtime
        self.count = count
    }
}

public struct MentraVideoRecordingRequest {
    public let requestId: String
    public let save: Bool
    public let flash: Bool
    public let sound: Bool

    public init(requestId: String, save: Bool, flash: Bool, sound: Bool) {
        self.requestId = requestId
        self.save = save
        self.flash = flash
        self.sound = sound
    }
}

public struct MentraButtonPressEvent: CustomStringConvertible {
    public let buttonId: String
    public let pressType: String
    public let timestamp: Int?

    public init(buttonId: String, pressType: String, timestamp: Int? = nil) {
        self.buttonId = buttonId
        self.pressType = pressType
        self.timestamp = timestamp
    }

    public var description: String {
        "MentraButtonPressEvent(buttonId: \(buttonId), pressType: \(pressType))"
    }
}

public struct MentraTouchEvent: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }

    public var deviceModel: String? {
        stringValue(values, "device_model", "deviceModel")
    }

    public var gestureName: String? {
        stringValue(values, "gesture_name", "gestureName")
    }

    public var timestamp: Int? {
        intValue(values["timestamp"])
    }

    public var isSwipe: Bool {
        gestureName?.localizedCaseInsensitiveContains("swipe") == true
    }

    public var description: String {
        "MentraTouchEvent(gestureName: \(gestureName ?? "unknown"))"
    }
}

public enum MentraWifiStatus: CustomStringConvertible, Equatable {
    public enum State: String {
        case unknown
        case disconnected
        case connected
    }

    case unknown
    case disconnected
    case connected(ssid: String, localIp: String)

    public init(connected: Bool, ssid: String?, localIp: String?) {
        if connected {
            guard
                let ssid = ssid?.trimmingCharacters(in: .whitespacesAndNewlines),
                !ssid.isEmpty,
                let localIp = localIp?.trimmingCharacters(in: .whitespacesAndNewlines),
                !localIp.isEmpty
            else {
                self = .unknown
                return
            }
            self = .connected(ssid: ssid, localIp: localIp)
        } else {
            self = .disconnected
        }
    }

    public init(values: [String: Any]) {
        if let nested = values["wifi"] as? [String: Any] {
            self = MentraWifiStatus(values: nested)
            return
        }

        if let state = stringValue(values, "state", "wifiState")?.lowercased() {
            switch state {
            case State.connected.rawValue:
                self = MentraWifiStatus(
                    connected: true,
                    ssid: nonEmptyStringValue(values, "ssid", "wifiSsid"),
                    localIp: nonEmptyStringValue(values, "localIp", "local_ip", "wifiLocalIp")
                )
            case State.disconnected.rawValue:
                self = .disconnected
            default:
                self = .unknown
            }
            return
        }

        guard hasAnyKey(values, "connected", "wifiConnected", "ssid", "wifiSsid", "localIp", "local_ip", "wifiLocalIp") else {
            self = .unknown
            return
        }

        self = MentraWifiStatus(
            connected: boolValue(values, "connected") ?? boolValue(values, "wifiConnected") ?? false,
            ssid: nonEmptyStringValue(values, "ssid", "wifiSsid"),
            localIp: nonEmptyStringValue(values, "localIp", "local_ip", "wifiLocalIp")
        )
    }

    public var state: State {
        switch self {
        case .unknown:
            .unknown
        case .disconnected:
            .disconnected
        case .connected:
            .connected
        }
    }

    public var isConnected: Bool {
        if case .connected = self {
            return true
        }
        return false
    }

    public var values: [String: Any] {
        switch self {
        case .unknown:
            ["state": State.unknown.rawValue]
        case .disconnected:
            ["state": State.disconnected.rawValue]
        case let .connected(ssid, localIp):
            [
                "state": State.connected.rawValue,
                "ssid": ssid,
                "localIp": localIp,
            ]
        }
    }

    var storeValues: [String: Any] {
        switch self {
        case .unknown:
            [
                "wifiConnected": false,
                "wifiSsid": "",
                "wifiLocalIp": "",
            ]
        case .disconnected:
            [
                "wifiConnected": false,
                "wifiSsid": "",
                "wifiLocalIp": "",
            ]
        case let .connected(ssid, localIp):
            [
                "wifiConnected": true,
                "wifiSsid": ssid,
                "wifiLocalIp": localIp,
            ]
        }
    }

    public var description: String {
        switch self {
        case .unknown:
            "MentraWifiStatus(unknown)"
        case .disconnected:
            "MentraWifiStatus(disconnected)"
        case let .connected(ssid, localIp):
            "MentraWifiStatus(connected: \(ssid), localIp: \(localIp))"
        }
    }
}

public struct MentraWifiStatusEvent: CustomStringConvertible {
    public let status: MentraWifiStatus

    public init(status: MentraWifiStatus) {
        self.status = status
    }

    public init(connected: Bool, ssid: String?, localIp: String?) {
        self.status = MentraWifiStatus(connected: connected, ssid: ssid, localIp: localIp)
    }

    public init(values: [String: Any]) {
        self.status = MentraWifiStatus(values: values)
    }

    public var values: [String: Any] {
        status.values.merging(["type": "wifi_status_change"]) { _, new in new }
    }

    public var description: String {
        "MentraWifiStatusEvent(\(status))"
    }
}

public struct MentraHotspotStatusEvent: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }

    public var enabled: Bool? {
        boolValue(values, "enabled")
    }

    public var ssid: String? {
        stringValue(values, "ssid")
    }

    public var password: String? {
        stringValue(values, "password")
    }

    public var localIp: String? {
        stringValue(values, "local_ip", "localIp")
    }

    public var description: String {
        "MentraHotspotStatusEvent(enabled: \(enabled.map(String.init) ?? "unknown"), ssid: \(ssid ?? "none"))"
    }
}

public struct MentraHotspotErrorEvent: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }

    public var message: String? {
        stringValue(values, "error_message", "message", "error")
    }

    public var timestamp: Int? {
        intValue(values["timestamp"])
    }

    public var description: String {
        "MentraHotspotErrorEvent(message: \(message ?? "unknown"))"
    }
}

public struct MentraPhotoResponseEvent: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }

    public var requestId: String? {
        stringValue(values, "requestId", "request_id")
    }

    public var success: Bool? {
        boolValue(values, "success")
    }

    public var photoUrl: String? {
        stringValue(values, "photoUrl", "photo_url")
    }

    public var errorCode: String? {
        stringValue(values, "errorCode", "error_code")
    }

    public var errorMessage: String? {
        stringValue(values, "errorMessage", "error_message")
    }

    public var description: String {
        "MentraPhotoResponseEvent(requestId: \(requestId ?? "unknown"), success: \(success.map(String.init) ?? "unknown"))"
    }
}

public struct MentraStreamStatusEvent: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }

    public var status: String? {
        stringValue(values, "status")
    }

    public var streamId: String? {
        stringValue(values, "streamId", "stream_id")
    }

    public var description: String {
        "MentraStreamStatusEvent(status: \(status ?? "unknown"), streamId: \(streamId ?? "none"))"
    }
}

public struct MentraBluetoothError: Error, LocalizedError, CustomStringConvertible {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? {
        message
    }

    public var description: String {
        "\(code): \(message)"
    }
}

private final class BluetoothAvailability: NSObject, CBCentralManagerDelegate {
    static let shared = BluetoothAvailability()

    private var centralManager: CBCentralManager?
    private var state: CBManagerState = .unknown

    override private init() {
        super.init()
        centralManager = CBCentralManager(
            delegate: self,
            queue: .main,
            options: [CBCentralManagerOptionShowPowerAlertKey: false]
        )
        state = centralManager?.state ?? .unknown
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        state = central.state
    }

    func requirePoweredOn(operation: String) throws {
        if let current = centralManager?.state {
            state = current
        }
        switch state {
        case .poweredOn:
            return
        case .poweredOff:
            throw MentraBluetoothError(
                code: "bluetooth_powered_off",
                message: "Turn on phone Bluetooth to \(operation)."
            )
        case .unauthorized:
            throw MentraBluetoothError(
                code: "bluetooth_unauthorized",
                message: "Allow Bluetooth access to \(operation)."
            )
        case .unsupported:
            throw MentraBluetoothError(
                code: "bluetooth_unsupported",
                message: "This phone does not support Bluetooth."
            )
        case .resetting, .unknown:
            throw MentraBluetoothError(
                code: "bluetooth_not_ready",
                message: "Bluetooth is not ready yet. Try again."
            )
        @unknown default:
            throw MentraBluetoothError(
                code: "bluetooth_unavailable",
                message: "Bluetooth is unavailable. Try again."
            )
        }
    }
}

public enum MentraScanStopReason {
    case completed
    case cancelled
    case error
}

public struct MentraLocalTranscriptionEvent: CustomStringConvertible {
    public let text: String
    public let isFinal: Bool
    public let values: [String: Any]

    public init(text: String, isFinal: Bool, values: [String: Any]) {
        self.text = text
        self.isFinal = isFinal
        self.values = values
    }

    public var description: String {
        "MentraLocalTranscriptionEvent(text: \(text), isFinal: \(isFinal))"
    }
}

public enum MentraBluetoothEvent: CustomStringConvertible {
    case buttonPress(MentraButtonPressEvent)
    case touch(MentraTouchEvent)
    case wifiStatus(MentraWifiStatusEvent)
    case hotspotStatus(MentraHotspotStatusEvent)
    case hotspotError(MentraHotspotErrorEvent)
    case photoResponse(MentraPhotoResponseEvent)
    case streamStatus(MentraStreamStatusEvent)
    case localTranscription(MentraLocalTranscriptionEvent)
    case raw(name: String, values: [String: Any])

    public var description: String {
        switch self {
        case let .buttonPress(event):
            event.description
        case let .touch(event):
            event.description
        case let .wifiStatus(event):
            event.description
        case let .hotspotStatus(event):
            event.description
        case let .hotspotError(event):
            event.description
        case let .photoResponse(event):
            event.description
        case let .streamStatus(event):
            event.description
        case let .localTranscription(event):
            event.description
        case let .raw(name, values):
            "\(name): \(values)"
        }
    }
}

@MainActor
public protocol MentraBluetoothSDKDelegate: AnyObject {
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlassesStatus status: MentraGlassesStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateBluetoothStatus status: MentraBluetoothStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: MentraDevice)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didStopScan reason: MentraScanStopReason)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceive event: MentraBluetoothEvent)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicPcm frame: Data)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicLc3 frame: Data)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didChangeDefaultDevice device: MentraDevice?)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didLog message: String)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didFail error: MentraBluetoothError)
}

@MainActor
public extension MentraBluetoothSDKDelegate {
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateGlassesStatus _: MentraGlassesStatusUpdate) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateBluetoothStatus _: MentraBluetoothStatusUpdate) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didDiscover _: MentraDevice) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didStopScan _: MentraScanStopReason) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceive _: MentraBluetoothEvent) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicPcm _: Data) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicLc3 _: Data) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didChangeDefaultDevice _: MentraDevice?) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didLog _: String) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didFail _: MentraBluetoothError) {}
}

@MainActor
public final class MentraBluetoothSDK {
    public weak var delegate: MentraBluetoothSDKDelegate?

    private let configuration: MentraBluetoothSDKConfiguration
    private var discoveredDeviceNames = Set<String>()
    private var bridgeEventSinkId: String?
    private var storeListenerId: String?
    private let defaultDeviceKeys: Set<String> = ["default_wearable", "device_name", "device_address"]
    private var suppressDefaultDeviceEvents = false
    private var defaultDeviceApplyGeneration = 0

    public init(configuration: MentraBluetoothSDKConfiguration = .default) {
        self.configuration = configuration
        _ = BluetoothAvailability.shared
        bridgeEventSinkId = Bridge.addEventSink { [weak self] eventName, data in
            Task { @MainActor [weak self] in
                self?.dispatchBridgeEvent(eventName, data)
            }
        }
        storeListenerId = GlassesStore.shared.store.addListener { [weak self] category, changes in
            Task { @MainActor [weak self] in
                self?.dispatchStoreUpdate(category, changes)
            }
        }
    }

    public var glassesStatus: MentraGlassesStatus {
        MentraGlassesStatus(values: GlassesStore.shared.store.getCategory("glasses"))
    }

    public var bluetoothStatus: MentraBluetoothStatus {
        MentraBluetoothStatus(values: GlassesStore.shared.store.getCategory(ObservableStore.coreCategory))
    }

    public var defaultDevice: MentraDevice? {
        currentDefaultDevice()
    }

    public func getDefaultDevice() -> MentraDevice? {
        currentDefaultDevice()
    }

    public func setDefaultDevice(_ device: MentraDevice?) {
        guard let device else {
            clearDefaultDevice()
            return
        }
        defaultDeviceApplyGeneration += 1
        let generation = defaultDeviceApplyGeneration
        suppressDefaultDeviceEvents = true
        GlassesStore.shared.apply(ObservableStore.coreCategory, "default_wearable", device.model.deviceType)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "device_name", device.name)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "device_address", device.identifier ?? "")
        finishDefaultDeviceApply(generation: generation)
    }

    public func clearDefaultDevice() {
        defaultDeviceApplyGeneration += 1
        let generation = defaultDeviceApplyGeneration
        suppressDefaultDeviceEvents = true
        GlassesStore.shared.apply(ObservableStore.coreCategory, "default_wearable", "")
        GlassesStore.shared.apply(ObservableStore.coreCategory, "device_name", "")
        GlassesStore.shared.apply(ObservableStore.coreCategory, "device_address", "")
        finishDefaultDeviceApply(generation: generation)
    }

    public func startScan(model: MentraDeviceModel) throws {
        if model != .simulated {
            try BluetoothAvailability.shared.requirePoweredOn(operation: "scan for glasses")
        }
        discoveredDeviceNames.removeAll()
        GlassesStore.shared.apply(ObservableStore.coreCategory, "searching", true)
        CoreManager.shared.findCompatibleDevices(model.deviceType)
    }

    public func stopScan() {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "searching", false)
        delegate?.mentraBluetoothSDK(self, didStopScan: .cancelled)
    }

    public func connect(to device: MentraDevice, options: MentraConnectOptions = MentraConnectOptions()) throws {
        if device.model != .simulated {
            try BluetoothAvailability.shared.requirePoweredOn(operation: "connect to glasses")
        }
        let isController = ControllerTypes.ALL.contains(device.model.deviceType)
        if options.cancelExistingConnectionAttempt {
            if isController {
                CoreManager.shared.disconnectController()
            } else {
                cancelConnectionAttempt()
            }
        }
        if options.saveAsDefault && !isController {
            setDefaultDevice(device)
        }
        GlassesStore.shared.apply(ObservableStore.coreCategory, "pending_wearable", device.model.deviceType)
        CoreManager.shared.connectByName(device.name)
    }

    public func connectDefault(options: MentraConnectOptions = MentraConnectOptions()) throws {
        guard let device = currentDefaultDevice() else {
            throw MentraBluetoothError(
                code: "default_device_missing",
                message: "Set a default glasses device before calling connectDefault."
            )
        }
        if device.model != .simulated {
            try BluetoothAvailability.shared.requirePoweredOn(operation: "connect to glasses")
        }
        if options.cancelExistingConnectionAttempt {
            cancelConnectionAttempt()
        }
        CoreManager.shared.connectDefault()
    }

    public func cancelConnectionAttempt() {
        CoreManager.shared.disconnect()
    }

    public func connectSimulated() {
        CoreManager.shared.connectSimulated()
    }

    public func disconnect() {
        CoreManager.shared.disconnect()
    }

    public func forget() {
        CoreManager.shared.forget()
    }

    public func displayText(_ request: MentraDisplayTextRequest) async throws {
        CoreManager.shared.displayText(request.dictionary)
    }

    public func displayEvent(_ request: MentraDisplayEventRequest) async throws {
        CoreManager.shared.displayEvent(request.values)
    }

    public func clearDisplay() async throws {
        CoreManager.shared.sgc?.clearDisplay()
    }

    public func showDashboard() {
        CoreManager.shared.showDashboard()
    }

    public func setBrightness(_ level: Int, autoMode: Bool? = nil) async throws {
        if let autoMode {
            GlassesStore.shared.apply(ObservableStore.coreCategory, "auto_brightness", autoMode)
        }
        GlassesStore.shared.apply(ObservableStore.coreCategory, "brightness", level)
    }

    public func setAutoBrightness(enabled: Bool) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "auto_brightness", enabled)
    }

    public func setDashboardPosition(_ request: MentraDashboardPositionRequest) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "dashboard_height", request.height)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "dashboard_depth", request.depth)
    }

    public func setDashboardMenu(_ items: [MentraDashboardMenuItem]) async throws {
        GlassesStore.shared.apply(
            ObservableStore.coreCategory,
            "dashboard_menu_apps",
            items.map(\.dictionary)
        )
    }

    public func setHeadUpAngle(_ angleDegrees: Int) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "head_up_angle", angleDegrees)
    }

    public func setScreenDisabled(_ disabled: Bool) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "screen_disabled", disabled)
    }

    public func setGalleryMode(_ mode: MentraGalleryMode) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "gallery_mode", mode == .auto)
    }

    public func setButtonPhotoSettings(_ settings: MentraButtonPhotoSettings) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "button_photo_size", settings.size.rawValue)
    }

    public func setButtonVideoRecordingSettings(_ settings: MentraButtonVideoRecordingSettings) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "button_video_width", settings.width)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "button_video_height", settings.height)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "button_video_fps", settings.fps)
    }

    public func setButtonCameraLed(enabled: Bool) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "button_camera_led", enabled)
    }

    public func setButtonMaxRecordingTime(minutes: Int) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "button_max_recording_time", minutes)
    }

    public func setCameraFov(_ fov: MentraCameraFov) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "camera_fov", fov.value)
    }

    public func setMicState(_ config: MentraMicConfiguration) {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "should_send_pcm", config.sendPcmData)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "should_send_lc3", config.sendLc3Data)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "should_send_transcript", config.sendTranscript)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "bypass_vad", config.bypassVad)
        CoreManager.shared.setMicState()
    }

    public func setPreferredMic(_ preferredMic: MentraMicPreference) {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "preferred_mic", preferredMic.rawValue)
    }

    public func setOwnAppAudioPlaying(_ playing: Bool) {
        PhoneAudioMonitor.getInstance().setOwnAppAudioPlaying(playing)
    }

    public func requestWifiScan() {
        CoreManager.shared.requestWifiScan()
    }

    public func sendWifiCredentials(ssid: String, password: String) {
        CoreManager.shared.sendWifiCredentials(ssid, password)
    }

    public func forgetWifiNetwork(ssid: String) {
        CoreManager.shared.forgetWifiNetwork(ssid)
    }

    public func setHotspotState(enabled: Bool) {
        CoreManager.shared.setHotspotState(enabled)
    }

    public func requestPhoto(_ request: MentraPhotoRequest) {
        CoreManager.shared.photoRequest(
            request.requestId,
            request.appId,
            request.size.rawValue,
            request.webhookUrl,
            request.authToken,
            request.compress?.rawValue,
            request.flash,
            request.sound
        )
    }

    public func queryGalleryStatus() {
        CoreManager.shared.queryGalleryStatus()
    }

    public func startStream(_ request: MentraStreamRequest) {
        CoreManager.shared.startStream(request.values)
    }

    public func keepStreamAlive(_ request: MentraStreamKeepAliveRequest) {
        CoreManager.shared.keepStreamAlive(request.values)
    }

    public func rgbLedControl(_ request: MentraRgbLedRequest) {
        CoreManager.shared.rgbLedControl(
            requestId: request.requestId,
            packageName: request.packageName,
            action: request.action.rawValue,
            color: request.color?.rawValue,
            ontime: request.ontime,
            offtime: request.offtime,
            count: request.count
        )
    }

    public func stopStream() {
        CoreManager.shared.stopStream()
    }

    public func startVideoRecording(_ request: MentraVideoRecordingRequest) {
        CoreManager.shared.startVideoRecording(
            request.requestId,
            request.save,
            request.flash,
            request.sound
        )
    }

    public func stopVideoRecording(requestId: String) {
        CoreManager.shared.stopVideoRecording(requestId)
    }

    public func requestVersionInfo() {
        CoreManager.shared.requestVersionInfo()
    }

    public func sendOtaStart() {
        CoreManager.shared.sendOtaStart()
    }

    public func sendOtaQueryStatus() {
        CoreManager.shared.sendOtaQueryStatus()
    }

    public func sendShutdown() {
        CoreManager.shared.sendShutdown()
    }

    public func sendReboot() {
        CoreManager.shared.sendReboot()
    }

    public func sendIncidentId(_ incidentId: String, apiBaseUrl: String? = nil) {
        CoreManager.shared.sendIncidentId(incidentId, apiBaseUrl: apiBaseUrl)
    }

    public func invalidate() {
        if let bridgeEventSinkId {
            Bridge.removeEventSink(bridgeEventSinkId)
            self.bridgeEventSinkId = nil
        }
        if let storeListenerId {
            GlassesStore.shared.store.removeListener(storeListenerId)
            self.storeListenerId = nil
        }
        delegate = nil
    }

    private func dispatchStoreUpdate(_ category: String, _ changes: [String: Any]) {
        switch ObservableStore.normalizeCategory(category) {
        case "glasses":
            delegate?.mentraBluetoothSDK(self, didUpdateGlassesStatus: MentraGlassesStatusUpdate(values: glassesStatusChanges(changes)))
        case ObservableStore.coreCategory:
            delegate?.mentraBluetoothSDK(self, didUpdateBluetoothStatus: MentraBluetoothStatusUpdate(values: changes))
            if !suppressDefaultDeviceEvents && changes.keys.contains(where: { defaultDeviceKeys.contains($0) }) {
                dispatchDefaultDeviceChanged()
            }
            dispatchDiscoveredDevices(changes["searchResults"])
        default:
            break
        }
    }

    private func glassesStatusChanges(_ changes: [String: Any]) -> [String: Any] {
        guard changes["signalStrengthUpdatedAt"] != nil, changes["signalStrength"] == nil else {
            return changes
        }

        var merged = changes
        merged["signalStrength"] = GlassesStore.shared.get("glasses", "signalStrength") as? Int ?? -1
        return merged
    }

    private func dispatchDefaultDeviceChanged() {
        delegate?.mentraBluetoothSDK(self, didChangeDefaultDevice: currentDefaultDevice())
    }

    private func finishDefaultDeviceApply(generation: Int) {
        Task { @MainActor [weak self] in
            guard let self, generation == self.defaultDeviceApplyGeneration else { return }
            self.suppressDefaultDeviceEvents = false
            self.dispatchDefaultDeviceChanged()
        }
    }

    private func currentDefaultDevice() -> MentraDevice? {
        let core = GlassesStore.shared.store.getCategory(ObservableStore.coreCategory)
        guard let model = core["default_wearable"] as? String, !model.isEmpty else { return nil }
        guard let name = core["device_name"] as? String, !name.isEmpty else { return nil }
        let identifier = (core["device_address"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return MentraDevice(
            model: MentraDeviceModel.fromDeviceType(model),
            name: name,
            identifier: identifier
        )
    }

    private func dispatchDiscoveredDevices(_ rawSearchResults: Any?) {
        guard let results = rawSearchResults as? [[String: Any]] else { return }
        for result in results {
            guard let name = result["deviceName"] as? String ?? result["name"] as? String else { continue }
            guard discoveredDeviceNames.insert(name).inserted else { continue }
            guard let device = MentraDevice(values: result) else { continue }
            delegate?.mentraBluetoothSDK(self, didDiscover: device)
        }
    }

    private func dispatchBridgeEvent(_ eventName: String, _ data: [String: Any]) {
        switch eventName {
        case "log":
            delegate?.mentraBluetoothSDK(self, didLog: data["message"] as? String ?? data.description)
        case "button_press":
            let event = MentraButtonPressEvent(
                buttonId: data["buttonId"] as? String ?? "",
                pressType: data["pressType"] as? String ?? "",
                timestamp: intValue(data["timestamp"])
            )
            delegate?.mentraBluetoothSDK(self, didReceive: .buttonPress(event))
        case "touch_event":
            delegate?.mentraBluetoothSDK(self, didReceive: .touch(MentraTouchEvent(values: data)))
        case "mic_pcm":
            if let frame = data["pcm"] as? Data {
                delegate?.mentraBluetoothSDK(self, didReceiveMicPcm: frame)
            }
        case "mic_lc3":
            if let frame = data["lc3"] as? Data {
                delegate?.mentraBluetoothSDK(self, didReceiveMicLc3: frame)
            }
        case "local_transcription":
            let event = MentraLocalTranscriptionEvent(
                text: data["text"] as? String ?? "",
                isFinal: data["isFinal"] as? Bool ?? false,
                values: data
            )
            delegate?.mentraBluetoothSDK(self, didReceive: .localTranscription(event))
        case "hotspot_status_change":
            delegate?.mentraBluetoothSDK(self, didReceive: .hotspotStatus(MentraHotspotStatusEvent(values: data)))
        case "wifi_status_change":
            delegate?.mentraBluetoothSDK(self, didReceive: .wifiStatus(MentraWifiStatusEvent(values: data)))
        case "hotspot_error":
            delegate?.mentraBluetoothSDK(self, didReceive: .hotspotError(MentraHotspotErrorEvent(values: data)))
        case "photo_response":
            delegate?.mentraBluetoothSDK(self, didReceive: .photoResponse(MentraPhotoResponseEvent(values: data)))
        case "stream_status":
            delegate?.mentraBluetoothSDK(self, didReceive: .streamStatus(MentraStreamStatusEvent(values: data)))
        case "compatible_glasses_search_stop":
            delegate?.mentraBluetoothSDK(self, didStopScan: .completed)
        case "pair_failure":
            delegate?.mentraBluetoothSDK(
                self,
                didFail: MentraBluetoothError(
                    code: "pair_failure",
                    message: data["error"] as? String ?? data.description
                )
            )
        default:
            delegate?.mentraBluetoothSDK(self, didReceive: .raw(name: eventName, values: data))
        }
    }
}
