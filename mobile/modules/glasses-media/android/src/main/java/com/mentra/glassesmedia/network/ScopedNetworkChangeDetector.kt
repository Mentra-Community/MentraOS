package com.mentra.glassesmedia.network

import android.content.Context
import android.net.ConnectivityManager
import com.mentra.glassesmedia.trace.SoftApTrace
import java.net.Inet4Address
import org.webrtc.NetworkChangeDetector
import org.webrtc.NetworkMonitor
import org.webrtc.NetworkMonitorAutoDetect

/**
 * Adds the scoped SoftAP network to libwebrtc's Android network inventory.
 *
 * ## Why this exists
 *
 * The SoftAP [Network] is requested without `NET_CAPABILITY_INTERNET` so that Android keeps ACS on
 * cellular. But stock libwebrtc's `NetworkMonitorAutoDetect` registers a request for
 * *internet-capable* networks, so it never sees this one, and ICE therefore never gathers a host
 * candidate on the hotspot subnet. Holding a scoped `Network` object is not by itself enough to make
 * libwebrtc's internally-created UDP sockets use that interface — `PeerConnectionFactory.Options`
 * exposes `networkIgnoreMask` and `disableNetworkMonitor`, not a socket factory or a network handle.
 *
 * Injecting the interface into the inventory is the supported way through: it is the same technique
 * the glasses already use for their `ap0` tethering interface in
 * `HotspotAwareNetworkChangeDetector`.
 *
 * The monitor this touches is process-wide and the libwebrtc AAR is shared with LiveKit, so the
 * takeover is scoped and reversible; [ScopedNetworkObserver] documents and enforces that contract.
 *
 * ## Why the handle is the real [Network] handle
 *
 * Two device-proven behaviours, both captured, both fatal on their own:
 *
 * Handle `0` makes `BindSocketToNetwork` return `NOT_IMPLEMENTED`, so libwebrtc binds the socket to
 * `192.168.43.x` and advertises that address. The answer is truthful. ICE checks then sit on that
 * pair with `|CR-I|-|0|0|` forever: the OS accepted the bind, and even a send-only datagram, but
 * unmarked UDP on a non-default network is not delivered. 18:56 / 19:01 runs: ACS `CONNECTED`,
 * `ingest_host_candidate onHotspot=true`, then `ingest_no_first_frame` and the glasses reporting
 * `ICE did not connect`.
 *
 * A real handle makes `android_setsocknetwork` succeed, so the socket is marked onto the scoped
 * SoftAP and ICE packets can actually leave and return. libwebrtc then rebinds to `0.0.0.0` and
 * `UDPPort` substitutes the default-route (cellular) address into the candidate:
 *
 * ```
 * Allocate ports on wlan0
 * Port[...:Net[wlan0:192.168.43.x/24:Wifi:id=5]]: Gathered candidate: Cand[...:10.48.51.x:...:host...]
 * ```
 *
 * That advertised address is what the glasses would send to, and they have no route to it. So the
 * handle is real — sockets must be marked — and [SoftApSdpGuard.pinHostAddresses] rewrites the
 * answer the glasses see back onto the scoped IP. One inventory entry, so the handle cannot collide
 * with a decoy the way `0` did when we published more than one.
 *
 * ## Status
 *
 * Whether stock libwebrtc needs this at all is exactly what the Phase 0.5 feasibility gate
 * (`SoftApFeasibilityGateTest`) measures. The gate fired on-device (see [install]), so
 * [AcsMeetingModule][com.mentra.acsmeeting.AcsMeetingModule] installs it at module creation.
 */
