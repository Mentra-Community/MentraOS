import Foundation

public struct MentraBluetoothState: CustomStringConvertible {
    public let glasses: GlassesRuntimeState
    public let sdk: PhoneSdkRuntimeState
    public let scan: BluetoothScanState

    public init(glasses: GlassesRuntimeState, sdk: PhoneSdkRuntimeState, scan: BluetoothScanState) {
        self.glasses = glasses
        self.sdk = sdk
        self.scan = scan
    }

    init(glassesStatus: GlassesStatus, bluetoothStatus: BluetoothStatus) {
        glasses = GlassesRuntimeState(status: glassesStatus)
        sdk = PhoneSdkRuntimeState(status: bluetoothStatus)
        scan = BluetoothScanState(status: bluetoothStatus)
    }

    public var description: String {
        "MentraBluetoothState(glasses: \(glasses), scan: \(scan))"
    }
}

public struct GlassesBatteryState: Equatable, CustomStringConvertible {
    public let charging: Bool
    public let level: Int?

    public init(charging: Bool, level: Int?) {
        self.charging = charging
        self.level = level
    }

    public var description: String {
        "GlassesBatteryState(level: \(level.map(String.init) ?? "unknown"), charging: \(charging))"
    }
}

public struct ConnectedGlassesInfo: Equatable, CustomStringConvertible {
    public let appVersion: String?
    public let bluetoothName: String?
    public let buildNumber: String?
    public let color: String?
    public let deviceModel: DeviceModel?
    public let firmwareVersion: String?
    public let serialNumber: String?
    public let style: String?

    public init(
        appVersion: String?,
        bluetoothName: String?,
        buildNumber: String?,
        color: String?,
        deviceModel: DeviceModel?,
        firmwareVersion: String?,
        serialNumber: String?,
        style: String?
    ) {
        self.appVersion = appVersion
        self.bluetoothName = bluetoothName
        self.buildNumber = buildNumber
        self.color = color
        self.deviceModel = deviceModel
        self.firmwareVersion = firmwareVersion
        self.serialNumber = serialNumber
        self.style = style
    }

    public var description: String {
        bluetoothName ?? serialNumber ?? deviceModel?.deviceType ?? "Connected glasses"
    }
}

public enum FirmwareSource: String {
    case app
    case bes
    case firmware
    case mtk
    case unknown
}

public struct FirmwareInfo: Equatable, CustomStringConvertible {
    public let appVersion: String?
    public let buildNumber: String?
    public let source: FirmwareSource
    public let version: String?

    public init(appVersion: String?, buildNumber: String?, source: FirmwareSource, version: String?) {
        self.appVersion = appVersion
        self.buildNumber = buildNumber
        self.source = source
        self.version = version
    }

    public var description: String {
        version ?? "Unknown firmware"
    }
}

public struct SignalState: Equatable, CustomStringConvertible {
    public let strengthDbm: Int?
    public let updatedAt: Int?

    public init(strengthDbm: Int?, updatedAt: Int?) {
        self.strengthDbm = strengthDbm
        self.updatedAt = updatedAt
    }

    public var description: String {
        strengthDbm.map { "\($0) dBm" } ?? "Unknown signal"
    }
}

public enum GlassesRuntimeState: CustomStringConvertible {
    case disconnected(connection: GlassesConnectionState)
    case connected(
        battery: GlassesBatteryState,
        connection: GlassesConnectionState,
        device: ConnectedGlassesInfo,
        firmware: FirmwareInfo,
        hotspot: HotspotStatus,
        ready: Bool,
        signal: SignalState,
        voiceActivityDetectionEnabled: Bool,
        wifi: WifiStatus
    )

    init(status: GlassesStatus) {
        if !status.connected, status.connectionState != .connected {
            self = .disconnected(connection: status.connectionState)
            return
        }

        self = .connected(
            battery: GlassesBatteryState(
                charging: status.charging,
                level: status.batteryLevel >= 0 ? status.batteryLevel : nil
            ),
            connection: .connected,
            device: ConnectedGlassesInfo(
                appVersion: status.appVersion.nonEmpty,
                bluetoothName: status.bluetoothName.nonEmpty,
                buildNumber: status.buildNumber.nonEmpty,
                color: status.color.nonEmpty,
                deviceModel: status.deviceModel.nonEmpty.map(DeviceModel.fromDeviceType),
                firmwareVersion: status.firmwareVersion.nonEmpty,
                serialNumber: status.serialNumber.nonEmpty,
                style: status.style.nonEmpty
            ),
            firmware: FirmwareInfo(status: status),
            hotspot: status.hotspot,
            ready: status.fullyBooted,
            signal: SignalState(
                strengthDbm: status.signalStrength == -1 ? nil : status.signalStrength,
                updatedAt: status.signalStrengthUpdatedAt <= 0 ? nil : status.signalStrengthUpdatedAt
            ),
            voiceActivityDetectionEnabled: status.voiceActivityDetectionEnabled,
            wifi: status.wifi
        )
    }

    public var connected: Bool {
        if case .connected = self {
            return true
        }
        return false
    }

    public var connection: GlassesConnectionState {
        switch self {
        case let .disconnected(connection):
            connection
        case let .connected(_, connection, _, _, _, _, _, _, _):
            connection
        }
    }

