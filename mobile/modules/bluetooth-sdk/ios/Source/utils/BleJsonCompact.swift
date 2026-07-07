import Foundation

/// BLE Wire Protocol v2 JSON compaction: short keys, enum ints, omitted defaults, config diff.
enum BleJsonCompact {
    static let keyResolvedConfigHash = "rch"

    private static let longToShort: [String: String] = [
        "type": "t",
        "requestId": "r",
        "timestamp": "ts",
        "status": "s",
        "kind": "k",
        "source": "src",
        "requestedCaptureConfig": "rcc",
        "meteredPreview": "mp",
        "exposureTimeNs": "etn",
        "captureMetadata": "cm",
        "aeStateName": "aes",
        "transferMethod": "tm",
        "manual": "m",
        "reconnecting": "rc",
    ]

    private static let shortToLong: [String: String] = {
        var map: [String: String] = [:]
        for (longKey, shortKey) in longToShort {
            map[shortKey] = longKey
        }
        return map
    }()

    private static let photoStatusToInt: [String: Int] = [
        "accepted": 0, "queued": 1, "configuring": 2, "capturing": 3,
        "captured": 4, "uploading": 5, "uploaded": 6, "failed": 7,
    ]
    private static let photoStatusFromInt: [Int: String] = {
        var map: [Int: String] = [:]
        for (key, value) in photoStatusToInt { map[value] = key }
        return map
    }()

    private static let kindToInt = ["lifecycle": 0, "snapshot": 1]
    private static let kindFromInt: [Int: String] = [0: "lifecycle", 1: "snapshot"]

    private static let sourceToInt = ["sdk": 0, "button": 1]
    private static let sourceFromInt: [Int: String] = [0: "sdk", 1: "button"]

    private static let aeStateToInt: [String: Int] = [
        "CONVERGED": 0, "SEARCHING": 1, "INACTIVE": 2,
        "LOCKED": 3, "FLASH_REQUIRED": 4, "PRECAPTURE": 5,
    ]
    private static let aeStateFromInt: [Int: String] = {
        var map: [Int: String] = [:]
        for (key, value) in aeStateToInt { map[value] = key }
        return map
    }()

    private static var sessionConnectEpochMs: Int64 = 0
    private static var resolvedConfigSent = false
    private static var currentSessionResolvedConfigHash: String?
    private static var resolvedConfigByHash: [String: [String: Any]] = [:]

    private static let highRoiMessageTypes: Set<String> = [
        "photo_status",
        "stream_status",
        "wifi_scan_result",
        "start_stream",
        "photo_response",
    ]

    private static let chunkMessageTypes: Set<String> = ["ck", "chunked_msg"]

    static func shouldCompactOutbound(_ messageType: String) -> Bool {
        highRoiMessageTypes.contains(messageType)
    }

    static func supportsCompactInbound(_ messageType: String) -> Bool {
        !messageType.isEmpty
            && (highRoiMessageTypes.contains(messageType) || chunkMessageTypes.contains(messageType))
    }

    static func isCompactWireForm(_ json: [String: Any]) -> Bool {
        json["t"] != nil && json["type"] == nil
    }

    static func extractMessageType(_ json: [String: Any]) -> String {
        if let type = stringValue(json["type"]) {
            return type
        }
        if let compactType = stringValue(json["t"]) {
            return compactType
        }
        return ""
    }

    static func resetSession() {
        sessionConnectEpochMs = 0
        resolvedConfigSent = false
        currentSessionResolvedConfigHash = nil
        resolvedConfigByHash.removeAll()
    }

    static func markSessionConnected(epochMs: Int64) {
        resetSession()
        sessionConnectEpochMs = epochMs
    }

    static func isCameraCommandJson(_ jsonData: String) -> Bool {
        jsonData.contains("cs_pho")
            || jsonData.contains("cs_cpho")
            || jsonData.contains("cs_vid")
            || jsonData.contains("\"type\":\"take_photo\"")
    }

    static func encode(_ json: [String: Any]) -> [String: Any] {
        if isCameraCommandJson(jsonString(json) ?? "") {
            return json
        }
        let messageType = extractMessageType(json)
        if !shouldCompactOutbound(messageType) {
            return json
        }
        return compactObject(json, topLevel: true)
    }

