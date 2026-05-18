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

public enum DeviceModel: String {
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

    public static func fromDeviceType(_ deviceType: String?) -> DeviceModel {
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

public struct Device: Identifiable, Equatable, CustomStringConvertible {
    public let model: DeviceModel
    public let name: String
    public let identifier: String?
    public let rssi: Int?
    public let id: String

    public init(
        model: DeviceModel,
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
        "Device(model: \(model), name: \(name))"
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
            model: DeviceModel.fromDeviceType(model),
            name: name,
            identifier: identifier,
            rssi: rssi,
            id: stringValue(values, "id")
        )
    }
}

public struct ConnectOptions {
    public let saveAsDefault: Bool
    public let cancelExistingConnectionAttempt: Bool

    public init(saveAsDefault: Bool = true, cancelExistingConnectionAttempt: Bool = true) {
        self.saveAsDefault = saveAsDefault
        self.cancelExistingConnectionAttempt = cancelExistingConnectionAttempt
    }
}

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
        "WifiScanResult(ssid: \(ssid), signalStrength: \(signalStrength))"
    }
}

public struct GlassesStatus: CustomStringConvertible {
    let values: [String: Any]

    init(values: [String: Any]) {
        self.values = values
    }

    public func applying(_ update: GlassesStatusUpdate) -> GlassesStatus {
        GlassesStatus(values: values.merging(update.values) { _, new in new })
    }

    public func withBattery(level: Int, charging: Bool) -> GlassesStatus {
        applying(GlassesStatusUpdate(values: ["batteryLevel": level, "charging": charging]))
    }

    public func withWifi(_ wifi: WifiStatus) -> GlassesStatus {
        applying(GlassesStatusUpdate(values: wifi.storeValues))
    }

    public func withHotspot(_ hotspot: HotspotStatus) -> GlassesStatus {
        applying(GlassesStatusUpdate(values: hotspot.storeValues))
    }

    public func disconnected() -> GlassesStatus {
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
    public var wifi: WifiStatus { WifiStatus.fromStoreValues(values) ?? .disconnected }
    public var hotspot: HotspotStatus { HotspotStatus.fromStoreValues(values) ?? .disabled }
    public var dictionary: [String: Any] { Self.dictionary(from: values) }
    public var batteryLevel: Int { intValue(values["batteryLevel"]) ?? -1 }
    public var charging: Bool { boolValue(values, "charging") ?? false }
    public var caseBatteryLevel: Int { intValue(values["caseBatteryLevel"]) ?? -1 }
    public var caseCharging: Bool { boolValue(values, "caseCharging") ?? false }
    public var caseOpen: Bool { boolValue(values, "caseOpen") ?? true }
    public var caseRemoved: Bool { boolValue(values, "caseRemoved") ?? true }
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
        dictionary["wifi"] = (WifiStatus.fromStoreValues(values) ?? .disconnected).values
        dictionary["hotspot"] = (HotspotStatus.fromStoreValues(values) ?? .disabled).values
        dictionary.removeValue(forKey: "wifiConnected")
        dictionary.removeValue(forKey: "wifiSsid")
        dictionary.removeValue(forKey: "wifiLocalIp")
        dictionary.removeValue(forKey: "hotspotEnabled")
        dictionary.removeValue(forKey: "hotspotSsid")
        dictionary.removeValue(forKey: "hotspotPassword")
        dictionary.removeValue(forKey: "hotspotGatewayIp")
        dictionary.removeValue(forKey: "hotspotLocalIp")
        return dictionary
    }

    static func updateDictionary(from values: [String: Any]) -> [String: Any] {
        var dictionary = values
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
        } else if hasAnyKey(values, "hotspotEnabled", "hotspotSsid", "hotspotPassword", "hotspotGatewayIp", "hotspotLocalIp") {
            if let hotspot = HotspotStatus.fromStoreValues(values) {
                dictionary["hotspot"] = hotspot.values
            }
            dictionary.removeValue(forKey: "hotspotEnabled")
            dictionary.removeValue(forKey: "hotspotSsid")
            dictionary.removeValue(forKey: "hotspotPassword")
            dictionary.removeValue(forKey: "hotspotGatewayIp")
            dictionary.removeValue(forKey: "hotspotLocalIp")
        }
        return dictionary
    }
}

public struct BluetoothStatus: CustomStringConvertible {
    let values: [String: Any]

    init(values: [String: Any]) {
        self.values = Self.normalized(values)
    }

    private static func normalized(_ values: [String: Any]) -> [String: Any] {
        var normalizedValues = values
        if let searchResults = values["searchResults"] as? [[String: Any]] {
            normalizedValues["searchResults"] = searchResults.compactMap { Device(values: $0)?.dictionary }
        }
        return normalizedValues
    }

    public func applying(_ update: BluetoothStatusUpdate) -> BluetoothStatus {
        BluetoothStatus(values: values.merging(update.values) { _, new in new })
    }

