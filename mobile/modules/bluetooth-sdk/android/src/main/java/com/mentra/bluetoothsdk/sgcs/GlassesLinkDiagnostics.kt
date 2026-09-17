package com.mentra.bluetoothsdk.sgcs

/**
 * Keeps the handful of measurements that explain why a Mentra Live BLE link died, and renders them
 * as one line when it does.
 *
 * <p>A BES watchdog reboot reaches the phone only as `GATT connection error: status=8`, which says
 * nothing about whether the link faded, went abruptly quiet, or was dropped while healthy. The
 * answer is always in the seconds before: how far the RSSI had fallen, how long since the glasses
 * last said anything, and how long since a mic packet arrived. Those exist today only as thousands
 * of separate `RSSI:` and `MICDBG-RX` lines that have to be correlated by hand after the fact.
 *
 * <p>Phone-side, because the glasses' own log is the artifact most likely to be missing or to have
 * lost the window: it uploads only a 600-line logcat tail, which the post-reboot reconnect fills.
 */
object GlassesLinkDiagnostics {

    /** Grep marker. Never build this by concatenation — a single grep must be exhaustive. */
    const val MARKER = "LINK_DEATH"

    private const val RSSI_HISTORY = 12

    private val rssiHistory = ArrayDeque<Sample>(RSSI_HISTORY)
    private var lastInboundMs: Long? = null
    private var lastMicPacketMs: Long? = null
    private var sessionStartMs: Long? = null

    private data class Sample(val atMs: Long, val rssi: Int)

    /** Called when a BLE session is established, so ages are measured against this link only. */
    @Synchronized
    fun onSessionStart(nowMs: Long = System.currentTimeMillis()) {
        rssiHistory.clear()
        lastInboundMs = null
        lastMicPacketMs = null
        sessionStartMs = nowMs
    }

    /** Called for every JSON message the glasses send. */
    @Synchronized
    fun recordInbound(nowMs: Long = System.currentTimeMillis()) {
        lastInboundMs = nowMs
    }

    /** Called for every LC3 mic packet. Mic gaps lead the control-channel failure by seconds. */
    @Synchronized
    fun recordMicPacket(nowMs: Long = System.currentTimeMillis()) {
        lastMicPacketMs = nowMs
    }

    @Synchronized
    fun recordRssi(rssi: Int, nowMs: Long = System.currentTimeMillis()) {
        while (rssiHistory.size >= RSSI_HISTORY) {
            rssiHistory.removeFirst()
        }
        rssiHistory.addLast(Sample(nowMs, rssi))
    }

    /**
     * One-line summary of the link's final seconds.
     *
     * @param reason the transition being explained, e.g. `gatt_error` or `gatt_disconnected`
     * @param status the GATT status code, or null when the stack did not report one
     */
    @Synchronized
    fun summary(
            reason: String,
            status: Int? = null,
            streamActive: Boolean? = null,
            nowMs: Long = System.currentTimeMillis()
    ): String {
        val parts = mutableListOf<String>()
        parts.add(MARKER)
        parts.add("reason=$reason")
        if (status != null) parts.add("status=$status")
        parts.add("sessionMs=${age(sessionStartMs, nowMs)}")
        parts.add("msSinceInbound=${age(lastInboundMs, nowMs)}")
        parts.add("msSinceMicPacket=${age(lastMicPacketMs, nowMs)}")
        parts.add("lastRssi=${rssiHistory.lastOrNull()?.rssi ?: UNKNOWN}")
        parts.add("minRssi=${rssiHistory.minOfOrNull { it.rssi } ?: UNKNOWN}")
        parts.add("rssiTrend=${trend()}")
        if (streamActive != null) parts.add("streamActive=$streamActive")
        return parts.joinToString(" ")
    }

    /** Oldest-to-newest RSSI so a fade is distinguishable from an abrupt drop at full signal. */
    private fun trend(): String =
            if (rssiHistory.isEmpty()) "none"
            else rssiHistory.joinToString(",") { it.rssi.toString() }

    /** Reports [UNKNOWN] for a signal never seen on this link, rather than an age from epoch. */
    private fun age(sinceMs: Long?, nowMs: Long): Long =
            if (sinceMs == null) UNKNOWN.toLong() else nowMs - sinceMs

    private const val UNKNOWN = -1
}
