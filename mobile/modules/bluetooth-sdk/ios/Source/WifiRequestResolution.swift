import CoreFoundation
import Foundation

private func isWifiProtocolV1(_ raw: Any?) -> Bool {
    guard let number = raw as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID()
    else { return false }
    return number.doubleValue == 1
}

/// Validate raw fields before convenience conversions erase malformed or partial tuples.
func wifiResponseEnvelopeIsValid(_ values: [String: Any], allowLegacy: Bool) -> Bool {
    for key in ["connected", "dispatched"] where values[key] != nil {
        guard let number = values[key] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID()
        else { return false }
    }
    let hasTuple = ["protocol_version", "requestId", "sid"].contains { values[$0] != nil }
    if !hasTuple { return allowLegacy && values["outcome"] == nil }
    guard let requestId = values["requestId"] as? String,
          let sid = values["sid"] as? String
    else { return false }
    return isWifiProtocolV1(values["protocol_version"]) && wifiSsidIsValid(requestId) && wifiSsidIsValid(sid)
        && values["dispatched"] == nil
}

func wifiSsidIsValid(_ ssid: String) -> Bool {
    !ssid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

let wifiCapabilityNegotiationTimeoutCode = "capability_negotiation_timeout"

enum WifiProtocolCapability: Equatable {
    case unknown
    case supported(version: Int)
    case unsupported
    case legacy
}

enum WifiRequestMode: Equatable {
    case discovering
    case modern
    case legacy
    case unsupported
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
        forgetResult = capability(values["wifiForgetResultVersion"])
        savedNetworks = capability(values["savedWifiNetworksVersion"])
    }

    func forgetMode() -> WifiRequestMode {
        Self.requestMode(forgetResult)
    }

    func savedNetworksMode() -> WifiRequestMode {
        Self.requestMode(savedNetworks)
    }

    private func capability(_ raw: Any?) -> WifiProtocolCapability {
        guard let raw else { return .legacy }
        return isWifiProtocolV1(raw) && !sessionId.isEmpty ? .supported(version: 1) : .unsupported
    }

    private static func requestMode(_ capability: WifiProtocolCapability) -> WifiRequestMode {
        switch capability {
        case .unknown: .discovering
        case .supported: .modern
        case .legacy: .legacy
        case .unsupported: .unsupported
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
    guard wifiSsidIsValid(ssid) else { return nil }
    if !requestId.isEmpty, !sid.isEmpty,
       protocolVersion == 1,
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
    if requestId.isEmpty, sid.isEmpty, protocolVersion == 0, outcome.isEmpty, let legacyDispatched {
        var body: [String: Any] = [
            "mode": "legacy",
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
    public let ssid: String
    public let outcome: WifiForgetOutcome
    public let connected: Bool?
    public let currentSsid: String?
    public let localIp: String?
    public let error: String?

    public var values: [String: Any] {
        var result: [String: Any] = [
            "ssid": ssid,
            "outcome": outcome.rawValue,
        ]
        if let connected { result["connected"] = connected }
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
    public let outcome: SavedWifiNetworksOutcome
    public let networks: [String]
    public let error: String?

    public var values: [String: Any] {
        var result: [String: Any] = [
            "outcome": outcome.rawValue,
            "networks": networks,
        ]
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
    guard capabilityVersion == 1, !expectedRequestId.isEmpty, !expectedSid.isEmpty,
          data["requestId"] as? String == expectedRequestId,
          data["sid"] as? String == expectedSid,
          data["ssid"] as? String == expectedSsid,
          isWifiProtocolV1(data["protocolVersion"]),
          let rawOutcome = data["outcome"] as? String,
          let outcome = WifiForgetOutcome(rawValue: rawOutcome),
          outcome != .legacyUnverified
    else { return nil }
    return WifiForgetResult(
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
    guard capabilityVersion == 1, !expectedRequestId.isEmpty, !expectedSid.isEmpty,
          data["requestId"] as? String == expectedRequestId,
          data["sid"] as? String == expectedSid,
          isWifiProtocolV1(data["protocolVersion"]),
          let rawOutcome = data["outcome"] as? String,
          let outcome = SavedWifiNetworksOutcome(rawValue: rawOutcome)
    else { return nil }
    guard let rawNetworks = data["networks"] as? [String], outcome == .confirmed || rawNetworks.isEmpty else { return nil }
    var seen = Set<String>()
    let networks = rawNetworks.filter { network in
        !network.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && seen.insert(network).inserted
    }
    return SavedWifiNetworksResult(
        outcome: outcome,
        networks: networks,
        error: (data["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    )
}

func legacyWifiForgetResult(
    ssid: String
) -> WifiForgetResult {
    return WifiForgetResult(
        ssid: ssid,
        outcome: .legacyUnverified,
        connected: nil,
        currentSsid: nil,
        localIp: nil,
        error: nil
    )
}
