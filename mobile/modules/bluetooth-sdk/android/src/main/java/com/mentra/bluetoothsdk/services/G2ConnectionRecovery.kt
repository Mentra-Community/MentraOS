package com.mentra.bluetoothsdk.services

import android.content.Context
import com.mentra.bluetoothsdk.utils.DeviceTypes
import org.json.JSONObject

/** Native recovery of the last active G2 link when Android restarts our sticky service. */
internal class G2ConnectionRecovery(context: Context) {
    private val preferences = context.getSharedPreferences("g2_connection_recovery", Context.MODE_PRIVATE)

    companion object {
        // Deliberately exclude transient connection flags, mic intent, tokens and pending pairing.
        internal val keys = setOf(
            "default_wearable", "device_name", "device_address", "project_name",
            "brightness", "auto_brightness", "dashboard_height", "dashboard_depth",
            "head_up_angle", "use_native_dashboard", "twelve_hour_time", "metric_system",
            "screen_disabled", "power_saving_mode", "lc3_frame_size",
        )
    }

    fun save(settings: Map<String, Any>) {
        if (settings["default_wearable"] != DeviceTypes.G2 ||
            (settings["device_name"] as? String).isNullOrBlank()) {
            clear()
            return
        }
        val snapshot = settings.filterKeys { it in keys }
        preferences.edit().putString("snapshot", JSONObject(snapshot).toString()).apply()
    }

    fun clear() {
        preferences.edit().remove("snapshot").apply()
    }

    fun read(): Map<String, Any>? {
        val raw = preferences.getString("snapshot", null) ?: return null
        return try {
            val json = JSONObject(raw)
            if (json.optString("default_wearable") != DeviceTypes.G2 ||
                json.optString("device_name").isBlank()) return null
            keys.filter { json.has(it) && !json.isNull(it) }.associateWith { json.get(it) }
        } catch (_: Exception) {
            clear()
            null
        }
    }
}
