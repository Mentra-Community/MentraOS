package com.mentra.bluetoothsdk.sgcs

import android.util.Base64
import com.mentra.bluetoothsdk.BluetoothSdkDefaults
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.utils.ConnTypes
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
 * Dev-only SGC driver that proxies to the mentra-agent harness daemon on the
 * dev laptop, which holds REAL glasses over BLE (tools/mentra-agent/ble). This
 * lets the app run in an Android emulator (no Bluetooth radio) while text,
 * brightness, and mic flow to/from physical hardware on the developer's desk.
 *
 * Transport is a plain TCP socket (the module has no HTTP/WS client dep)
 * speaking newline-delimited JSON: commands out ({cmd:"text", text:...}),
 * events in ({event:"hello"|"status"|"battery"|"gesture"|"imu"} and
 * {event:"audio", b64:<LC3>} carrying the real glasses microphone, which is
 * fed into the normal glasses-mic pipeline).
 *
 * Default host 10.0.2.2 (emulator loopback to host machine), port 8802.
 */
class RemoteHarness : SGCManager() {

    private val host: String =
        (DeviceStore.get("bluetooth", "remote_harness_host") as? String)?.takeIf { it.isNotEmpty() }
            ?: "10.0.2.2"
    private val port: Int =
        (DeviceStore.get("bluetooth", "remote_harness_port") as? Int) ?: 8802

    @Volatile private var socket: Socket? = null
    @Volatile private var writer: OutputStreamWriter? = null
    private val alive = AtomicBoolean(true)
    @Volatile private var remoteDevice: String = ""
    @Volatile private var remoteConnected = false

    /**
     * Outbound queue drained by a dedicated writer thread. Callers (often the
     * MAIN thread — e.g. the glasses-mic watchdog) must never touch the socket
     * directly: Android throws NetworkOnMainThreadException (message: null),
     * which once masqueraded as a dead socket and churned the connection.
     */
    private val outbox = LinkedBlockingQueue<String>()

