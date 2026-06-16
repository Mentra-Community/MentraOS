//
//  DeviceRegistry.swift
//  Registry of glasses adapters keyed on a stable model ID (CTO Phase 2, item 2 in
//  docs/device-driver-contract.md §0). Mirror of the Android DeviceRegistry.kt.
//
//  The contract an adapter implements is the public SGCManager protocol itself —
//  there is no separate driver interface. Built-in SGCs register here as built-ins;
//  an OEM registers their own SGCManager-conforming type the same way.
//  DeviceManager.initSGC resolves a wearable to an adapter through make() instead of
//  a hardcoded if/else.
//
//  Matching preserves the legacy wearable.contains(modelId) semantics and resolves
//  in registration order, so registering the built-ins in their original branch
//  order keeps behavior identical.
//

import Foundation

@MainActor
final class DeviceRegistry {
    struct Entry {
        let modelId: String
        let make: () -> SGCManager?
    }

    static let shared = DeviceRegistry()

    private var entries: [Entry] = []

    /// Register an adapter factory for a model ID. Re-registering the same model ID
    /// replaces the prior entry (built-ins register once; an OEM may override).
    func register(_ modelId: String, _ make: @escaping () -> SGCManager?) {
        entries.removeAll { $0.modelId == modelId }
        entries.append(Entry(modelId: modelId, make: make))
    }

    /// Resolve a wearable name to a new adapter instance, or nil if no model matches.
    func make(_ wearable: String) -> SGCManager? {
        entries.first { wearable.contains($0.modelId) }?.make()
    }

    var isEmpty: Bool { entries.isEmpty }
}
