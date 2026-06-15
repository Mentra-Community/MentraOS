package com.mentra.bluetoothsdk.drivers

import android.util.Base64
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.utils.DeviceTypes
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/**
 * Dev-only [GlassesDriver] that proxies to the mentra-agent harness daemon on
 * the dev laptop, which holds REAL glasses over BLE (tools/mentra-agent/ble).
 * This is the first driver ported onto the public contract — behavior is
 * identical to the legacy `sgcs/RemoteHarness`, but it talks through
 * [DeviceHost] instead of Bridge/DeviceStore/DeviceManager directly.
 *
 * Transport: a plain TCP socket speaking newline-delimited JSON (the dev/sim
 * "MDBP" wire format). Default daemon host 10.0.2.2 (emulator loopback), 8802.
 *
 * NOTE: still reads two CONFIG values (host/port) from DeviceStore; that's a
 * read, not a callback, and the callback decoupling (events out) is what the
 * contract is proving here.
 */
class RemoteHarnessDriver : GlassesDriver {

    override val deviceType: String = DeviceTypes.REMOTE_HARNESS

    // Permissive caps: the daemon may hold any family. Only hasMic is consumed
    // by the adapter today; the rest become real gating in a later migration step.
    override val capabilities = DeviceCapabilities(
        hasDisplay = true, hasMic = true, hasCamera = true, hasImu = true,
    )

    private lateinit var host: DeviceHost

    private val daemonHost: String =
        (DeviceStore.get("bluetooth", "remote_harness_host") as? String)?.takeIf { it.isNotEmpty() }
            ?: "10.0.2.2"
    private val daemonPort: Int =
        (DeviceStore.get("bluetooth", "remote_harness_port") as? Int) ?: 8802

    @Volatile private var socket: Socket? = null
    @Volatile private var writer: OutputStreamWriter? = null
    private val alive = AtomicBoolean(true)
    @Volatile private var remoteDevice: String = ""
    @Volatile private var remoteConnected = false
    @Volatile private var micEnabled = false

    private val outbox = LinkedBlockingQueue<String>()

    override fun start(host: DeviceHost) {
        this.host = host
        Thread({ runLoop() }, "RemoteHarnessIO").apply { isDaemon = true }.start()
        Thread({ writeLoop() }, "RemoteHarnessTX").apply { isDaemon = true }.start()
    }

    private fun writeLoop() {
        while (alive.get()) {
            val line = try { outbox.take() } catch (_: InterruptedException) { return }
            val w = writer
            if (w == null) {
                host.log("REMOTE: drop queued cmd (no socket)")
                continue
            }
            try {
                w.write(line); w.write("\n"); w.flush()
                host.log("REMOTE: tx ${line.take(60)}")
            } catch (e: Exception) {
                host.log("REMOTE: tx failed (${e.javaClass.simpleName}: ${e.message}); closing socket")
                try { socket?.close() } catch (_: Exception) {}
            }
        }
    }

    private fun runLoop() {
        while (alive.get()) {
            try {
                host.log("REMOTE: connecting to harness daemon $daemonHost:$daemonPort ...")
                val s = Socket()
                s.tcpNoDelay = true
                s.connect(InetSocketAddress(daemonHost, daemonPort), 4000)
                // Daemon pings every 3s; if nothing for 10s the socket is dead/hung.
                s.soTimeout = 10000
                socket = s
                writer = OutputStreamWriter(s.getOutputStream(), Charsets.UTF_8)
                val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
                host.log("REMOTE: socket up; awaiting hello")
                var line: String?
                while (alive.get()) {
                    line = reader.readLine() ?: break
                    if (line.isBlank()) continue
                    try {
                        handleEvent(JSONObject(line))
                    } catch (e: Exception) {
                        host.log("REMOTE: bad line: ${e.message}")
                    }
                }
            } catch (e: Exception) {
                host.log("REMOTE: socket error: ${e.message}")
            }
            markDisconnected()
            if (!alive.get()) return
            try { Thread.sleep(3000) } catch (_: InterruptedException) { return }
        }
    }

