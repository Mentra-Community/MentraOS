//
//  ObservableStore.swift
//  BluetoothSdk
//
//  Observable state management with immediate event emission
//

import Foundation

@MainActor
class ObservableStore {
    private var values: [String: Any] = [:]
    private var onEmit: ((String, [String: Any]) -> Void)?
    private var listeners: [String: (String, [String: Any]) -> Void] = [:]

    // Serialize every access to `values` / `listeners`. This type is annotated
    // @MainActor, but it is reached from BLE background callbacks through the
    // Obj-C/React Native bridge, which bypasses Swift actor isolation. The
    // resulting data race corrupts the backing dictionary and crashes with
    // "-[__NSTaggedDate countByEnumeratingWithState:objects:count:]: unrecognized
    // selector" inside getCategory's enumeration. A recursive lock makes the
    // dictionary access safe regardless of the calling thread (recursive so a
    // listener firing on the same thread can safely re-enter).
    private let lock = NSRecursiveLock()

    nonisolated static let bluetoothCategory = "bluetooth"
    private nonisolated static let legacyCoreCategory = "core"

    nonisolated static func normalizeCategory(_ category: String) -> String {
        category == legacyCoreCategory ? bluetoothCategory : category
    }

    func configure(onEmit: @escaping (String, [String: Any]) -> Void) {
        self.onEmit = onEmit
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

        lock.lock()
        let oldValue = values[fullKey]
        // Skip if unchanged
        if let old = oldValue, areEqual(old, value) {
            lock.unlock()
            return
        }
        values[fullKey] = value
        // Snapshot listeners under the lock, then release before emitting so a
        // listener that re-enters the store on another thread cannot deadlock.
        let listenersSnapshot = Array(listeners.values)
        lock.unlock()

        // Emit immediately
        let changes = [key: value]
        onEmit?(normalizedCategory, changes)
        for listener in listenersSnapshot {
            listener(normalizedCategory, changes)
        }
    }

    func remove(_ category: String, _ key: String) {
        let normalizedCategory = Self.normalizeCategory(category)
        let fullKey = "\(normalizedCategory).\(key)"
        guard values[fullKey] != nil else { return }
        values.removeValue(forKey: fullKey)
        // Emit updated category snapshot so UI listeners clear the removed key
        let snapshot = getCategory(normalizedCategory)
        onEmit?(normalizedCategory, snapshot)
        for listener in Array(listeners.values) { listener(normalizedCategory, snapshot) }
    }

    func get(_ category: String, _ key: String) -> Any? {
        lock.lock()
        defer { lock.unlock() }
        return values["\(Self.normalizeCategory(category)).\(key)"]
    }

    func wouldSkipSet(_ category: String, _ key: String, _ value: Any) -> Bool {
        let fullKey = "\(Self.normalizeCategory(category)).\(key)"
        lock.lock()
        defer { lock.unlock() }
        guard let oldValue = values[fullKey] else { return false }
        return areEqual(oldValue, value)
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