    public func withDefaultDevice(_ device: Device?) -> BluetoothStatus {
        applying(BluetoothStatusUpdate(values: [
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
    public var searchResults: [Device] {
        dictionaryListValue(values, "searchResults").compactMap(Device.init(values:))
    }
    public var wifiScanResults: [WifiScanResult] {
        dictionaryListValue(values, "wifiScanResults").map(WifiScanResult.init(values:))
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
    public var galleryModeAuto: Bool { boolValue(values, "gallery_mode") ?? true }
    public var buttonPhotoSize: ButtonPhotoSize {
        ButtonPhotoSize(rawValue: stringValue(values, "button_photo_size") ?? "") ?? .medium
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

    public var defaultDevice: Device? {
        guard !defaultWearable.isEmpty else { return nil }
        return Device(
            model: DeviceModel.fromDeviceType(defaultWearable),
            name: deviceName,
            identifier: deviceAddress.isEmpty ? nil : deviceAddress
        )
    }

    public var description: String {
        values.description
    }
}

public struct GlassesStatusUpdate: CustomStringConvertible {
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
    public var wifi: WifiStatus? {
        if let wifi = values["wifi"] as? [String: Any] {
            return WifiStatus(values: wifi)
        }
        if hasAnyKey(values, "wifiConnected", "wifiSsid", "wifiLocalIp") {
            return WifiStatus.fromStoreValues(values)
        }
        return nil
    }
    public var hotspot: HotspotStatus? {
        if let hotspot = values["hotspot"] as? [String: Any] {
            return HotspotStatus(values: hotspot)
        }
        if hasAnyKey(values, "hotspotEnabled", "hotspotSsid", "hotspotPassword", "hotspotGatewayIp", "hotspotLocalIp") {
            return HotspotStatus.fromStoreValues(values)
        }
        return nil
    }
    public var dictionary: [String: Any] { GlassesStatus.updateDictionary(from: values) }
    public var batteryLevel: Int? { optionalIntValue(values, "batteryLevel") }
    public var charging: Bool? { optionalBoolValue(values, "charging") }
    public var caseBatteryLevel: Int? { optionalIntValue(values, "caseBatteryLevel") }
    public var caseCharging: Bool? { optionalBoolValue(values, "caseCharging") }
    public var caseOpen: Bool? { optionalBoolValue(values, "caseOpen") }
    public var caseRemoved: Bool? { optionalBoolValue(values, "caseRemoved") }
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

public struct BluetoothStatusUpdate: CustomStringConvertible {
    let values: [String: Any]

    init(values: [String: Any]) {
        var normalizedValues = values
        if let searchResults = values["searchResults"] as? [[String: Any]] {
            normalizedValues["searchResults"] = searchResults.compactMap { Device(values: $0)?.dictionary }
        }
        self.values = normalizedValues
    }

    public var searching: Bool? { optionalBoolValue(values, "searching") }
    public var searchingController: Bool? { optionalBoolValue(values, "searchingController") }
    public var systemMicUnavailable: Bool? { optionalBoolValue(values, "systemMicUnavailable") }
    public var micEnabled: Bool? { optionalBoolValue(values, "micEnabled") }
    public var currentMic: String? { optionalStringValue(values, "currentMic") }
    public var micRanking: [String]? { optionalStringListValue(values, "micRanking") }
    public var searchResults: [Device]? {
        optionalDictionaryListValue(values, "searchResults")?.compactMap(Device.init(values:))
    }
    public var wifiScanResults: [WifiScanResult]? {
        optionalDictionaryListValue(values, "wifiScanResults")?.map(WifiScanResult.init(values:))
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
    public var buttonPhotoSize: ButtonPhotoSize? {
        optionalStringValue(values, "button_photo_size").flatMap(ButtonPhotoSize.init(rawValue:))
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

public struct DisplayTextRequest {
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

public struct DisplayEventRequest {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }
}

public struct DashboardPositionRequest {
    public let height: Int
    public let depth: Int

    public init(height: Int, depth: Int) {
        self.height = height
        self.depth = depth
    }
}

public struct DashboardMenuItem {
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

public enum GalleryMode {
    case auto
    case manual
}

public enum PhotoSize: String {
    case small
    case medium
    case large
    case full
}

public enum ButtonPhotoSize: String {
    case small
    case medium
    case large
}

public enum PhotoCompression: String {
    case none
    case medium
    case heavy
}

public struct ButtonPhotoSettings {
    public let size: ButtonPhotoSize

    public init(size: ButtonPhotoSize) {
        self.size = size
    }
}

public struct ButtonVideoRecordingSettings {
    public let width: Int
    public let height: Int
    public let fps: Int

    public init(width: Int, height: Int, fps: Int) {
        self.width = width
        self.height = height
        self.fps = fps
    }
}

public enum CameraFov {
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

public struct MicConfiguration {
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

public enum MicPreference: String {
    case auto
    case phone
    case glasses
    case bluetooth
}

public struct PhotoRequest {
    public let requestId: String
    public let appId: String
    public let size: PhotoSize
    public let webhookUrl: String?
    public let authToken: String?
    public let compress: PhotoCompression?
    public let flash: Bool
    public let sound: Bool
    /// Sensor exposure time for this capture only (ns), or nil for auto exposure
    public let exposureTimeNs: Double?

    public init(
        requestId: String,
        appId: String,
        size: PhotoSize,
        webhookUrl: String? = nil,
        authToken: String? = nil,
        compress: PhotoCompression? = nil,
        flash: Bool,
        sound: Bool,
        exposureTimeNs: Double? = nil
    ) {
        self.requestId = requestId
        self.appId = appId
        self.size = size
        self.webhookUrl = webhookUrl
        self.authToken = authToken
        self.compress = compress
        self.flash = flash
        self.sound = sound
        self.exposureTimeNs = exposureTimeNs
    }
}

public struct StreamVideoConfig {
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

public struct StreamAudioConfig {
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

public struct StreamRequest {
    public let streamUrl: String
    public let streamId: String
    public let keepAlive: Bool
    public let keepAliveIntervalSeconds: Int
    public let flash: Bool
    public let sound: Bool
    public let video: StreamVideoConfig?
    public let audio: StreamAudioConfig?
    public let extraValues: [String: Any]

    public init(
        streamUrl: String,
        streamId: String = "",
        keepAlive: Bool = true,
        keepAliveIntervalSeconds: Int = 15,
        flash: Bool = true,
        sound: Bool = true,
        video: StreamVideoConfig? = nil,
        audio: StreamAudioConfig? = nil,
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
            video: StreamVideoConfig(values: (values["video"] ?? values["v"]) as? [String: Any]),
            audio: StreamAudioConfig(values: (values["audio"] ?? values["a"]) as? [String: Any]),
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

public struct StreamKeepAliveRequest {
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

public enum RgbLedAction: String {
    case on
    case off
}

public enum RgbLedColor: String {
    case red
    case green
    case blue
    case orange
    case white
}

public struct RgbLedRequest {
    public let requestId: String
    public let packageName: String?
    public let action: RgbLedAction
    public let color: RgbLedColor?
    public let ontime: Int
    public let offtime: Int
    public let count: Int

    public init(
        requestId: String,
        packageName: String?,
        action: RgbLedAction,
        color: RgbLedColor?,
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

public struct VideoRecordingRequest {
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

public struct ButtonPressEvent: CustomStringConvertible {
    public let buttonId: String
    public let pressType: String
    public let timestamp: Int?

    public init(buttonId: String, pressType: String, timestamp: Int? = nil) {
        self.buttonId = buttonId
        self.pressType = pressType
        self.timestamp = timestamp
    }

    public var description: String {
        "ButtonPressEvent(buttonId: \(buttonId), pressType: \(pressType))"
    }
}

public struct TouchEvent: CustomStringConvertible {
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
        "TouchEvent(gestureName: \(gestureName ?? "unknown"))"
    }
}

public enum WifiStatus: CustomStringConvertible, Equatable {
    public enum State: String {
        case disconnected
        case connected
    }

    case disconnected
    case connected(ssid: String, localIp: String?)

    private init?(connected: Bool, ssid: String?, localIp: String?) {
        if connected {
            guard
                let ssid = ssid?.trimmingCharacters(in: .whitespacesAndNewlines),
                !ssid.isEmpty
            else {
                return nil
            }
            let trimmedLocalIp = localIp?.trimmingCharacters(in: .whitespacesAndNewlines)
            self = .connected(
                ssid: ssid,
                localIp: trimmedLocalIp?.isEmpty == false ? trimmedLocalIp : nil
            )
        } else {
            self = .disconnected
        }
    }

    init?(values: [String: Any]) {
        if let nested = values["wifi"] as? [String: Any] {
            guard let wifi = WifiStatus(values: nested) else {
                return nil
            }
            self = wifi
            return
        }

        if let state = stringValue(values, "state")?.lowercased() {
            switch state {
            case State.connected.rawValue:
                guard let wifi = WifiStatus(
                    connected: true,
                    ssid: nonEmptyStringValue(values, "ssid"),
                    localIp: nonEmptyStringValue(values, "localIp")
                ) else {
                    return nil
                }
                self = wifi
            case State.disconnected.rawValue:
                self = .disconnected
            default:
                return nil
            }
            return
        }

        return nil
    }

    static func fromStoreValues(_ values: [String: Any]) -> WifiStatus? {
        guard let connected = boolValue(values, "wifiConnected") else { return nil }
        return fromStoreFields(
            connected: connected,
            ssid: nonEmptyStringValue(values, "wifiSsid"),
            localIp: nonEmptyStringValue(values, "wifiLocalIp")
        )
    }

    static func fromStoreFields(connected: Bool, ssid: String?, localIp: String?) -> WifiStatus? {
        WifiStatus(connected: connected, ssid: ssid, localIp: localIp)
    }

    public var state: State {
        switch self {
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
        case .disconnected:
            return ["state": State.disconnected.rawValue]
        case let .connected(ssid, localIp):
            var values: [String: Any] = [
                "state": State.connected.rawValue,
                "ssid": ssid,
            ]
            if let localIp = localIp {
                values["localIp"] = localIp
            }
            return values
        }
    }

    var storeValues: [String: Any] {
        switch self {
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
                "wifiLocalIp": localIp ?? "",
            ]
        }
    }

    public var description: String {
        switch self {
        case .disconnected:
            "WifiStatus(disconnected)"
        case let .connected(ssid, localIp):
            "WifiStatus(connected: \(ssid), localIp: \(localIp ?? "unknown"))"
        }
    }
}

public struct WifiStatusEvent: CustomStringConvertible {
    public let status: WifiStatus

    public init(status: WifiStatus) {
        self.status = status
    }

    init(connected: Bool, ssid: String?, localIp: String?) {
        self.status = WifiStatus.fromStoreFields(connected: connected, ssid: ssid, localIp: localIp) ?? .disconnected
    }

    init(values: [String: Any]) {
        self.status = WifiStatus(values: values) ?? .disconnected
    }

    public var values: [String: Any] {
        status.values.merging(["type": "wifi_status_change"]) { _, new in new }
    }

    public var description: String {
        "WifiStatusEvent(\(status))"
    }
}

public enum HotspotStatus: CustomStringConvertible, Equatable {
    public enum State: String {
        case disabled
        case enabled
    }

    case disabled
    case enabled(ssid: String, password: String, localIp: String)

    public init?(enabled: Bool, ssid: String?, password: String?, localIp: String?) {
        if enabled {
            guard
                let ssid = ssid?.trimmingCharacters(in: .whitespacesAndNewlines),
                !ssid.isEmpty,
                let password = password?.trimmingCharacters(in: .whitespacesAndNewlines),
                !password.isEmpty,
                let localIp = localIp?.trimmingCharacters(in: .whitespacesAndNewlines),
                !localIp.isEmpty
            else {
                return nil
            }
            self = .enabled(ssid: ssid, password: password, localIp: localIp)
        } else {
            self = .disabled
        }
    }

    public init?(values: [String: Any]) {
        if let nested = values["hotspot"] as? [String: Any] {
            self.init(values: nested)
            return
        }

        guard let state = stringValue(values, "state")?.lowercased() else {
            return nil
        }

        switch state {
        case State.enabled.rawValue:
            self.init(
                enabled: true,
                ssid: nonEmptyStringValue(values, "ssid"),
                password: nonEmptyStringValue(values, "password"),
                localIp: nonEmptyStringValue(values, "localIp")
            )
        case State.disabled.rawValue:
            self = .disabled
        default:
            return nil
        }
    }

    static func fromStoreValues(_ values: [String: Any]) -> HotspotStatus? {
        guard let enabled = boolValue(values, "hotspotEnabled") else {
            return nil
        }
        return fromStoreFields(
            enabled: enabled,
            ssid: nonEmptyStringValue(values, "hotspotSsid"),
            password: nonEmptyStringValue(values, "hotspotPassword"),
            localIp: nonEmptyStringValue(values, "hotspotGatewayIp", "hotspotLocalIp")
        )
    }

    static func fromStoreFields(enabled: Bool, ssid: String?, password: String?, localIp: String?) -> HotspotStatus? {
        HotspotStatus(enabled: enabled, ssid: ssid, password: password, localIp: localIp)
    }

    var storeValues: [String: Any] {
        switch self {
        case .disabled:
            [
                "hotspotEnabled": false,
                "hotspotSsid": "",
                "hotspotPassword": "",
                "hotspotGatewayIp": "",
            ]
        case let .enabled(ssid, password, localIp):
            [
                "hotspotEnabled": true,
                "hotspotSsid": ssid,
                "hotspotPassword": password,
                "hotspotGatewayIp": localIp,
            ]
        }
    }

    public var values: [String: Any] {
        switch self {
        case .disabled:
            ["state": State.disabled.rawValue]
        case let .enabled(ssid, password, localIp):
            [
                "state": State.enabled.rawValue,
                "ssid": ssid,
                "password": password,
                "localIp": localIp,
            ]
        }
    }

    public var state: State {
        switch self {
        case .disabled:
            .disabled
        case .enabled:
            .enabled
        }
    }

    public var isEnabled: Bool {
        if case .enabled = self {
            return true
        }
        return false
    }

    public var description: String {
        switch self {
        case .disabled:
            "HotspotStatus(disabled)"
        case let .enabled(ssid, _, localIp):
            "HotspotStatus(enabled: \(ssid), localIp: \(localIp))"
        }
    }
}

public struct HotspotStatusEvent: CustomStringConvertible {
    public let status: HotspotStatus

    public init(status: HotspotStatus) {
        self.status = status
    }

    init(enabled: Bool, ssid: String?, password: String?, localIp: String?) {
        self.status = HotspotStatus.fromStoreFields(enabled: enabled, ssid: ssid, password: password, localIp: localIp) ?? .disabled
    }

    init(values: [String: Any]) {
        self.status = HotspotStatus(values: values) ?? .disabled
    }

    public var values: [String: Any] {
        status.values.merging(["type": "hotspot_status_change"]) { _, new in new }
    }

    public var description: String {
        "HotspotStatusEvent(\(status))"
    }
}

public struct HotspotErrorEvent: CustomStringConvertible {
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
        "HotspotErrorEvent(message: \(message ?? "unknown"))"
    }
}

public enum PhotoResponse: CustomStringConvertible, Equatable {
    public enum State: String {
        case success
        case error
    }

    case success(requestId: String, photoUrl: String, timestamp: Int)
    case error(requestId: String, errorCode: String?, errorMessage: String, timestamp: Int)

    public init(values: [String: Any]) {
        let requestId = stringValue(values, "requestId", "request_id") ?? ""
        let timestamp = intValue(values["timestamp"]) ?? Int(Date().timeIntervalSince1970 * 1000)
        let state = stringValue(values, "state", "status")?.lowercased()
        if state == State.success.rawValue || boolValue(values, "success") == true {
            self = .success(
                requestId: requestId,
                photoUrl: stringValue(values, "photoUrl", "photo_url") ?? "",
                timestamp: timestamp
            )
        } else {
            self = .error(
                requestId: requestId,
                errorCode: stringValue(values, "errorCode", "error_code"),
                errorMessage: stringValue(values, "errorMessage", "error_message", "error") ?? "Unknown photo error",
                timestamp: timestamp
            )
        }
    }

    public var state: State {
        switch self {
        case .success:
            .success
        case .error:
            .error
        }
    }

    public var requestId: String {
        switch self {
        case let .success(requestId, _, _), let .error(requestId, _, _, _):
            requestId
        }
    }

    public var timestamp: Int {
        switch self {
        case let .success(_, _, timestamp), let .error(_, _, _, timestamp):
            timestamp
        }
    }

    public var values: [String: Any] {
        switch self {
        case let .success(requestId, photoUrl, timestamp):
            return [
                "state": State.success.rawValue,
                "requestId": requestId,
                "photoUrl": photoUrl,
                "timestamp": timestamp,
            ]
        case let .error(requestId, errorCode, errorMessage, timestamp):
            var values: [String: Any] = [
                "state": State.error.rawValue,
                "requestId": requestId,
                "errorMessage": errorMessage,
                "timestamp": timestamp,
            ]
            if let errorCode, !errorCode.isEmpty {
                values["errorCode"] = errorCode
            }
            return values
        }
    }

    public var description: String {
        "PhotoResponse(requestId: \(requestId), state: \(state.rawValue))"
    }
}

public struct PhotoResponseEvent: CustomStringConvertible {
    public let response: PhotoResponse

    public init(response: PhotoResponse) {
        self.response = response
    }

    public init(values: [String: Any]) {
        self.response = PhotoResponse(values: values)
    }

    public var requestId: String {
        response.requestId
    }

    public var values: [String: Any] {
        var values = response.values
        values["type"] = "photo_response"
        return values
    }

    public var description: String {
        "PhotoResponseEvent(requestId: \(requestId), state: \(response.state.rawValue))"
    }
}

public enum StreamState: String, Equatable {
    case initializing
    case streaming
    case stopping
    case stopped
    case reconnecting
    case reconnected
    case reconnectFailed = "reconnect_failed"
    case error

    fileprivate static func from(_ value: String?) -> StreamState? {
        switch value?.lowercased() {
        case "initializing", "starting", "connecting":
            return .initializing
        case "streaming", "streaming_started", "active":
            return .streaming
        case "stopping":
            return .stopping
        case "stopped", "not_streaming", "disconnected", "timeout":
            return .stopped
        case "reconnecting":
            return .reconnecting
        case "reconnected":
            return .reconnected
        case "reconnect_failed":
            return .reconnectFailed
        case "error", "error_not_streaming":
            return .error
        default:
            return nil
        }
    }
}

public enum StreamStatusKind: String, Equatable {
    case lifecycle
    case reconnect
    case error
    case snapshot
}

public enum StreamStatus: CustomStringConvertible, Equatable {
    case lifecycle(state: StreamState, streamId: String?, timestamp: Int?)
    case reconnecting(streamId: String?, attempt: Int, maxAttempts: Int, reason: String, timestamp: Int?)
    case reconnected(streamId: String?, attempt: Int, timestamp: Int?)
    case reconnectFailed(streamId: String?, maxAttempts: Int, timestamp: Int?)
    case error(streamId: String?, errorDetails: String, timestamp: Int?)
    case snapshot(state: StreamState, streaming: Bool, reconnecting: Bool, streamId: String?, attempt: Int?, timestamp: Int?)

    public init(values: [String: Any]) {
        let rawState = stringValue(values, "status")
        let streamId = stringValue(values, "streamId", "stream_id")
        let timestamp = intValue(values["timestamp"])
        let attempt = optionalIntValue(values, "attempt")
        let maxAttempts = optionalIntValue(values, "maxAttempts", "max_attempts") ?? 0

        if hasAnyKey(values, "streaming") || hasAnyKey(values, "reconnecting") {
            let streaming = boolValue(values, "streaming") == true
            let reconnecting = boolValue(values, "reconnecting") == true
            let snapshotState: StreamState = reconnecting ? .reconnecting : (streaming ? .streaming : .stopped)
            self = .snapshot(
                state: snapshotState,
                streaming: streaming,
                reconnecting: reconnecting,
                streamId: streamId,
                attempt: attempt,
                timestamp: timestamp
            )
            return
        }

        guard let state = StreamState.from(rawState) else {
            self = .error(
                streamId: streamId,
                errorDetails: rawState.map { "Unknown stream status: \($0)" } ?? "Missing stream status",
                timestamp: timestamp
            )
            return
        }

        switch state {
        case .reconnecting:
            self = .reconnecting(
                streamId: streamId,
                attempt: attempt ?? 0,
                maxAttempts: maxAttempts,
                reason: stringValue(values, "reason") ?? "",
                timestamp: timestamp
            )
        case .reconnected:
            self = .reconnected(streamId: streamId, attempt: attempt ?? 0, timestamp: timestamp)
        case .reconnectFailed:
            self = .reconnectFailed(streamId: streamId, maxAttempts: maxAttempts, timestamp: timestamp)
        case .error:
            self = .error(
                streamId: streamId,
                errorDetails: stringValue(values, "errorDetails", "error_details", "details", "error", "errorMessage")
                    ?? (rawState == "error_not_streaming" ? "not_streaming" : "Unknown stream error"),
                timestamp: timestamp
            )
        default:
            self = .lifecycle(state: state, streamId: streamId, timestamp: timestamp)
        }
    }

    public var kind: StreamStatusKind {
        switch self {
        case .lifecycle:
            .lifecycle
        case .reconnecting, .reconnected, .reconnectFailed:
            .reconnect
        case .error:
            .error
        case .snapshot:
            .snapshot
        }
    }

    public var state: StreamState {
        switch self {
        case let .lifecycle(state, _, _):
            state
        case .reconnecting:
            .reconnecting
        case .reconnected:
            .reconnected
        case .reconnectFailed:
            .reconnectFailed
        case .error:
            .error
        case let .snapshot(state, _, _, _, _, _):
            state
        }
    }

    public var streamId: String? {
        switch self {
        case let .lifecycle(_, streamId, _),
             let .reconnecting(streamId, _, _, _, _),
             let .reconnected(streamId, _, _),
             let .reconnectFailed(streamId, _, _),
             let .error(streamId, _, _),
             let .snapshot(_, _, _, streamId, _, _):
            streamId
        }
    }

    public var timestamp: Int? {
        switch self {
        case let .lifecycle(_, _, timestamp),
             let .reconnecting(_, _, _, _, timestamp),
             let .reconnected(_, _, timestamp),
             let .reconnectFailed(_, _, timestamp),
             let .error(_, _, timestamp),
             let .snapshot(_, _, _, _, _, timestamp):
            timestamp
        }
    }

    public var values: [String: Any] {
        var values: [String: Any] = [
            "kind": kind.rawValue,
            "status": state.rawValue,
        ]
        if let streamId, !streamId.isEmpty {
            values["streamId"] = streamId
        }
        if let timestamp {
            values["timestamp"] = timestamp
        }

        switch self {
        case .lifecycle:
            break
        case let .reconnecting(_, attempt, maxAttempts, reason, _):
            values["attempt"] = attempt
            values["maxAttempts"] = maxAttempts
            values["reason"] = reason
        case let .reconnected(_, attempt, _):
            values["attempt"] = attempt
        case let .reconnectFailed(_, maxAttempts, _):
            values["maxAttempts"] = maxAttempts
        case let .error(_, errorDetails, _):
            values["errorDetails"] = errorDetails
        case let .snapshot(_, streaming, reconnecting, _, attempt, _):
            values["streaming"] = streaming
            values["reconnecting"] = reconnecting
            if let attempt {
                values["attempt"] = attempt
            }
        }

        return values
    }

    public var description: String {
        "StreamStatus(kind: \(kind.rawValue), status: \(state.rawValue), streamId: \(streamId ?? "none"))"
    }
}

public struct StreamStatusEvent: CustomStringConvertible {
    public let status: StreamStatus

    public init(status: StreamStatus) {
        self.status = status
    }

    public init(values: [String: Any]) {
        self.status = StreamStatus(values: values)
    }

    public var state: StreamState {
        status.state
    }

    public var streamId: String? {
        status.streamId
    }

    public var values: [String: Any] {
        var values = status.values
        values["type"] = "stream_status"
        return values
    }

    public var description: String {
        "StreamStatusEvent(kind: \(status.kind.rawValue), status: \(state.rawValue), streamId: \(streamId ?? "none"))"
    }
}

public struct KeepAliveAckEvent: CustomStringConvertible, Equatable {
    public let streamId: String
    public let ackId: String
    public let timestamp: Int?

    public init(streamId: String, ackId: String, timestamp: Int? = nil) {
        self.streamId = streamId
        self.ackId = ackId
        self.timestamp = timestamp
    }

    public init(values: [String: Any]) {
        self.streamId = stringValue(values, "streamId", "stream_id") ?? ""
        self.ackId = stringValue(values, "ackId", "ack_id") ?? ""
        self.timestamp = intValue(values["timestamp"])
    }

    public var values: [String: Any] {
        var values: [String: Any] = [
            "type": "keep_alive_ack",
            "streamId": streamId,
            "ackId": ackId,
        ]
        if let timestamp {
            values["timestamp"] = timestamp
        }
        return values
    }

    public var description: String {
        "KeepAliveAckEvent(streamId: \(streamId), ackId: \(ackId))"
    }
}

public struct BluetoothError: Error, LocalizedError, CustomStringConvertible {
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
            throw BluetoothError(
                code: "bluetooth_powered_off",
                message: "Turn on phone Bluetooth to \(operation)."
            )
        case .unauthorized:
            throw BluetoothError(
                code: "bluetooth_unauthorized",
                message: "Allow Bluetooth access to \(operation)."
            )
        case .unsupported:
            throw BluetoothError(
                code: "bluetooth_unsupported",
                message: "This phone does not support Bluetooth."
            )
        case .resetting, .unknown:
            throw BluetoothError(
                code: "bluetooth_not_ready",
                message: "Bluetooth is not ready yet. Try again."
            )
        @unknown default:
            throw BluetoothError(
                code: "bluetooth_unavailable",
                message: "Bluetooth is unavailable. Try again."
            )
        }
    }
}

public enum ScanStopReason {
    case completed
    case cancelled
    case error
}

public struct LocalTranscriptionEvent: CustomStringConvertible {
    public let text: String
    public let isFinal: Bool
    public let values: [String: Any]

    public init(text: String, isFinal: Bool, values: [String: Any]) {
        self.text = text
        self.isFinal = isFinal
        self.values = values
    }

    public var description: String {
        "LocalTranscriptionEvent(text: \(text), isFinal: \(isFinal))"
    }
}

public enum BluetoothEvent: CustomStringConvertible {
    case buttonPress(ButtonPressEvent)
    case touch(TouchEvent)
    case wifiStatus(WifiStatusEvent)
    case hotspotStatus(HotspotStatusEvent)
    case hotspotError(HotspotErrorEvent)
    case photoResponse(PhotoResponseEvent)
    case streamStatus(StreamStatusEvent)
    case keepAliveAck(KeepAliveAckEvent)
    case localTranscription(LocalTranscriptionEvent)
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
        case let .keepAliveAck(event):
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
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlassesStatus status: GlassesStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateBluetoothStatus status: BluetoothStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: Device)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didStopScan reason: ScanStopReason)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceive event: BluetoothEvent)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicPcm frame: Data)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicLc3 frame: Data)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didChangeDefaultDevice device: Device?)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didLog message: String)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didFail error: BluetoothError)
}

@MainActor
public extension MentraBluetoothSDKDelegate {
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateGlassesStatus _: GlassesStatusUpdate) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateBluetoothStatus _: BluetoothStatusUpdate) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didDiscover _: Device) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didStopScan _: ScanStopReason) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceive _: BluetoothEvent) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicPcm _: Data) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicLc3 _: Data) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didChangeDefaultDevice _: Device?) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didLog _: String) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didFail _: BluetoothError) {}
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

    public var glassesStatus: GlassesStatus {
        GlassesStatus(values: GlassesStore.shared.store.getCategory("glasses"))
    }

    public var bluetoothStatus: BluetoothStatus {
        BluetoothStatus(values: GlassesStore.shared.store.getCategory(ObservableStore.coreCategory))
    }

    public var defaultDevice: Device? {
        currentDefaultDevice()
    }

    public func getDefaultDevice() -> Device? {
        currentDefaultDevice()
    }

    public func setDefaultDevice(_ device: Device?) {
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

    public func startScan(model: DeviceModel) throws {
        if model != .simulated {
            try BluetoothAvailability.shared.requirePoweredOn(operation: "scan for glasses")
        }
        discoveredDeviceNames.removeAll()
        GlassesStore.shared.apply(ObservableStore.coreCategory, "searching", true)
        CoreManager.shared.findCompatibleDevices(model.deviceType)
    }

    public func stopScan() {
        CoreManager.shared.stopScan()
        GlassesStore.shared.apply(ObservableStore.coreCategory, "searching", false)
        delegate?.mentraBluetoothSDK(self, didStopScan: .cancelled)
    }

    public func connect(to device: Device, options: ConnectOptions = ConnectOptions()) throws {
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

    public func connectDefault(options: ConnectOptions = ConnectOptions()) throws {
        guard let device = currentDefaultDevice() else {
            throw BluetoothError(
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

    public func displayText(_ request: DisplayTextRequest) async throws {
        CoreManager.shared.displayText(request.dictionary)
    }

    public func displayEvent(_ request: DisplayEventRequest) async throws {
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

    public func setDashboardPosition(_ request: DashboardPositionRequest) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "dashboard_height", request.height)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "dashboard_depth", request.depth)
    }

    public func setDashboardMenu(_ items: [DashboardMenuItem]) async throws {
        GlassesStore.shared.apply(
            ObservableStore.coreCategory,
            "menu_apps",
            items.map(\.dictionary)
        )
    }

    public func setHeadUpAngle(_ angleDegrees: Int) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "head_up_angle", angleDegrees)
    }

    public func setScreenDisabled(_ disabled: Bool) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "screen_disabled", disabled)
    }

    public func setGalleryMode(_ mode: GalleryMode) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "gallery_mode", mode == .auto)
    }

    public func setButtonPhotoSettings(_ settings: ButtonPhotoSettings) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "button_photo_size", settings.size.rawValue)
    }

    public func setButtonVideoRecordingSettings(_ settings: ButtonVideoRecordingSettings) async throws {
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

    public func setCameraFov(_ fov: CameraFov) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "camera_fov", fov.value)
    }

    public func setMicState(_ config: MicConfiguration) {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "should_send_pcm", config.sendPcmData)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "should_send_lc3", config.sendLc3Data)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "should_send_transcript", config.sendTranscript)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "bypass_vad", config.bypassVad)
        CoreManager.shared.setMicState()
    }

    public func setPreferredMic(_ preferredMic: MicPreference) {
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

    public func requestPhoto(_ request: PhotoRequest) {
        Bridge.log(
            "NATIVE: PHOTO PIPELINE [3b/6] MentraBluetoothSdk.requestPhoto requestId=\(request.requestId) appId=\(request.appId)"
        )
        CoreManager.shared.photoRequest(
            request.requestId,
            request.appId,
            request.size.rawValue,
            request.webhookUrl,
            request.authToken,
            request.compress?.rawValue,
            request.flash,
            request.sound,
            exposureTimeNs: request.exposureTimeNs
        )
    }

    public func queryGalleryStatus() {
        CoreManager.shared.queryGalleryStatus()
    }

    public func startStream(_ request: StreamRequest) {
        CoreManager.shared.startStream(request.values)
    }

    public func keepStreamAlive(_ request: StreamKeepAliveRequest) {
        CoreManager.shared.keepStreamAlive(request.values)
    }

    public func rgbLedControl(_ request: RgbLedRequest) {
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

    public func startVideoRecording(_ request: VideoRecordingRequest) {
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
            delegate?.mentraBluetoothSDK(self, didUpdateGlassesStatus: GlassesStatusUpdate(values: glassesStatusChanges(changes)))
        case ObservableStore.coreCategory:
            delegate?.mentraBluetoothSDK(self, didUpdateBluetoothStatus: BluetoothStatusUpdate(values: changes))
            if !suppressDefaultDeviceEvents && changes.keys.contains(where: { defaultDeviceKeys.contains($0) }) {
                dispatchDefaultDeviceChanged()
            }
            dispatchDiscoveredDevices(changes["searchResults"])
        default:
            break
        }
    }

    private func glassesStatusChanges(_ changes: [String: Any]) -> [String: Any] {
        var merged = changes

        if changes.keys.contains(where: { ["wifiConnected", "wifiSsid", "wifiLocalIp"].contains($0) }) {
            merged["wifiConnected"] = GlassesStore.shared.get("glasses", "wifiConnected") as? Bool ?? false
            merged["wifiSsid"] = GlassesStore.shared.get("glasses", "wifiSsid") as? String ?? ""
            merged["wifiLocalIp"] = GlassesStore.shared.get("glasses", "wifiLocalIp") as? String ?? ""
        }

        if changes["signalStrengthUpdatedAt"] != nil, changes["signalStrength"] == nil {
            merged["signalStrength"] = GlassesStore.shared.get("glasses", "signalStrength") as? Int ?? -1
        }

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

    private func currentDefaultDevice() -> Device? {
        let core = GlassesStore.shared.store.getCategory(ObservableStore.coreCategory)
        guard let model = core["default_wearable"] as? String, !model.isEmpty else { return nil }
        guard let name = core["device_name"] as? String, !name.isEmpty else { return nil }
        let identifier = (core["device_address"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return Device(
            model: DeviceModel.fromDeviceType(model),
            name: name,
            identifier: identifier
        )
    }

    private func dispatchDiscoveredDevices(_ rawSearchResults: Any?) {
        guard let results = rawSearchResults as? [[String: Any]] else { return }
        for result in results {
            guard let name = result["deviceName"] as? String ?? result["name"] as? String else { continue }
            guard discoveredDeviceNames.insert(name).inserted else { continue }
            guard let device = Device(values: result) else { continue }
            delegate?.mentraBluetoothSDK(self, didDiscover: device)
        }
    }

    private func dispatchBridgeEvent(_ eventName: String, _ data: [String: Any]) {
        switch eventName {
        case "log":
            delegate?.mentraBluetoothSDK(self, didLog: data["message"] as? String ?? data.description)
        case "button_press":
            let event = ButtonPressEvent(
                buttonId: data["buttonId"] as? String ?? "",
                pressType: data["pressType"] as? String ?? "",
                timestamp: intValue(data["timestamp"])
            )
            delegate?.mentraBluetoothSDK(self, didReceive: .buttonPress(event))
        case "touch_event":
            delegate?.mentraBluetoothSDK(self, didReceive: .touch(TouchEvent(values: data)))
        case "mic_pcm":
            if let frame = data["pcm"] as? Data {
                delegate?.mentraBluetoothSDK(self, didReceiveMicPcm: frame)
            }
        case "mic_lc3":
            if let frame = data["lc3"] as? Data {
                delegate?.mentraBluetoothSDK(self, didReceiveMicLc3: frame)
            }
        case "local_transcription":
            let event = LocalTranscriptionEvent(
                text: data["text"] as? String ?? "",
                isFinal: data["isFinal"] as? Bool ?? false,
                values: data
            )
            delegate?.mentraBluetoothSDK(self, didReceive: .localTranscription(event))
        case "hotspot_status_change":
            delegate?.mentraBluetoothSDK(self, didReceive: .hotspotStatus(HotspotStatusEvent(values: data)))
        case "wifi_status_change":
            delegate?.mentraBluetoothSDK(self, didReceive: .wifiStatus(WifiStatusEvent(values: data)))
        case "hotspot_error":
            delegate?.mentraBluetoothSDK(self, didReceive: .hotspotError(HotspotErrorEvent(values: data)))
        case "photo_response":
            delegate?.mentraBluetoothSDK(self, didReceive: .photoResponse(PhotoResponseEvent(values: data)))
        case "stream_status":
            delegate?.mentraBluetoothSDK(self, didReceive: .streamStatus(StreamStatusEvent(values: data)))
        case "keep_alive_ack":
            delegate?.mentraBluetoothSDK(self, didReceive: .keepAliveAck(KeepAliveAckEvent(values: data)))
        case "compatible_glasses_search_stop":
            delegate?.mentraBluetoothSDK(self, didStopScan: .completed)
        case "pair_failure":
            delegate?.mentraBluetoothSDK(
                self,
                didFail: BluetoothError(
                    code: "pair_failure",
                    message: data["error"] as? String ?? data.description
                )
            )
        default:
            delegate?.mentraBluetoothSDK(self, didReceive: .raw(name: eventName, values: data))
        }
    }
}