    public var ready: Bool {
        switch self {
        case .disconnected:
            false
        case let .connected(_, _, _, _, _, ready, _, _, _):
            ready
        }
    }

    public var battery: GlassesBatteryState? {
        guard case let .connected(battery, _, _, _, _, _, _, _, _) = self else {
            return nil
        }
        return battery
    }

    public var device: ConnectedGlassesInfo? {
        guard case let .connected(_, _, device, _, _, _, _, _, _) = self else {
            return nil
        }
        return device
    }

    public var firmware: FirmwareInfo? {
        guard case let .connected(_, _, _, firmware, _, _, _, _, _) = self else {
            return nil
        }
        return firmware
    }

    public var hotspot: HotspotStatus? {
        guard case let .connected(_, _, _, _, hotspot, _, _, _, _) = self else {
            return nil
        }
        return hotspot
    }

    public var signal: SignalState? {
        guard case let .connected(_, _, _, _, _, _, signal, _, _) = self else {
            return nil
        }
        return signal
    }

    public var voiceActivityDetectionEnabled: Bool {
        guard case let .connected(_, _, _, _, _, _, _, voiceActivityDetectionEnabled, _) = self else {
            return false
        }
        return voiceActivityDetectionEnabled
    }

    public var wifi: WifiStatus? {
        guard case let .connected(_, _, _, _, _, _, _, _, wifi) = self else {
            return nil
        }
        return wifi
    }

    public var description: String {
        switch self {
        case let .disconnected(connection):
            "GlassesRuntimeState(\(connection.rawValue))"
        case let .connected(_, _, device, _, _, ready, _, _, _):
            "GlassesRuntimeState(connected: \(device), ready: \(ready))"
        }
    }
}

public struct GalleryModeState: Equatable {
    public let enabled: Bool

    public init(enabled: Bool) {
        self.enabled = enabled
    }
}

public enum MicMode: String {
    case phone
    case glasses
    case bluetoothClassic
    case bluetooth
}

public struct PhoneSdkRuntimeState: CustomStringConvertible {
    public let currentMic: MicMode?
    public let defaultDevice: Device?
    public let galleryMode: GalleryModeState
    public let lastLog: [String]
    public let micRanking: [MicMode]
    public let otherBluetoothConnected: Bool
    public let searching: Bool
    public let searchingController: Bool
    public let systemMicUnavailable: Bool
    public let wifiScanResults: [WifiScanResult]

    public init(
        currentMic: MicMode?,
        defaultDevice: Device?,
        galleryMode: GalleryModeState,
        lastLog: [String],
        micRanking: [MicMode],
        otherBluetoothConnected: Bool,
        searching: Bool,
        searchingController: Bool,
        systemMicUnavailable: Bool,
        wifiScanResults: [WifiScanResult]
    ) {
        self.currentMic = currentMic
        self.defaultDevice = defaultDevice
        self.galleryMode = galleryMode
        self.lastLog = lastLog
        self.micRanking = micRanking
        self.otherBluetoothConnected = otherBluetoothConnected
        self.searching = searching
        self.searchingController = searchingController
        self.systemMicUnavailable = systemMicUnavailable
        self.wifiScanResults = wifiScanResults
    }

    init(status: BluetoothStatus) {
        currentMic = MicMode(rawValue: status.currentMic)
        defaultDevice = status.defaultDevice
        galleryMode = GalleryModeState(enabled: status.galleryModeEnabled)
        lastLog = status.lastLog
        micRanking = status.micRanking.compactMap(MicMode.init(rawValue:))
        otherBluetoothConnected = status.otherBtConnected
        searching = status.searching
        searchingController = status.searchingController
        systemMicUnavailable = status.systemMicUnavailable
        wifiScanResults = status.wifiScanResults
    }

    public var description: String {
        "PhoneSdkRuntimeState(searching: \(searching), currentMic: \(currentMic?.rawValue ?? "unknown"))"
    }
}

public struct BluetoothScanState: CustomStringConvertible {
    public let active: Bool
    public let devices: [Device]
    public let searchingController: Bool

    public init(active: Bool, devices: [Device], searchingController: Bool) {
        self.active = active
        self.devices = devices
        self.searchingController = searchingController
    }

    init(status: BluetoothStatus) {
        active = status.searching
        devices = status.searchResults
        searchingController = status.searchingController
    }

    public var description: String {
        "BluetoothScanState(active: \(active), devices: \(devices.count))"
    }
}

private extension FirmwareInfo {
    init(status: GlassesStatus) {
        let sources: [(String, FirmwareSource)] = [
            (status.firmwareVersion, .firmware),
            (status.besFirmwareVersion, .bes),
            (status.mtkFirmwareVersion, .mtk),
            (status.appVersion, .app),
        ]
        let match = sources.first { !$0.0.isEmpty }
        self.init(
            appVersion: status.appVersion.nonEmpty,
            buildNumber: status.buildNumber.nonEmpty,
            source: match?.1 ?? .unknown,
            version: match?.0.nonEmpty
        )
    }
}

private extension String {
    var nonEmpty: String? {
        isEmpty ? nil : self
    }
}
