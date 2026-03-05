package com.mentra.core

import org.json.JSONObject

/** Observable state management with immediate event emission */
class ObservableStore {
    private val values = mutableMapOf<String, Any>()
    private var onEmit: ((String, Map<String, Any>) -> Unit)? = null

    fun configure(onEmit: (String, Map<String, Any>) -> Unit) {
        this.onEmit = onEmit
    }

    fun set(category: String, key: String, value: Any) {
        val fullKey = "$category.$key"
        val oldValue = values[fullKey]

        // Skip if unchanged
        if (oldValue != null && toJson(oldValue) == toJson(value)) return

        values[fullKey] = value

        // Emit immediately
        onEmit?.invoke(category, mapOf(key to value))
    }

    fun get(category: String, key: String): Any? = values["$category.$key"]

    fun getCategory(category: String): Map<String, Any> {
        val prefix = "$category."
        return values.filterKeys { it.startsWith(prefix) }.mapKeys { it.key.removePrefix(prefix) }
    }

    private fun toJson(value: Any): String {
        return JSONObject(mapOf("v" to value)).toString()
    }
}