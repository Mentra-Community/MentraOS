package com.mentra.bluetoothsdk.sgcs

import com.mentra.bluetoothsdk.BluetoothSdkDefaults
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.PhotoRequest
import com.mentra.bluetoothsdk.utils.ConnTypes

/**
 * One element of a scene frame (display.render()). Geometry is raw pixels on
 * the device's drawable canvas; `change` is the host differ's annotation
 * against the previous frame sent to this device.
 */
data class SceneElement(
        val id: String,
        val type: String, // "text" | "rect" | "image"
        val x: Int,
        val y: Int,
        val w: Int,
        val h: Int,
        val text: String?,
        val data: String?, // base64 image pixels (SGC decodes → re-encodes to wire format)
        val border: Int,
        val radius: Int,
        val change: String, // "created" | "updated" | "moved" | "unchanged"
        val contentHash: String
)

/**
 * A whole scene from the host pipeline — the full frame plus per-element change
 * annotations and host-computed removes. Full-frame consumers can serialize
 * `elements` and ignore the annotations; per-element consumers walk them.
 */
data class SceneFrame(
        val appId: String,
        val epoch: Int,
        val replay: Boolean,
        val elements: List<SceneElement>,
        val removed: List<String>
)

abstract class SGCManager {
    // Hard coded device properties:
    @JvmField var type: String = ""
    @JvmField var hasMic: Boolean = false

    // Audio Control
    abstract fun setMicEnabled(enabled: Boolean)
    open val isMicSuspendedForAudio: Boolean
        get() = false
    abstract fun sortMicRanking(list: MutableList<String>): MutableList<String>

    // Camera & Media
    abstract fun requestPhoto(request: PhotoRequest)
    abstract fun startStream(message: MutableMap<String, Any>)
    abstract fun stopStream()
    abstract fun sendStreamKeepAlive(message: MutableMap<String, Any>)
    abstract fun startVideoRecording(requestId: String, save: Boolean, sound: Boolean)

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
        sound: Boolean,
        width: Int,
        height: Int,
        fps: Int,
        maxRecordingTimeMinutes: Int,
    ) {
        startVideoRecording(requestId, save, sound)
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

    /**
     * Retained-mode layout element (bitmap). Like [displayBitmap] but tagged with a stable
     * [elementId] within a [layoutId] scene, so an SGC that supports it (Nex) can diff:
     * same id -> update in place, new id -> create, new layoutId -> clear the previous scene.
     * Default: ignore the ids and behave exactly like [displayBitmap].
     */
    open fun drawLayoutBitmap(
            base64ImageData: String,
            x: Int,
            y: Int,
            width: Int,
            height: Int,
            elementId: String,
            layoutId: String?
    ): Boolean = displayBitmap(base64ImageData, x, y, width, height)

    /** Retained-mode layout element (text). Default: behave like [sendPositionedText]. */
    open fun drawLayoutText(
            text: String,
            x: Int,
            y: Int,
            width: Int,
            height: Int,
            borderWidth: Int,
            borderRadius: Int,
            elementId: String,
            layoutId: String?
    ) = sendPositionedText(text, x, y, width, height, borderWidth, borderRadius)

    /** Remove a retained layout element by id. Default: no-op (SGC doesn't support layouts). */
    open fun removeLayoutElement(elementId: String, layoutId: String?) {}

    /**
     * Apply a whole scene frame from the host pipeline (display.render()).
     *
     * The host has already diffed the scene against what it last sent, so each
     * element arrives annotated (created/updated/moved/unchanged) and `removed`
     * lists what disappeared. This default implementation is fully generic:
     *
     *  - PAINT-THEN-SWEEP: creates/updates/moves first (new content lands over
     *    or beside old), removes LAST — so a scene transition never shows a
     *    blank interval.
     *  - "unchanged" elements are skipped entirely (the host diff is the truth;
     *    this is also what prevents image re-uploads over BLE).
     *  - `replay` frames arrive all-"created" after a reconnect/recovery —
     *    [onSceneReplay] lets an SGC reset its component registry first so
     *    creates take the create path (updates to dead firmware ids are dropped
     *    silently by hardware).
     *  - rects compile to empty bordered text boxes (no shape primitive on
     *    current targets); a rect always gets a visible border.
     *
     * SGCs with per-element verbs (G2, Mentra Display) just implement
     * [drawLayoutText]/[drawLayoutBitmap]/[removeLayoutElement]. A full-frame
     * device (e.g. NIMO-style) overrides this whole method instead and
     * serializes [SceneFrame.elements], ignoring the annotations.
     */
    open fun applySceneFrame(frame: SceneFrame) {
        if (frame.replay) {
            onSceneReplay(frame.appId)
        }
        // An id in `removed` that ALSO appears in `elements` is a type change
        // (the differ keys matches by type:id). Its removal must run BEFORE the
        // paint — registries key by id, so a post-paint sweep would delete the
        // just-painted replacement.
        val paintedIds = frame.elements.mapTo(HashSet()) { it.id }
        for (id in frame.removed) {
            if (id in paintedIds) removeLayoutElement(id, frame.appId)
        }
        for (el in frame.elements) {
            if (!frame.replay && el.change == "unchanged") continue
            when (el.type) {
                "text" ->
                    drawLayoutText(el.text ?: "", el.x, el.y, el.w, el.h, el.border, el.radius, el.id, frame.appId)
                "rect" ->
                    drawLayoutText("", el.x, el.y, el.w, el.h, maxOf(1, el.border), el.radius, el.id, frame.appId)
                "image" ->
                    el.data?.let { drawLayoutBitmap(it, el.x, el.y, el.w, el.h, el.id, frame.appId) }
                else -> Bridge.log("SGC: applySceneFrame: unknown element type ${el.type}")
            }
        }
        for (id in frame.removed) {
            if (id !in paintedIds) removeLayoutElement(id, frame.appId)
        }
    }

    /**
     * A replay frame is about to repaint from scratch — forget any retained
     * component bookkeeping for [appId] so "created" elements take the create
     * path. Default: no-op.
     */
    open fun onSceneReplay(appId: String) {}

    /**
     * Remove a set of scene elements (scene→legacy handoff: a legacy layout is
     * about to draw and the previous scene's elements must not linger under it).
     */
    open fun clearSceneElements(elementIds: List<String>) {
        for (id in elementIds) removeLayoutElement(id, null)
    }

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
    abstract fun requestWifiScan(scanId: String?)
    abstract fun sendWifiCredentials(ssid: String, password: String)
    abstract fun forgetWifiNetwork(ssid: String)
    abstract fun sendHotspotState(enabled: Boolean)

    /** Set glasses system clock (Mentra Live and G2; no-op on other devices). */
    open fun sendSetSystemTime(timestampMs: Long) {
        Bridge.log("SGC: sendSetSystemTime not supported on $type")
    }

    /** Enable/disable Wi-Fi ADB on Mentra Live (no-op on other devices). */
    open fun sendWifiAdbState(enabled: Boolean) {
        Bridge.log("SGC: sendWifiAdbState not supported on $type")
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

    // Mentra Live center-mic loudness / Barrier gate
    open fun sendLoudnessGateSetting() {}

    // Start/stop LC3 audio playback from glasses based on the nex_lc3_audio_playback flag.
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
