package com.mentra.bluetoothsdk.hotspot

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Looper
import android.os.SystemClock
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * The phone's join of the glasses' Wi-Fi Direct group, the second link of the glasses Wi-Fi service.
 *
 * Bluetooth asks the glasses for a group (`wifi_direct_start`); they create it as group owner and
 * answer with its name and passphrase. The phone joins with [WifiP2pConfig.Builder], which goes
 * straight to the WPA2 join: no discovery, no WPS and no dialog on either side. Android keeps the
 * group on its local network, so the phone's own Wi-Fi or cellular stays its internet, and there
 * is no [android.net.Network] for it: sockets reach the group's subnet without one.
 *
 * Blocking; runs on the joining thread. [release] ends a join in progress.
 */
internal class WifiDirectJoin(context: Context) {
    data class Joined(
        val ssid: String,
        val interfaceName: String,
        val localIpv4: String,
        val prefixLength: Int,
        val gateway: String,
    )

    private val context = context.applicationContext
    private val lock = Any()
    private var manager: WifiP2pManager? = null
    private var channel: WifiP2pManager.Channel? = null
    private var receiver: BroadcastReceiver? = null
    private var wake: CountDownLatch? = null
    private var joined: Joined? = null
    private var onLost: (() -> Unit)? = null
    private var releases = 0

    /** Whether the phone and the connected glasses can hold this link now, once the glasses have said what they support. */
    fun available(): Boolean = blocker() == null

    @Throws(ScopedNetworkError::class)
    fun join(onLost: () -> Unit): Joined {
        blocker()?.let { throw ScopedNetworkError.RequestFailed("wifi_direct_$it") }
        val releasesAtStart = synchronized(lock) { releases }
        val cancelled = { synchronized(lock) { releases != releasesAtStart } }

        // 1. Ask the glasses for a group, on the phone's own Wi-Fi channel when it has one.
        val status = arrayOfNulls<JSONObject>(1)
        val answered = latch()
        val answer = StartAnswer()
        GlassesWifiDirect.onStatus { json ->
            if (answer.answers(json.optString("state"), json.has("error"))) {
                status[0] = json
                answered.countDown()
            }
        }
        if (!GlassesWifiDirect.start(currentWifiFrequency())) {
            throw ScopedNetworkError.RequestFailed("wifi_direct_glasses_not_connected")
        }
        await(answered, GLASSES_ANSWER_TIMEOUT_MS, cancelled, "wifi_direct_glasses_no_answer")
        val group = status[0]!!
        if (group.optString("state") != "ready") {
            throw ScopedNetworkError.RequestFailed("wifi_direct_glasses_" + group.optString("error", group.optString("state")))
        }
        val ssid = group.optString("ssid")
        val passphrase = group.optString("passphrase")
        val gateway = group.optString("address")
        if (ssid.isEmpty() || passphrase.isEmpty() || gateway.isEmpty()) {
            throw ScopedNetworkError.RequestFailed("wifi_direct_glasses_sent_no_credentials")
        }

        // 2. Join it.
        var refused: Int? = null
        val formed = latch()
        val (m, c) = ensureChannel { info ->
            if (info.groupFormed && !info.isGroupOwner && info.groupOwnerAddress?.hostAddress == gateway) formed.countDown()
        }
        val config =
            WifiP2pConfig.Builder()
                .setNetworkName(ssid)
                .setPassphrase(passphrase)
                .enablePersistentMode(false)
                .apply { group.optInt("frequency", 0).takeIf { it > 0 }?.let(::setGroupOperatingFrequency) }
                .build()
        SoftApTrace.stage("wifi_direct_join_requested", "ssid" to ssid)
        try {
            m.connect(
                c,
                config,
                object : WifiP2pManager.ActionListener {
                    override fun onSuccess() = Unit

                    override fun onFailure(reason: Int) {
                        refused = reason
                        formed.countDown()
                    }
                },
            )
        } catch (error: SecurityException) {
            throw ScopedNetworkError.PermissionDenied(nearbyPermission())
        }
        await(formed, JOIN_TIMEOUT_MS, cancelled, "wifi_direct_join_timeout")
        refused?.let { throw ScopedNetworkError.RequestFailed("wifi_direct_connect_refused_$it") }

        // 3. The phone's address on the group's interface.
        val deadline = SystemClock.elapsedRealtime() + ADDRESS_WAIT_MS
        var local: Pair<NetworkInterface, java.net.InterfaceAddress>? = null
        while (local == null && SystemClock.elapsedRealtime() < deadline && !cancelled()) {
            local = p2pAddress(gateway)
            if (local == null) Thread.sleep(150)
        }
        if (cancelled()) throw ScopedNetworkError.Cancelled(ssid)
        val (iface, address) = local ?: throw ScopedNetworkError.NoLocalAddress(ssid)
        val result =
            Joined(ssid, iface.name, address.address.hostAddress!!, address.networkPrefixLength.toInt(), gateway)
        synchronized(lock) {
            joined = result
            this.onLost = onLost
        }
        // From now on, the group going away on either side is a loss.
        GlassesWifiDirect.onStatus { json -> if (json.optString("state") in setOf("stopped", "error")) lost() }
        SoftApTrace.stage("wifi_direct_joined", "ssid" to ssid, "localIpv4" to result.localIpv4, "interface" to iface.name)
        return result
    }

