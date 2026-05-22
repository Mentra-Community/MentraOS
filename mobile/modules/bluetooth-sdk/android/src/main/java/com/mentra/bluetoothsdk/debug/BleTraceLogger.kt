package com.mentra.bluetoothsdk.debug

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

object BleTraceLogger {
    private const val TAG = "MentraBleTrace"
    private const val MAX_PAYLOAD_CHARS = 3000
    private val sensitiveKeyParts =
        listOf("password", "pass", "token", "secret", "authorization", "auth", "email")

    @JvmStatic
    fun logJson(direction: String, layer: String, payload: JSONObject?, bytes: Int? = null) {
        if (payload == null) {
            Log.i(TAG, format(direction, layer, caller(), "null", bytes, "null"))
            return
        }

        val sanitized = sanitize(payload)
        Log.i(TAG, format(direction, layer, caller(), extractType(payload), bytes, sanitized.toString()))
    }

    @JvmStatic
    fun logMap(direction: String, layer: String, type: String?, payload: Map<String, Any>) {
        val sanitized = sanitize(JSONObject(payload))
        Log.i(TAG, format(direction, layer, caller(), type ?: extractType(sanitized), null, sanitized.toString()))
    }

    private fun format(
        direction: String,
        layer: String,
        source: String,
        type: String,
        bytes: Int?,
        payload: String,
    ): String {
        val bytesText = bytes?.let { " bytes=$it" } ?: ""
        return "BLE_TRACE direction=$direction layer=$layer source=$source type=$type$bytesText payload=${truncate(payload)}"
    }

    private fun extractType(payload: JSONObject): String {
        payload.optString("type").takeIf { it.isNotBlank() }?.let { return it }
        payload.optString("C").takeIf { it.isNotBlank() }?.let { cValue ->
            try {
                val inner = JSONObject(cValue)
                inner.optString("type").takeIf { it.isNotBlank() }?.let { return it }
            } catch (_: Exception) {
                return "k900:${cValue.take(40)}"
            }
        }
        return "unknown"
    }

    private fun sanitize(value: JSONObject): JSONObject {
        val output = JSONObject()
        value.keys().forEach { key ->
            output.put(key, sanitizeValue(key, value.opt(key)))
        }
        return output
    }

    private fun sanitize(value: JSONArray): JSONArray {
        val output = JSONArray()
        for (index in 0 until value.length()) {
            output.put(sanitizeValue(null, value.opt(index)))
        }
        return output
    }

    private fun sanitizeValue(key: String?, value: Any?): Any? {
        if (key != null && sensitiveKeyParts.any { key.contains(it, ignoreCase = true) }) {
            return "<redacted>"
        }
        if (key == "C" && value is String) {
            try {
                return sanitize(JSONObject(value)).toString()
            } catch (_: Exception) {
                return truncate(value)
            }
        }
        return when (value) {
            is JSONObject -> sanitize(value)
            is JSONArray -> sanitize(value)
            JSONObject.NULL -> JSONObject.NULL
            else -> value
        }
    }

    private fun caller(): String {
        val frame =
            Throwable().stackTrace.firstOrNull {
                !it.className.contains("BleTraceLogger") &&
                    !it.className.startsWith("java.lang.") &&
                    !it.className.startsWith("kotlin.")
        }
        return frame?.let {
            "${it.className.substringAfterLast('.')}.${it.methodName}(${it.fileName}:${it.lineNumber})"
        } ?: "unknown"
    }

    private fun truncate(value: String): String {
        if (value.length <= MAX_PAYLOAD_CHARS) {
            return value
        }
        return "${value.take(MAX_PAYLOAD_CHARS)}...(truncated ${value.length - MAX_PAYLOAD_CHARS} chars)"
    }
}
