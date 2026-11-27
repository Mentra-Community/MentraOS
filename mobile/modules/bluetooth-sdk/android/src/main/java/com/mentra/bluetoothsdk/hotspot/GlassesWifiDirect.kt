package com.mentra.bluetoothsdk.hotspot

import org.json.JSONObject

/**
 * The Bluetooth half of the glasses' Wi-Fi Direct link: what the connected glasses advertise, the
 * `wifi_direct_start` / `wifi_direct_stop` pair, and the `wifi_direct_status` answers. Only the
 * glasses Wi-Fi service's join in [ScopedSoftApNetwork] uses it; nothing else talks to the radio.
 */
object GlassesWifiDirect {
    private val lock = Object()
    private var known: Int? = 0

    /**
     * The connected glasses' `wifi_direct_version`: 0 when they can't hold a group or none are
     * connected, null from asking them for their `version_info` until it answers.
     */
    var version: Int?
        get() = synchronized(lock) { known }
        set(value) = synchronized(lock) {
            known = value
            lock.notifyAll()
        }

    /** [version] once the glasses have answered, waiting up to [timeoutMs]; 0 if they never do. */
    fun awaitVersion(timeoutMs: Long): Int = synchronized(lock) {
        val deadline = System.nanoTime() / 1_000_000 + timeoutMs
        while (known == null) {
            val left = deadline - System.nanoTime() / 1_000_000
            if (left <= 0) break
            lock.wait(left)
        }
        known ?: 0
    }

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
