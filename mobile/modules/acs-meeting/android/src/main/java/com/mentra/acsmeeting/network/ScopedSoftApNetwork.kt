package com.mentra.acsmeeting.network

import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkRequest
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

    private var callback: ConnectivityManager.NetworkCallback? = null
    private var network: Network? = null
    private var localIpv4: String? = null
    private var spec: ScopedNetworkRequestSpec? = null
    private var listener: Listener? = null

    /** The joined network, or null. Pass this to anything that must send over the SoftAP link. */
    fun network(): Network? = synchronized(lock) { network }

    /** This phone's address on the hotspot subnet, e.g. `192.168.43.20`. */
    fun localIpv4(): String? = synchronized(lock) { localIpv4 }

    fun isAvailable(): Boolean = synchronized(lock) { state.phase == ScopedNetworkState.Phase.AVAILABLE }

    /**
     * Whether the local-network permission is granted. Below the SDK level that enforces it, access
     * is implicit and this reports true.
     */
    fun hasLocalNetworkPermission(): Boolean {
        if (Build.VERSION.SDK_INT < LOCAL_NETWORK_ENFORCED_SDK) return true
        return context.checkSelfPermission(ScopedNetworkError.LOCAL_NETWORK_PERMISSION) ==
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

        release()

        val requestSpec = ScopedNetworkRequestSpec.forSoftAp(ssid, passphrase)
        val manager = connectivityManager()
        val ready = CountDownLatch(1)

        val generation: Int
        synchronized(lock) {
            generation = state.startRequest()
            spec = requestSpec
            this.listener = listener
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
                    val resolvedIpv4 = firstIpv4(manager.getLinkProperties(available))
                    val notify: Listener?
                    synchronized(lock) {
                        if (!state.onAvailable(generation)) return
                        network = available
                        localIpv4 = resolvedIpv4
                        notify = this@ScopedSoftApNetwork.listener
                    }
                    SoftApTrace.stage(
                        "scoped_network_available",
                        "ssid" to ssid,
                        "localIpv4" to resolvedIpv4,
                        "joinMs" to (System.currentTimeMillis() - startedAtMs),
                        "defaultNetworkIsCellular" to defaultNetworkIsCellular(manager),
                    )
                    ready.countDown()
                    if (resolvedIpv4 != null) notify?.onAvailable(available, resolvedIpv4)
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

        synchronized(lock) {
            val joined = network
            if (state.phase == ScopedNetworkState.Phase.AVAILABLE && joined != null) {
                val address = localIpv4
                if (address == null) {
                    releaseLocked()
                    throw ScopedNetworkError.NoLocalAddress(ssid)
                }
                return joined
            }
            val failure =
                ScopedNetworkError.from(state.failure, ssid, requestSpec.timeoutMs)
                    ?: ScopedNetworkError.Timeout(ssid, requestSpec.timeoutMs)
            releaseLocked()
            throw failure
        }
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
        return capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)
    }

    companion object {
        /** Android 17. `ACCESS_LOCAL_NETWORK` is enforced for apps targeting SDK 37+. */
        const val LOCAL_NETWORK_ENFORCED_SDK = 37

        private const val AWAIT_GRACE_MS = 2_000L
    }
}
