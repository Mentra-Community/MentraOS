package com.mentra.acsmeeting.network

import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import com.mentra.acsmeeting.trace.SoftApTrace
import java.net.Inet4Address
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Joins the glasses' SoftAP as a scoped, internet-less network and keeps the [Network] handle
 * in-process.
 *
 * ## Why this is not reused from the Bluetooth SDK
 *
 * `MentraLocalNetworkModule` in `bluetooth-sdk` already holds a scoped `Network` for the same
 * hotspot, but it only exposes `HttpURLConnection`. A `Network` object cannot cross the JS bridge,
 * and `acs-meeting` has no Gradle edge onto `bluetooth-sdk` — adding one would couple this module to
 * the *published public* SDK and force an internal registry to be exported from it.
 *
 * Owning the join here instead puts the `Network` handle in the same module and lifecycle as the
 * `PeerConnectionFactory`, which is precisely what the libwebrtc interface-agreement problem needs:
 * the ingest source has to bind its sockets to the same network object this class produced. The
 * duplication with the Bluetooth SDK is deliberate.
 *
 * ## Dual-homing
 *
 * The request drops `NET_CAPABILITY_INTERNET` (see [ScopedNetworkRequestSpec]), so Android never
 * promotes the hotspot to the default network and ACS keeps using cellular.
 */
class ScopedSoftApNetwork(private val context: Context) {

    /** Notified on the ConnectivityManager callback thread. */
    interface Listener {
        fun onAvailable(network: Network, localIpv4: String)

        fun onLost(error: ScopedNetworkError)
    }

    private val lock = Any()
    private val state = ScopedNetworkState()
    private val readiness = ScopedNetworkReadiness()

    private var callback: ConnectivityManager.NetworkCallback? = null
    private var network: Network? = null
    private var localIpv4: String? = null
    private var spec: ScopedNetworkRequestSpec? = null
    private var listener: Listener? = null

    /** The joined network, or null. Pass this to anything that must send over the SoftAP link. */
    fun network(): Network? = synchronized(lock) { network }

    /** This phone's address on the hotspot subnet, e.g. `192.168.43.20`. */
    fun localIpv4(): String? = synchronized(lock) { localIpv4 }

    /**
     * The subnet this phone joined, straight from `LinkProperties`.
     *
     * This is the invariant every SoftAP media check is written against: the selected ICE candidate
     * has to be on *this* prefix, not merely on some private range. Reading the prefix length rather
     * than assuming /24 is what keeps the check true when an OEM hands out a different hotspot
     * subnet.
     */
    fun scopedPrefix(): Ipv4Prefix? {
        val net = network() ?: return null
        val properties = connectivityManager().getLinkProperties(net) ?: return null
        return properties.linkAddresses
            .firstOrNull { it.address is Inet4Address }
            ?.let { link -> link.address.hostAddress?.let { Ipv4Prefix(it, link.prefixLength) } }
    }

    fun isAvailable(): Boolean = synchronized(lock) { state.phase == ScopedNetworkState.Phase.AVAILABLE }

    /** Station radio on? `WifiNetworkSpecifier` is a no-op while this is false. */
    fun isWifiEnabled(): Boolean {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        return wifi?.isWifiEnabled == true
    }