    init {
        type = DeviceTypes.REMOTE_HARNESS
        hasMic = true // the daemon streams the real glasses mic to us
        DeviceStore.apply("glasses", "fullyBooted", false)
        DeviceStore.apply("glasses", "connected", false)
        DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTING)
        DeviceStore.apply("glasses", "micEnabled", false)
        DeviceStore.apply(
            "glasses",
            "voiceActivityDetectionEnabled",
            BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED
        )
        Thread({ runLoop() }, "RemoteHarnessIO").apply { isDaemon = true }.start()
        Thread({ writeLoop() }, "RemoteHarnessTX").apply { isDaemon = true }.start()
    }

    /** Drain the outbox onto the live socket; never runs on a caller's thread. */
    private fun writeLoop() {
        while (alive.get()) {
            val line = try { outbox.take() } catch (_: InterruptedException) { return }
            val w = writer
            if (w == null) {
                Bridge.log("REMOTE: drop queued cmd (no socket)")
                continue
            }
            try {
                w.write(line)
                w.write("\n")
                w.flush()
                Bridge.log("REMOTE: tx ${line.take(60)}")
            } catch (e: Exception) {
                Bridge.log("REMOTE: tx failed (${e.javaClass.simpleName}: ${e.message}); closing socket")
                try { socket?.close() } catch (_: Exception) {}
            }
        }
    }

    // ---------- socket loop ----------

    private fun runLoop() {
        while (alive.get()) {
            try {
                Bridge.log("REMOTE: connecting to harness daemon $host:$port ...")
                val s = Socket()
                s.tcpNoDelay = true
                s.connect(InetSocketAddress(host, port), 4000)
                socket = s
                writer = OutputStreamWriter(s.getOutputStream(), Charsets.UTF_8)
                val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
                Bridge.log("REMOTE: socket up; awaiting hello")
                var line: String?
                while (alive.get()) {
                    line = reader.readLine() ?: break
                    if (line.isBlank()) continue
                    try {
                        handleEvent(JSONObject(line))
                    } catch (e: Exception) {
                        Bridge.log("REMOTE: bad line: ${e.message}")
                    }
                }
            } catch (e: Exception) {
                Bridge.log("REMOTE: socket error: ${e.message}")
            }
            markDisconnected()
            if (!alive.get()) return
            try {
                Thread.sleep(3000)
            } catch (_: InterruptedException) {
                return
            }
        }
    }

    private fun handleEvent(o: JSONObject) {
        when (o.optString("event")) {
            "hello", "status" -> {
                remoteConnected = o.optBoolean("connected", false)
                remoteDevice = o.optString("device", o.optString("match", ""))
                if (remoteConnected) {
                    Bridge.log("REMOTE: daemon holds real glasses (${remoteDevice}); marking connected")
                    // Report the UNDERLYING device family as the model so hardware
                    // capabilities resolve to the real hardware's profile (an
                    // unknown model falls back to NONE, which silently gates
                    // display/camera/mic for every miniapp).
                    val model = when (remoteDevice) {
                        "g2" -> DeviceTypes.G2
                        "g1" -> DeviceTypes.G1
                        "live" -> DeviceTypes.LIVE
                        else -> type
                    }
                    DeviceStore.apply("glasses", "deviceModel", model)
                    DeviceStore.apply("glasses", "fullyBooted", true)
                    DeviceStore.apply("glasses", "connected", true)
                    DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTED)
                } else {
                    // Daemon reachable but no glasses on it yet: stay "connecting" so the
                    // pairing UI keeps spinning rather than claiming a dead link works.
                    Bridge.log("REMOTE: daemon up, no glasses held yet")
                    DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTING)
                }
            }
            "battery" -> {
                val level = o.optInt("level", -1)
                if (level >= 0) {
                    DeviceStore.apply("glasses", "batteryLevel", level)
                    DeviceStore.apply("glasses", "charging", o.optBoolean("charging", false))
                    Bridge.sendBatteryStatus(level, o.optBoolean("charging", false))
                }
            }
            "gesture" -> {
                Bridge.sendTouchEvent(type, o.optString("gesture", "tap"), System.currentTimeMillis(), 0)
            }
            "imu" -> {
                // Daemon relays the glasses IMU (Live: 9-axis arrays; G2: x/y/z accel).
                fun arr(name: String, fallback: DoubleArray): DoubleArray {
                    val a = o.optJSONArray(name) ?: return fallback
                    return DoubleArray(a.length()) { a.optDouble(it, 0.0) }
                }
                val zero3 = DoubleArray(3)
                val accel = if (o.has("accel")) arr("accel", zero3)
                            else doubleArrayOf(o.optDouble("x", 0.0), o.optDouble("y", 0.0), o.optDouble("z", 0.0))
                Bridge.sendImuDataEvent(
                    accel,
                    arr("gyro", zero3),
                    arr("mag", zero3),
                    arr("quat", DoubleArray(4)),
                    arr("euler", zero3),
                    System.currentTimeMillis()
                )
            }
            "audio" -> {
                val b64 = o.optString("b64", "")
                if (b64.isNotEmpty() && micEnabled) {
                    try {
                        val lc3 = Base64.decode(b64, Base64.DEFAULT)
                        // Real glasses LC3 (40-byte frames; G2 bundles ~5 per chunk).
                        DeviceManager.getInstance().handleGlassesMicData(lc3, 40)
                    } catch (e: Exception) {
                        Bridge.log("REMOTE: audio decode failed: ${e.message}")
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
            DeviceStore.apply("glasses", "connected", false)
            DeviceStore.apply("glasses", "fullyBooted", false)
            DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTING)
        }
    }

    private fun send(cmd: String, fill: (JSONObject) -> Unit = {}) {
        // Enqueue only — actual socket I/O happens on the writer thread, so this
        // is safe to call from any thread (including main).
        try {
            val o = JSONObject()
            o.put("cmd", cmd)
            fill(o)
            outbox.offer(o.toString())
        } catch (e: Exception) {
            Bridge.log("REMOTE: send '$cmd' failed to build: ${e.message}")
        }
    }

    // ---------- Audio ----------

    override fun setMicEnabled(enabled: Boolean) {
        DeviceStore.apply("glasses", "micEnabled", enabled)
        send("mic") { it.put("enable", enabled) }
    }

    override suspend fun setImuEnabled(enabled: Boolean) {
        send("imuEnable") { it.put("enable", enabled) }
    }

    override fun sortMicRanking(list: MutableList<String>): MutableList<String> = list

    // ---------- Camera & media (forwarded; meaningful when the daemon holds a Live) ----------

    override fun requestPhoto(
            requestId: String,
            appId: String,
            size: String,
            webhookUrl: String?,
            authToken: String?,
            compress: String?,
            flash: Boolean,
            save: Boolean,
            sound: Boolean,
            exposureTimeNs: Long?,
            iso: Int?,
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
        Bridge.log("REMOTE: startStream not proxied (use the daemon's stream API)")
    }

    override fun stopStream() {}

    override fun sendStreamKeepAlive(message: MutableMap<String, Any>) {}

    override fun startVideoRecording(requestId: String, save: Boolean, flash: Boolean, sound: Boolean) {
        Bridge.log("REMOTE: startVideoRecording not supported")
    }

    override fun stopVideoRecording(requestId: String) {}

    // ---------- Button settings (no-ops; harness owns the hardware) ----------

    override fun sendButtonPhotoSettings() {}
    override fun sendButtonVideoRecordingSettings() {}
    override fun sendButtonMaxRecordingTime() {}
    override fun sendButtonCameraLedSetting() {}
    override fun sendCameraFovSetting() {}

    // ---------- Display ----------

    override fun setBrightness(level: Int, autoMode: Boolean) {
        // App levels are 0-100; the daemon takes 0-255.
        send("brightness") {
            it.put("level", (level.coerceIn(0, 100) * 255) / 100)
            it.put("auto", autoMode)
        }
    }

    override fun clearDisplay() {
        send("clear")
    }

    override fun sendTextWall(text: String) {
        send("text") { it.put("text", text) }
    }

    override fun sendDoubleTextWall(top: String, bottom: String) {
        send("text") { it.put("text", "$top\n\n$bottom") }
    }

    override fun displayBitmap(
            base64ImageData: String,
            x: Int?,
            y: Int?,
            width: Int?,
            height: Int?
    ): Boolean {
        Bridge.log("REMOTE: displayBitmap not supported in v1")
        return false
    }

    override fun showDashboard() {}

    override fun setDashboardPosition(height: Int, depth: Int) {}

    // ---------- Device control ----------

    override fun setHeadUpAngle(angle: Int) {
        send("headup") { it.put("angle", angle) }
    }

    override fun getBatteryStatus() {
        send("battery")
    }

    override fun setSilentMode(enabled: Boolean) {}

    override fun exit() {
        send("clear")
    }

    override fun sendShutdown() {
        Bridge.log("REMOTE: sendShutdown not proxied")
    }

    override fun sendReboot() {
        Bridge.log("REMOTE: sendReboot not proxied")
    }

    override fun sendRgbLedControl(
            requestId: String,
            packageName: String?,
            action: String,
            color: String?,
            onDurationMs: Int,
            offDurationMs: Int,
            count: Int
    ) {
        Bridge.sendRgbLedControlResponse(requestId, false, "device_not_supported")
    }

    // ---------- Connection management ----------

    override fun disconnect() {
        Bridge.log("REMOTE: disconnect")
        alive.set(false)
        try { socket?.close() } catch (_: Exception) {}
        DeviceStore.apply("glasses", "connected", false)
        DeviceStore.apply("glasses", "fullyBooted", false)
        DeviceStore.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
    }

    override fun forget() {
        disconnect()
    }

    override fun findCompatibleDevices() {
        // The daemon owns scanning; report ourselves so the pairing UI can proceed.
        Bridge.sendDiscoveredDevice(type, type)
    }

    override fun stopScan() {}

    override fun connectById(id: String) {
        // Connection is implicit (socket to the daemon); nothing per-id to do.
    }

    override fun getConnectedBluetoothName(): String =
        if (remoteConnected) "harness:$remoteDevice" else ""

    override fun cleanup() {
        disconnect()
    }

    override fun ping() {
        send("ping")
    }

    override fun dbg1() {}
    override fun dbg2() {}

    // ---------- Network management (not proxied) ----------

    override fun requestWifiScan() {}
    override fun sendWifiCredentials(ssid: String, password: String) {}
    override fun forgetWifiNetwork(ssid: String) {}
    override fun sendHotspotState(enabled: Boolean) {}
    override fun sendUserEmailToGlasses(email: String) {}
    override fun sendIncidentId(incidentId: String, apiBaseUrl: String?) {}

    // ---------- Gallery / version ----------

    override fun queryGalleryStatus() {}
    override fun sendGalleryMode() {}

    override fun requestVersionInfo() {
        send("battery") // battery reply refreshes level; version comes via daemon status
    }
}
