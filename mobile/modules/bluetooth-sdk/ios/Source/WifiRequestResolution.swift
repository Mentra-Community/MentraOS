import Foundation

func wifiSsidIsValid(_ ssid: String) -> Bool {
    !ssid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

func wifiDelayedCallbackApplies(
    expectedEpoch: UInt64,
    currentEpoch: UInt64,
    isCurrentRequest: Bool
) -> Bool {
    isCurrentRequest && expectedEpoch == currentEpoch
}

let wifiCapabilityNegotiationTimeoutCode = "capability_negotiation_timeout"

func wifiCapabilityDiscoveryDeadlineRequired(_ mode: WifiRequestMode) -> Bool {
    mode == .discovering
}

enum WifiProtocolCapability: Equatable {
    case unknown
    case supported(version: Int)
    case unsupported
}

enum WifiRequestMode: Equatable {
    case discovering
    case modern
    case legacy
}

final class WifiSessionCapabilities {
    private(set) var sessionId = ""
    private(set) var epoch: UInt64 = 0
    private(set) var forgetResult: WifiProtocolCapability = .unknown
    private(set) var savedNetworks: WifiProtocolCapability = .unknown

    func reset(sessionId: String = "") {
        epoch &+= 1
        self.sessionId = sessionId
        forgetResult = .unknown
        savedNetworks = .unknown
    }

    func applyVersionInfo1(_ values: [String: Any]) {
        if let sid = values["sid"] as? String, !sid.isEmpty {
            sessionId = sid
        }
        forgetResult = Self.capability(values["wifiForgetResultVersion"])
        savedNetworks = Self.capability(values["savedWifiNetworksVersion"])
    }

    func forgetMode() -> WifiRequestMode {
        Self.requestMode(forgetResult)
    }

    func savedNetworksMode() -> WifiRequestMode {
        Self.requestMode(savedNetworks)
    }

    private static func capability(_ raw: Any?) -> WifiProtocolCapability {
        let version = (raw as? NSNumber)?.intValue ?? 0
        return version > 0 ? .supported(version: version) : .unsupported
    }

    private static func requestMode(_ capability: WifiProtocolCapability) -> WifiRequestMode {
        switch capability {
        case .unknown: .discovering
        case .supported: .modern
        case .unsupported: .legacy
        }
    }
}

public enum WifiForgetOutcome: String {
    case confirmed
    case dispatched
    case notFound = "not_found"
    case unsupported
    case failed
    case legacyUnverified = "legacy_unverified"
}

func normalizeWifiForgetResultEvent(
    requestId: String,
    sid: String,
    ssid: String,
    protocolVersion: Int,
    outcome: String,
    legacyDispatched: Bool?,
    connected: Bool?,
    currentSsid: String,
    localIp: String,
    error: String?
) -> [String: Any]? {
    if !sid.isEmpty,
       protocolVersion > 0,
       let modernOutcome = WifiForgetOutcome(rawValue: outcome),
       modernOutcome != .legacyUnverified
    {
        var body: [String: Any] = [
            "mode": "modern",
            "requestId": requestId,
            "sid": sid,
            "ssid": ssid,
            "protocolVersion": protocolVersion,
            "outcome": modernOutcome.rawValue,
        ]
        if let connected { body["connected"] = connected }
        if !currentSsid.isEmpty { body["currentSsid"] = currentSsid }
        if !localIp.isEmpty { body["localIp"] = localIp }
        if let error { body["error"] = error }
        return body
    }
    if let legacyDispatched {
        var body: [String: Any] = [
            "mode": "legacy",
            "requestId": requestId,
            "ssid": ssid,
            "dispatched": legacyDispatched,
        ]
        if let connected { body["connected"] = connected }
        if !currentSsid.isEmpty { body["currentSsid"] = currentSsid }
        if !localIp.isEmpty { body["localIp"] = localIp }
        if let error { body["error"] = error }
        return body
    }
    return nil
}

public struct WifiForgetResult {
    public let mode: String
    public let capabilityVersion: Int?
    public let requestId: String
    public let sid: String
    public let ssid: String
    public let outcome: WifiForgetOutcome
    public let connected: Bool?
    public let currentSsid: String?
    public let localIp: String?
    public let error: String?

    public var values: [String: Any] {
        var result: [String: Any] = [
            "mode": mode,
            "requestId": requestId,
            "sid": sid,
            "ssid": ssid,
            "outcome": outcome.rawValue,
        ]
        if let connected { result["connected"] = connected }
        if let capabilityVersion { result["capabilityVersion"] = capabilityVersion }
        if let currentSsid { result["currentSsid"] = currentSsid }
        if let localIp { result["localIp"] = localIp }
        if let error { result["error"] = error }
        return result
    }
}

public enum SavedWifiNetworksOutcome: String {
    case confirmed
    case unsupported
    case failed
}

public struct SavedWifiNetworksResult {
    public let mode: String
    public let capabilityVersion: Int?
    public let requestId: String
    public let sid: String
    public let outcome: SavedWifiNetworksOutcome
    public let networks: [String]
    public let error: String?

    public var values: [String: Any] {
        var result: [String: Any] = [
            "mode": mode,
            "requestId": requestId,
            "sid": sid,
            "outcome": outcome.rawValue,
            "networks": networks,
        ]
        if let capabilityVersion { result["capabilityVersion"] = capabilityVersion }
        if let error { result["error"] = error }
        return result
    }
}

func parseWifiForgetResult(
    expectedRequestId: String,
    expectedSid: String,
    expectedSsid: String,
    capabilityVersion: Int,
    data: [String: Any]
) -> WifiForgetResult? {
    guard data["requestId"] as? String == expectedRequestId,
          data["sid"] as? String == expectedSid,
          data["ssid"] as? String == expectedSsid,
          (data["protocolVersion"] as? NSNumber)?.intValue == capabilityVersion,
          let rawOutcome = data["outcome"] as? String,
          let outcome = WifiForgetOutcome(rawValue: rawOutcome),
          outcome != .legacyUnverified
    else { return nil }
    return WifiForgetResult(
        mode: "correlated",
        capabilityVersion: capabilityVersion,
        requestId: expectedRequestId,
        sid: expectedSid,
        ssid: expectedSsid,
        outcome: outcome,
        connected: data["connected"] as? Bool,
        currentSsid: data["currentSsid"] as? String,
        localIp: data["localIp"] as? String,
        error: (data["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    )
}

func parseSavedWifiNetworks(
    expectedRequestId: String,
    expectedSid: String,
    capabilityVersion: Int,
    data: [String: Any]
) -> SavedWifiNetworksResult? {
    guard data["requestId"] as? String == expectedRequestId,
          data["sid"] as? String == expectedSid,
          (data["protocolVersion"] as? NSNumber)?.intValue == capabilityVersion,
          let rawOutcome = data["outcome"] as? String,
          let outcome = SavedWifiNetworksOutcome(rawValue: rawOutcome)
    else { return nil }
    var seen = Set<String>()
    let networks = (data["networks"] as? [String] ?? []).filter { network in
        !network.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && seen.insert(network).inserted
    }
    return SavedWifiNetworksResult(
        mode: "correlated",
        capabilityVersion: capabilityVersion,
        requestId: expectedRequestId,
        sid: expectedSid,
        outcome: outcome,
        networks: networks,
        error: (data["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    )
}

func legacyWifiForgetResult(
    requestId: String,
    sid: String,
    ssid: String,
    event: WifiStatusEvent
) -> WifiForgetResult {
    let connected: Bool
    let currentSsid: String?
    let localIp: String?
    switch event.status {
    case .disconnected:
        connected = false
        currentSsid = nil
        localIp = nil
    case let .connected(ssid, ip):
        connected = true
        currentSsid = ssid
        localIp = ip
    }
    return WifiForgetResult(
        mode: "legacy",
        capabilityVersion: nil,
        requestId: requestId,
        sid: sid,
        ssid: ssid,
        outcome: .legacyUnverified,
        connected: connected,
        currentSsid: currentSsid,
        localIp: localIp,
        error: nil
    )
}