    /**
     * Block until the station radio is on, or [timeoutMs] elapses. Used after the system Wi-Fi
     * panel is shown: the join must wait for the user, not abort and remint ACS over a broken
     * default route.
     */
    fun awaitWifiEnabled(timeoutMs: Long = WIFI_ENABLE_WAIT_MS): Boolean {
        if (isWifiEnabled()) return true
        val deadline = android.os.SystemClock.elapsedRealtime() + timeoutMs
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            Thread.sleep(WIFI_ENABLE_POLL_MS)
            if (isWifiEnabled()) return true
        }
        return isWifiEnabled()
    }

    /**
     * True when a VPN is this app's default network — i.e. our UID falls inside its captured
     * ranges. A VPN that excludes us (split tunneling) or is simply installed does not count: the
     * default network is then cellular/Wi-Fi and the hotspot path works.
     */
    fun isVpnCapturingApp(): Boolean {
        val manager = connectivityManager()
        val active = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(active) ?: return false
        return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
    }

    /** Verdict of [probeGateway]: [detail] is one human-readable line for the UI and the trace. */
    data class GatewayProbe(val reachable: Boolean, val detail: String)

    /**
     * The hotspot's own address on the joined network — the DHCP server, since the glasses
     * deliberately advertise no default route. Falls back to `.1` of the phone's /24.
     */
    fun gatewayIpv4(): String? {
        val net = network() ?: return null
        val properties = connectivityManager().getLinkProperties(net)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            properties?.dhcpServerAddress?.hostAddress?.let { return it }
        }
        val local = localIpv4() ?: return null
        val prefix = local.substringBeforeLast('.', "")
        return if (prefix.isEmpty()) null else "$prefix.1"
    }

    /**
     * Prove the phone can reach the glasses over the network it just joined.
     *
     * TCP, through [Network.getSocketFactory], so the kernel routes via the hotspot's table rather
     * than the cellular default that unbound sockets would take. A *refused* connection is a pass:
     * the SYN arrived and the RST came back, which is the reachability question. Only a timeout or
     * an unreachable-network error is a fail.
     */
    fun probeGateway(timeoutMs: Int = GATEWAY_PROBE_TIMEOUT_MS): GatewayProbe {
        val net = network() ?: return GatewayProbe(false, "no scoped network")
        val gateway = gatewayIpv4() ?: return GatewayProbe(false, "no gateway address on the scoped network")
        var lastFailure = "no ports tried"
        for (port in GATEWAY_PROBE_PORTS) {
            val startedAt = android.os.SystemClock.elapsedRealtime()
            val socket =
                try {
                    net.socketFactory.createSocket()
                } catch (error: java.io.IOException) {
                    // netd answers EPERM when a VPN owns our UID and forbids binding elsewhere.
                    val message = error.message ?: error.javaClass.simpleName
                    val detail =
                        if (message.contains("EPERM")) {
                            "cannot bind to the hotspot network ($message): a VPN is capturing this app"
                        } else {
                            "cannot bind to the hotspot network: $message"
                        }
                    SoftApTrace.failure("gateway_probe", "gateway" to gateway, "result" to detail)
                    return GatewayProbe(false, detail)
                }
            try {
                socket.connect(java.net.InetSocketAddress(gateway, port), timeoutMs)
                val elapsed = android.os.SystemClock.elapsedRealtime() - startedAt
                SoftApTrace.stage("gateway_probe", "gateway" to gateway, "port" to port, "result" to "connected", "ms" to elapsed)
                return GatewayProbe(true, "tcp $gateway:$port connected in ${elapsed}ms")
            } catch (error: java.net.ConnectException) {
                val elapsed = android.os.SystemClock.elapsedRealtime() - startedAt
                val message = error.message ?: ""
                if (message.contains("refused", ignoreCase = true)) {
                    SoftApTrace.stage("gateway_probe", "gateway" to gateway, "port" to port, "result" to "refused", "ms" to elapsed)
                    return GatewayProbe(true, "tcp $gateway:$port refused (host answered) in ${elapsed}ms")
                }
                lastFailure = "tcp $gateway:$port $message"
            } catch (error: java.net.SocketTimeoutException) {
                lastFailure = "tcp $gateway:$port timed out after ${timeoutMs}ms"
            } catch (error: java.io.IOException) {
                lastFailure = "tcp $gateway:$port ${error.message ?: error.javaClass.simpleName}"
            } finally {
                runCatching { socket.close() }
            }
        }
        SoftApTrace.failure("gateway_probe", "gateway" to gateway, "result" to lastFailure)
        return GatewayProbe(false, lastFailure)
    }

    /**
     * Whether the local-network permission is granted. Below the SDK level that enforces it, access
     * is implicit and this reports true.
     */
    fun hasLocalNetworkPermission(): Boolean =
        hasLocalNetworkPermission(Build.VERSION.SDK_INT, context.applicationInfo.targetSdkVersion) {
            context.checkSelfPermission(ScopedNetworkError.LOCAL_NETWORK_PERMISSION) ==
                PackageManager.PERMISSION_GRANTED
        }

    /**
     * Join [ssid] and block until it is usable or the request fails.
     *
     * @throws ScopedNetworkError on permission denial, timeout, or an unavailable network
     */
    @Throws(ScopedNetworkError::class)
    fun join(ssid: String, passphrase: String, listener: Listener? = null): Network {
        if (!hasLocalNetworkPermission()) {
            SoftApTrace.failure("scoped_join_permission_denied", "ssid" to ssid)
            throw ScopedNetworkError.PermissionDenied(ScopedNetworkError.LOCAL_NETWORK_PERMISSION)
        }

        // A disabled radio makes WifiNetworkSpecifier fail as Unavailable in under 10ms, which is
        // indistinguishable from a hotspot that never came up. Report the real cause instead.
        if (!isWifiEnabled()) {
            SoftApTrace.failure("scoped_join_wifi_disabled", "ssid" to ssid)
            throw ScopedNetworkError.WifiDisabled()
        }

        // The specifier join would succeed, but the glasses could never complete a TCP handshake
        // to our listener and we could not bind to the hotspot. Fail here, where the message can
        // say why, instead of ten seconds into the camera step.
        if (isVpnCapturingApp()) {
            SoftApTrace.failure("scoped_join_vpn_captures_app", "ssid" to ssid)
            throw ScopedNetworkError.VpnCapturesApp()
        }

        release()

        val requestSpec = ScopedNetworkRequestSpec.forSoftAp(ssid, passphrase)
        val manager = connectivityManager()
        val ready = CountDownLatch(1)

        val generation: Int
        synchronized(lock) {
            generation = state.startRequest()
            spec = requestSpec
            this.listener = listener
            readiness.reset()
        }
        SoftApTrace.stage(
            "scoped_join_requested",
            "ssid" to ssid,
            "timeoutMs" to requestSpec.timeoutMs,
            "avoidsInternetCapability" to requestSpec.avoidsInternetCapability,
        )
        val startedAtMs = System.currentTimeMillis()

        val networkCallback =
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(available: Network) {
                    val properties = manager.getLinkProperties(available)
                    val resolvedIpv4 = firstIpv4(properties)
                    synchronized(lock) {
                        if (!state.onAvailable(generation)) return
                        network = available
                        localIpv4 = resolvedIpv4
                        readiness.onAvailable()
                        readiness.seedLinkProperties(properties?.interfaceName, resolvedIpv4)
                    }
                    SoftApTrace.stage(
                        "scoped_network_available",
                        "ssid" to ssid,
                        "localIpv4" to resolvedIpv4,
                        "joinMs" to (System.currentTimeMillis() - startedAtMs),
                        "defaultNetworkIsCellular" to defaultNetworkIsCellular(manager),
                    )
                    // Does the address we were just handed exist in the kernel's interface table,
                    // and under the name LinkProperties claims? ICE gathers from that table, so a
                    // mismatch here is the difference between a hotspot candidate and none. The
                    // address can also land in the table *after* onAvailable, which is why this is
                    // only a snapshot for the trace and readiness is decided by polling below.
                    val table = NetworkFacts.snapshot()
                    SoftApTrace.stage(
                        "scoped_network_ifaddrs",
                        "localIpv4" to resolvedIpv4,
                        "claimed" to (properties?.interfaceName ?: "none"),
                        "owner" to (resolvedIpv4?.let { NetworkFacts.ownerOf(it, table) } ?: "ABSENT"),
                        "gatherable" to NetworkFacts.render(NetworkFacts.gatherable(table)),
                    )
                    if (readiness.callbacksSatisfied()) ready.countDown()
                }

                /**
                 * The callback Android says to read properties from. It also arrives again when
                 * DHCP completes, which is the case `onAvailable` alone missed.
                 */
                override fun onLinkPropertiesChanged(
                    changed: Network,
                    properties: LinkProperties,
                ) {
                    val address = firstIpv4(properties)
                    synchronized(lock) {
                        if (!state.accepts(generation)) return
                        // Sticky, unlike the readiness observation: the WHIP listener is bound to
                        // this address and mid-call disappearance is `onLost`'s business, so a
                        // transient property update must not blank the ingest URL.
                        if (address != null) localIpv4 = address
                        readiness.onLinkProperties(properties.interfaceName, address)
                    }
                    SoftApTrace.stage(
                        "scoped_link_properties",
                        "interface" to (properties.interfaceName ?: "none"),
                        "localIpv4" to (address ?: "none"),
                    )
                    if (readiness.callbacksSatisfied()) ready.countDown()
                }

                override fun onCapabilitiesChanged(
                    changed: Network,
                    capabilities: NetworkCapabilities,
                ) {
                    synchronized(lock) {
                        if (!state.accepts(generation)) return
                        readiness.onCapabilities()
                    }
                    if (readiness.callbacksSatisfied()) ready.countDown()
                }

                override fun onUnavailable() {
                    synchronized(lock) { if (!state.onUnavailable(generation)) return }
                    SoftApTrace.failure("scoped_network_unavailable", "ssid" to ssid)
                    ready.countDown()
                }

                override fun onLost(lost: Network) {
                    val notify: Listener?
                    synchronized(lock) {
                        if (!state.onLost(generation)) return
                        network = null
                        localIpv4 = null
                        notify = this@ScopedSoftApNetwork.listener
                    }
                    SoftApTrace.failure("scoped_network_lost", "ssid" to ssid)
                    ready.countDown()
                    notify?.onLost(ScopedNetworkError.Lost(ssid))
                }
            }

        synchronized(lock) { callback = networkCallback }

        try {
            manager.requestNetwork(request(requestSpec), networkCallback, requestSpec.timeoutMs)
        } catch (error: SecurityException) {
            synchronized(lock) { state.onRequestFailed(generation, permissionDenied = true) }
            clearCallback(networkCallback)
            SoftApTrace.failure("scoped_join_security_exception", "ssid" to ssid)
            throw ScopedNetworkError.PermissionDenied(ScopedNetworkError.LOCAL_NETWORK_PERMISSION)
        } catch (error: Exception) {
            synchronized(lock) { state.onRequestFailed(generation, permissionDenied = false) }
            clearCallback(networkCallback)
            SoftApTrace.failure("scoped_join_request_failed", "ssid" to ssid)
            throw ScopedNetworkError.RequestFailed(error.message ?: "unknown")
        }

        // requestNetwork's own timeout fires onUnavailable, but a slightly longer await guards
        // against never being called back at all.
        val awaited =
            ready.await(requestSpec.timeoutMs.toLong() + AWAIT_GRACE_MS, TimeUnit.MILLISECONDS)
        if (!awaited) synchronized(lock) { state.onTimeout(generation) }

        val joinedNetwork =
            synchronized(lock) {
                network.takeIf { state.phase == ScopedNetworkState.Phase.AVAILABLE }
            }
        if (joinedNetwork != null) {
            val verdict = awaitReadiness(ssid)
            val notify = synchronized(lock) { listener }
            notify?.onAvailable(joinedNetwork, verdict.address)
            probeUnmarkedUdpSend(verdict.address)
            return joinedNetwork
        }

        throw synchronized(lock) {
            val failure =
                ScopedNetworkError.from(state.failure, ssid, requestSpec.timeoutMs)
                    ?: ScopedNetworkError.Timeout(ssid, requestSpec.timeoutMs)
            releaseLocked()
            failure
        }
    }

    /**
     * Block until the joined network is ready for ICE, or fail with the source that never reported.
     *
     * The kernel interface table is the one input with no callback, so it is polled: the hotspot
     * address is regularly absent when `onAvailable` returns and appears a moment later. Starting
     * ingest before it exists produced an answer with zero candidates, which looked identical to a
     * binding bug and was misdiagnosed as one.
     */
    @Throws(ScopedNetworkError::class)
    private fun awaitReadiness(ssid: String): ScopedNetworkReadiness.Verdict.Ready {
        val deadline = android.os.SystemClock.elapsedRealtime() + READINESS_WAIT_MS
        var verdict: ScopedNetworkReadiness.Verdict
        while (true) {
            val address = readiness.observations.linkAddress
            readiness.onInterfaceTable(address?.let { NetworkFacts.ownerOf(it) })
            verdict = readiness.verdict()
            if (verdict is ScopedNetworkReadiness.Verdict.Ready) break
            if (android.os.SystemClock.elapsedRealtime() >= deadline) break
            Thread.sleep(READINESS_POLL_MS)
        }

        val observed = readiness.observations
        if (verdict is ScopedNetworkReadiness.Verdict.Ready) {
            SoftApTrace.stage(
                "scoped_network_ready",
                "localIpv4" to verdict.address,
                "claimed" to (verdict.interfaceName ?: "none"),
                "owner" to verdict.owner,
                "agrees" to (verdict.interfaceName == null || verdict.interfaceName == verdict.owner),
                "capabilitiesSeen" to observed.capabilities,
            )
            return verdict
        }

        val waiting = verdict as ScopedNetworkReadiness.Verdict.Waiting
        SoftApTrace.failure(
            "scoped_network_not_ready",
            "ssid" to ssid,
            "missing" to waiting.missing,
            "localIpv4" to (observed.linkAddress ?: "none"),
            "claimed" to (observed.linkInterface ?: "none"),
            "capabilitiesSeen" to observed.capabilities,
            "gatherable" to NetworkFacts.render(NetworkFacts.gatherable()),
        )
        release()
        throw ScopedNetworkError.NotReady(ssid, waiting.missing)
    }

    /**
     * Whether an unmarked UDP socket on the hotspot address can even be created and written to.
     *
     * Diagnostic only, and deliberately not a gate. A successful `send` means the OS accepted the
     * datagram; it says nothing about whether the glasses received it or can reply, so it cannot
     * establish that unmarked UDP works. What it *can* do is separate "bind refused outright" from
     * "bound fine, nothing came back", which is the FAILED_BINDING hypothesis. The real answer to
     * whether this path carries traffic is the ICE connectivity-check result.
     */
    private fun probeUnmarkedUdpSend(address: String) {
        val gateway = gatewayIpv4()
        val result =
            runCatching {
                java.net.DatagramSocket(0, java.net.InetAddress.getByName(address)).use { socket ->
                    val target = gateway ?: return@runCatching "bound to $address; no gateway to send to"
                    socket.send(
                        java.net.DatagramPacket(
                            ByteArray(1),
                            1,
                            java.net.InetAddress.getByName(target),
                            UDP_PROBE_PORT,
                        ),
                    )
                    "bound to ${socket.localAddress?.hostAddress}:${socket.localPort}, send accepted"
                }
            }
        SoftApTrace.stage(
            "unmarked_udp_send",
            "address" to address,
            "gateway" to (gateway ?: "none"),
            "accepted" to result.isSuccess,
            "detail" to
                (result.getOrNull() ?: result.exceptionOrNull()?.let { "${it.javaClass.simpleName}: ${it.message}" }),
            "proves" to "the OS accepted a datagram; not that the glasses received one",
        )
    }

    /** Unregister the callback and drop the network. Safe to call twice. */
    fun release() {
        synchronized(lock) { releaseLocked() }
    }

    private fun releaseLocked() {
        val active = callback
        if (active != null) {
            runCatching { connectivityManager().unregisterNetworkCallback(active) }
            SoftApTrace.stage("scoped_network_released")
        }
        callback = null
        network = null
        localIpv4 = null
        spec = null
        listener = null
        state.release()
        state.reset()
    }

    private fun clearCallback(expected: ConnectivityManager.NetworkCallback) {
        synchronized(lock) {
            if (callback !== expected) return
            runCatching { connectivityManager().unregisterNetworkCallback(expected) }
            callback = null
        }
    }

    private fun connectivityManager(): ConnectivityManager =
        requireNotNull(context.getSystemService(ConnectivityManager::class.java)) {
            "ConnectivityManager is unavailable"
        }



    /** Translate the pure spec into the framework request. */
    private fun request(spec: ScopedNetworkRequestSpec): NetworkRequest {
        val specifier =
            WifiNetworkSpecifier.Builder()
                .setSsid(spec.ssid)
                .apply { if (spec.hasPassphrase) setWpa2Passphrase(spec.passphrase) }
                .build()

        val builder = NetworkRequest.Builder()
        spec.transportTypes.forEach { builder.addTransportType(it) }
        spec.removedCapabilities.forEach { builder.removeCapability(it) }
        return builder.setNetworkSpecifier(specifier).build()
    }

    private fun firstIpv4(properties: LinkProperties?): String? =
        properties
            ?.linkAddresses
            ?.firstOrNull { it.address is Inet4Address }
            ?.address
            ?.hostAddress

    /** Dual-homing check: the default route must still be cellular after the scoped join. */
    private fun defaultNetworkIsCellular(manager: ConnectivityManager): Boolean {
        val active = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(active) ?: return false
        return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
    }

    companion object {
        /** Android 17. `ACCESS_LOCAL_NETWORK` is enforced for apps targeting SDK 37+. */
        const val LOCAL_NETWORK_ENFORCED_SDK = 37

        /** Legacy targets retain implicit LAN access, even when the runtime grant reports denied. */
        internal fun hasLocalNetworkPermission(
            sdkInt: Int,
            targetSdkInt: Int,
            permissionGranted: () -> Boolean,
        ): Boolean =
            sdkInt < LOCAL_NETWORK_ENFORCED_SDK ||
                targetSdkInt < LOCAL_NETWORK_ENFORCED_SDK ||
                permissionGranted()

        private const val AWAIT_GRACE_MS = 2_000L

        /** How long we hold the scoped-join step open for the user to flip the Wi-Fi toggle. */
        const val WIFI_ENABLE_WAIT_MS = 90_000L
        const val WIFI_ENABLE_POLL_MS = 300L
        /** Radio + scan need a beat after `isWifiEnabled` flips before specifier can see the AP. */
        const val WIFI_ENABLE_SETTLE_MS = 1_500L

        /**
         * After `WifiNetworkSpecifier` returns Unavailable while leaving another AP (office Wi-Fi
         * or a phone hotspot), Samsung has already dropped that network. A second specifier from
         * an idle STA is the join that succeeds; this is the gap before we issue it.
         */
        const val UNAVAILABLE_RETRY_SETTLE_MS = 2_000L

        /**
         * dnsmasq (DHCP/DNS) on the hotspot, then the glasses' local HTTP servers. Any answer —
         * accept or refuse — proves the path; only silence fails it.
         */
        private val GATEWAY_PROBE_PORTS = intArrayOf(53, 8089, 80)
        private const val GATEWAY_PROBE_TIMEOUT_MS = 2_000

        /**
         * How long the address is given to appear in the kernel table after the callbacks agree.
         * Generous because failing here aborts the call, and the observed lag is sub-second.
         */
        private const val READINESS_WAIT_MS = 5_000L
        private const val READINESS_POLL_MS = 150L

        /** dnsmasq on the hotspot. Nothing is expected back; only the send is being observed. */
        private const val UDP_PROBE_PORT = 53
    }
}
