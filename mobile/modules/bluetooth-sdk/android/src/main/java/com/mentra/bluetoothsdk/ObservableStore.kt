package com.mentra.core

import java.util.UUID
import org.json.JSONObject

/** Observable state management with immediate event emission */
class ObservableStore {
    companion object {
        const val CORE_CATEGORY = "core"
        private const val LEGACY_BLUETOOTH_CATEGORY = "bluetooth"

        fun normalizeCategory(category: String): String =
                if (category == LEGACY_BLUETOOTH_CATEGORY) CORE_CATEGORY else category
    }

    private val values = mutableMapOf<String, Any>()
    private val emitListeners = linkedMapOf<String, (String, Map<String, Any>) -> Unit>()

    @Synchronized
    fun configure(onEmit: (String, Map<String, Any>) -> Unit) {
        emitListeners["default"] = onEmit
    }

    @Synchronized
    fun addListener(onEmit: (String, Map<String, Any>) -> Unit): String {
        val id = UUID.randomUUID().toString()
        emitListeners[id] = onEmit
        return id
    }

    @Synchronized
    fun removeListener(id: String) {
        emitListeners.remove(id)
    }

    fun set(category: String, key: String, value: Any) {
        val normalizedCategory: String
        val listeners: List<(String, Map<String, Any>) -> Unit>

        synchronized(this) {
            normalizedCategory = normalizeCategory(category)
            val fullKey = "$normalizedCategory.$key"
            val oldValue = values[fullKey]

            // Skip if unchanged
            if (oldValue != null && toJson(oldValue) == toJson(value)) return

            values[fullKey] = value
            listeners = emitListeners.values.toList()
        }

        // Emit immediately, outside the store lock so callbacks can safely re-enter the store.
        listeners.forEach { it(normalizedCategory, mapOf(key to value)) }
    }

    @Synchronized
    fun get(category: String, key: String): Any? = values["${normalizeCategory(category)}.$key"]

    @Synchronized
    fun getCategory(category: String): Map<String, Any> {
        val prefix = "${normalizeCategory(category)}."
        return values.filterKeys { it.startsWith(prefix) }.mapKeys { it.key.removePrefix(prefix) }
    }

    private fun toJson(value: Any): String {
        return JSONObject(mapOf("v" to value)).toString()
    }
}