    private fun handleEvent(o: JSONObject) {
        when (o.optString("event")) {
            "hello", "status" -> {
                remoteConnected = o.optBoolean("connected", false)
                remoteDevice = o.optString("device", o.optString("match", ""))
                if (remoteConnected) {
                    host.log("REMOTE: daemon holds real glasses ($remoteDevice); marking connected")
                    val model = when (remoteDevice) {
                        "g2" -> DeviceTypes.G2
                        "g1" -> DeviceTypes.G1
                        "live" -> DeviceTypes.LIVE
                        else -> deviceType
                    }
                    host.reportDeviceInfo(DeviceInfo(model = model))
                    host.reportReady(true)
                    host.reportConnectionState(ConnectionState.CONNECTED)
                } else {
                    host.log("REMOTE: daemon up, no glasses held yet")
                    host.reportConnectionState(ConnectionState.CONNECTING)
                }
            }
            "battery" -> {
                val level = o.optInt("level", -1)
                if (level >= 0) host.emitBattery(level, o.optBoolean("charging", false))
            }
            "gesture" -> host.emitTouchEvent(o.optString("gesture", "tap"))
            "imu" -> {
                fun arr(name: String, fallback: DoubleArray): DoubleArray {
                    val a = o.optJSONArray(name) ?: return fallback
                    return DoubleArray(a.length()) { a.optDouble(it, 0.0) }
                }
                val zero3 = DoubleArray(3)
                val accel = if (o.has("accel")) arr("accel", zero3)
                    else doubleArrayOf(o.optDouble("x", 0.0), o.optDouble("y", 0.0), o.optDouble("z", 0.0))
                host.emitImu(accel, arr("gyro", zero3), arr("mag", zero3), arr("quat", DoubleArray(4)), arr("euler", zero3))
            }
            "audio" -> {
                val b64 = o.optString("b64", "")
                if (b64.isNotEmpty() && micEnabled) {
                    try {
                        val lc3 = Base64.decode(b64, Base64.DEFAULT)
                        host.emitMicAudio(lc3, 40)
                    } catch (e: Exception) {
                        host.log("REMOTE: audio decode failed: ${e.message}")
                    }
                }
            }
        }
    }

    private fun markDisconnected() {
        socket = null
        writer = null
        if (remoteConnected) {
            remoteConnected = false
            host.reportConnectionState(ConnectionState.CONNECTING)
            host.reportReady(false)
        }
    }

    private fun send(cmd: String, fill: (JSONObject) -> Unit = {}) {
        try {
            val o = JSONObject()
            o.put("cmd", cmd)
            fill(o)
            outbox.offer(o.toString())
        } catch (e: Exception) {
            host.log("REMOTE: send '$cmd' failed to build: ${e.message}")
        }
    }

    // ---- audio ----
    override fun setMicEnabled(enabled: Boolean) {
        micEnabled = enabled
        host.reportMicEnabled(enabled)
        send("mic") { it.put("enable", enabled) }
    }

    override suspend fun setImuEnabled(enabled: Boolean) {
        send("imuEnable") { it.put("enable", enabled) }
    }

    // ---- camera / media ----
    override fun requestPhoto(
        requestId: String, appId: String, size: String, webhookUrl: String?, authToken: String?,
        compress: String?, flash: Boolean, save: Boolean, sound: Boolean, exposureTimeNs: Long?, iso: Int?,
    ) {
        send("photo") {
            val opts = JSONObject()
            opts.put("requestId", requestId)
            opts.put("appId", appId)
            opts.put("size", size)
            if (webhookUrl != null) opts.put("webhookUrl", webhookUrl)
            if (authToken != null) opts.put("authToken", authToken)
            opts.put("transferMethod", if (webhookUrl != null) "wifi" else "ble")
            opts.put("save", save)
            it.put("opts", opts)
        }
    }

    override fun startStream(message: MutableMap<String, Any>) {
        host.log("REMOTE: startStream not proxied (use the daemon's stream API)")
    }

    // ---- display ----
    override fun setBrightness(level: Int, autoMode: Boolean) {
        send("brightness") {
            it.put("level", (level.coerceIn(0, 100) * 255) / 100)
            it.put("auto", autoMode)
        }
    }

    override fun clearDisplay() = send("clear")
    override fun sendTextWall(text: String) = send("text") { it.put("text", text) }
    override fun sendDoubleTextWall(top: String, bottom: String) = send("text") { it.put("text", "$top\n\n$bottom") }

    override fun displayBitmap(base64ImageData: String, x: Int?, y: Int?, width: Int?, height: Int?): Boolean {
        host.log("REMOTE: displayBitmap not supported in v1")
        return false
    }

    // ---- device control ----
    override fun setHeadUpAngle(angle: Int) = send("headup") { it.put("angle", angle) }
    override fun getBatteryStatus() = send("battery")

    override fun sendRgbLedControl(
        requestId: String, packageName: String?, action: String, color: String?,
        onDurationMs: Int, offDurationMs: Int, count: Int,
    ) {
        host.reportCommandResult(requestId, false, "device_not_supported")
    }

    // ---- connection management ----
    override fun disconnect() {
        host.log("REMOTE: disconnect")
        alive.set(false)
        try { socket?.close() } catch (_: Exception) {}
        host.reportConnectionState(ConnectionState.DISCONNECTED)
        host.reportReady(false)
    }

    override fun cleanup() = disconnect()
    override fun ping() = send("ping")

    override fun getConnectedName(): String? = if (remoteConnected) "harness:$remoteDevice" else null

    override fun findCompatibleDevices() {
        // The daemon owns scanning; report ourselves so the pairing UI can proceed.
        host.reportDiscoveredDevice(deviceType, deviceType)
    }

    override fun requestVersionInfo() = send("battery")
}
