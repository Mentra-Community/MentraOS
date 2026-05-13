//
//  ObservableStore.swift
//  Core
//
//  Observable state management with immediate event emission
//

import Foundation

class ObservableStore {
    private let lock = NSLock()
    private var values: [String: Any] = [:]
    private var onEmit: ((String, [String: Any]) -> Void)?
    private var listeners: [String: (String, [String: Any]) -> Void] = [:]

    static let coreCategory = "core"
    private static let legacyBluetoothCategory = "bluetooth"

    static func normalizeCategory(_ category: String) -> String {
        category == legacyBluetoothCategory ? coreCategory : category
    }

    func configure(onEmit: @escaping (String, [String: Any]) -> Void) {
        lock.lock()
        self.onEmit = onEmit
        lock.unlock()
    }

    func addListener(_ listener: @escaping (String, [String: Any]) -> Void) -> String {
        let id = UUID().uuidString
        lock.lock()
        listeners[id] = listener
        lock.unlock()
        return id
    }

    func removeListener(_ id: String) {
        lock.lock()
        listeners.removeValue(forKey: id)
        lock.unlock()
    }

    func set(_ category: String, _ key: String, _ value: Any) {
        let normalizedCategory = Self.normalizeCategory(category)
        let fullKey = "\(normalizedCategory).\(key)"
        let changes = [key: value]
        let emitter: ((String, [String: Any]) -> Void)?
        let activeListeners: [(String, [String: Any]) -> Void]

        lock.lock()
        let oldValue = values[fullKey]

        // Skip if unchanged
        if let old = oldValue, areEqual(old, value) {
            lock.unlock()
            return
        }

        values[fullKey] = value
        emitter = onEmit
        activeListeners = Array(listeners.values)
        lock.unlock()

        // Emit immediately
        emitter?(normalizedCategory, changes)
        for listener in activeListeners {
            listener(normalizedCategory, changes)
        }
    }

    func get(_ category: String, _ key: String) -> Any? {
        lock.lock()
        defer { lock.unlock() }
        return values["\(Self.normalizeCategory(category)).\(key)"]
    }

    func getCategory(_ category: String) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }

        var result: [String: Any] = [:]
        let prefix = "\(Self.normalizeCategory(category))."
        for (key, value) in values where key.hasPrefix(prefix) {
            let shortKey = String(key.dropFirst(prefix.count))
            result[shortKey] = value
        }
        return result
    }

    /// Helper to compare values
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