    static func encode(jsonString: String) -> [String: Any]? {
        guard let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        return encode(json)
    }

    static func decode(_ json: [String: Any]) -> [String: Any] {
        if isCameraCommandJson(jsonString(json) ?? "") {
            return json
        }
        return expandObject(json, topLevel: true)
    }

    static func decodeIfSupported(_ json: [String: Any]) -> [String: Any]? {
        if isCameraCommandJson(jsonString(json) ?? "") {
            return json
        }
        if !isCompactWireForm(json) {
            return json
        }
        let compactType = stringValue(json["t"]) ?? ""
        if !supportsCompactInbound(compactType) {
            return nil
        }
        return expandObject(json, topLevel: true)
    }

    static func decode(jsonString: String) -> [String: Any]? {
        guard let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        return decode(json)
    }

    private static func compactObject(_ input: [String: Any], topLevel: Bool) -> [String: Any] {
        var output: [String: Any] = [:]
        let messageType = stringValue(input["type"]) ?? stringValue(input["t"]) ?? ""
        var skipResolvedConfig = false

        if topLevel, shouldDiffResolvedConfig(messageType),
           let resolvedConfig = input["resolvedConfig"] as? [String: Any]
        {
            let hash = hashConfig(resolvedConfig)
            resolvedConfigByHash[hash] = resolvedConfig
            if resolvedConfigSent, hash == currentSessionResolvedConfigHash {
                output[keyResolvedConfigHash] = hash
                skipResolvedConfig = true
            } else {
                currentSessionResolvedConfigHash = hash
                resolvedConfigSent = true
            }
        }

        for (key, value) in input {
            if skipResolvedConfig, key == "resolvedConfig" { continue }
            let shortKey = longToShort[key] ?? key
            guard let compacted = compactValue(longKey: key, value: value, messageType: messageType),
                  !shouldOmit(compacted)
            else {
                continue
            }
            output[shortKey] = compacted
        }

        if topLevel {
            compactTimestamp(&output)
        }
        return output
    }

    private static func shouldDiffResolvedConfig(_ messageType: String) -> Bool {
        messageType == "photo_status" || messageType == "stream_status"
    }

