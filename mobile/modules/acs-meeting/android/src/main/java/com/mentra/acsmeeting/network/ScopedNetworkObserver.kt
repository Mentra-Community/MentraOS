package com.mentra.acsmeeting.network

import com.mentra.acsmeeting.trace.SoftApTrace
import org.webrtc.NetworkChangeDetector

/**
 * Owns libwebrtc's network state for as long as a scoped SoftAP is joined, and gives it back after.
 *
 * `getActiveNetworkList` is only a snapshot. libwebrtc's process-wide monitor also keeps every
 * network it has ever been told about through [onNetworkConnect]. AutoDetect is constructed with
 * this observer and reports cellular (and leftover home Wi-Fi) throughout the ACS join that happens
 * *before* ingest starts, and those handles stay in the native list. Gathering unions the snapshot
 * with that history, which is how a correct inventory still produced a lone cellular candidate.
 *
 * ## Ownership, not filtering
 *
 * The monitor is process-wide and the libwebrtc AAR is deliberately shared with LiveKit, so this
 * cannot simply mute callbacks and walk away. The contract is explicit:
 *
 *  - **While SoftAP is joined** this observer owns the monitor. Stock connect/disconnect callbacks
 *    are suppressed (but *recorded*), every handle outside the SoftAP inventory is disconnected,
 *    and exactly that inventory is connected.
 *  - **When the hotspot goes away** ownership is handed back by [restore]: the synthetic entry is
 *    disconnected and every stock network whose callback was suppressed is replayed, so a WHEP or
 *    LiveKit connection started afterwards sees real networks. Resuming pass-through alone is not
 *    enough — the networks it never heard about would stay missing until the OS happened to
 *    re-announce them.
 *
 * Restoration is driven from both directions, because either may come first: [publish] runs on
 * every inventory read, and each stock callback checks too, since after teardown the OS may be the
 * only thing still talking to us.
 */
internal class ScopedNetworkObserver(
    private val downstream: NetworkChangeDetector.Observer,
    private val scoped: () -> ScopedNetworkChangeDetector.ScopedInterface?,
) : NetworkChangeDetector.Observer() {

    private val lock = Any()

    /**
     * Stock networks by handle, kept whole rather than as bare handles: replaying a suppressed
     * network on teardown requires the [NetworkChangeDetector.NetworkInformation] verbatim.
     */
    private val stock = linkedMapOf<Long, NetworkChangeDetector.NetworkInformation>()

    private val published = mutableSetOf<Long>()
    private var lastSignature: String? = null

    /** True while this observer has taken over the monitor and still owes a [restore]. */
    private var owning = false

    /**
     * Make native state match [inventory] whenever SoftAP is up. A no-op when the snapshot has not
     * changed, so [ScopedNetworkChangeDetector.getActiveNetworkList] can call this on every read.
     */
    fun publish(inventory: List<NetworkChangeDetector.NetworkInformation>) {
        if (scoped() == null) {
            restore()
            return
        }
        val signature =
            inventory.joinToString("|") { info ->
                val ips =
                    info.ipAddresses.joinToString("/") { address ->
                        ScopedNetworkChangeDetector.formatIpv4(address.address)
                    }
                "${info.handle}:${info.name}:$ips"
            }
        synchronized(lock) {
            if (signature == lastSignature) return
            lastSignature = signature
            owning = true

            val keep = inventory.map { it.handle }.toSet()
            // Stock handles announced *before* the join are the ones that poison gathering, so
            // they are disconnected here even though their callbacks were never forwarded.
            val dropped = (stock.keys + published).filterNot { it in keep }
            dropped.forEach { handle -> downstream.onNetworkDisconnect(handle) }
            published.clear()
            inventory.forEach { info ->
                published.add(info.handle)
                downstream.onNetworkConnect(info)
            }
            SoftApTrace.stage(
                "webrtc_network_reconciled",
                "published" to inventory.size,
                "dropped" to dropped.size,
            )
        }
    }

    /**
     * Hand the monitor back: drop the synthetic entry, replay every suppressed stock network.
     *
     * Idempotent, and safe to call when this observer never took ownership.
     */
    fun restore() {
        synchronized(lock) {
            if (!owning) return
            owning = false
            lastSignature = null

            val synthetic = published.toList()
            published.clear()
            synthetic.forEach { handle -> downstream.onNetworkDisconnect(handle) }
            // Replay rather than wait: these networks exist, and the monitor was told they did not.
            stock.values.forEach { info -> downstream.onNetworkConnect(info) }
            SoftApTrace.stage(
                "webrtc_network_restored",
                "syntheticDropped" to synthetic.size,
                "stockReplayed" to stock.size,
            )
        }
    }

    override fun onConnectionTypeChanged(connectionType: NetworkChangeDetector.ConnectionType) {
        if (scoped() != null) {
            downstream.onConnectionTypeChanged(NetworkChangeDetector.ConnectionType.CONNECTION_WIFI)
            return
        }
        restore()
        downstream.onConnectionTypeChanged(connectionType)
    }

    override fun onNetworkConnect(networkInfo: NetworkChangeDetector.NetworkInformation) {
        if (scoped() != null) {
            synchronized(lock) { stock[networkInfo.handle] = networkInfo }
            SoftApTrace.stage(
                "webrtc_stock_connect_suppressed",
                "name" to networkInfo.name,
                "handle" to networkInfo.handle,
            )
            return
        }
        // Restore before recording, so this network is forwarded once below rather than also
        // arriving in the replay.
        restore()
        synchronized(lock) { stock[networkInfo.handle] = networkInfo }
        downstream.onNetworkConnect(networkInfo)
    }

    override fun onNetworkDisconnect(networkHandle: Long) {
        if (scoped() != null) {
            synchronized(lock) { stock.remove(networkHandle) }
            return
        }
        restore()
        synchronized(lock) { stock.remove(networkHandle) }
        downstream.onNetworkDisconnect(networkHandle)
    }

    override fun onNetworkPreference(
        types: List<NetworkChangeDetector.ConnectionType>,
        preference: Int,
    ) {
        if (scoped() != null) return
        restore()
        downstream.onNetworkPreference(types, preference)
    }
}
