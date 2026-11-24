package com.mentra.bluetoothsdk.sgcs

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pInfo
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import com.mentra.bluetoothsdk.utils.NativeLog as Log
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.URL
import org.json.JSONObject

/**
 * The phone's side of the Wi-Fi Direct link to Mentra Live, used to fetch photos fast.
 *
 * Bluetooth is the control channel. [open] asks the glasses for a group (`wifi_direct_start`);
 * they create it as group owner and answer `wifi_direct_status` with its name and passphrase. The
 * phone joins with [WifiP2pConfig.Builder], which goes straight to the WPA2 join: no peer
 * discovery, no WPS, and no "Invitation to connect" dialog on either side. Android keeps the group
 * on its local network, so the phone's own Wi-Fi or cellular stays its internet.
 *
 * Photos then arrive as `fast_photo_ready` with a URL on the link, fetched by [fetchPhoto]. When
 * there is no group but the phone is on the glasses hotspot for something else (gallery sync,
 * Mentra Call, an update), photos use that instead ([hotspotNetwork]). Everything else goes over Bluetooth.
 */
class WifiDirectLink(
    context: Context,
    private val sendToGlasses: (JSONObject) -> Boolean,
    private val onStatus: (Map<String, Any>) -> Unit,
) {
    companion object {
        private const val TAG = "WifiDirectLink"
        private const val GLASSES_ANSWER_TIMEOUT_MS = 20_000L
        private const val JOIN_TIMEOUT_MS = 20_000L
        private const val FETCH_CONNECT_TIMEOUT_MS = 3_000
        private const val FETCH_READ_TIMEOUT_MS = 5_000

        const val STATE_CLOSED = "closed"
        const val STATE_OPENING = "opening"
        const val STATE_OPEN = "open"
        const val STATE_UNAVAILABLE = "unavailable"
    }

    private val context = context.applicationContext
    private val handler = Handler(Looper.getMainLooper())
    private val lock = Any()

    private var manager: WifiP2pManager? = null
    private var channel: WifiP2pManager.Channel? = null
    private var receiver: BroadcastReceiver? = null

    private var state = STATE_CLOSED
    private var reason: String? = null
    private var wanted = false
    private var joining = false
    private var openingStartedMs = 0L
    private var openedAfterMs = 0L
    private var frequencyMhz = 0
    /** The group owner's address the glasses reported; Mentra Live uses 192.168.43.1. */
    private var ownerAddress: String? = null

    /**
     * The glasses' `wifi_direct_version` from `version_info`: 0 when they can't hold a group (older
     * ASG), so the link is unavailable at once instead of waiting for an answer that never comes.
     */
    @Volatile var glassesVersion: Int = 0
        set(value) {
            if (field == value) return
            field = value
            // Tell listeners whether these glasses can hold a group.
            handler.post { synchronized(lock) { publishLocked() } }
        }

    private val answerTimeout = Runnable { fail("glasses_no_answer") }
    private val joinTimeout = Runnable { fail("join_timeout") }

    /** `closed`, `opening`, `open` or `unavailable`, with the reason for the last two. */
    fun status(): Map<String, Any> = synchronized(lock) { statusLocked() }

    fun isOpen(): Boolean = synchronized(lock) { state == STATE_OPEN }

    /**
     * Opens the link, or reports the one already open or opening. The result arrives through
     * `onStatus`; nothing here waits.
     */
    fun open() {
        handler.post { openOnMain() }
    }

    /** Leaves the group and tells the glasses to remove it. */
    fun close(reason: String = "closed") {
        handler.post { closeOnMain(reason, tellGlasses = true) }
    }

    /** The Bluetooth link to the glasses is gone, so is the group's owner. */
    fun onGlassesDisconnected() {
        handler.post { closeOnMain("glasses_disconnected", tellGlasses = false) }
    }

    /** A `wifi_direct_status` message from the glasses. */
    fun onGlassesStatus(json: JSONObject) {
        handler.post { onGlassesStatusOnMain(json) }
    }

    private fun openOnMain() {
        synchronized(lock) {
            if (state == STATE_OPEN || state == STATE_OPENING) {
                publishLocked()
                return
            }
        }
        val blocker = blocker()
        if (blocker != null) {
            setState(STATE_UNAVAILABLE, blocker)
            return
        }
        synchronized(lock) {
            wanted = true
            joining = false
            openingStartedMs = SystemClock.elapsedRealtime()
        }
        setState(STATE_OPENING, null)
        // Sharing the phone's own Wi-Fi channel keeps both links at full speed on one radio.
        frequencyMhz = currentWifiFrequency()
        val sent =
            sendToGlasses(
                JSONObject().put("type", "wifi_direct_start").apply {
                    if (frequencyMhz > 0) put("frequency", frequencyMhz)
                },
            )
        if (!sent) {
            fail("glasses_not_connected")
            return
        }
        handler.removeCallbacks(answerTimeout)
        handler.postDelayed(answerTimeout, GLASSES_ANSWER_TIMEOUT_MS)
    }

    private fun onGlassesStatusOnMain(json: JSONObject) {
        val glassesState = json.optString("state")
        val active = synchronized(lock) { wanted }
        if (!active) {
            if (glassesState == "ready" || glassesState == "starting") {
                // A group nobody here asked for (an earlier session): let the glasses drop it.
                sendToGlasses(JSONObject().put("type", "wifi_direct_stop"))
            }
            return
        }
        when (glassesState) {
            "starting" -> Unit
            "ready" -> {
                handler.removeCallbacks(answerTimeout)
                val alreadyJoining = synchronized(lock) { joining || state == STATE_OPEN }
                synchronized(lock) { ownerAddress = json.optString("address").ifEmpty { null } }
                if (!alreadyJoining) {
                    join(
                        json.optString("ssid"),
                        json.optString("passphrase"),
                        json.optInt("frequency", 0),
                    )
                }
            }
            "stopped" -> closeOnMain("glasses_stopped", tellGlasses = false)
            "error" -> fail("glasses_" + json.optString("error", "error"))
        }
    }

    private fun join(ssid: String, passphrase: String, groupFrequencyMhz: Int) {
        if (ssid.isEmpty() || passphrase.isEmpty()) {
            fail("glasses_sent_no_credentials")
            return
        }
        if (!ensureChannel()) {
            fail("p2p_unavailable")
            return
        }
        synchronized(lock) { joining = true }
        val config =
            WifiP2pConfig.Builder()
                .setNetworkName(ssid)
                .setPassphrase(passphrase)
                .enablePersistentMode(false)
                .apply { if (groupFrequencyMhz > 0) setGroupOperatingFrequency(groupFrequencyMhz) }
                .build()
        Log.i(TAG, "Joining Wi-Fi Direct group $ssid on $groupFrequencyMhz MHz")
        handler.removeCallbacks(joinTimeout)
        handler.postDelayed(joinTimeout, JOIN_TIMEOUT_MS)
        try {
            manager!!.connect(
                channel,
                config,
                object : WifiP2pManager.ActionListener {
                    override fun onSuccess() {
                        Log.i(TAG, "P2P connect accepted; waiting for the group")
                    }

                    override fun onFailure(reason: Int) {
                        fail("join_failed_" + reasonName(reason))
                    }
                },
            )
        } catch (e: SecurityException) {
            fail("permission")
        }
    }

    private fun onConnectionChanged(info: WifiP2pInfo?) {
        val formed = info != null && info.groupFormed && !info.isGroupOwner
        val groupOwner = info?.groupOwnerAddress?.hostAddress
        synchronized(lock) {
            if (!wanted) return
            val ours = ownerAddress == null || groupOwner == ownerAddress
            if (formed && ours && state != STATE_OPEN) {
                handler.removeCallbacks(joinTimeout)
                openedAfterMs = SystemClock.elapsedRealtime() - openingStartedMs
                joining = false
                state = STATE_OPEN
                reason = null
                Log.i(TAG, "Wi-Fi Direct open after ${openedAfterMs} ms")
                publishLocked()
            } else if (!formed && state == STATE_OPEN) {
                state = STATE_OPENING
                reason = "link_lost"
                joining = false
                publishLocked()
                // Ask the glasses again: they answer with the group, and we rejoin it.
                openingStartedMs = SystemClock.elapsedRealtime()
                sendToGlasses(JSONObject().put("type", "wifi_direct_start"))
                handler.removeCallbacks(answerTimeout)
                handler.postDelayed(answerTimeout, GLASSES_ANSWER_TIMEOUT_MS)
            }
        }
    }

    private fun fail(why: String) {
        Log.w(TAG, "Wi-Fi Direct unavailable: $why")
        handler.removeCallbacks(answerTimeout)
        handler.removeCallbacks(joinTimeout)
        leaveGroup()
        sendToGlasses(JSONObject().put("type", "wifi_direct_stop"))
        synchronized(lock) {
            wanted = false
            joining = false
        }
        setState(STATE_UNAVAILABLE, why)
    }

    private fun closeOnMain(why: String, tellGlasses: Boolean) {
        handler.removeCallbacks(answerTimeout)
        handler.removeCallbacks(joinTimeout)
        val wasActive =
            synchronized(lock) {
                val active = wanted || state != STATE_CLOSED
                wanted = false
                joining = false
                active
            }
        if (!wasActive) return
        leaveGroup()
        if (tellGlasses) sendToGlasses(JSONObject().put("type", "wifi_direct_stop"))
        setState(STATE_CLOSED, why)
    }

    private fun leaveGroup() {
        val m = manager ?: return
        val c = channel ?: return
        try {
            m.cancelConnect(c, null)
            m.removeGroup(c, null)
        } catch (e: RuntimeException) {
            Log.w(TAG, "Could not leave the group: ${e.message}")
        }
    }

    /** Why the phone can't use Wi-Fi Direct right now, or null. */
    private fun blocker(): String? {
        if (glassesVersion < 1) return "glasses_unsupported"
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "android_too_old"
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)) return "unsupported"
        val wifi = context.getSystemService(WifiManager::class.java)
        if (wifi == null || !wifi.isWifiEnabled) return "wifi_off"
        val permission =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                Manifest.permission.NEARBY_WIFI_DEVICES
            } else {
                Manifest.permission.ACCESS_FINE_LOCATION
            }
        if (ContextCompat.checkSelfPermission(context, permission) != PackageManager.PERMISSION_GRANTED) {
            return "permission"
        }
        return null
    }

    @Suppress("DEPRECATION")
    private fun currentWifiFrequency(): Int =
        try {
            context.getSystemService(WifiManager::class.java)?.connectionInfo?.frequency?.takeIf { it > 0 } ?: 0
        } catch (e: RuntimeException) {
            0
        }

    @Suppress("DEPRECATION")
    private fun ensureChannel(): Boolean {
        if (manager != null && channel != null) return true
        val m = context.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager ?: return false
        val c =
            m.initialize(context, Looper.getMainLooper()) {
                Log.w(TAG, "Wi-Fi P2P channel lost")
                channel = null
                manager = null
                if (synchronized(lock) { wanted }) fail("channel_lost")
            } ?: return false
        manager = m
        channel = c
        if (receiver == null) {
            val r =
                object : BroadcastReceiver() {
                    override fun onReceive(ctx: Context, intent: Intent) {
                        if (intent.action != WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION) return
                        // The broadcast's extras vary by Android version and vendor: ask for the
                        // connection itself.
                        requestConnectionInfo()
                    }
                }
            val filter = IntentFilter(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                context.registerReceiver(r, filter)
            }
            receiver = r
        }
        return true
    }

    private fun requestConnectionInfo() {
        val m = manager ?: return
        val c = channel ?: return
        try {
            m.requestConnectionInfo(c) { info -> onConnectionChanged(info) }
        } catch (e: SecurityException) {
            Log.w(TAG, "requestConnectionInfo not permitted: ${e.message}")
        }
    }

    private fun setState(next: String, why: String?) {
        synchronized(lock) {
            state = next
            reason = why
            publishLocked()
        }
    }

    private fun publishLocked() {
        val status = statusLocked()
        Log.i(TAG, "Fast link: $status")
        onStatus(status)
    }

    private fun statusLocked(): Map<String, Any> =
        buildMap {
            put("state", state)
            put("link", "wifi_direct")
            put("glassesSupported", glassesVersion >= 1)
            reason?.let { put("reason", it) }
            if (state == STATE_OPEN) put("openedAfterMs", openedAfterMs)
        }

    /** A photo fetched over a fast link, with how long the fetch took. */
    class FetchedPhoto(val bytes: ByteArray, val fetchMs: Long)

    /**
     * Fetches a photo the glasses announced with `fast_photo_ready` and confirms it. Blocks: call it
     * off the main thread.
     *
     * @throws Exception when the link can't deliver it; the caller then asks for Bluetooth
     */
    fun fetchPhoto(url: String, ackUrl: String, link: String): FetchedPhoto {
        val started = SystemClock.elapsedRealtime()
        val bytes = request(url, "GET", link)
        val fetchMs = SystemClock.elapsedRealtime() - started
        try {
            request(ackUrl, "POST", link)
        } catch (e: Exception) {
            // The photo is here; the glasses fall back to Bluetooth only if the ack is lost, and the
            // duplicate is dropped as an unknown transfer.
            Log.w(TAG, "Fast photo ack failed: ${e.message}")
        }
        return FetchedPhoto(bytes, fetchMs)
    }

    private fun request(url: String, method: String, link: String): ByteArray {
        val target = URL(url)
        val connection =
            if (link == "hotspot") {
                val network = hotspotNetwork(target.host)
                    ?: throw IllegalStateException("The phone is not on the glasses hotspot")
                network.openConnection(target)
            } else {
                // The P2P subnet is a directly connected local network: any app socket reaches it.
                target.openConnection()
            } as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = FETCH_CONNECT_TIMEOUT_MS
            connection.readTimeout = FETCH_READ_TIMEOUT_MS
            connection.useCaches = false
            if (method == "POST") {
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(0)
            }
            val code = connection.responseCode
            if (code != 200) throw IllegalStateException("HTTP $code from $link")
            val expected = connection.contentLength
            connection.inputStream.use { input ->
                val out = ByteArrayOutputStream(if (expected > 0) expected else 64 * 1024)
                input.copyTo(out, 64 * 1024)
                val bytes = out.toByteArray()
                if (expected >= 0 && bytes.size != expected) {
                    throw IllegalStateException("Got ${bytes.size} of $expected bytes from $link")
                }
                return bytes
            }
        } finally {
            connection.disconnect()
        }
    }

    /**
     * The phone's Wi-Fi network whose subnet holds the glasses' hotspot address, however the phone
     * joined it (a scoped request from gallery sync or Mentra Call, a process-bound join, or by
     * hand), or null when the phone is not on the glasses hotspot.
     */
    @Suppress("DEPRECATION")
    fun hotspotNetwork(gatewayIp: String?): Network? {
        val gateway = gatewayIp?.takeIf { it.isNotEmpty() }?.let { parseIpv4(it) } ?: return null
        val connectivity = context.getSystemService(ConnectivityManager::class.java) ?: return null
        return connectivity.allNetworks.firstOrNull { network ->
            val capabilities = connectivity.getNetworkCapabilities(network)
            if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) != true) return@firstOrNull false
            connectivity.getLinkProperties(network)?.linkAddresses?.any { link ->
                val local = (link.address as? Inet4Address)?.address ?: return@any false
                sameSubnet(local, gateway, link.prefixLength)
            } == true
        }
    }

    private fun parseIpv4(text: String): ByteArray? =
        try {
            (InetAddress.getByName(text) as? Inet4Address)?.address
        } catch (e: Exception) {
            null
        }

    private fun sameSubnet(a: ByteArray, b: ByteArray, prefixLength: Int): Boolean {
        val bits = prefixLength.coerceIn(0, 32)
        for (i in 0 until 4) {
            val maskBits = (bits - i * 8).coerceIn(0, 8)
            val mask = (0xFF shl (8 - maskBits)) and 0xFF
            if ((a[i].toInt() and mask) != (b[i].toInt() and mask)) return false
        }
        return true
    }

    private fun reasonName(reason: Int): String =
        when (reason) {
            WifiP2pManager.ERROR -> "error"
            WifiP2pManager.P2P_UNSUPPORTED -> "unsupported"
            WifiP2pManager.BUSY -> "busy"
            else -> reason.toString()
        }
}