    private static func compactValue(longKey: String, value: Any, messageType: String) -> Any? {
        if value is NSNull { return nil }
        if let nested = value as? [String: Any] {
            return compactObject(nested, topLevel: false)
        }
        if let array = value as? [Any] {
            return array.map { item -> Any in
                if let nested = item as? [String: Any] {
                    return compactObject(nested, topLevel: false)
                }
                return item
            }
        }
        if let boolValue = value as? Bool { return boolValue }
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            return number
        }
        if let str = value as? String {
            if longKey == "status", messageType == "photo_status", let code = photoStatusToInt[str] {
                return code
            }
            if longKey == "kind", let code = kindToInt[str] { return code }
            if longKey == "source", let code = sourceToInt[str] { return code }
            if longKey == "aeStateName", let code = aeStateToInt[str] { return code }
            return str
        }
        return value
    }

    private static func shouldOmit(_ value: Any) -> Bool {
        if value is NSNull { return true }
        if let boolValue = value as? Bool, !boolValue { return true }
        if let dict = value as? [String: Any], dict.isEmpty { return true }
        if let array = value as? [Any], array.isEmpty { return true }
        return false
    }

    private static func compactTimestamp(_ output: inout [String: Any]) {
        let tsKey: String?
        if output["timestamp"] != nil {
            tsKey = "timestamp"
        } else if output["ts"] != nil {
            tsKey = "ts"
        } else {
            tsKey = nil
        }
        guard let key = tsKey else { return }
        let absolute = int64Value(output[key]) ?? 0
        guard absolute > 0 else { return }
        if sessionConnectEpochMs <= 0 {
            sessionConnectEpochMs = absolute
        }
        output["ts"] = absolute - sessionConnectEpochMs
        if key != "ts" {
            output.removeValue(forKey: key)
        }
    }

    private static func expandObject(_ input: [String: Any], topLevel: Bool) -> [String: Any] {
        var output: [String: Any] = [:]
        let messageType = stringValue(input["type"]) ?? stringValue(input["t"]) ?? ""

        for (key, value) in input {
            if topLevel, key == "ts" {
                output["ts"] = value
                continue
            }
            let longKey = shortToLong[key] ?? key
            guard let expanded = expandValue(longKey: longKey, value: value, messageType: messageType) else {
                continue
            }
            output[longKey] = expanded
        }

        if topLevel {
            expandTimestamp(&output)
            expandResolvedConfigHash(&output)
            cacheResolvedConfigIfPresent(&output)
        }
        return output
    }

    private static func cacheResolvedConfigIfPresent(_ output: inout [String: Any]) {
        guard let resolvedConfig = output["resolvedConfig"] as? [String: Any] else { return }
        let hash = hashConfig(resolvedConfig)
        resolvedConfigByHash[hash] = resolvedConfig
        currentSessionResolvedConfigHash = hash
        resolvedConfigSent = true
    }

    private static func expandResolvedConfigHash(_ output: inout [String: Any]) {
        guard output["resolvedConfig"] == nil,
              let hash = output[keyResolvedConfigHash] as? String,
              let cached = resolvedConfigByHash[hash]
        else {
            return
        }
        output["resolvedConfig"] = cached
        output.removeValue(forKey: keyResolvedConfigHash)
    }

    private static func expandValue(longKey: String, value: Any, messageType: String) -> Any? {
        if value is NSNull { return nil }
        if let nested = value as? [String: Any] {
            return expandObject(nested, topLevel: false)
        }
        if let array = value as? [Any] {
            return array.map { item -> Any in
                if let nested = item as? [String: Any] {
                    return expandObject(nested, topLevel: false)
                }
                return item
            }
        }
        if longKey == "status", messageType == "photo_status", let code = value as? Int {
            return photoStatusFromInt[code] ?? value
        }
        if longKey == "kind", let code = value as? Int {
            return kindFromInt[code] ?? value
        }
        if longKey == "source", let code = value as? Int {
            return sourceFromInt[code] ?? value
        }
        if longKey == "aeStateName", let code = value as? Int {
            return aeStateFromInt[code] ?? value
        }
        return value
    }

    private static func expandTimestamp(_ output: inout [String: Any]) {
        guard output["timestamp"] == nil, let delta = int64Value(output["ts"]) else { return }
        let absolute = sessionConnectEpochMs > 0 ? sessionConnectEpochMs + delta : delta
        output["timestamp"] = absolute
        output.removeValue(forKey: "ts")
        if sessionConnectEpochMs <= 0 {
            sessionConnectEpochMs = absolute - delta
        }
    }

    static func hashConfig(_ config: [String: Any]) -> String {
        fnv1a32Hex(canonicalJsonString(config))
    }

    private static func canonicalJsonString(_ object: [String: Any]) -> String {
        let sortedKeys = object.keys.sorted()
        var parts: [String] = []
        for key in sortedKeys {
            guard let value = object[key] else { continue }
            let encodedValue: String
            if let nested = value as? [String: Any] {
                encodedValue = canonicalJsonString(nested)
            } else if let str = value as? String {
                encodedValue = "\"\(str)\""
            } else if let boolValue = value as? Bool {
                encodedValue = boolValue ? "true" : "false"
            } else if let number = value as? NSNumber {
                encodedValue = "\(number)"
            } else {
                encodedValue = "null"
            }
            parts.append("\"\(key)\":\(encodedValue)")
        }
        return "{\(parts.joined(separator: ","))}"
    }

    private static func fnv1a32Hex(_ value: String) -> String {
        var hash: UInt32 = 0x811c9dc5
        for byte in value.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 0x01000193
        }
        return String(format: "%08x", hash)
    }

    private static func stringValue(_ value: Any?) -> String? {
        if let str = value as? String { return str }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    private static func int64Value(_ value: Any?) -> Int64? {
        if let number = value as? NSNumber { return number.int64Value }
        if let str = value as? String, let parsed = Int64(str) { return parsed }
        return nil
    }

    private static func jsonString(_ json: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
