import Foundation

let wifiForgetCorrelatedPriorityWindowMs = 750

func wifiSsidIsValid(_ ssid: String) -> Bool {
    !ssid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

enum ParsedWifiForgetResult {
    case dispatched(connected: Bool, currentSsid: String?, localIp: String?)
    case failure(error: String)
}

struct ParsedSavedWifiNetworks: Equatable {
    let networks: [String]
    let error: String?
}

func parseWifiForgetResult(
    expectedRequestId: String,
    expectedSsid: String,
    data: [String: Any]
) -> ParsedWifiForgetResult? {
    guard data["requestId"] as? String == expectedRequestId,
          data["ssid"] as? String == expectedSsid
    else { return nil }
    guard data["dispatched"] as? Bool == true else {
        let error = (data["error"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "forget_dispatch_failed"
        return .failure(error: error)
    }
    return .dispatched(
        connected: data["connected"] as? Bool ?? false,
        currentSsid: data["currentSsid"] as? String,
        localIp: data["localIp"] as? String
    )
}

func parseSavedWifiNetworks(
    expectedRequestId: String,
    data: [String: Any]
) -> ParsedSavedWifiNetworks? {
    guard data["requestId"] as? String == expectedRequestId else { return nil }
    var seen = Set<String>()
    let networks = (data["networks"] as? [String] ?? []).filter { network in
        !network.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && seen.insert(network).inserted
    }
    return ParsedSavedWifiNetworks(
        networks: networks,
        error: (data["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    )
}

func wifiForgetLegacyFallbackDelayMs(priorityDeadlineMs: Int64, nowMs: Int64) -> Int {
    Int(max(0, priorityDeadlineMs - nowMs))
}

func wifiForgetFallbackStillApplies(
    scheduledRequestId: String,
    activeRequestId: String?
) -> Bool {
    scheduledRequestId == activeRequestId
}
