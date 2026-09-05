package com.mentra.acsmeeting.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import com.mentra.acsmeeting.trace.SoftApTrace
import java.net.Inet4Address
import java.net.NetworkInterface
import org.webrtc.NetworkChangeDetector
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
 * Unlike the glasses case, the phone holds a real [Network] from `requestNetwork`, so the actual
 * `networkHandle` is published rather than the WiFi-Direct-style `0`. That lets libwebrtc bind its
 * sockets through the scoped network instead of merely binding to the interface address.
 *
 * ## Status
 *
 * Whether stock libwebrtc needs this at all is exactly what the Phase 0.5 feasibility gate
 * (`SoftApFeasibilityGateTest`) measures. Install it only when the gate shows the host candidate is
 * missing without it.
 */
class ScopedNetworkChangeDetector
internal constructor(
    private val delegate: NetworkChangeDetector,
    private val scopedNetworkSupplier: () -> ScopedInterface?,
) : NetworkChangeDetector {

    constructor(
        observer: NetworkChangeDetector.Observer,
        context: Context,
        scopedNetwork: ScopedSoftApNetwork,
    ) : this(
        NetworkMonitorAutoDetect(observer, context),
        { resolveScopedInterface(context, scopedNetwork) },
    )

    /** The SoftAP interface as libwebrtc needs to see it. */
    data class ScopedInterface(
        val name: String,
        val networkHandle: Long,
        val ipv4Addresses: List<ByteArray>,
    )

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
        val merged = mergeScopedNetwork(delegate.activeNetworkList, scopedNetworkSupplier())
        SoftApTrace.stage(
            "webrtc_network_inventory",
            "count" to merged.size,
            "interfaces" to merged.joinToString(",") { it.name },
        )
        return merged
    }

    override fun destroy() {
        delegate.destroy()
    }

    companion object {

        /**
         * Append the scoped interface unless the delegate already reported it.
         *
         * Pure so the merge — the part that actually decides whether ICE can see the hotspot — is
         * unit testable without a device or a live PeerConnectionFactory.
         */
        @JvmStatic
        fun mergeScopedNetwork(
            detected: List<NetworkChangeDetector.NetworkInformation>?,
            scoped: ScopedInterface?,
        ): List<NetworkChangeDetector.NetworkInformation> {
            val result = detected?.toMutableList() ?: mutableListOf()
            if (scoped == null) return result
            if (result.any { it.name == scoped.name }) return result

            val information = toNetworkInformation(scoped) ?: return result
            result.add(information)
            return result
        }

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

            val addresses =
                runCatching { NetworkInterface.getByName(interfaceName) }
                    .getOrNull()
                    ?.inetAddresses
                    ?.toList()
                    ?.filterIsInstance<Inet4Address>()
                    ?.map { it.address }
                    ?: emptyList()

            if (addresses.isEmpty()) return null
            return ScopedInterface(interfaceName, network.networkHandle, addresses)
        }
    }
}
