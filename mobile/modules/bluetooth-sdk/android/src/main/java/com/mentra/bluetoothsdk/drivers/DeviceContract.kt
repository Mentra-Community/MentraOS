package com.mentra.bluetoothsdk.drivers

/**
 * Public device-driver contract (Android). See docs/device-driver-contract.md.
 *
 * A driver author implements [GlassesDriver]; the app injects a [DeviceHost]
 * the driver calls back through (instead of touching Bridge/DeviceStore/
 * DeviceManager directly). [GlassesDriverSgcAdapter] bridges a GlassesDriver
 * onto the existing internal SGCManager so the rest of the app is unchanged.
 *
 * This is the first, pragmatic cut: inbound command signatures intentionally
 * mirror SGCManager's so the adapter is a 1:1 forward. The cleaner typed
 * surface (PhotoRequest, etc.) in the doc is a later refinement.
 */

enum class ConnectionState { CONNECTING, CONNECTED, DISCONNECTED }

enum class DisplayKind { NONE, MONOCHROME, GRAYSCALE, COLOR }

data class DisplayGeometry(val widthPx: Int, val heightPx: Int)

/** What a device can do. Gates which GlassesDriver methods are called and the
 *  app's miniapp feature-gating. Replaces the bare `hasMic` + hardcoded map. */
data class DeviceCapabilities(
    val hasDisplay: Boolean = false,
    val displayKind: DisplayKind = DisplayKind.NONE,
    val displayGeometry: DisplayGeometry? = null,
    val hasMic: Boolean = false,
    val hasCamera: Boolean = false,
    val hasSpeaker: Boolean = false,
    val hasImu: Boolean = false,
    val hasWifi: Boolean = false,
    val buttons: List<String> = emptyList(),
    val hasTouchpad: Boolean = false,
)

/** Identity the driver reports once it knows what it's connected to. */
data class DeviceInfo(
    val model: String,
    val serial: String? = null,
    val firmware: String? = null,
    val color: String? = null,
    val style: String? = null,
)

/**
 * The narrow façade the driver calls back through. Every method maps to a real
 * call RemoteHarness made into Bridge/DeviceStore/DeviceManager (see the
 * mapping table in docs/device-driver-contract.md §6). Implemented by
 * [DeviceHostImpl]; safe to call from any thread.
 */
interface DeviceHost {
    /** Reset glasses state to a fresh "connecting" device (called once on start). */
    fun reset()

    fun reportConnectionState(state: ConnectionState)
    fun reportReady(ready: Boolean)
    fun reportDeviceInfo(info: DeviceInfo)

    fun emitBattery(level: Int, charging: Boolean)

    fun emitMicAudio(lc3: ByteArray, frameSize: Int)
    fun reportMicEnabled(on: Boolean)

    fun emitTouchEvent(gesture: String)
    fun emitImu(
        accel: DoubleArray,
        gyro: DoubleArray,
        mag: DoubleArray,
        quat: DoubleArray,
        euler: DoubleArray,
    )

    fun reportCommandResult(requestId: String, ok: Boolean, error: String?)
    fun reportDiscoveredDevice(id: String, name: String)

    fun log(msg: String)
}

/**
 * The public interface an OEM (or a built-in / dev driver) implements. Inbound
 * commands only; events go out through [DeviceHost]. Optional groups have
 * default no-ops so a driver implements only what its capabilities advertise.
 */
interface GlassesDriver {
    /** Stable type string for this driver (e.g. DeviceTypes.REMOTE_HARNESS). */
    val deviceType: String
    val capabilities: DeviceCapabilities

    /** Called once after construction: keep the host, do initial setup, begin connecting. */
    fun start(host: DeviceHost)

    // ---- lifecycle ----
    fun connectById(id: String) {}
    fun disconnect()
    fun cleanup()
    fun ping() {}
    fun getConnectedName(): String? = null
    fun findCompatibleDevices() {}
    fun stopScan() {}
    fun requestVersionInfo() {}

    // ---- display (only if capabilities.hasDisplay) ----
    fun setBrightness(level: Int, autoMode: Boolean) {}
    fun clearDisplay() {}
    fun sendTextWall(text: String) {}
    fun sendDoubleTextWall(top: String, bottom: String) {}
    fun displayBitmap(base64ImageData: String, x: Int?, y: Int?, width: Int?, height: Int?): Boolean = false
    fun showDashboard() {}
    fun setDashboardPosition(height: Int, depth: Int) {}

    // ---- audio (only if capabilities.hasMic) ----
    fun setMicEnabled(enabled: Boolean) {}
    fun sortMicRanking(list: MutableList<String>): MutableList<String> = list

    // ---- camera / media (only if capabilities.hasCamera) ----
    fun requestPhoto(
        requestId: String, appId: String, size: String, webhookUrl: String?, authToken: String?,
        compress: String?, flash: Boolean, save: Boolean, sound: Boolean, exposureTimeNs: Long?, iso: Int?,
    ) {}
    fun startStream(message: MutableMap<String, Any>) {}
    fun stopStream() {}
    fun sendStreamKeepAlive(message: MutableMap<String, Any>) {}
    fun startVideoRecording(requestId: String, save: Boolean, flash: Boolean, sound: Boolean) {}
    fun stopVideoRecording(requestId: String) {}

    // ---- sensors / control ----
    suspend fun setImuEnabled(enabled: Boolean) {}
    fun setHeadUpAngle(angle: Int) {}
    fun getBatteryStatus() {}
    fun setSilentMode(enabled: Boolean) {}
    fun sendShutdown() {}
    fun sendReboot() {}
    fun sendRgbLedControl(
        requestId: String, packageName: String?, action: String, color: String?,
        onDurationMs: Int, offDurationMs: Int, count: Int,
    ) {}

    // ---- network (only if capabilities.hasWifi) ----
    fun requestWifiScan() {}
    fun sendWifiCredentials(ssid: String, password: String) {}
    fun forgetWifiNetwork(ssid: String) {}
    fun sendHotspotState(enabled: Boolean) {}
}
