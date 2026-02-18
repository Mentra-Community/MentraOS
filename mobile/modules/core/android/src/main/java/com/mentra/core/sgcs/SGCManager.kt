package com.mentra.core.sgcs

import com.mentra.core.GlassesStore
import com.mentra.core.utils.ConnTypes

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
            silent: Boolean
    )
    abstract fun startRtmpStream(message: MutableMap<String, Any>)
    abstract fun stopRtmpStream()
    abstract fun sendRtmpKeepAlive(message: MutableMap<String, Any>)
    abstract fun startBufferRecording()
    abstract fun stopBufferRecording()
    abstract fun saveBufferVideo(requestId: String, durationSeconds: Int)
    abstract fun startVideoRecording(requestId: String, save: Boolean, silent: Boolean)
    abstract fun stopVideoRecording(requestId: String)

    // Button Settings
    abstract fun sendButtonPhotoSettings()
    abstract fun sendButtonModeSetting()
    abstract fun sendButtonVideoRecordingSettings()
    abstract fun sendButtonMaxRecordingTime()
    abstract fun sendButtonCameraLedSetting()

    // Display Control
    abstract fun setBrightness(level: Int, autoMode: Boolean)
    abstract fun clearDisplay()
    abstract fun sendTextWall(text: String)
    abstract fun sendDoubleTextWall(top: String, bottom: String)
    abstract fun displayBitmap(base64ImageData: String): Boolean
    abstract fun showDashboard()
    abstract fun setDashboardPosition(height: Int, depth: Int)

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
            ontime: Int,
            offtime: Int,
            count: Int
    )

    // Connection Management
    abstract fun disconnect()
    abstract fun forget()
    abstract fun findCompatibleDevices()
    abstract fun connectById(id: String)
    abstract fun getConnectedBluetoothName(): String
    abstract fun cleanup()

    // Network Management
    abstract fun requestWifiScan()
    abstract fun sendWifiCredentials(ssid: String, password: String)
    abstract fun forgetWifiNetwork(ssid: String)
    abstract fun sendHotspotState(enabled: Boolean)

    // User Context (for crash reporting)
    abstract fun sendUserEmailToGlasses(email: String)

    // Gallery
    abstract fun queryGalleryStatus()
    abstract fun sendGalleryMode()

    // Version info
    abstract fun requestVersionInfo()

    // GlassesStore-backed read-only getters for convenience
    val fullyBooted: Boolean
        get() = GlassesStore.get("glasses", "fullyBooted") as? Boolean ?: false

    val connected: Boolean
        get() = GlassesStore.get("glasses", "connected") as? Boolean ?: false

    val connectionState: String
        get() = GlassesStore.get("glasses", "connectionState") as? String ?: ConnTypes.DISCONNECTED

    val appVersion: String
        get() = GlassesStore.get("glasses", "appVersion") as? String ?: ""

    val buildNumber: String
        get() = GlassesStore.get("glasses", "buildNumber") as? String ?: ""

    val deviceModel: String
        get() = GlassesStore.get("glasses", "deviceModel") as? String ?: ""

    val androidVersion: String
        get() = GlassesStore.get("glasses", "androidVersion") as? String ?: ""

    val otaVersionUrl: String
        get() = GlassesStore.get("glasses", "otaVersionUrl") as? String ?: ""

    val firmwareVersion: String
        get() = GlassesStore.get("glasses", "firmwareVersion") as? String ?: ""

    val btMacAddress: String
        get() = GlassesStore.get("glasses", "btMacAddress") as? String ?: ""

    val serialNumber: String
        get() = GlassesStore.get("glasses", "serialNumber") as? String ?: ""

    val style: String
        get() = GlassesStore.get("glasses", "style") as? String ?: ""

    val color: String
        get() = GlassesStore.get("glasses", "color") as? String ?: ""

    val micEnabled: Boolean
        get() = GlassesStore.get("glasses", "micEnabled") as? Boolean ?: false

    val batteryLevel: Int
        get() = GlassesStore.get("glasses", "batteryLevel") as? Int ?: -1

    val headUp: Boolean
        get() = GlassesStore.get("glasses", "headUp") as? Boolean ?: false

    val charging: Boolean
        get() = GlassesStore.get("glasses", "charging") as? Boolean ?: false

    val caseOpen: Boolean
        get() = GlassesStore.get("glasses", "caseOpen") as? Boolean ?: true

    val caseRemoved: Boolean
        get() = GlassesStore.get("glasses", "caseRemoved") as? Boolean ?: true

    val caseCharging: Boolean
        get() = GlassesStore.get("glasses", "caseCharging") as? Boolean ?: false

    val caseBatteryLevel: Int
        get() = GlassesStore.get("glasses", "caseBatteryLevel") as? Int ?: -1

    val wifiSsid: String
        get() = GlassesStore.get("glasses", "wifiSsid") as? String ?: ""

    val wifiConnected: Boolean
        get() = GlassesStore.get("glasses", "wifiConnected") as? Boolean ?: false

    val wifiLocalIp: String
        get() = GlassesStore.get("glasses", "wifiLocalIp") as? String ?: ""

    val hotspotEnabled: Boolean
        get() = GlassesStore.get("glasses", "hotspotEnabled") as? Boolean ?: false

    val hotspotSsid: String
        get() = GlassesStore.get("glasses", "hotspotSsid") as? String ?: ""

    val hotspotPassword: String
        get() = GlassesStore.get("glasses", "hotspotPassword") as? String ?: ""

    val hotspotGatewayIp: String
        get() = GlassesStore.get("glasses", "hotspotGatewayIp") as? String ?: ""
}
