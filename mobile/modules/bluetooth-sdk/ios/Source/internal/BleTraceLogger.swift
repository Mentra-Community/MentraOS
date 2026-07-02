import Foundation
import os.log
import UIKit

enum BleTraceLogger {
    private static let log = OSLog(subsystem: "com.mentra.bluetoothsdk", category: "MentraBleTrace")
    private static let maxPayloadChars = 3000
    private static let k900Type = "k900"
    private static let sensitiveKeyParts = ["password", "pass", "token", "secret", "authorization", "auth", "email"]

    static func logJson(
        direction: String,
        layer: String,
        payload: [String: Any]?,
        bytes: Int? = nil,
        sourceFile: String = #fileID,
        sourceFunction: String = #function,
        sourceLine: Int = #line
    ) {
        guard let payload else {
            emit(format(
                direction: direction,
                layer: layer,
                source: source(file: sourceFile, function: sourceFunction, line: sourceLine),
                type: "null",
                bytes: bytes,
                payload: "null"
            ))
            return
        }

        let sanitized = sanitizeDictionary(payload)
        emit(format(
            direction: direction,
            layer: layer,
            source: source(file: sourceFile, function: sourceFunction, line: sourceLine),
            type: extractType(from: payload),
            bytes: bytes,
            payload: jsonString(sanitized)
        ))
    }

    static func logMap(
        direction: String,
        layer: String,
        type: String?,
        payload: [String: Any],
        bytes: Int? = nil,
        sourceFile: String = #fileID,
        sourceFunction: String = #function,
        sourceLine: Int = #line
    ) {
        let sanitized = sanitizeDictionary(payload)
        emit(format(
            direction: direction,
            layer: layer,
            source: source(file: sourceFile, function: sourceFunction, line: sourceLine),
            type: type ?? extractType(from: sanitized),
            bytes: bytes,
            payload: jsonString(sanitized)
        ))
    }

    static func logLifecycle(component: String, event: String, extra: [String: Any] = [:]) {
        var payload: [String: Any] = [
            "event": event,
            "component": component,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "model": UIDevice.current.model,
            "systemVersion": UIDevice.current.systemVersion,
        ]
        for (key, value) in extra {
            payload[key] = value
        }
        logMap(direction: "phone_app", layer: "app_lifecycle", type: event, payload: payload)
    }

    private static func emit(_ line: String) {
        os_log("%{public}@", log: log, type: .info, line)
    }

    private static func format(
        direction: String,
        layer: String,
        source: String,
        type: String,
        bytes: Int?,
        payload: String
    ) -> String {
        let bytesText = bytes.map { " bytes=\($0)" } ?? ""
        return "BLE_TRACE direction=\(direction) layer=\(layer) source=\(source) type=\(type)\(bytesText) payload=\(truncate(payload))"
    }

    private static func extractType(from payload: [String: Any]) -> String {
        if let type = payload["type"] as? String, !type.isEmpty {
            return type
        }
        if let cValue = payload["C"] as? String, !cValue.isEmpty {
            if let data = cValue.data(using: .utf8),
               let inner = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let type = inner["type"] as? String,
               !type.isEmpty
            {
                return type
            }
            return extractK900Type(cValue)
        }
        return "unknown"
    }

    private static func extractK900Type(_ value: String) -> String {
        value == "sr_log" ? "\(k900Type):sr_log" : k900Type
    }

    private static func sanitizeDictionary(_ value: [String: Any]) -> [String: Any] {
        var output: [String: Any] = [:]
        for (key, child) in value {
            output[key] = sanitizeValue(key: key, value: child)
        }
        return output
    }

    private static func sanitizeArray(_ value: [Any]) -> [Any] {
        value.map { sanitizeValue(key: nil, value: $0) }
    }

    private static func sanitizeValue(key: String?, value: Any) -> Any {
        if let key, sensitiveKeyParts.contains(where: { key.localizedCaseInsensitiveContains($0) }) {
            return "<redacted>"
        }

        if key == "C", let stringValue = value as? String {
            if let data = stringValue.data(using: .utf8),
               let parsed = try? JSONSerialization.jsonObject(with: data)
            {
                return jsonString(sanitizeJsonValue(parsed))
            }
            return sanitizeK900Command(stringValue)
        }

        return sanitizeJsonValue(value)
    }

    private static func sanitizeJsonValue(_ value: Any) -> Any {
        switch value {
        case let dictionary as [String: Any]:
            return sanitizeDictionary(dictionary)
        case let array as [Any]:
            return sanitizeArray(array)
        case let data as Data:
            return "<data \(data.count) bytes>"
        case let url as URL:
            return url.absoluteString
        case let bool as Bool:
            return bool
        case let number as NSNumber:
            return number
        case let string as String:
            return string
        case _ as NSNull:
            return NSNull()
        default:
            return String(describing: value)
        }
    }

    private static func sanitizeK900Command(_ value: String) -> String {
        value == "sr_log" ? value : "<non-json C payload>"
    }

    private static func jsonString(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let string = String(data: data, encoding: .utf8)
        else {
            return String(describing: value)
        }
        return string
    }

    private static func source(file: String, function: String, line: Int) -> String {
        "\(function)(\(file):\(line))"
    }

    private static func truncate(_ value: String) -> String {
        guard value.count > maxPayloadChars else {
            return value
        }
        let endIndex = value.index(value.startIndex, offsetBy: maxPayloadChars)
        return "\(value[..<endIndex])...(truncated \(value.count - maxPayloadChars) chars)"
    }
}
