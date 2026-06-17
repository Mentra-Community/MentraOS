package com.mentra.bluetoothsdk.sgcs

import com.mentra.bluetoothsdk.BluetoothSdkDefaults
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
            save: Boolean,
            sound: Boolean,
            exposureTimeNs: Long?,
            iso: Int?,
    )
    abstract fun startStream(message: MutableMap<String, Any>)
    abstract fun stopStream()
    abstract fun sendStreamKeepAlive(message: MutableMap<String, Any>)
    abstract fun startVideoRecording(requestId: String, save: Boolean, flash: Boolean, sound: Boolean)

    /**
     * Start video recording with optional per-recording resolution/fps. A width,
     * height, or fps of 0 means "use the device's saved button-video default".
     * The base implementation ignores the settings and delegates to the default
     * recording path; devices that support custom settings (e.g. Mentra Live)
     * override this.
     */
    open fun startVideoRecording(
        requestId: String,
        save: Boolean,
        flash: Boolean,
        sound: Boolean,
        width: Int,
        height: Int,
        fps: Int,
        maxRecordingTimeMinutes: Int,
    ) {
        startVideoRecording(requestId, save, flash, sound)
    }

    abstract fun stopVideoRecording(requestId: String)

    /**
     * Stop recording and upload the result to [webhookUrl] (multipart) using
     * [authToken]. These are supplied at stop time so the token is fresh when
     * the upload runs. The base implementation ignores the upload target and
     * just stops; devices that support webhook upload (e.g. Mentra Live)
     * override this. An empty/null [webhookUrl] means "keep the video on device".
     */
    open fun stopVideoRecording(requestId: String, webhookUrl: String?, authToken: String?) {
        stopVideoRecording(requestId)
    }

    // Button Settings
    abstract fun sendButtonPhotoSettings()
    abstract fun sendButtonVideoRecordingSettings()
    abstract fun sendButtonMaxRecordingTime()
    abstract fun sendButtonCameraLedSetting()
    abstract fun sendCameraFovSetting()

    // Display Control
    abstract fun setBrightness(level: Int, autoMode: Boolean)
    abstract fun clearDisplay()
    abstract fun sendText(text: String)
    abstract fun sendTextWall(text: String)
    abstract fun sendDoubleTextWall(top: String, bottom: String)
    /**
     * Display a bitmap. Optional [x]/[y]/[width]/[height] position and size the target
     * container (used by G2; other SGCs ignore positioning and render the bitmap as before).
     */
    abstract fun displayBitmap(
            base64ImageData: String,
            x: Int? = null,
            y: Int? = null,
            width: Int? = null,
            height: Int? = null
    ): Boolean

    /**
     * Show text in a positioned container with an optional rounded border.
     * G2-only capability; default no-op so other glasses ignore it.
     */
    open fun sendPositionedText(
            text: String,
            x: Int,
            y: Int,
            width: Int,
            height: Int,
            borderWidth: Int = 0,
            borderRadius: Int = 0
    ) {}
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

    // Calendar Events (default no-op — only G2 supports this)
    open fun sendCalendarEvents(events: List<Map<String, Any>>) {}

    // Dashboard display settings (default no-op — only G2 supports this)
    open fun sendDashboardDisplaySettings() {}

    // Notification Panel (default no-op — only G2 supports this)
    open suspend fun showNotificationsPanel() {}

    // Controller bridging (default no-op — only G2 supports pairing with a ring controller)
    open fun connectController() {}
    open fun disconnectController() {}

    // Device Control
    abstract fun setHeadUpAngle(angle: Int)

    /**
     * Enable/disable raw accelerometer (IMU) reporting from the glasses.
     * Default no-op for devices without IMU support. G2 (both iOS and Android) overrides this to
     * stream IMU data; other devices accept the call so the cross-platform JS API stays uniform.
     */
    open suspend fun setImuEnabled(enabled: Boolean) {
        Bridge.log("SGC: setImuEnabled not supported")
    }

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

    // Start/stop LC3 audio playback from glasses based on the nex_audio_playback flag.
    open fun applyNexAudioPlaybackSetting() {}

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
        get() =
            DeviceStore.get("glasses", "voiceActivityDetectionEnabled") as? Boolean
                ?: BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED

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
