package com.mentra.bluetoothsdk.hotspot

import org.json.JSONObject

/**
 * The Bluetooth half of the glasses' Wi-Fi Direct link: what the connected glasses advertise, the
 * `wifi_direct_start` / `wifi_direct_stop` pair, and the `wifi_direct_status` answers. Only the
 * glasses Wi-Fi service's join in [ScopedSoftApNetwork] uses it; nothing else talks to the radio.
 */
object GlassesWifiDirect {
    /** The connected glasses' `wifi_direct_version`; 0 when they can't hold a group or are gone. */
    @Volatile var version: Int = 0

    /** Sends a command to the connected glasses; false when none are connected. */
    @Volatile internal var sender: ((JSONObject) -> Boolean)? = null

    @Volatile private var listener: ((JSONObject) -> Unit)? = null

    fun start(frequencyMhz: Int): Boolean =
        sender?.invoke(
            JSONObject().put("type", "wifi_direct_start").apply { if (frequencyMhz > 0) put("frequency", frequencyMhz) },
        ) == true

    fun stop() {
        sender?.invoke(JSONObject().put("type", "wifi_direct_stop"))
    }

    internal fun onStatus(listener: ((JSONObject) -> Unit)?) {
        this.listener = listener
    }

    /** A `wifi_direct_status` from the glasses, or a synthetic `stopped` when they disconnect. */
    fun onGlassesStatus(json: JSONObject) {
        listener?.invoke(json)
    }

    /** The glasses left Bluetooth: no group survives that. */
    fun onGlassesDisconnected() {
        version = 0
        onGlassesStatus(JSONObject().put("type", "wifi_direct_status").put("state", "stopped").put("error", "glasses_disconnected"))
    }
}
