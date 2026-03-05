//
//  ObservableStore.swift
//  Core
//
//  Observable state management with immediate event emission
//

import Foundation

@MainActor
class ObservableStore {
    private nonisolated(unsafe) var values: [String: Any] = [:]
    private var onEmit: ((String, [String: Any]) -> Void)?

    func configure(onEmit: @escaping (String, [String: Any]) -> Void) {
        self.onEmit = onEmit
    }

    func set(_ category: String, _ key: String, _ value: Any) {
        let fullKey = "\(category).\(key)"
        let oldValue = values[fullKey]

        // Skip if unchanged
        if let old = oldValue, areEqual(old, value) {
            return
        }

        values[fullKey] = value

        // Emit immediately
        onEmit?(category, [key: value])
    }

    nonisolated func get(_ category: String, _ key: String) -> Any? {
        values["\(category).\(key)"]
    }

    func getCategory(_ category: String) -> [String: Any] {
        var result: [String: Any] = [:]
        let prefix = "\(category)."
        for (key, value) in values where key.hasPrefix(prefix) {
            let shortKey = String(key.dropFirst(prefix.count))
            result[shortKey] = value
        }
        return result
    }

    // Helper to compare values
    private func areEqual(_ lhs: Any, _ rhs: Any) -> Bool {
        if let l = lhs as? String, let r = rhs as? String { return l == r }
        if let l = lhs as? Int, let r = rhs as? Int { return l == r }
        if let l = lhs as? Bool, let r = rhs as? Bool { return l == r }
        if let l = lhs as? Double, let r = rhs as? Double { return l == r }
        if let l = lhs as? [String], let r = rhs as? [String] { return l == r }
        if let l = lhs as? [[String: Any]], let r = rhs as? [[String: Any]] {
            return toJson(l) == toJson(r)
        }
        return false
    }

    private func toJson(_ value: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
