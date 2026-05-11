package com.mentra.core.controllers

import com.mentra.core.GlassesStore

abstract class ControllerManager {
    @JvmField var type: String = ""
    @JvmField var hasMic: Boolean = false

    // Audio Control
    abstract fun setMicEnabled(enabled: Boolean)
    abstract fun sortMicRanking(list: MutableList<String>): MutableList<String>

    // Messaging
    abstract fun sendJson(jsonOriginal: Map<String, Any>, wakeUp: Boolean, requireAck: Boolean)

    // Camera & Media
    abstract fun requestPhoto(
        requestId: String,
        appId: String,
        size: String?,
        webhookUrl: String?,
        authToken: String?,
        compress: String?,
        flash: Boolean,
        sound: Boolean
    )
    abstract fun startStream(message: Map<String, Any>)
    abstract fun stopStream()
    abstract fun sendStreamKeepAlive(message: Map<String, Any>)
    abstract fun startVideoRecording(requestId: String, save: Boolean, flash: Boolean, sound: Boolean)
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
    abstract fun getConnectedBluetoothName(): String?
    abstract fun cleanup()
    abstract fun ping()

    // Network Management
    abstract fun requestWifiScan()
    abstract fun sendWifiCredentials(ssid: String, password: String)
    abstract fun forgetWifiNetwork(ssid: String)
    abstract fun sendHotspotState(enabled: Boolean)
    abstract fun sendOtaStart()

    // User Context (for crash reporting)
    abstract fun sendUserEmailToGlasses(email: String)

    // Incident Reporting
    abstract fun sendIncidentId(incidentId: String)

    // Gallery
    abstract fun queryGalleryStatus()
    abstract fun sendGalleryMode()

    // Version Info
    abstract fun requestVersionInfo()

    // GlassesStore-backed read-only getters for convenience
    val fullyBooted: Boolean
        get() = GlassesStore.get("glasses", "fullyBooted") as? Boolean ?: false

    val connected: Boolean
        get() = GlassesStore.get("glasses", "connected") as? Boolean ?: false

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

    val vadEnabled: Boolean
        get() = GlassesStore.get("glasses", "vadEnabled") as? Boolean ?: false

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
}
