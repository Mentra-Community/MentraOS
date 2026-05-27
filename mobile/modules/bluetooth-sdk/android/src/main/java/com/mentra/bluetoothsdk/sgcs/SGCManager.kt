package com.mentra.bluetoothsdk.sgcs

import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.utils.ConnTypes

abstract class SGCManager {
    // Hard coded device properties:
    @JvmField var type: String = ""
    @JvmField var hasMic: Boolean = false

    // Audio Control
    abstract fun setMicEnabled(enabled: Boolean)
    abstract fun sortMicRanking(list: MutableList<String>): MutableList<String>

    // Camera & Media
    abstract fun requestPhoto(
            requestId: String,
            appId: String,
            size: String,
            webhookUrl: String?,
            authToken: String?,
            compress: String?,
            flash: Boolean,
            sound: Boolean,
            exposureTimeNs: Long?,
    )
    abstract fun startStream(message: MutableMap<String, Any>)
    abstract fun stopStream()
    abstract fun sendStreamKeepAlive(message: MutableMap<String, Any>)
    abstract fun startVideoRecording(requestId: String, save: Boolean, flash: Boolean, sound: Boolean)
    abstract fun stopVideoRecording(requestId: String)

    // Button Settings
    abstract fun sendButtonPhotoSettings()
    abstract fun sendButtonVideoRecordingSettings()
    abstract fun sendButtonMaxRecordingTime()
    abstract fun sendButtonCameraLedSetting()
    abstract fun sendCameraFovSetting()

    // Display Control
    abstract fun setBrightness(level: Int, autoMode: Boolean)
    abstract fun clearDisplay()
    abstract fun sendTextWall(text: String)
    abstract fun sendDoubleTextWall(top: String, bottom: String)
    abstract fun displayBitmap(base64ImageData: String): Boolean
    abstract fun showDashboard()
    abstract fun setDashboardPosition(height: Int, depth: Int)

    /** Default: full [setDashboardPosition] (e.g. G1 single command). Nex overrides to height protobuf only. */
    open fun setDashboardHeightOnly(height: Int) {
        val depth = (DeviceStore.store.get("bluetooth", "dashboard_depth") as? Number)?.toInt() ?: 2
        setDashboardPosition(height, depth)
    }

    /** Default: full [setDashboardPosition]. Nex overrides to display_distance only. */
    open fun setDashboardDepthOnly(depth: Int) {
        val height = (DeviceStore.store.get("bluetooth", "dashboard_height") as? Number)?.toInt() ?: 4
        setDashboardPosition(height, depth)
    }

    // Dashboard Menu (default no-op — only G2 supports this)
    open fun setDashboardMenu(items: List<Map<String, Any>>) {}

    // Controller bridging (default no-op — only G2 supports pairing with a ring controller)
    open fun connectController() {}
    open fun disconnectController() {}

    // Device Control
    abstract fun setHeadUpAngle(angle: Int)
    abstract fun getBatteryStatus()
    abstract fun setSilentMode(enabled: Boolean)
    abstract fun exit()
    abstract fun sendShutdown()
    abstract fun sendReboot()
    abstract fun sendRgbLedControl(
            requestId: String,
            packageName: String?,
            action: String,
            color: String?,
            onDurationMs: Int,
            offDurationMs: Int,
            count: Int
    )

    // Connection Management
    abstract fun disconnect()
    abstract fun forget()
    abstract fun findCompatibleDevices()
    abstract fun stopScan()
    abstract fun connectById(id: String)
    abstract fun getConnectedBluetoothName(): String
    abstract fun cleanup()
    abstract fun ping()
    abstract fun dbg1()
    abstract fun dbg2()

    // Network Management
    abstract fun requestWifiScan()
    abstract fun sendWifiCredentials(ssid: String, password: String)
    abstract fun forgetWifiNetwork(ssid: String)
    abstract fun sendHotspotState(enabled: Boolean)

    /** Set glasses system clock (Mentra Live only; no-op on other devices). */
    open fun sendSetSystemTime(timestampMs: Long) {
        Bridge.log("SGC: sendSetSystemTime not supported on $type")
    }

