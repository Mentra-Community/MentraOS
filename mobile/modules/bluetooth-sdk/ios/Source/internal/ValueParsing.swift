import Foundation

func intValue(_ value: Any?) -> Int? {
    if let int = value as? Int { return int }
    if let double = value as? Double { return Int(double) }
    if let number = value as? NSNumber { return number.intValue }
    return nil
}

func stringValue(_ values: [String: Any], _ keys: String...) -> String? {
    stringValue(values, keys)
}

func stringValue(_ values: [String: Any], _ keys: [String]) -> String? {
    for key in keys {
        if let value = values[key] as? String {
            return value
        }
    }
    return nil
}

func boolValue(_ values: [String: Any], _ keys: String...) -> Bool? {
    boolValue(values, keys)
}

func boolValue(_ values: [String: Any], _ keys: [String]) -> Bool? {
    for key in keys {
        if let value = values[key] as? Bool { return value }
        if let value = values[key] as? NSNumber { return value.boolValue }
    }
    return nil
}

func hasAnyKey(_ values: [String: Any], _ keys: String...) -> Bool {
    hasAnyKey(values, keys)
}

func hasAnyKey(_ values: [String: Any], _ keys: [String]) -> Bool {
    keys.contains { values.keys.contains($0) }
}

func optionalStringValue(_ values: [String: Any], _ keys: String...) -> String? {
    hasAnyKey(values, keys) ? stringValue(values, keys) : nil
}

func nonEmptyStringValue(_ values: [String: Any], _ keys: String...) -> String? {
    for key in keys {
        guard let value = values[key] as? String else { continue }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return value
        }
    }
    return nil
}

func optionalIntValue(_ values: [String: Any], _ keys: String...) -> Int? {
    guard hasAnyKey(values, keys) else { return nil }
    for key in keys {
        if let value = intValue(values[key]) { return value }
    }
    return nil
}

func optionalBoolValue(_ values: [String: Any], _ keys: String...) -> Bool? {
    hasAnyKey(values, keys) ? boolValue(values, keys) : nil
}

func stringListValue(_ values: [String: Any], _ key: String) -> [String] {
    values[key] as? [String] ?? []
}

func optionalStringListValue(_ values: [String: Any], _ key: String) -> [String]? {
    values.keys.contains(key) ? stringListValue(values, key) : nil
}

func dictionaryListValue(_ values: [String: Any], _ key: String) -> [[String: Any]] {
    values[key] as? [[String: Any]] ?? []
}

func optionalDictionaryListValue(_ values: [String: Any], _ key: String) -> [[String: Any]]? {
    values.keys.contains(key) ? dictionaryListValue(values, key) : nil
}

func putIfNotNil(_ map: inout [String: Any], _ key: String, _ value: Any?) {
    if let value {
        map[key] = value
    }
}
