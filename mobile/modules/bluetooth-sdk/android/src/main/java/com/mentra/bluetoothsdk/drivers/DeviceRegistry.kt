package com.mentra.bluetoothsdk.drivers

import com.mentra.bluetoothsdk.sgcs.SGCManager

/**
 * Registry of glasses adapters keyed on a stable model ID (CTO Phase 2, item 2 in
 * docs/device-driver-contract.md §0).
 *
 * The contract an adapter implements is the public [SGCManager] itself — there is
 * no separate driver interface. Built-in SGCs register here as built-ins, and an
 * OEM registers their own [SGCManager] subclass the same way. [DeviceManager.initSGC]
 * resolves a wearable to an adapter through [make] instead of a hardcoded if/else.
 *
 * Matching preserves the legacy `wearable.contains(modelId)` semantics and resolves
 * in registration order, so registering the built-ins in their original branch order
 * keeps behavior identical.
 */
object DeviceRegistry {
    class Entry(
        val modelId: String,
        val make: () -> SGCManager?,
    )

    private val entries = mutableListOf<Entry>()

    /**
     * Register an adapter factory for a model ID. Re-registering the same model ID
     * replaces the prior entry (built-ins register once; an OEM may override).
     */
    @JvmStatic
    @Synchronized
    fun register(modelId: String, make: () -> SGCManager?) {
        entries.removeAll { it.modelId == modelId }
        entries.add(Entry(modelId, make))
    }

    /** Resolve a wearable name to a new adapter instance, or null if no model matches. */
    @JvmStatic
    @Synchronized
    fun make(wearable: String): SGCManager? =
        entries.firstOrNull { wearable.contains(it.modelId) }?.make?.invoke()

    @JvmStatic
    @Synchronized
    fun isEmpty(): Boolean = entries.isEmpty()
}
