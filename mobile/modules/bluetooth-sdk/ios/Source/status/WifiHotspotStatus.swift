import Foundation

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

    /// Glasses-reported provisioning failure reason when THIS event is the verdict of a
    /// failed connect attempt; nil for routine link-state updates. An attempt property,
    /// not a link property — which is why it lives on the event and not on `WifiStatus`:
    /// "connect_timeout" arrives with a disconnected status (never associated), while
    /// "connected_to_other_network" arrives with a *connected* status — the attempt
    /// failed and Android's auto-join left the glasses on (or returned them to) a
    /// different SSID than requested, so the link is genuinely up while the request
    /// genuinely failed. Sent by ASG client builds that include the WiFi error
    /// surfacing (v40+); older glasses never set it.
    public let error: String?

    public init(status: WifiStatus, error: String? = nil) {
        self.status = status
        self.error = error
    }

    init(connected: Bool, ssid: String?, localIp: String?) {
        status = WifiStatus.fromStoreFields(connected: connected, ssid: ssid, localIp: localIp) ?? .disconnected
        error = nil
    }

    init(values: [String: Any]) {
        status = WifiStatus(values: values) ?? .disconnected
        let rawError = stringValue(values, "error")
        error = rawError?.isEmpty == false ? rawError : nil
    }

    public var values: [String: Any] {
        var body = status.values.merging(["type": "wifi_status_change"]) { _, new in new }
        if let error {
            body["error"] = error
        }
        return body
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
            localIp: nonEmptyStringValue(values, "hotspotGatewayIp")
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
        status = HotspotStatus.fromStoreFields(enabled: enabled, ssid: ssid, password: password, localIp: localIp) ?? .disabled
    }

    init(values: [String: Any]) {
        status = HotspotStatus(values: values) ?? .disabled
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
        stringValue(values, "errorMessage")
    }

    public var timestamp: Int? {
        intValue(values["timestamp"])
    }

    public var description: String {
        "HotspotErrorEvent(message: \(message ?? "unknown"))"
    }
}
