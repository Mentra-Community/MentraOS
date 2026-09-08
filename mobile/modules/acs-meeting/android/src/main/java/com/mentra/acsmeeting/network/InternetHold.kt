package com.mentra.acsmeeting.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.SystemClock
import com.mentra.acsmeeting.trace.SoftApTrace
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Keeps the phone's internet on cellular across the hotspot join, and says so honestly.
 *
 * Joining the glasses' SoftAP takes the phone off office Wi-Fi. Cellular becomes the default route,
 * and on device it was not yet validated when that happened: `scoped_network_available` at 18:04:57
 * was followed by a 30 s gap before ACS even began its native join, then a 40 s step timeout, with
 * device-wide DNS and TLS deadline failures throughout. ACS needs the internet during that window,
 * so the transition has to be deliberate rather than hoped for.
 *
 * ## What a request does and does not buy
 *
 * `requestNetwork(CELLULAR + INTERNET)` asks Android to bring cellular up and keeps it up while the
 * request is held. It does **not** guarantee the network is validated, and it does not switch the
 * default route on any particular schedule. So this class does two separate things, and neither is
 * inferred from the other:
 *
 *  - [awaitValidatedCellular] holds the request and waits for `NET_CAPABILITY_VALIDATED` on the
 *    cellular network itself. Run *before* leaving Wi-Fi, so a phone with no working cellular fails
 *    with a reason instead of stranding ACS on a hotspot with no internet.
 *  - [awaitValidatedDefault] asks what the app's actual default network is now, and whether it is
 *    validated. Run *after* the hotspot join, because that is when the default can change.
 *
 * Bounded, released on every exit, and idempotent: teardown calls [release] without checking.
 */
class InternetHold(private val context: Context) {

    /** The app's default network as the framework currently reports it. */
    data class DefaultNetwork(val transport: String, val validated: Boolean, val present: Boolean) {
        /** Whether ACS can be expected to reach the internet over this. */
        val usable: Boolean
            get() = present && validated

        override fun toString(): String =
            if (!present) "none" else "$transport${if (validated) " (validated)" else " (unvalidated)"}"
    }

    /** Outcome of holding cellular up. [validated] is the only field worth branching on. */
    data class CellularHold(val held: Boolean, val validated: Boolean, val waitedMs: Long)

    private val lock = Any()
    private var callback: ConnectivityManager.NetworkCallback? = null

    /**
     * Request cellular and wait until it validates, bounded by [timeoutMs].
     *
     * The request stays held afterwards — including when validation times out — so that a caller
     * which chooses to continue anyway does not also lose the radio. [release] is the only thing
     * that drops it.
     */
    fun awaitValidatedCellular(timeoutMs: Long = CELLULAR_WAIT_MS): CellularHold {
        val manager = connectivityManager() ?: return CellularHold(false, false, 0)
        val validated = CountDownLatch(1)
        val startedAt = SystemClock.elapsedRealtime()

        val watcher =
            object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(
                    network: Network,
                    capabilities: NetworkCapabilities,
                ) {
                    // Validation is a capability change, not an availability one: `onAvailable`
                    // fires for a cellular network that cannot yet carry a TLS handshake.
                    if (isValidatedInternet(capabilities)) validated.countDown()
                }
            }

        val request =
            NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()

        val held =
            runCatching {
                synchronized(lock) {
                    releaseLocked()
                    manager.requestNetwork(request, watcher)
                    callback = watcher
                }
            }.isSuccess
        if (!held) {
            SoftApTrace.failure("cellular_validated", "held" to false, "reason" to "requestNetwork threw")
            return CellularHold(false, false, 0)
        }

        val ok = validated.await(timeoutMs, TimeUnit.MILLISECONDS)
        val waitedMs = SystemClock.elapsedRealtime() - startedAt
        // A network that was already validated before the request may never produce a callback we
        // see, so the current state is the tiebreak rather than the latch alone.
        val resolved = ok || cellularIsValidated(manager)
        SoftApTrace.stage(
            "cellular_validated",
            "held" to true,
            "validated" to resolved,
            "viaCallback" to ok,
            "waitedMs" to waitedMs,
        )
        return CellularHold(true, resolved, waitedMs)
    }

    /**
     * Poll the app's default network until it is validated, bounded by [timeoutMs].
     *
     * Polled rather than awaited: what matters is which network *this app's* unbound sockets use,
     * and that is `activeNetwork`, which has no per-app change callback.
     */
    fun awaitValidatedDefault(timeoutMs: Long = DEFAULT_WAIT_MS): DefaultNetwork {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        var current = defaultNetwork()
        while (!current.usable && SystemClock.elapsedRealtime() < deadline) {
            Thread.sleep(DEFAULT_POLL_MS)
            current = defaultNetwork()
        }
        val fields = arrayOf(
            "transport" to current.transport,
            "validated" to current.validated,
            "present" to current.present,
        )
        // Error level when unusable so it survives a level filter: this is the line that explains an
        // ACS join failing on a hotspot that was itself fine.
        if (current.usable) {
            SoftApTrace.stage("default_network_after_join", *fields)
        } else {
            SoftApTrace.failure("default_network_after_join", *fields)
        }
        return current
    }

    /** The app's default network right now, without waiting. */
    fun defaultNetwork(): DefaultNetwork {
        val manager = connectivityManager() ?: return DefaultNetwork("unknown", false, false)
        val active = manager.activeNetwork ?: return DefaultNetwork("none", false, false)
        val capabilities =
            manager.getNetworkCapabilities(active)
                ?: return DefaultNetwork("unknown", false, true)
        return DefaultNetwork(
            transportName(capabilities),
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
            true,
        )
    }

    /** Drop the cellular request. Safe to call when nothing is held, and safe to call twice. */
    fun release() {
        synchronized(lock) { releaseLocked() }
    }

    private fun releaseLocked() {
        val active = callback ?: return
        runCatching { connectivityManager()?.unregisterNetworkCallback(active) }
        callback = null
        SoftApTrace.stage("cellular_hold_released")
    }

    private fun cellularIsValidated(manager: ConnectivityManager): Boolean =
        manager.allNetworks.any { network ->
            val capabilities = manager.getNetworkCapabilities(network) ?: return@any false
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) &&
                isValidatedInternet(capabilities)
        }

    private fun connectivityManager(): ConnectivityManager? =
        context.applicationContext.getSystemService(ConnectivityManager::class.java)

    companion object {
        /** Generous: failing here aborts a call the wearer asked for, on a phone that may be indoors. */
        const val CELLULAR_WAIT_MS = 15_000L

        /** Short: the default route normally settles in well under a second after the scoped join. */
        const val DEFAULT_WAIT_MS = 8_000L

        private const val DEFAULT_POLL_MS = 200L

        fun isValidatedInternet(capabilities: NetworkCapabilities): Boolean =
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

        /** For the trace only. Nothing routes by this name. */
        fun transportName(capabilities: NetworkCapabilities): String =
            transportNameOf(
                cellular = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
                wifi = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                vpn = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN),
                ethernet = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
            )

        /**
         * VPN first: when a tunnel owns the app's UID it is the transport that decides whether ACS
         * reaches the internet, and it stacks on top of the others rather than replacing them.
         */
        fun transportNameOf(
            cellular: Boolean,
            wifi: Boolean,
            vpn: Boolean,
            ethernet: Boolean,
        ): String =
            when {
                vpn -> "vpn"
                cellular -> "cellular"
                wifi -> "wifi"
                ethernet -> "ethernet"
                else -> "other"
            }
    }
}
