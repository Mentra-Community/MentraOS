import Foundation

public struct MentraBluetoothSDKConfiguration {
    public static let `default` = MentraBluetoothSDKConfiguration()

    public let analytics: BluetoothSdkAnalyticsConfiguration

    public init(analytics: BluetoothSdkAnalyticsConfiguration = BluetoothSdkAnalyticsConfiguration()) {
        self.analytics = analytics
    }
}

public enum DeviceModel: String {
    case g1
    case g2
    case mentraLive
    case mentraNex
    case mach1
    case z100
    case frame
    case nimo
    case ar99
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
        case .nimo:
            DeviceTypes.NIMO
        case .ar99:
            DeviceTypes.AR99
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
        case DeviceTypes.NIMO:
            .nimo
        case DeviceTypes.AR99:
            .ar99
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
    /// CoreBluetooth identifier when available.
    public let identifier: String?
    public let projectName: String?
    public let rssi: Int?
    /// Stable app-facing scan-result key. Do not parse; use typed fields instead.
    public let id: String
    public let pairingMode: Bool?
    public let pairingCode: String?
    public let securePairingCapable: Bool?

    public init(
        model: DeviceModel,
        name: String,
        identifier: String? = nil,
        projectName: String? = nil,
        rssi: Int? = nil,
        id: String? = nil,
        pairingMode: Bool? = nil,
        pairingCode: String? = nil,
        securePairingCapable: Bool? = nil
    ) {
        self.model = model
        self.name = name
        self.identifier = identifier
        self.projectName = projectName
        self.rssi = rssi
        self.id = id ?? identifier.flatMap { $0.isEmpty ? nil : $0 } ?? "\(model.deviceType):\(name)"
        self.pairingMode = pairingMode
        self.pairingCode = pairingCode
        self.securePairingCapable = securePairingCapable
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
        if let projectName, !projectName.isEmpty {
            values["projectName"] = projectName
        }
        if let rssi {
            values["rssi"] = rssi
        }
        if let pairingMode {
            values["pairingMode"] = pairingMode
        }
        if let pairingCode, !pairingCode.isEmpty {
            values["pairingCode"] = pairingCode
        }
        if let securePairingCapable {
            values["securePairingCapable"] = securePairingCapable
        }
        return values
    }

    init?(values: [String: Any]) {
        guard let model = stringValue(values, "model") else { return nil }
        guard let name = stringValue(values, "name") else { return nil }
        let identifier = stringValue(values, "address").flatMap { $0.isEmpty ? nil : $0 }
        let projectName = stringValue(values, "projectName").flatMap { $0.isEmpty ? nil : $0 }
        let rssi = intValue(values["rssi"])
        self.init(
            model: DeviceModel.fromDeviceType(model),
            name: name,
            identifier: identifier,
            projectName: projectName,
            rssi: rssi,
            id: stringValue(values, "id"),
            pairingMode: boolValue(values, "pairingMode"),
            pairingCode: stringValue(values, "pairingCode").flatMap { $0.isEmpty ? nil : $0 },
            securePairingCapable: boolValue(values, "securePairingCapable")
        )
    }
}

public struct ConnectOptions {
    public let saveAsDefault: Bool
    public let cancelExistingConnectionAttempt: Bool
    /// Mentra Live on iOS only. Whether CoreBluetooth should require ANCS
    /// authorization while establishing the connection.
    public let requiresAncs: Bool

    public init(
        saveAsDefault: Bool = true,
        cancelExistingConnectionAttempt: Bool = true,
        requiresAncs: Bool = true
    ) {
        self.saveAsDefault = saveAsDefault
        self.cancelExistingConnectionAttempt = cancelExistingConnectionAttempt
        self.requiresAncs = requiresAncs
    }
}