class ScopedNetworkChangeDetector
internal constructor(
    private val delegate: NetworkChangeDetector,
    private val scopedNetworkSupplier: () -> ScopedInterface?,
    private val observer: ScopedNetworkObserver? = null,
) : NetworkChangeDetector {

    constructor(
        observer: NetworkChangeDetector.Observer,
        context: Context,
        scopedNetwork: ScopedSoftApNetwork,
    ) : this(wire(observer, context) { resolveScopedInterface(context, scopedNetwork) })

    private constructor(wired: Wired) : this(wired.delegate, wired.scoped, wired.observer)

    /** The SoftAP interface as libwebrtc needs to see it. */
    data class ScopedInterface(
        val name: String,
        val networkHandle: Long,
        val ipv4Addresses: List<ByteArray>,
    )

    /**
     * One inventory entry as libwebrtc was told about it.
     *
     * Kept as plain values rather than the webrtc type so [lastPublished] can outlive a gathering
     * pass without pinning native objects, and so the diagnosis can be unit tested.
     */
    data class PublishedEntry(
        val name: String,
        val type: String,
        val handle: Long,
        val addresses: List<String>,
    ) {
        override fun toString(): String = "$name[$type]#$handle(${addresses.joinToString("/")})"
    }

    override fun getCurrentConnectionType(): NetworkChangeDetector.ConnectionType {
        val delegateType = delegate.currentConnectionType
        if (delegateType == NetworkChangeDetector.ConnectionType.CONNECTION_NONE &&
            scopedNetworkSupplier() != null
        ) {
            return NetworkChangeDetector.ConnectionType.CONNECTION_WIFI
        }
        return delegateType
    }

    override fun supportNetworkCallback(): Boolean = delegate.supportNetworkCallback()

    override fun getActiveNetworkList(): List<NetworkChangeDetector.NetworkInformation> {
        val scoped = scopedNetworkSupplier()
        val table = NetworkFacts.snapshot()
        val stock = delegate.activeNetworkList

        // The three views that have to agree, logged side by side. libwebrtc gathers from the
        // kernel table; we only get to label the names in it. A scoped address missing from
        // `ifaddrs`, or present under a different name than LinkProperties claims, is
        // unrecoverable by any mask — and is invisible unless all three are printed together.
        SoftApTrace.stage(
            "softap_ifaddrs",
            "gatherable" to NetworkFacts.render(NetworkFacts.gatherable(table)),
            "all" to NetworkFacts.render(table),
        )
        SoftApTrace.stage(
            "webrtc_stock_inventory",
            "count" to stock.orEmpty().size,
            "interfaces" to renderInventory(stock),
        )
        if (scoped != null) {
            val address = scoped.ipv4Addresses.firstOrNull()?.let { formatIpv4(it) }
            val owner = address?.let { NetworkFacts.ownerOf(it, table) }
            // The smoking-gun check. `claimed` is what LinkProperties told us; `owner` is what the
            // kernel says. If owner is null the address is not in the table at all and ICE cannot
            // gather it; if they differ, our WIFI label is being applied to the wrong interface.
            SoftApTrace.stage(
                "softap_scoped_address_owner",
                "address" to (address ?: "none"),
                "claimed" to scoped.name,
                "owner" to (owner ?: "ABSENT"),
                "agrees" to (owner != null && owner == scoped.name),
                "handle" to scoped.networkHandle,
            )
        }

        val merged = mergeScopedNetwork(stock, scoped, relayNetwork != null)
        lastPublished = snapshotOf(merged)
        SoftApTrace.stage(
            "webrtc_network_inventory",
            "count" to merged.size,
            "interfaces" to lastPublished.joinToString(",") { it.toString() },
        )
        observer?.publish(merged)
        return merged
    }

    override fun destroy() {
        // Give the monitor back before the delegate goes away, otherwise the synthetic entry is
        // the last thing libwebrtc was told about and every later connection inherits it.
        observer?.restore()
        delegate.destroy()
    }

    companion object {

        /**
         * What was last handed to libwebrtc, for the rejection diagnostics.
         *
         * A missing hotspot candidate has several causes and they are only separable by knowing
         * whether the hotspot was in the inventory at gathering time, and whether any two entries
         * shared a handle. Process-wide because the inventory is; read-only for callers.
         */
        @Volatile
        @JvmStatic
        var lastPublished: List<PublishedEntry> = emptyList()
            private set

        /** An inventory entry reduced to the fields a diagnosis or a trace needs. */
        @JvmStatic
        fun snapshotOf(
            entries: List<NetworkChangeDetector.NetworkInformation>?,
        ): List<PublishedEntry> =
            entries.orEmpty().map { info ->
                PublishedEntry(
                    info.name,
                    info.type.name,
                    info.handle,
                    info.ipAddresses.map { formatIpv4(it.address) },
                )
            }

        /** `name[type]#handle(ips)` per entry — the shape both traces and diagnostics want. */
        @JvmStatic
        fun renderInventory(
            entries: List<NetworkChangeDetector.NetworkInformation>?,
        ): String = snapshotOf(entries).joinToString(",") { it.toString() }

        /**
         * The handle that tells libwebrtc "bind to the address, not to a network".
         *
         * `AndroidNetworkMonitor::BindSocketToNetwork` maps a zero handle to `NOT_IMPLEMENTED`,
         * which is the only branch that leaves the socket bound to a real local address — and so
         * the only branch that yields a truthful host candidate. Named because it is load-bearing,
         * not a placeholder.
         */
        const val UNBINDABLE_HANDLE = 0L

        /**
         * Register this detector as the one libwebrtc builds when it starts monitoring.
         *
         * `NetworkMonitor` is process-wide and only consults the factory when it creates a
         * detector — on the first `startMonitoring` and again after every `stopMonitoring` that
         * drops the observer count to zero. So this must run before any `PeerConnectionFactory`
         * exists, and [scopedNetworkSupplier] must resolve the *current* join at call time rather
         * than capture one instance: the module recreates its [ScopedSoftApNetwork] across
         * sessions.
         *
         * Idempotent. Feasibility gate result that made this necessary, on a Galaxy S25 /
         * Android 16 with webrtc-sdk 137: `NetworkMonitorAutoDetect.networkToInfo` drops every
         * network lacking `NET_CAPABILITY_INTERNET`, so the answer to the glasses' offer carried
         * zero host candidates and the ingest returned WHIP 500 `no_softap_host_candidate`.
         */
        private data class Wired(
            val delegate: NetworkChangeDetector,
            val scoped: () -> ScopedInterface?,
            val observer: ScopedNetworkObserver,
        )

        /**
         * One observer is shared: AutoDetect's callbacks go through it, and so does the
         * reconcile in [getActiveNetworkList]. Two instances would drop stock handles on one
         * and publish the hotspot on the other, which is how the native list stayed dirty.
         */
        private fun wire(
            downstream: NetworkChangeDetector.Observer,
            context: Context,
            scoped: () -> ScopedInterface?,
        ): Wired {
            val filter = ScopedNetworkObserver(downstream, scoped) { relayNetwork != null }
            return Wired(NetworkMonitorAutoDetect(filter, context), scoped, filter)
        }

        @JvmStatic
        fun install(scopedNetworkSupplier: () -> ScopedSoftApNetwork?) {
            acsNetworkSupplier = scopedNetworkSupplier
            installMonitor()
        }

        @Volatile private var acsNetworkSupplier: () -> ScopedSoftApNetwork? = { null }
        @Volatile private var relayNetwork: ScopedSoftApNetwork? = null

        /** Keep real internet handles visible for the outgoing peer; each factory masks its leg. */
        @JvmStatic
        fun setRelayNetwork(network: ScopedSoftApNetwork?) {
            relayNetwork = network
            installMonitor()
        }

        private fun installMonitor() {
            val monitor = NetworkMonitor.getInstance()
            // A live detector was built by an earlier factory (or the stock one) and will not be
            // replaced until monitoring restarts; say so in the trace so a missing host candidate
            // after this point has an explanation.
            SoftApTrace.stage(
                "webrtc_network_detector_installed",
                "monitorObservers" to monitor.numObservers,
            )
            monitor.setNetworkChangeDetectorFactory { observer, context ->
                val wired =
                    wire(observer, context) {
                        (relayNetwork ?: acsNetworkSupplier())?.let { resolveScopedInterface(context, it) }
                    }
                ScopedNetworkChangeDetector(wired.delegate, wired.scoped, wired.observer)
            }
        }

        /**
         * The SoftAP inventory: exactly one entry, the scoped network, typed Wi-Fi.
         *
         * Publishing decoy entries for the other interfaces was tried and is wrong. The theory was
         * that an interface the monitor has never heard of comes back `ADAPTER_TYPE_UNKNOWN == 0`
         * and `networkIgnoreMask and 0` is always `0`, making an omitted interface unmaskable. The
         * device log says otherwise: an interface with no monitor entry is dropped from the network
         * list entirely, not admitted as unknown. Here `rmnet_data0` vanishes the moment its entry
         * is gone, while `lo` survives because libwebrtc types loopback from the interface flags
         * and the mask drops it:
         *
         * ```
         * Network connected: NetInfo[name wlan0; handle 0; type 2]
         * Count of networks: 3
         *   Net[wlan0:192.168.43.x/24:Wifi:id=5]
         *   Net[lo:...:Loopback:id=2]
         *   Net[lo:127.0.0.x/8:Loopback:id=1]
         * ```
         *
         * Worse, the decoys were actively fatal. `AndroidNetworkMonitor` keys its networks by
         * *handle*, and both the hotspot and the decoys have to use [UNBINDABLE_HANDLE], so each
         * `onNetworkConnect` overwrote the previous one. Whichever arrived last was the only
         * network the monitor knew, and when that was a masked decoy the answer carried no
         * candidates at all:
         *
         * ```
         * Network connected: NetInfo[name wlan0; handle 0; type 2]
         * Network connected: NetInfo[name rmnet_data0; handle 0; type 4]
         * Count of networks: 4 -> rmnet_data0, rmnet_data0, lo, lo   (wlan0 gone)
         * ```
         *
         * One entry, therefore. The invariant stays structural — the only gatherable adapter is the
         * scoped SoftAP — and it no longer depends on a handle being unique.
         *
         * When the hotspot shares an interface *name* with a stock address, the scoped entry wins
         * and carries only its `LinkProperties` addresses. Type cannot separate two addresses on
         * one name, so that residual case is caught by `SoftApSdpGuard` instead.
         */
        @JvmStatic
        fun mergeScopedNetwork(
            detected: List<NetworkChangeDetector.NetworkInformation>?,
            scoped: ScopedInterface?,
            includeInternet: Boolean = false,
        ): List<NetworkChangeDetector.NetworkInformation> {
            val hotspot = scoped?.let { toNetworkInformation(it) } ?: return detected.orEmpty()
            return if (includeInternet) {
                detected.orEmpty().filter { it.handle != hotspot.handle && it.name != hotspot.name } + hotspot
            } else listOf(hotspot)
        }

        /** Dotted-quad for the inventory trace. */
        @JvmStatic
        fun formatIpv4(bytes: ByteArray): String =
            bytes.joinToString(".") { (it.toInt() and 0xff).toString() }

        /** Null when the interface has no address, which libwebrtc cannot use. */
        @JvmStatic
        fun toNetworkInformation(
            scoped: ScopedInterface,
        ): NetworkChangeDetector.NetworkInformation? {
            if (scoped.ipv4Addresses.isEmpty()) return null
            val addresses =
                scoped.ipv4Addresses
                    .map { NetworkChangeDetector.IPAddress(it) }
                    .toTypedArray()
            return NetworkChangeDetector.NetworkInformation(
                scoped.name,
                NetworkChangeDetector.ConnectionType.CONNECTION_WIFI,
                NetworkChangeDetector.ConnectionType.CONNECTION_NONE,
                // The real handle, so BindSocketToNetwork marks ICE sockets onto this Network.
                // Handle 0 advertised the right address and then never completed a check; see the
                // class doc. SoftApSdpGuard.pinHostAddresses puts the scoped IP back in the SDP.
                scoped.networkHandle,
                addresses,
            )
        }

        /** Resolve the joined SoftAP into the interface libwebrtc should be told about. */
        private fun resolveScopedInterface(
            context: Context,
            scopedNetwork: ScopedSoftApNetwork,
        ): ScopedInterface? {
            val network = scopedNetwork.network() ?: return null
            val manager =
                context.getSystemService(ConnectivityManager::class.java) ?: return null
            val properties = manager.getLinkProperties(network) ?: return null
            val interfaceName = properties.interfaceName ?: return null
            // LinkProperties of *this* Network, not NetworkInterface.getByName. On a phone that
            // kept internet Wi-Fi up, wlan0 can carry both 10.x and 192.168.43.x; getByName would
            // hand ICE both, and it just picked the 10.x.
            val addresses =
                properties.linkAddresses
                    .mapNotNull { (it.address as? Inet4Address)?.address }
            if (addresses.isEmpty()) return null
            return ScopedInterface(interfaceName, network.networkHandle, addresses)
        }
    }
}