    /** Leave the group and tell the glasses to remove it. Ends a join in progress. */
    fun release() {
        val hadLink: Boolean
        synchronized(lock) {
            releases++
            wake?.countDown()
            hadLink = joined != null || wake != null
            joined = null
            onLost = null
        }
        GlassesWifiDirect.onStatus(null)
        leaveGroup()
        if (hadLink) GlassesWifiDirect.stop()
    }

    private fun lost() {
        val notify = synchronized(lock) {
            if (joined == null) return
            joined = null
            onLost.also { onLost = null }
        }
        SoftApTrace.failure("wifi_direct_lost")
        notify?.invoke()
    }

    private fun latch(): CountDownLatch = CountDownLatch(1).also { synchronized(lock) { wake = it } }

    private fun await(latch: CountDownLatch, timeoutMs: Long, cancelled: () -> Boolean, timeoutReason: String) {
        val done = latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        synchronized(lock) { if (wake === latch) wake = null }
        if (cancelled()) throw ScopedNetworkError.Cancelled("the Wi-Fi Direct group")
        if (!done) throw ScopedNetworkError.RequestFailed(timeoutReason)
    }

    /** Why the phone can't use Wi-Fi Direct with these glasses now, or null. */
    private fun blocker(): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "android_too_old"
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)) return "unsupported"
        val wifi = context.getSystemService(WifiManager::class.java)
        if (wifi == null || !wifi.isWifiEnabled) return "wifi_off"
        if (context.checkSelfPermission(nearbyPermission()) != PackageManager.PERMISSION_GRANTED) return "permission"
        if (GlassesWifiDirect.awaitVersion(CAPABILITY_WAIT_MS) < 1) return "glasses_unsupported"
        return null
    }

    private fun nearbyPermission(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.NEARBY_WIFI_DEVICES
        } else {
            Manifest.permission.ACCESS_FINE_LOCATION
        }

    @Suppress("DEPRECATION")
    private fun currentWifiFrequency(): Int =
        runCatching { context.getSystemService(WifiManager::class.java)?.connectionInfo?.frequency ?: 0 }
            .getOrDefault(0)
            .coerceAtLeast(0)

    /** The interface address on the group's subnet, beside the group owner's [gateway]. */
    private fun p2pAddress(gateway: String): Pair<NetworkInterface, java.net.InterfaceAddress>? {
        for (iface in NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()) {
            if (!iface.name.startsWith("p2p") || !iface.isUp) continue
            for (address in iface.interfaceAddresses) {
                val mine = (address.address as? Inet4Address)?.hostAddress ?: continue
                if (Ipv4Prefix(mine, address.networkPrefixLength.toInt()).contains(gateway)) return iface to address
            }
        }
        return null
    }

    @Suppress("DEPRECATION")
    private fun ensureChannel(onInfo: (android.net.wifi.p2p.WifiP2pInfo) -> Unit): Pair<WifiP2pManager, WifiP2pManager.Channel> {
        val m = manager ?: (context.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager)
            ?: throw ScopedNetworkError.RequestFailed("wifi_direct_unsupported")
        val c = channel ?: m.initialize(context, Looper.getMainLooper()) {
            channel = null
            lost()
        } ?: throw ScopedNetworkError.RequestFailed("wifi_direct_unsupported")
        manager = m
        channel = c
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        val r =
            object : BroadcastReceiver() {
                override fun onReceive(ctx: Context, intent: Intent) {
                    // The broadcast's extras vary by Android version and vendor: ask for the connection.
                    runCatching {
                        m.requestConnectionInfo(c) { info ->
                            if (info == null) return@requestConnectionInfo
                            onInfo(info)
                            if (!info.groupFormed) lost()
                        }
                    }
                }
            }
        val filter = IntentFilter(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(r, filter)
        }
        receiver = r
        return m to c
    }

    private fun leaveGroup() {
        val m = manager ?: return
        val c = channel ?: return
        runCatching {
            m.cancelConnect(c, null)
            m.removeGroup(c, null)
        }
    }

    /**
     * Which `wifi_direct_status` answers the `wifi_direct_start` just sent. The glasses report every
     * change, so the `stopped` of the group a release just asked them to remove can reach the phone
     * after the next start went out: the glasses then go on to report this start `starting` and
     * `ready`. A `stopped` answers the start only once the glasses reported it `starting`, or when it
     * carries an error, like the one sent when the glasses disconnect.
     */
    internal class StartAnswer {
        private var started = false

        @Synchronized
        fun answers(state: String, hasError: Boolean): Boolean =
            when (state) {
                "starting" -> {
                    started = true
                    false
                }
                "ready", "error" -> true
                "stopped" -> started || hasError
                else -> false
            }
    }

    private companion object {
        const val GLASSES_ANSWER_TIMEOUT_MS = 20_000L
        const val JOIN_TIMEOUT_MS = 20_000L
        const val ADDRESS_WAIT_MS = 5_000L
        /** The glasses answer `request_version` within a few seconds of connecting. */
        const val CAPABILITY_WAIT_MS = 10_000L
    }
}