    // User Context (for crash reporting)
    abstract fun sendUserEmailToGlasses(email: String)

    // Incident Reporting
    abstract fun sendIncidentId(incidentId: String, apiBaseUrl: String? = null)

    // Gallery
    abstract fun queryGalleryStatus()
    abstract fun sendGalleryMode()

    // Voice Activity Detection
    open fun sendVoiceActivityDetectionSetting() {}

    // Version info
    abstract fun requestVersionInfo()

    // DeviceStore-backed read-only getters for convenience
    val fullyBooted: Boolean
        get() = DeviceStore.get("glasses", "fullyBooted") as? Boolean ?: false

    val connected: Boolean
        get() = DeviceStore.get("glasses", "connected") as? Boolean ?: false

    val connectionState: String
        get() = DeviceStore.get("glasses", "connectionState") as? String ?: ConnTypes.DISCONNECTED

    val appVersion: String
        get() = DeviceStore.get("glasses", "appVersion") as? String ?: ""

    val buildNumber: String
        get() = DeviceStore.get("glasses", "buildNumber") as? String ?: ""

    val deviceModel: String
        get() = DeviceStore.get("glasses", "deviceModel") as? String ?: ""

    val androidVersion: String
        get() = DeviceStore.get("glasses", "androidVersion") as? String ?: ""

    val otaVersionUrl: String
        get() = DeviceStore.get("glasses", "otaVersionUrl") as? String ?: ""

    val firmwareVersion: String
        get() = DeviceStore.get("glasses", "firmwareVersion") as? String ?: ""

    val bluetoothMacAddress: String
        get() = DeviceStore.get("glasses", "bluetoothMacAddress") as? String ?: ""

    val serialNumber: String
        get() = DeviceStore.get("glasses", "serialNumber") as? String ?: ""

    val style: String
        get() = DeviceStore.get("glasses", "style") as? String ?: ""

    val color: String
        get() = DeviceStore.get("glasses", "color") as? String ?: ""

    val micEnabled: Boolean
        get() = DeviceStore.get("glasses", "micEnabled") as? Boolean ?: false

    val voiceActivityDetectionEnabled: Boolean
        get() = DeviceStore.get("glasses", "voiceActivityDetectionEnabled") as? Boolean ?: true

    val batteryLevel: Int
        get() = DeviceStore.get("glasses", "batteryLevel") as? Int ?: -1

    val headUp: Boolean
        get() = DeviceStore.get("glasses", "headUp") as? Boolean ?: false

    val charging: Boolean
        get() = DeviceStore.get("glasses", "charging") as? Boolean ?: false

    val caseOpen: Boolean
        get() = DeviceStore.get("glasses", "caseOpen") as? Boolean ?: true

    val caseRemoved: Boolean
        get() = DeviceStore.get("glasses", "caseRemoved") as? Boolean ?: true

    val caseCharging: Boolean
        get() = DeviceStore.get("glasses", "caseCharging") as? Boolean ?: false

    val caseBatteryLevel: Int
        get() = DeviceStore.get("glasses", "caseBatteryLevel") as? Int ?: -1

    val wifiSsid: String
        get() = DeviceStore.get("glasses", "wifiSsid") as? String ?: ""

    val wifiConnected: Boolean
        get() = DeviceStore.get("glasses", "wifiConnected") as? Boolean ?: false

    val wifiLocalIp: String
        get() = DeviceStore.get("glasses", "wifiLocalIp") as? String ?: ""

    val hotspotEnabled: Boolean
        get() = DeviceStore.get("glasses", "hotspotEnabled") as? Boolean ?: false

    val hotspotSsid: String
        get() = DeviceStore.get("glasses", "hotspotSsid") as? String ?: ""

    val hotspotPassword: String
        get() = DeviceStore.get("glasses", "hotspotPassword") as? String ?: ""

    val hotspotGatewayIp: String
        get() = DeviceStore.get("glasses", "hotspotGatewayIp") as? String ?: ""
}
