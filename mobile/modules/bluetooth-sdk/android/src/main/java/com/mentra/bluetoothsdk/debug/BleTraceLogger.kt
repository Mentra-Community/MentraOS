package com.mentra.bluetoothsdk.debug

import android.content.Context
import android.os.Build
import android.os.Process
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

object BleTraceLogger {
    private const val TAG = "MentraBleTrace"
    private const val MAX_PAYLOAD_CHARS = 3000
    private const val K900_TYPE = "k900"
    private val sensitiveKeyParts =
        listOf("password", "pass", "token", "secret", "authorization", "auth", "email", "serial")

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
        try {
            val sanitized = sanitize(JSONObject(payload))
            Log.i(TAG, format(direction, layer, caller(), type ?: extractType(sanitized), null, sanitized.toString()))
        } catch (e: Exception) {
            Log.d(TAG, "BLE trace map logging failed", e)
        }
    }

    @JvmStatic
    fun logLifecycle(
        context: Context?,
        component: String,
        event: String,
        extra: Map<String, Any?> = emptyMap(),
    ) {
        try {
            val payload = JSONObject()
            payload.put("event", event)
            payload.put("component", component)
            payload.put("pid", Process.myPid())
            payload.put("model", Build.MODEL)
            payload.put("sdkInt", Build.VERSION.SDK_INT)

            context?.let {
                payload.put("package", it.packageName)
                packageVersion(it)?.let { version -> payload.put("version", version) }
            }

            extra.forEach { (key, value) -> payload.put(key, value ?: JSONObject.NULL) }
            Log.i(TAG, format("phone_app", "app_lifecycle", caller(), event, null, sanitize(payload).toString()))
        } catch (e: Exception) {
            Log.d(TAG, "BLE trace lifecycle logging failed", e)
        }
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
                return extractK900Type(cValue)
            }
            return extractK900Type(cValue)
        }
        return "unknown"
    }

    private fun extractK900Type(cValue: String): String =
        if (cValue == "sr_log") "$K900_TYPE:sr_log" else K900_TYPE

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
                return sanitizeK900Command(value)
            }
        }
        return when (value) {
            is JSONObject -> sanitize(value)
            is JSONArray -> sanitize(value)
            JSONObject.NULL -> JSONObject.NULL
            else -> value
        }
    }

    private fun sanitizeK900Command(value: String): String =
        if (value == "sr_log") value else "<non-json C payload>"

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

    private fun packageVersion(context: Context): String? =
        try {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            val versionCode =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    packageInfo.longVersionCode
                } else {
                    @Suppress("DEPRECATION")
                    packageInfo.versionCode.toLong()
                }
            "${packageInfo.versionName ?: "unknown"}+$versionCode"
        } catch (_: Exception) {
            null
        }

    private fun truncate(value: String): String {
        if (value.length <= MAX_PAYLOAD_CHARS) {
            return value
        }
        return "${value.take(MAX_PAYLOAD_CHARS)}...(truncated ${value.length - MAX_PAYLOAD_CHARS} chars)"
    }
}
