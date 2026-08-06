package com.mentra.bluetoothsdk

import android.bluetooth.BluetoothManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import com.mentra.bluetoothsdk.utils.ControllerTypes
import com.mentra.bluetoothsdk.utils.PhoneAudioMonitor
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

class MentraBluetoothSdk private constructor(
    context: Context,
    private val config: MentraBluetoothSdkConfig,
    listener: MentraBluetoothSdkListener,
) : AutoCloseable {
    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val deviceManager: DeviceManager
    private val listeners =
        Collections.synchronizedSet(mutableSetOf<MentraBluetoothSdkListener>())
    private val analytics = BluetoothSdkAnalytics(appContext, config.analytics)
    private val discoveredDeviceNames = mutableSetOf<String>()
    private val bridgeEventSinkId: String
    private val storeListenerId: String
    private var suppressDefaultDeviceEvents = false
    private val streamKeepAliveLock = Any()
    private var activeStreamKeepAlive: ActiveStreamKeepAlive? = null
    private val pendingPhotoRequests = ConcurrentHashMap<String, PendingResponse<PhotoResponseEvent>>()
    private val pendingCameraStatusRequests = ConcurrentHashMap<String, PendingResponse<CameraStatusEvent>>()
    private val pendingVideoRecordingRequests =
        ConcurrentHashMap<String, PendingVideoRecordingRequest>()
    private val pendingRgbLedRequests = ConcurrentHashMap<String, PendingResponse<RgbLedControlResponseEvent>>()
    private val pendingSettingsRequests = ConcurrentHashMap<String, PendingResponse<SettingsAckEvent>>()
    private val pendingStreamStarts = ConcurrentHashMap<String, PendingStreamStart>()
    private val streamStartSeq = AtomicLong()
    private val streamStartOrderLock = Any()
    private val oneShotLock = Any()
    private var pendingGalleryStatus: PendingResponse<GalleryStatusEvent>? = null
    private var pendingOtaQuery: PendingResponse<OtaQueryResult>? = null
    private var pendingOtaStart: PendingResponse<OtaStartAckEvent>? = null
    private var pendingStreamStop: PendingStreamStop? = null
    private var pendingWifiScan: PendingWifiScan? = null
    private var pendingWifiStatus: PendingWifiStatusRequest? = null
    private var pendingHotspotStatus: PendingHotspotStatusRequest? = null
    private var pendingVersionInfo: PendingResponse<VersionInfoResult>? = null
    @Volatile private var configuredOtaVersionUrl: String? = null

    init {
        listeners.add(listener)
        Bridge.initialize(appContext)
        deviceManager = DeviceManager.getInstance()
        bridgeEventSinkId = Bridge.addEventSink { eventName, data -> dispatchBridgeEvent(eventName, data) }
        // Baseline the analytics connection state before subscribing to the store:
        // store updates invoke listeners synchronously on the updating thread, so a
        // connected status observed before the baseline would be reported as a fresh
        // bluetooth_sdk_glasses_connected transition.
        analytics.initializeGlassesStatus(getRawGlassesStatus())
        storeListenerId = DeviceStore.store.addListener { category, changes -> dispatchStoreUpdate(category, changes) }
        analytics.captureStarted()
    }

    companion object {
        private val DEFAULT_DEVICE_KEYS = setOf("default_wearable", "device_name", "device_address", "project_name")
        private val SCAN_STATE_KEYS = setOf("searching", "searchingController", "searchResults")
        private const val DEFAULT_SCAN_TIMEOUT_MS = 15_000L
        private const val DEFAULT_REQUEST_TIMEOUT_MS = 15_000L
        // A photo response is terminal only after capture, encoding, transport, and upload.
        // Max-quality BLE fallback can legitimately exceed the generic command deadline.
        private const val PHOTO_REQUEST_TIMEOUT_MS = 30_000L
        private const val WIFI_SCAN_TIMEOUT_MS = 20_000L
        // Local-only hotspot startup may need to disconnect station WiFi and retry.
        // Keep this aligned with the gallery sync request window.
        private const val HOTSPOT_REQUEST_TIMEOUT_MS = 30_000L
        private const val VIDEO_UPLOAD_STOP_TIMEOUT_MS = 10 * 60 * 1000L
        private const val STREAM_START_TIMEOUT_MS = 30_000L
        private const val STREAM_STOP_TIMEOUT_MS = 15_000L
        private const val OTA_BES_VERSION_WAIT_MS = 5_000L
        private const val OTA_MTK_VERSION_WAIT_MS = 2_000L
        private const val OTA_VERSION_POLL_MS = 100L
        private const val DEFAULT_STREAM_KEEP_ALIVE_INTERVAL_SECONDS = 5
        private const val MAX_MISSED_STREAM_KEEP_ALIVE_ACKS = 3

        // Stream states the glasses only reach after start_stream has run past
        // stopAllServices() — the point where every older start is actually
        // preempted. ERROR and STOPPED are deliberately absent: an ERROR can be
        // a command-level preflight rejection emitted before stopAllServices,
        // and a STOPPED is a stop ack; neither proves older starts were killed.
        private val PREEMPTION_PROVEN_STATES = setOf(
            StreamState.INITIALIZING,
            StreamState.RECONNECTING,
            StreamState.RECONNECTED,
            StreamState.STREAMING,
        )

        @JvmStatic
        fun create(
            context: Context,
            listener: MentraBluetoothSdkListener,
        ): MentraBluetoothSdk = create(context, MentraBluetoothSdkConfig(), listener)

        @JvmStatic
        fun create(
            context: Context,
            config: MentraBluetoothSdkConfig,
            listener: MentraBluetoothSdkListener,
        ): MentraBluetoothSdk = MentraBluetoothSdk(context, config, listener)
    }

    private data class ActiveStreamKeepAlive(
        val streamId: String,
        val intervalMs: Long,
        var pendingAckId: String? = null,
        var missedAckCount: Int = 0,
        var nextTick: Runnable? = null,
        // Missed-ACK counting only begins once the stream is confirmed live/coming up, so a
        // slow startup (glasses can't ACK until they reach starting/streaming) can't trip a
        // false keep-alive timeout before the stream is ever up.
        var armed: Boolean = false,
    )

    // seq records send order (assigned and handed to the BLE queue under
    // streamStartOrderLock) so that an id-carrying status for a newer start can
    // identify which older in-flight starts it preempted.
    private data class PendingStreamStart(
        val seq: Long,
        val pending: PendingResponse<StreamStatusEvent>,
        // Set when an id-carrying error arrives: a fatal publisher error never
        // reaches the reconnect machinery and winds down with a streamId-less
        // stopped, so the stash both attributes that stopped to this start and
        // preserves the real error details for the rejection.
        var lastError: StreamStatusEvent? = null,
    )

    private data class PendingStreamStop(
        val streamId: String?,
        // The stop's slot in the shared streamStartSeq order (drawn inside
        // streamStartOrderLock at send time): every pending start with a
        // lower seq reached the glasses' FIFO before this stop.
        val seq: Long,
        val pending: PendingResponse<StreamStatusEvent>,
    )

    private data class PendingVideoRecordingRequest(
        val expectedStatus: String,
        val pending: PendingResponse<VideoRecordingStatusEvent>,
        val waitForUpload: Boolean = false,
        var stoppedEvent: VideoRecordingStatusEvent? = null,
        var uploadSucceeded: Boolean = false,
    )

    private data class PendingWifiScan(
        val pending: PendingResponse<List<WifiScanResult>>,
        val scanId: String,
        var latestResults: List<WifiScanResult> = emptyList(),
        var waiters: Int = 0,
        // Chunks accumulated from scanId-echoing glasses, deduplicated by SSID;
        // resolved only when the glasses flag the scan complete.
        val accumulated: MutableList<WifiScanResult> = mutableListOf(),
    )

    private data class PendingWifiStatusRequest(
        val operation: WifiStatusOperation,
        val ssid: String,
        val pending: PendingResponse<WifiStatusEvent>,
    )

    private enum class WifiStatusOperation {
        CONNECT,
        FORGET,
    }

    private data class PendingHotspotStatusRequest(
        val enabled: Boolean,
        val pending: PendingResponse<HotspotStatusEvent>,
    )

    // Suspends instead of parking a thread (OS-1714): the old CountDownLatch
    // version blocked its caller for the whole glasses round-trip. Expo runs
    // every plain AsyncFunction of every module on ONE shared thread
    // (expo.modules.AsyncFunctionQueue), so a blocked await here froze all
    // miniapp event delivery (Crust.mentraJsDispatchToJs) until the glasses
    // responded. resolve()/reject() stay callable from any thread.
    private class PendingResponse<T>(
        private val operation: String,
    ) {
        private val deferred = CompletableDeferred<T>()

        fun resolve(value: T) {
            deferred.complete(value)
        }

        fun reject(error: Throwable) {
            deferred.completeExceptionally(error)
        }

        suspend fun await(timeoutMs: Long = DEFAULT_REQUEST_TIMEOUT_MS): T {
            // All response types are non-null, so a null from withTimeoutOrNull
            // can only mean the deadline elapsed. A rejected deferred rethrows
            // its error from await() and propagates out unchanged.
            return withTimeoutOrNull(timeoutMs) { deferred.await() }
                ?: throw BluetoothSdkException(
                    "request_timeout",
                    "$operation timed out waiting for glasses response.",
                )
        }
    }

    fun addListener(listener: MentraBluetoothSdkListener) {
        listeners.add(listener)
    }

    fun removeListener(listener: MentraBluetoothSdkListener) {
        listeners.remove(listener)
    }

    fun getState(): MentraBluetoothState =
        MentraBluetoothState.from(getRawGlassesStatus(), getRawBluetoothStatus())

    fun getGlasses(): GlassesRuntimeState =
        getState().glasses

    fun getSdkState(): PhoneSdkRuntimeState =
        getState().sdk

    fun getScanState(): BluetoothScanState =
        getState().scan

    internal fun getRawGlassesStatus(): GlassesStatus =
        GlassesStatus.fromMap(DeviceStore.store.getCategory("glasses"))

    internal fun getRawBluetoothStatus(): BluetoothStatus =
        BluetoothStatus.fromMap(DeviceStore.store.getCategory(ObservableStore.BLUETOOTH_CATEGORY))

    fun getDefaultDevice(): Device? = currentDefaultDevice()

    private fun requireGlassesConnected(operation: String) {
        if (!getRawGlassesStatus().connected) {
            throw BluetoothSdkException(
                "glasses_not_connected",
                "Cannot $operation because glasses are not connected.",
            )
        }
    }

    fun setDefaultDevice(device: Device?) {
        if (device == null) {
            clearDefaultDevice()
            return
        }
        suppressDefaultDeviceEvents = true
        try {
            DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "default_wearable", device.model.deviceType)
            DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "device_name", device.name)
            DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "device_address", device.address ?: "")
            DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "project_name", device.projectName ?: "")
        } finally {
            suppressDefaultDeviceEvents = false
        }
        dispatchDefaultDeviceChanged()
    }

    fun clearDefaultDevice() {
        suppressDefaultDeviceEvents = true
        try {
            DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "default_wearable", "")
            DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "device_name", "")
            DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "device_address", "")
            DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "project_name", "")
        } finally {
            suppressDefaultDeviceEvents = false
        }
        dispatchDefaultDeviceChanged()
    }

    fun startScan(model: DeviceModel) {
        if (model != DeviceModel.SIMULATED) {
            requireBluetoothReady("scan for glasses")
        }
        discoveredDeviceNames.clear()
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "searching", true)
        deviceManager.findCompatibleDevices(model.deviceType)
    }

    fun stopScan() {
        stopScan(ScanStopReason.CANCELLED)
    }

    private fun stopScan(reason: ScanStopReason) {
        deviceManager.stopScan()
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "searching", false)
        dispatchToListeners { it.onScanStopped(reason) }
    }

    fun scan(
        model: DeviceModel,
        onResults: (List<Device>) -> Unit,
    ): ScanSession = scan(model, DEFAULT_SCAN_TIMEOUT_MS, onResults)

    fun scan(
        model: DeviceModel,
        timeoutMs: Long,
        onResults: (List<Device>) -> Unit,
    ): ScanSession =
        scan(
            model = model,
            callback =
                object : MentraBluetoothScanCallback() {
                    override fun onResults(devices: List<Device>) {
                        onResults(devices)
                    }
                },
            timeoutMs = timeoutMs,
        )

    @JvmOverloads
    fun scan(
        model: DeviceModel,
        callback: ScanCallback,
        timeoutMs: Long = DEFAULT_SCAN_TIMEOUT_MS,
    ): ScanSession {
        val normalizedTimeoutMs = if (timeoutMs > 0) timeoutMs else DEFAULT_SCAN_TIMEOUT_MS
        val latestResults = mutableListOf<Device>()
        lateinit var timeoutRunnable: Runnable
        lateinit var session: ScanSession
        val finished = AtomicBoolean(false)

        fun emitResults(devices: List<Device>) {
            latestResults.clear()
            latestResults.addAll(devices)
            callback.onResults(latestResults.toList())
        }

        val scanListener =
            object : MentraBluetoothSdkCallback() {
                override fun onScanChanged(scan: BluetoothScanState) {
                    emitResults(scan.devices.filter { it.model == model })
                }
            }

        fun finish(reason: ScanStopReason) {
            if (!finished.compareAndSet(false, true)) return
            removeListener(scanListener)
            mainHandler.removeCallbacks(timeoutRunnable)
            session.markStopped()
            stopScan(reason)
            callback.onComplete(latestResults.toList())
        }

        timeoutRunnable = Runnable { finish(ScanStopReason.COMPLETED) }
        session = ScanSession { finish(ScanStopReason.CANCELLED) }
        addListener(scanListener)

        try {
            emitResults(emptyList())
            startScan(model)
            emitResults(getRawBluetoothStatus().searchResults.filter { it.model == model })
            mainHandler.postDelayed(timeoutRunnable, normalizedTimeoutMs)
            return session
        } catch (error: Throwable) {
            removeListener(scanListener)
            mainHandler.removeCallbacks(timeoutRunnable)
            session.markStopped()
            callback.onError(error.toBluetoothError("scan_failed"))
            throw error
        }
    }

    @JvmOverloads
    fun connect(device: Device, options: ConnectOptions = ConnectOptions()) {
        if (device.model != DeviceModel.SIMULATED) {
            requireBluetoothReady("connect to glasses")
        }
        val isController = ControllerTypes.ALL.contains(device.model.deviceType)
        if (options.cancelExistingConnectionAttempt) {
            if (isController) {
                deviceManager.disconnectController()
            } else {
                cancelConnectionAttempt()
            }
        }
        if (options.saveAsDefault && !isController) {
            setDefaultDevice(device)
        }
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "pending_wearable", device.model.deviceType)
        deviceManager.connectByName(device.name)
    }

    @JvmOverloads
    fun connectDefault(options: ConnectOptions = ConnectOptions()) {
        val defaultDevice =
            currentDefaultDevice()
                ?: throw BluetoothSdkException(
                    "default_device_missing",
                    "Set a default glasses device before calling connectDefault.",
                )
        if (defaultDevice.model != DeviceModel.SIMULATED) {
            requireBluetoothReady("connect to glasses")
        }
        if (options.cancelExistingConnectionAttempt) {
            cancelConnectionAttempt()
        }
        deviceManager.connectDefault()
    }

    fun cancelConnectionAttempt() {
        deviceManager.disconnect()
    }

    internal fun connectSimulated() {
        deviceManager.connectSimulated()
    }

    fun disconnect() {
        deviceManager.disconnect()
    }

    fun forget() {
        deviceManager.forget()
    }

    @JvmOverloads
    fun displayText(text: String, x: Int = 0, y: Int = 0, size: Int = 24) {
        displayText(DisplayTextRequest(text = text, x = x, y = y, size = size))
    }

    fun displayText(request: DisplayTextRequest) {
        deviceManager.displayText(request.toMap())
    }

    internal fun displayEvent(request: DisplayEventRequest) {
        deviceManager.displayEvent(request.toMap())
    }

    fun clearDisplay() {
        deviceManager.clearDisplay()
    }

    fun showDashboard() {
        deviceManager.showDashboard()
    }

    internal fun setBrightness(level: Int, autoMode: Boolean? = null) {
        autoMode?.let { DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "auto_brightness", it) }
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "brightness", level)
    }

    internal fun setAutoBrightness(enabled: Boolean) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "auto_brightness", enabled)
    }

    fun setDashboardPosition(height: Int, depth: Int) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "dashboard_height", height)
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "dashboard_depth", depth)
    }

    fun setDashboardPosition(request: DashboardPositionRequest) {
        setDashboardPosition(height = request.height, depth = request.depth)
    }

    internal fun setDashboardMenu(items: List<DashboardMenuItem>) {
        DeviceStore.apply(
            ObservableStore.BLUETOOTH_CATEGORY,
            "menu_apps",
            items.map { it.toMap() },
        )
    }

    internal fun setCalendarEvents(events: List<CalendarEvent>) {
        DeviceStore.apply(
            ObservableStore.BLUETOOTH_CATEGORY,
            "calendar_events",
            events.map { it.toMap() },
        )
    }

    fun setHeadUpAngle(angleDegrees: Int) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "head_up_angle", angleDegrees)
    }

    fun setScreenDisabled(disabled: Boolean) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "screen_disabled", disabled)
    }

    suspend fun setGalleryModeEnabled(enabled: Boolean): SettingsAckEvent =
        performSettingsCommand(
            setting = "gallery_mode",
            updateStore = { _ -> DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "gallery_mode", enabled) },
            send = { requestId -> deviceManager.sendGalleryMode(requestId, enabled) },
        )

    private suspend fun performSettingsCommand(
        setting: String,
        updateStore: (SettingsAckEvent) -> Unit,
        send: (String) -> Unit,
    ): SettingsAckEvent {
        val requestId = "settings-$setting-${UUID.randomUUID()}"
        val pending = PendingResponse<SettingsAckEvent>("set $setting")
        pendingSettingsRequests[requestId] = pending
        try {
            send(requestId)
            val ack = pending.await()
            updateStore(ack)
            return ack
        } finally {
            pendingSettingsRequests.remove(requestId, pending)
        }
    }

    fun setVoiceActivityDetectionEnabled(enabled: Boolean) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "voice_activity_detection_enabled", enabled)
    }

    fun setLoudnessGateEnabled(enabled: Boolean) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "loudness_gate_enabled", enabled)
    }

    @Deprecated(
        message =
            "Sticky action-button photo presets are deprecated. Prefer per-request " +
                "requestPhoto(...) options (e.g. mode=TEXT for text sensor size/crop, or explicit per-shot fields). " +
                "This method still works but will be removed in a future release.",
    )
    suspend fun setPhotoCaptureDefaults(settings: PhotoCaptureDefaults): SettingsAckEvent =
        performSettingsCommand(
            setting = "button_photo",
            updateStore = { _ ->
                if (settings.resetCaptureTuning) {
                    // Clear all stored scan-tuning keys from phone cache
                    listOf(
                        "button_photo_zsl_mfnr",
                        "button_photo_mfnr",
                        "button_photo_zsl",
                        "button_photo_noise_reduction",
                        "button_photo_edge_enhancement",
                        "button_photo_isp_digital_gain",
                        "button_photo_isp_analog_gain",
                        "button_photo_ae_exposure_divisor",
                        "button_photo_iso_cap",
                        "button_photo_compress",
                        "button_photo_sound",
                    ).forEach { key ->
                        DeviceStore.store.remove(ObservableStore.BLUETOOTH_CATEGORY, key)
                    }
                }
                // Only update size if explicitly provided; omitted size = leave stored value unchanged
                settings.size?.let { DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_size", it.value) }
                settings.mfnr?.let { DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_mfnr", it) }
                settings.zsl?.let { DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_zsl", it) }
                settings.noiseReduction?.let {
                    DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_noise_reduction", it)
                }
                settings.edgeEnhancement?.let {
                    DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_edge_enhancement", it)
                }
                settings.ispDigitalGain?.let {
                    DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_isp_digital_gain", it)
                }
                settings.ispAnalogGain?.let {
                    DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_isp_analog_gain", it)
                }
                settings.aeExposureDivisor?.let {
                    DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_ae_exposure_divisor", it)
                }
                settings.isoCap?.let {
                    DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_iso_cap", it)
                }
                settings.compress?.let {
                    DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_compress", it)
                }
                settings.sound?.let {
                    DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_sound", it)
                }
            },
            send = { requestId -> deviceManager.sendButtonPhotoSettings(requestId, settings) },
        )

    suspend fun setVideoRecordingDefaults(defaults: VideoRecordingDefaults): SettingsAckEvent =
        performSettingsCommand(
            setting = "button_video_recording",
            updateStore = { _ ->
                DeviceStore.set(
                    ObservableStore.BLUETOOTH_CATEGORY,
                    "button_video_settings",
                    mapOf("width" to defaults.width, "height" to defaults.height, "fps" to defaults.fps),
                )
                // Keep legacy cache keys readable for older internal callers during migration.
                DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_video_width", defaults.width)
                DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_video_height", defaults.height)
                DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_video_fps", defaults.fps)
            },
            send = { requestId ->
                deviceManager.sendButtonVideoRecordingSettings(requestId, defaults.width, defaults.height, defaults.fps)
            },
        )

    suspend fun setMaxVideoRecordingDuration(minutes: Int): SettingsAckEvent =
        performSettingsCommand(
            setting = "button_max_recording_time",
            updateStore = { _ ->
                DeviceStore.set(ObservableStore.BLUETOOTH_CATEGORY, "button_max_recording_time", minutes)
            },
            send = { requestId -> deviceManager.sendButtonMaxRecordingTime(requestId, minutes) },
        )

    suspend fun setCameraFov(fov: CameraFov): CameraFovResult {
        val ack = performSettingsCommand(
            setting = "camera_fov",
            updateStore = { _ -> },
            send = { requestId -> deviceManager.sendCameraFovSetting(requestId, fov.fov, fov.roiPosition.value) },
        )
        val result = CameraFovResult.fromAck(ack, fov)
        DeviceStore.set(
            ObservableStore.BLUETOOTH_CATEGORY,
            "camera_fov",
            mapOf("fov" to result.fov, "roi_position" to result.roiPosition.value),
        )
        return result
    }

    /**
     * Compatibility path for ASG clients that support only the older one-way FOV command.
     * It resolves once the setting is queued to BLE because those clients never acknowledge it.
     */
    fun setLegacyCameraFov(fov: CameraFov): CameraFovResult {
        deviceManager.sendLegacyCameraFovSetting(fov.fov, fov.roiPosition.value)
        return CameraFovResult("legacy", fov.fov, fov.roiPosition, System.currentTimeMillis())
    }

    /** Restores the persistent base FOV through the acknowledgement-free compatibility path. */
    fun restoreLegacyCameraFov() {
        deviceManager.restoreLegacyCameraFovSetting()
    }

    suspend fun setCameraFovOverride(leaseId: String, fov: CameraFov, ttlMs: Int): CameraFovResult {
        val ack = performSettingsCommand(
            setting = "camera_fov_override",
            updateStore = { _ -> },
            send = { requestId ->
                deviceManager.sendCameraFovOverride(
                    requestId,
                    leaseId,
                    fov.fov,
                    fov.roiPosition.value,
                    ttlMs,
                )
            },
        )
        return CameraFovResult.fromAck(ack, fov)
    }

    suspend fun releaseCameraFovOverride(leaseId: String): SettingsAckEvent =
        performSettingsCommand(
            setting = "camera_fov_override",
            updateStore = { _ -> },
            send = { requestId -> deviceManager.releaseCameraFovOverride(requestId, leaseId) },
        )

    /**
     * Configure camera HAL tuning on Mentra Live glasses.
     *
     * The phone sends a {@code camera_tuning_config} BLE message; the ASG client relays it as a
     * {@code camconfig} broadcast to SystemUI's CTReceiver so the camera HAL picks up the new
     * parameters without a reboot.
     *
     * @param anrOn  {@code true} = ANR enabled, {@code false} = ANR disabled (pixsmart param)
     * @param gainOn {@code true} = stock gain params, {@code false} = pixsmart gain-off params
     */
    suspend fun setCameraTuningConfig(anrOn: Boolean, gainOn: Boolean): SettingsAckEvent =
        performSettingsCommand(
            setting = "camera_tuning",
            updateStore = { _ -> },
            send = { requestId -> deviceManager.sendCameraTuningConfig(requestId, anrOn, gainOn) },
        )

    fun setMicState(
        enabled: Boolean,
        useGlassesMic: Boolean = true,
        sendTranscript: Boolean = false,
        sendLc3Data: Boolean = false,
    ) {
        if (enabled) {
            DeviceStore.apply(
                ObservableStore.BLUETOOTH_CATEGORY,
                "preferred_mic",
                if (useGlassesMic) MicPreference.GLASSES.value else MicPreference.PHONE.value,
            )
        }
        applyMicState(
            sendPcmData = enabled,
            sendTranscript = enabled && sendTranscript,
            sendLc3Data = enabled && sendLc3Data,
        )
    }

    private fun applyMicState(
        sendPcmData: Boolean,
        sendTranscript: Boolean,
        sendLc3Data: Boolean,
    ) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "should_send_pcm", sendPcmData)
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "should_send_lc3", sendLc3Data)
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "should_send_transcript", sendTranscript)
        deviceManager.setMicState()
    }

    fun setPreferredMic(preferredMic: MicPreference) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "preferred_mic", preferredMic.value)
    }

    fun setOwnAppAudioPlaying(playing: Boolean) {
        PhoneAudioMonitor.getInstance(appContext).setOwnAppAudioPlaying(playing)
    }

    fun getGlassesMediaVolume(): GlassesMediaVolumeGetResult =
        GlassesMediaVolumeGetResult.fromMap(deviceManager.getGlassesMediaVolumeBlocking())

    fun setGlassesMediaVolume(level: Int): GlassesMediaVolumeSetResult {
        require(level in 0..15) { "Glasses media volume must be between 0 and 15." }
        return GlassesMediaVolumeSetResult.fromMap(deviceManager.setGlassesMediaVolumeBlocking(level))
    }

    suspend fun requestWifiScan(): List<WifiScanResult> {
        val pending = PendingResponse<List<WifiScanResult>>("WiFi scan request")
        val request = PendingWifiScan(pending, scanId = "scan-${UUID.randomUUID()}", waiters = 1)
        val existing =
            synchronized(oneShotLock) {
                pendingWifiScan?.also { it.waiters++ } ?: run {
                    pendingWifiScan = request
                    null
                }
            }
        if (existing != null) {
            // Join the in-flight scan instead of failing with request_in_flight;
            // the scan screen auto-starts a scan on mount and can be pushed twice.
            try {
                return existing.pending.await(WIFI_SCAN_TIMEOUT_MS)
            } finally {
                releaseWifiScanWaiter(existing)
            }
        }
        try {
            // Claim the scan-results store for this scan before the command goes
            // out, so a delayed chunk from an older, abandoned scan can no longer
            // mutate it.
            Bridge.claimWifiScanResults(request.scanId)
            deviceManager.requestWifiScan(request.scanId)
            // The glasses wait up to 15s for scan-results broadcasts before sending
            // scan_complete, so give them longer than that before falling back.
            return pending.await(WIFI_SCAN_TIMEOUT_MS)
        } catch (cancellation: CancellationException) {
            // Only this caller is going away; the glasses scan keeps running and
            // other coroutines may have joined the same pending entry. Leave the
            // shared deferred alone so scan_complete can still resolve for them.
            throw cancellation
        } catch (error: Throwable) {
            if (error is BluetoothSdkException && error.code == "request_timeout") {
                val fallbackResults = synchronized(oneShotLock) { request.latestResults }
                if (fallbackResults.isNotEmpty()) {
                    // Resolve so callers joined on the same scan get the fallback too.
                    pending.resolve(fallbackResults)
                    return fallbackResults
                }
            }
            // Fail joined callers immediately instead of letting them run out their
            // own timeout.
            pending.reject(error)
            throw error
        } finally {
            releaseWifiScanWaiter(request)
        }
    }

    /** Last waiter (starter or joiner) out clears the shared scan entry so a
     * cancelled starter can't strand it, and an abandoned scan can't wedge
     * future ones. handleWifiScanResultsForRequests may clear it first. */
    private fun releaseWifiScanWaiter(request: PendingWifiScan) {
        synchronized(oneShotLock) {
            request.waiters--
            if (request.waiters <= 0 && pendingWifiScan === request) {
                pendingWifiScan = null
            }
        }
    }

    suspend fun sendWifiCredentials(ssid: String, password: String): WifiStatusEvent {
        val pending = PendingResponse<WifiStatusEvent>("WiFi connect request")
        synchronized(oneShotLock) {
            if (pendingWifiStatus != null) {
                throw BluetoothSdkException(
                    "request_in_flight",
                    "A WiFi status command is already waiting for a glasses response.",
                )
            }
            pendingWifiStatus = PendingWifiStatusRequest(WifiStatusOperation.CONNECT, ssid, pending)
        }
        try {
            deviceManager.sendWifiCredentials(ssid, password)
            return pending.await()
        } finally {
            synchronized(oneShotLock) {
                if (pendingWifiStatus?.pending === pending) {
                    pendingWifiStatus = null
                }
            }
        }
    }

    suspend fun forgetWifiNetwork(ssid: String): WifiStatusEvent {
        val pending = PendingResponse<WifiStatusEvent>("WiFi forget request")
        synchronized(oneShotLock) {
            if (pendingWifiStatus != null) {
                throw BluetoothSdkException(
                    "request_in_flight",
                    "A WiFi status command is already waiting for a glasses response.",
                )
            }
            pendingWifiStatus = PendingWifiStatusRequest(WifiStatusOperation.FORGET, ssid, pending)
        }
        try {
            deviceManager.forgetWifiNetwork(ssid)
            return pending.await()
        } finally {
            synchronized(oneShotLock) {
                if (pendingWifiStatus?.pending === pending) {
                    pendingWifiStatus = null
                }
            }
        }
    }

    suspend fun setHotspotState(enabled: Boolean): HotspotStatusEvent {
        val pending = PendingResponse<HotspotStatusEvent>("hotspot ${if (enabled) "enable" else "disable"} request")
        synchronized(oneShotLock) {
            if (pendingHotspotStatus != null) {
                throw BluetoothSdkException(
                    "request_in_flight",
                    "A hotspot command is already waiting for a glasses response.",
                )
            }
            pendingHotspotStatus = PendingHotspotStatusRequest(enabled, pending)
        }
        try {
            deviceManager.setHotspotState(enabled)
            return pending.await(HOTSPOT_REQUEST_TIMEOUT_MS)
        } finally {
            synchronized(oneShotLock) {
                if (pendingHotspotStatus?.pending === pending) {
                    pendingHotspotStatus = null
                }
            }
        }
    }

    fun setSystemTime(timestampMs: Long) {
        deviceManager.setSystemTime(timestampMs)
    }

    suspend fun requestPhoto(request: PhotoRequest): PhotoResponseEvent {
        val routedRequest =
            nonBlankRequestId(request.requestId)
                ?.let { if (it == request.requestId) request else request.copy(requestId = it) }
                ?: request.copy(requestId = generatedCameraRequestId("photo"))
        Bridge.log(
            "NATIVE: PHOTO PIPELINE [3b/6] MentraBluetoothSdk.requestPhoto requestId=${routedRequest.requestId}"
        )
        val pending = PendingResponse<PhotoResponseEvent>("photo request ${routedRequest.requestId}")
        pendingPhotoRequests[routedRequest.requestId] = pending
        try {
            deviceManager.requestPhoto(routedRequest)
            return pending.await(PHOTO_REQUEST_TIMEOUT_MS)
        } finally {
            pendingPhotoRequests.remove(routedRequest.requestId, pending)
        }
    }

    suspend fun warmUpCamera(
        requestId: String? = null,
        size: PhotoSize,
        mode: PhotoMode = PhotoMode.PHOTO,
        exposureTimeNs: Long?,
        durationMs: Int,
        zsl: Boolean? = null,
        mfnr: Boolean? = null,
    ): CameraStatusEvent {
        val effectiveRequestId = nonBlankRequestId(requestId) ?: generatedCameraRequestId("warm")
        val pending = PendingResponse<CameraStatusEvent>("camera warm up $effectiveRequestId")
        // Guard against a concurrent warm-up reusing the same requestId: a blind put would overwrite
        // (and strand) the first caller's continuation until it times out. Reject the duplicate.
        if (pendingCameraStatusRequests.putIfAbsent(effectiveRequestId, pending) != null) {
            throw BluetoothSdkException(
                "request_in_flight",
                "A camera warm-up request with this requestId is already waiting for a glasses response.",
            )
        }
        try {
            deviceManager.warmUpCamera(effectiveRequestId, size, mode, exposureTimeNs, durationMs, zsl, mfnr)
            return pending.await()
        } finally {
            pendingCameraStatusRequests.remove(effectiveRequestId, pending)
        }
    }

    fun stopCameraWarmUp(requestId: String) {
        val effectiveRequestId = nonBlankRequestId(requestId)
            ?: throw BluetoothSdkException("invalid_request", "A warm-up request ID is required.")
        deviceManager.stopCameraWarmUp(effectiveRequestId)
    }

    suspend fun queryGalleryStatus(): GalleryStatusEvent {
        val pending = PendingResponse<GalleryStatusEvent>("gallery status query")
        synchronized(oneShotLock) {
            if (pendingGalleryStatus != null) {
                throw BluetoothSdkException(
                    "request_in_flight",
                    "A gallery status query is already waiting for a glasses response.",
                )
            }
            pendingGalleryStatus = pending
        }
        try {
            deviceManager.queryGalleryStatus()
            return pending.await()
        } finally {
            synchronized(oneShotLock) {
                if (pendingGalleryStatus === pending) {
                    pendingGalleryStatus = null
                }
            }
        }
    }

    suspend fun startStream(request: StreamRequest): StreamStatusEvent =
        startStream(request, startSdkKeepAlive = true)

    internal suspend fun startExternallyManagedStream(request: StreamRequest): StreamStatusEvent =
        startStream(request, startSdkKeepAlive = false)

    private suspend fun startStream(
        request: StreamRequest,
        startSdkKeepAlive: Boolean,
    ): StreamStatusEvent {
        val message = request.toMap().toMutableMap()
        val streamId = (message["streamId"] as? String)?.takeIf { it.isNotBlank() }
                ?: "sdk-${UUID.randomUUID()}"
        message["streamId"] = streamId
        val pending = PendingResponse<StreamStatusEvent>("start stream $streamId")
        var start: PendingStreamStart? = null
        try {
            // seq assignment and the BLE hand-off must be one critical section:
            // rejectPreemptedStreamStarts only works if seq order equals the
            // order the commands reach the glasses' FIFO.
            synchronized(streamStartOrderLock) {
                val registered = PendingStreamStart(streamStartSeq.incrementAndGet(), pending)
                pendingStreamStarts[streamId] = registered
                start = registered
                stopStreamKeepAliveMonitor()
                deviceManager.startStream(message)
            }
            val event = pending.await(STREAM_START_TIMEOUT_MS)
            if (startSdkKeepAlive) {
                startStreamKeepAliveMonitor(streamId, DEFAULT_STREAM_KEEP_ALIVE_INTERVAL_SECONDS)
            }
            return event
        } finally {
            start?.let { pendingStreamStarts.remove(streamId, it) }
        }
    }

    internal fun sendExternallyManagedStreamKeepAlive(request: StreamKeepAliveRequest) {
        deviceManager.keepStreamAlive(request.toMap().toMutableMap())
    }

    suspend fun rgbLedControl(request: RgbLedRequest): RgbLedControlResponseEvent {
        val pending = PendingResponse<RgbLedControlResponseEvent>("RGB LED command ${request.requestId}")
        pendingRgbLedRequests[request.requestId] = pending
        try {
            deviceManager.rgbLedControl(
                request.requestId,
                request.packageName,
                request.action.value,
                request.color?.value,
                request.onDurationMs,
                request.offDurationMs,
                request.count,
            )
            return pending.await()
        } finally {
            pendingRgbLedRequests.remove(request.requestId, pending)
        }
    }

    suspend fun stopStream(): StreamStatusEvent {
        val pending = PendingResponse<StreamStatusEvent>("stop stream")
        val targetStreamId = synchronized(streamKeepAliveLock) {
            activeStreamKeepAlive?.streamId
        }
        try {
            // The seq draw and the BLE hand-off share startStream's ordering
            // critical section: the stop takes its own slot in the send order,
            // so its ack can separate the pending starts the glasses consumed
            // before it (lower seq) from starts sent after it (higher seq).
            synchronized(streamStartOrderLock) {
                synchronized(oneShotLock) {
                    if (pendingStreamStop != null) {
                        throw BluetoothSdkException(
                            "request_in_flight",
                            "A stream stop command is already waiting for a glasses response.",
                        )
                    }
                    pendingStreamStop =
                        PendingStreamStop(targetStreamId, streamStartSeq.incrementAndGet(), pending)
                }
                stopStreamKeepAliveMonitor()
                deviceManager.stopStream()
            }
            return pending.await(STREAM_STOP_TIMEOUT_MS)
        } finally {
            synchronized(oneShotLock) {
                if (pendingStreamStop?.pending === pending) {
                    pendingStreamStop = null
                }
            }
        }
    }

    suspend fun startVideoRecording(request: VideoRecordingRequest): VideoRecordingStatusEvent {
        require(request.requestId.isNotBlank()) { "requestId is required to start video recording." }
        requireGlassesConnected("start video recording")
        val pending = PendingResponse<VideoRecordingStatusEvent>("start video recording")
        val pendingRequest = PendingVideoRecordingRequest("recording_started", pending)
        if (pendingVideoRecordingRequests.putIfAbsent(request.requestId, pendingRequest) != null) {
            throw BluetoothSdkException(
                "request_in_flight",
                "A video recording command is already waiting for requestId ${request.requestId}.",
            )
        }
        try {
            deviceManager.startVideoRecording(
                    request.requestId,
                    request.save,
                    request.sound,
                    request.width,
                    request.height,
                    request.fps,
                    request.maxRecordingTimeMinutes,
            )
            return pending.await()
        } finally {
            pendingVideoRecordingRequests.remove(request.requestId, pendingRequest)
        }
    }

    @JvmOverloads
    suspend fun stopVideoRecording(
            requestId: String,
            webhookUrl: String? = null,
            authToken: String? = null,
    ): VideoRecordingStatusEvent {
        require(requestId.isNotBlank()) { "requestId is required to stop video recording." }
        requireGlassesConnected("stop video recording")
        val pending = PendingResponse<VideoRecordingStatusEvent>("stop video recording")
        val waitForUpload = !webhookUrl.isNullOrBlank()
        val pendingRequest =
            PendingVideoRecordingRequest(
                expectedStatus = "recording_stopped",
                pending = pending,
                waitForUpload = waitForUpload,
            )
        if (pendingVideoRecordingRequests.putIfAbsent(requestId, pendingRequest) != null) {
            throw BluetoothSdkException(
                "request_in_flight",
                "A video recording command is already waiting for requestId $requestId.",
            )
        }
        try {
            deviceManager.stopVideoRecording(requestId, webhookUrl, authToken)
            val timeoutMs =
                if (waitForUpload) VIDEO_UPLOAD_STOP_TIMEOUT_MS else DEFAULT_REQUEST_TIMEOUT_MS
            return pending.await(timeoutMs)
        } finally {
            pendingVideoRecordingRequests.remove(requestId, pendingRequest)
        }
    }

    suspend fun requestVersionInfo(): VersionInfoResult {
        val pending = PendingResponse<VersionInfoResult>("version info request")
        synchronized(oneShotLock) {
            if (pendingVersionInfo != null) {
                throw BluetoothSdkException(
                    "request_in_flight",
                    "A version info request is already waiting for a glasses response.",
                )
            }
            pendingVersionInfo = pending
        }
        try {
            deviceManager.requestVersionInfo()
            return pending.await()
        } finally {
            synchronized(oneShotLock) {
                if (pendingVersionInfo === pending) {
                    pendingVersionInfo = null
                }
            }
        }
    }

    internal fun setOtaVersionUrl(otaVersionUrl: String) {
        configuredOtaVersionUrl = OtaManifestChecker.normalizeHttpUrl(otaVersionUrl)
    }

    internal fun getOtaVersionUrl(): String = configuredOtaVersionUrl ?: OtaManifestDefaults.defaultOtaVersionUrl()

    /** Fetch the configured OTA manifest and return whether any ASG/BES/MTK update is available. */
    suspend fun checkForOtaUpdate(): Boolean {
        val status = getFreshGlassesStatus()
        if (!status.connected) {
            throw BluetoothSdkException(
                "glasses_not_connected",
                "Cannot check OTA update because glasses are not connected.",
            )
        }
        if (status.buildNumber.isBlank()) {
            throw BluetoothSdkException(
                "missing_glasses_version",
                "Cannot check OTA update because glasses build number is unavailable.",
            )
        }

        val manifestUrl = resolveOtaVersionUrl(status)
        val manifest = OtaManifestChecker.fetch(manifestUrl)
        val otaStatus = waitForOtaManifestStatus(status, manifest)
        return OtaManifestChecker.hasUpdate(
            otaStatus.buildNumber,
            otaStatus.mtkFirmwareVersion,
            otaStatus.besFirmwareVersion,
            manifest,
        )
    }

    /** Ask connected Mentra Live glasses to report the current OTA install/session status. */
    private suspend fun queryOtaStatus(): OtaQueryResult =
        performOtaQuery("OTA status query") {
            deviceManager.sendOtaQueryStatus()
        }

    private suspend fun performOtaQuery(
        operation: String,
        sendRequest: () -> Unit,
    ): OtaQueryResult {
        val pending = PendingResponse<OtaQueryResult>(operation)
        synchronized(oneShotLock) {
            if (pendingOtaQuery != null) {
                throw BluetoothSdkException(
                    "request_in_flight",
                    "An OTA status query is already waiting for a glasses response.",
                )
            }
            pendingOtaQuery = pending
        }
        try {
            sendRequest()
            return pending.await()
        } finally {
            synchronized(oneShotLock) {
                if (pendingOtaQuery === pending) {
                    pendingOtaQuery = null
                }
            }
        }
    }

    /** Start the OTA flow after your app has presented the available update to the user. */
    suspend fun startOtaUpdate(): OtaStartAckEvent {
        val otaVersionUrl = resolveOtaVersionUrl(getFreshGlassesStatus())
        return startOtaUpdate(otaVersionUrl)
    }

    private suspend fun startOtaCommand(otaVersionUrl: String): OtaStartAckEvent {
        val pending = PendingResponse<OtaStartAckEvent>("OTA start command")
        synchronized(oneShotLock) {
            if (pendingOtaStart != null) {
                throw BluetoothSdkException(
                    "request_in_flight",
                    "An OTA start command is already waiting for a glasses response.",
                )
            }
            pendingOtaStart = pending
        }
        try {
            deviceManager.sendOtaStart(otaVersionUrl)
            return pending.await()
        } finally {
            synchronized(oneShotLock) {
                if (pendingOtaStart === pending) {
                    pendingOtaStart = null
                }
            }
        }
    }

    internal suspend fun startOtaUpdate(otaVersionUrl: String): OtaStartAckEvent =
        startOtaCommand(otaVersionUrl)

    internal suspend fun sendOtaQueryStatus(): OtaQueryResult = queryOtaStatus()

    fun startAr99OtaFromFile(path: String): Boolean {
        requireGlassesConnected("start AR99 OTA")
        return deviceManager.startAr99OtaFromFile(path)
    }

    fun cancelAr99Ota() {
        deviceManager.cancelAr99Ota()
    }

    fun sendAr99FactoryReset() {
        requireGlassesConnected("factory reset AR99")
        deviceManager.sendAr99FactoryReset()
    }

    private suspend fun getFreshGlassesStatus(): GlassesStatus {
        val status = getRawGlassesStatus()
        if (!status.connected || status.buildNumber.isNotBlank()) {
            return status
        }

        return try {
            val versionInfo = requestVersionInfo()
            status.copy(
                androidVersion = versionInfo.androidVersion.ifBlank { status.androidVersion },
                firmwareVersion = versionInfo.firmwareVersion.ifBlank { status.firmwareVersion },
                besFirmwareVersion = versionInfo.besFirmwareVersion.ifBlank { status.besFirmwareVersion },
                mtkFirmwareVersion = versionInfo.mtkFirmwareVersion.ifBlank { status.mtkFirmwareVersion },
                buildNumber = versionInfo.buildNumber.ifBlank { status.buildNumber },
                systemTimeMs = versionInfo.systemTimeMs ?: status.systemTimeMs,
                otaVersionUrl = versionInfo.otaVersionUrl.ifBlank { status.otaVersionUrl },
                appVersion = versionInfo.appVersion.ifBlank { status.appVersion },
            )
        } catch (cancellation: CancellationException) {
            // Never swallow cancellation into the stale-status fallback: callers
            // like startOtaUpdate() would otherwise keep running side effects
            // (sendOtaStart) on behalf of an already-cancelled coroutine.
            throw cancellation
        } catch (_: Throwable) {
            status
        }
    }

    private suspend fun waitForOtaManifestStatus(
        initialStatus: GlassesStatus,
        manifest: org.json.JSONObject,
    ): GlassesStatus {
        var status = initialStatus
        if (OtaManifestChecker.hasBesFirmware(manifest) && status.besFirmwareVersion.isBlank()) {
            status = waitForGlassesStatus(status, OTA_BES_VERSION_WAIT_MS) {
                !it.connected || it.besFirmwareVersion.isNotBlank()
            }
        }

        if (OtaManifestChecker.hasMtkPatches(manifest) && status.mtkFirmwareVersion.isBlank()) {
            status = waitForGlassesStatus(status, OTA_MTK_VERSION_WAIT_MS) {
                !it.connected || it.mtkFirmwareVersion.isNotBlank()
            }
        }

        if (!status.connected) {
            throw BluetoothSdkException(
                "glasses_not_connected",
                "Cannot check OTA update because glasses disconnected.",
            )
        }
        return status
    }

    private suspend fun waitForGlassesStatus(
        initialStatus: GlassesStatus,
        timeoutMs: Long,
        isReady: (GlassesStatus) -> Boolean,
    ): GlassesStatus {
        val deadline = System.currentTimeMillis() + timeoutMs
        var status = initialStatus
        while (System.currentTimeMillis() < deadline) {
            status = getRawGlassesStatus()
            if (isReady(status)) return status
            val remainingMs = deadline - System.currentTimeMillis()
            if (remainingMs <= 0L) break
            delay(minOf(OTA_VERSION_POLL_MS, remainingMs))
        }
        return getRawGlassesStatus()
    }

    private fun resolveOtaVersionUrl(status: GlassesStatus): String {
        val deviceUrl = status.otaVersionUrl.trim()
        if (isLegacyAsgOtaStartBuild(status.buildNumber)) {
            return OtaManifestDefaults.LEGACY_PROD_OTA_VERSION_URL
        }
        // SDK consumers are pinned to the manifest built for their SDK version.
        // A future glasses-advertised URL should not silently change that pairing.
        return configuredOtaVersionUrl ?: OtaManifestDefaults.defaultOtaVersionUrl()
    }

    private fun isLegacyAsgOtaStartBuild(buildNumber: String): Boolean {
        val parsed = buildNumber.toIntOrNull()
        return parsed != null && parsed < 39
    }

    internal fun sendShutdown() {
        deviceManager.sendShutdown()
    }

    internal fun sendReboot() {
        deviceManager.sendReboot()
    }

    internal fun sendIncidentId(incidentId: String, apiBaseUrl: String? = null) {
        deviceManager.sendIncidentId(incidentId, apiBaseUrl)
    }

    override fun close() {
        stopStreamKeepAliveMonitor()
        Bridge.removeEventSink(bridgeEventSinkId)
        DeviceStore.store.removeListener(storeListenerId)
        analytics.shutdown()
        listeners.clear()
    }

    private fun dispatchStoreUpdate(category: String, changes: Map<String, Any>) {
        when (ObservableStore.normalizeCategory(category)) {
            "glasses" -> {
                analytics.observeGlassesStatus(getRawGlassesStatus())
                val state = getState()
                dispatchToListeners {
                    it.onStateChanged(state)
                    it.onGlassesChanged(state.glasses)
                }
            }
            ObservableStore.BLUETOOTH_CATEGORY -> {
                val state = getState()
                val scanChanged = changes.keys.any { it in SCAN_STATE_KEYS }
                dispatchToListeners {
                    it.onStateChanged(state)
                    it.onSdkStateChanged(state.sdk)
                    if (scanChanged) {
                        it.onScanChanged(state.scan)
                    }
                }
                if (!suppressDefaultDeviceEvents && changes.keys.any { it in DEFAULT_DEVICE_KEYS }) {
                    dispatchDefaultDeviceChanged()
                }
                dispatchDiscoveredDevices(changes["searchResults"])
            }
        }
    }

    private fun dispatchDefaultDeviceChanged() {
        val defaultDevice = currentDefaultDevice()
        dispatchToListeners { it.onDefaultDeviceChanged(defaultDevice) }
    }

    private fun currentDefaultDevice(): Device? {
        val core = DeviceStore.store.getCategory(ObservableStore.BLUETOOTH_CATEGORY)
        val model = core["default_wearable"] as? String ?: return null
        val name = core["device_name"] as? String ?: return null
        if (model.isBlank() || name.isBlank()) return null
        val address = (core["device_address"] as? String)?.takeIf { it.isNotBlank() }
        val projectName = (core["project_name"] as? String)?.takeIf { it.isNotBlank() }
        return Device(
            model = DeviceModel.fromDeviceType(model),
            name = name,
            address = address,
            projectName = projectName,
        )
    }

    private fun requireBluetoothReady(operation: String) {
        val bluetoothManager = appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter =
            bluetoothManager?.adapter
                ?: throw BluetoothSdkException(
                    "bluetooth_unsupported",
                    "This phone does not support Bluetooth.",
                )
        val enabled =
            try {
                adapter.isEnabled
            } catch (error: SecurityException) {
                throw BluetoothSdkException(
                    "bluetooth_permission_denied",
                    "Allow Bluetooth permission to $operation.",
                    error,
                )
            }
        if (!enabled) {
            throw BluetoothSdkException(
                "bluetooth_powered_off",
                "Turn on phone Bluetooth to $operation.",
            )
        }
    }

    private fun Throwable.toBluetoothError(defaultCode: String): BluetoothError =
        if (this is BluetoothSdkException) {
            BluetoothError(code, message ?: code, this)
        } else {
            BluetoothError(defaultCode, message ?: toString(), this)
        }

    private fun dispatchDiscoveredDevices(rawSearchResults: Any?) {
        val results = rawSearchResults as? List<*> ?: return
        results.forEach { rawResult ->
            val result = rawResult as? Map<*, *> ?: return@forEach
            val name = result["name"] as? String ?: return@forEach
            if (!discoveredDeviceNames.add(name)) return@forEach
            val values =
                result.entries.mapNotNull { (key, value) ->
                    if (key is String && value != null) key to value else null
                }.toMap()
            val device = Device.fromMap(values) ?: return@forEach
            dispatchToListeners { it.onDeviceDiscovered(device) }
        }
    }

    private fun dispatchBridgeEvent(eventName: String, data: Map<String, Any>) {
        when (eventName) {
            "log" -> dispatchToListeners { it.onLog(data["message"] as? String ?: data.toString()) }
            "button_press" ->
                dispatchToListeners {
                    it.onButtonPress(
                        ButtonPressEvent(
                            buttonId = data["buttonId"] as? String ?: "",
                            pressType = data["pressType"] as? String ?: "",
                            timestamp = (data["timestamp"] as? Number)?.toLong(),
                        )
                    )
                }
            "touch_event" -> {
                val event = TouchEvent(data)
                dispatchToListeners { it.onTouch(event) }
                if (event.isSwipe) {
                    dispatchToListeners { it.onSwipe(SwipeEvent(data)) }
                }
            }
            "head_up" -> dispatchToListeners { it.onHeadUpChanged(data["up"] as? Boolean ?: false) }
            "voice_activity_detection_status" ->
                dispatchToListeners {
                    it.onVoiceActivityDetectionStatus(
                        VoiceActivityDetectionStatusEvent(
                            voiceActivityDetectionEnabled =
                                data["voiceActivityDetectionEnabled"] as? Boolean
                                    ?: BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED,
                            values = data,
                        )
                    )
                }
            "speaking_status" ->
                dispatchToListeners {
                    it.onSpeakingStatus(
                        SpeakingStatusEvent(
                            speaking = data["speaking"] as? Boolean ?: false,
                            values = data,
                        )
                    )
                }
            "battery_status" ->
                dispatchToListeners {
                    it.onBatteryStatus(
                        BatteryStatusEvent(
                            level = (data["level"] as? Number)?.toInt(),
                            charging = data["charging"] as? Boolean,
                            values = data,
                        )
                    )
                }
            "wifi_status_change" -> {
                val event = WifiStatusEvent(data)
                handleWifiStatusForRequests(event)
                dispatchToListeners { it.onWifiStatusChanged(event) }
            }
            "wifi_scan_result" -> {
                val networks =
                    (data["networks"] as? List<*>)
                        ?.mapNotNull { (it as? Map<*, *>)?.stringKeyedMap() }
                        ?.map(WifiScanResult::fromMap)
                        ?: emptyList()
                val hasCompletionFlag =
                    data.containsKey("scanComplete") || data.containsKey("scan_complete")
                val scanComplete =
                    (data["scanComplete"] as? Boolean) ?: (data["scan_complete"] as? Boolean) ?: false
                val scanId = (data["scanId"] as? String)?.ifEmpty { null }
                if (scanId != null) {
                    handleCorrelatedWifiScanChunk(scanId, networks, scanComplete)
                } else {
                    // Old firmware: no correlation id, keep the pre-scanId heuristics.
                    updateWifiScanLatestResults(networks)
                    if (scanComplete || !hasCompletionFlag) {
                        handleWifiScanResultsForRequests(networks)
                    }
                }
                dispatchToListeners { it.onRawEvent(eventName, data) }
            }
            "hotspot_status_change" -> {
                val event = HotspotStatusEvent(data)
                handleHotspotStatusForRequests(event)
                dispatchToListeners { it.onHotspotStatusChanged(event) }
            }
            "hotspot_error" -> {
                val event = HotspotErrorEvent(data)
                handleHotspotErrorForRequests(event)
                dispatchToListeners { it.onHotspotError(event) }
            }
            "gallery_status" -> {
                val event = GalleryStatusEvent(data)
                synchronized(oneShotLock) {
                    pendingGalleryStatus?.resolve(event)
                }
                dispatchToListeners { it.onGalleryStatus(event) }
            }
            "photo_response" -> {
                val event = PhotoResponseEvent(data)
                handlePhotoResponseForRequests(event)
                dispatchToListeners { it.onPhotoResponse(event) }
            }
            "photo_status" -> dispatchToListeners { it.onPhotoStatus(PhotoStatusEvent(data)) }
            "camera_status" -> {
                val event = CameraStatusEvent(data)
                handleCameraStatusForRequests(event)
                dispatchToListeners { it.onCameraStatus(event) }
            }
            "video_recording_status" -> {
                val event = VideoRecordingStatusEvent(data)
                handleVideoRecordingStatusForRequests(event)
                dispatchToListeners { it.onVideoRecordingStatus(event) }
            }
            "media_success", "media_error" -> {
                val event = MediaUploadEvent(data)
                handleMediaUploadForRequests(event)
                dispatchToListeners { it.onMediaUpload(event) }
            }
            "rgb_led_control_response" -> {
                val event = RgbLedControlResponseEvent(data)
                handleRgbLedResponseForRequests(event)
                dispatchToListeners { it.onRgbLedControlResponse(event) }
            }
            "stream_status" -> {
                val event = StreamStatusEvent(data)
                handleStreamStatusForRequests(event)
                handleStreamStatusForKeepAlive(event.status)
                dispatchToListeners { it.onStreamStatus(event) }
            }
            "keep_alive_ack" -> {
                val event = KeepAliveAckEvent(data)
                if (!handleStreamKeepAliveAck(event)) {
                    dispatchToListeners { it.onKeepAliveAck(event) }
                }
            }
            "ota_start_ack" -> {
                val event = OtaStartAckEvent.fromMap(data + mapOf("type" to "ota_start_ack"))
                synchronized(oneShotLock) {
                    pendingOtaStart?.resolve(event)
                }
                dispatchToListeners { it.onOtaStartAck(event) }
            }
            "ota_status" -> {
                val resultValues = data + mapOf("type" to "ota_status")
                synchronized(oneShotLock) {
                    pendingOtaQuery?.resolve(OtaQueryResult(resultValues))
                }
                dispatchToListeners { it.onOtaStatus(OtaStatusEvent.fromMap(resultValues)) }
            }
            "settings_ack" -> {
                val event = SettingsAckEvent(data)
                handleSettingsAckForRequests(event)
                dispatchToListeners { it.onSettingsAck(event) }
            }
            "version_info" -> {
                val event = VersionInfoResult.fromMap(data)
                synchronized(oneShotLock) {
                    pendingVersionInfo?.resolve(event)
                }
                dispatchToListeners { it.onVersionInfo(event) }
            }
            "mic_pcm" -> {
                val event = MicPcmEvent(data)
                if (event.pcm.isNotEmpty()) {
                    dispatchToListeners { it.onMicPcm(event) }
                }
            }
            "mic_lc3" -> {
                val event = MicLc3Event(data)
                if (event.lc3.isNotEmpty()) {
                    dispatchToListeners { it.onMicLc3(event) }
                }
            }
            "local_transcription" ->
                dispatchToListeners {
                    it.onLocalTranscription(
                        LocalTranscriptionEvent(
                            text = data["text"] as? String ?: "",
                            isFinal = data["isFinal"] as? Boolean ?: false,
                            values = data,
                        )
                    )
                }
            "compatible_glasses_search_stop" ->
                dispatchToListeners { it.onScanStopped(ScanStopReason.COMPLETED) }
            "pair_failure" ->
                dispatchToListeners {
                    it.onError(
                        BluetoothError(
                            code = "pair_failure",
                            message = data["error"] as? String ?: data.toString(),
                        )
                    )
                }
            else -> dispatchToListeners { it.onRawEvent(eventName, data) }
        }
    }

    private fun dispatchToListeners(callback: (MentraBluetoothSdkListener) -> Unit) {
        val snapshot = synchronized(listeners) { listeners.toList() }
        val deliver = {
            snapshot.forEach { listener ->
                try {
                    callback(listener)
                } catch (error: Throwable) {
                    // Listener exceptions should not crash Bluetooth event delivery.
                }
            }
        }
        if (config.deliverCallbacksOnMainThread && Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(deliver)
        } else {
            deliver()
        }
    }

    private fun startStreamKeepAliveMonitor(streamId: String, requestedIntervalSeconds: Int) {
        val intervalSeconds =
                requestedIntervalSeconds.takeIf { it > 0 } ?: DEFAULT_STREAM_KEEP_ALIVE_INTERVAL_SECONDS
        val tracker = ActiveStreamKeepAlive(
                streamId = streamId,
                intervalMs = intervalSeconds * 1_000L,
        )
        synchronized(streamKeepAliveLock) {
            activeStreamKeepAlive = tracker
        }
        sendNextStreamKeepAlive(tracker)
    }

    private fun stopStreamKeepAliveMonitor() {
        val tracker =
                synchronized(streamKeepAliveLock) {
                    val current = activeStreamKeepAlive
                    activeStreamKeepAlive = null
                    current
                }
        tracker?.nextTick?.let { mainHandler.removeCallbacks(it) }
    }

    private fun handleStreamStatusForRequests(event: StreamStatusEvent) {
        val startMatch = matchingStreamStart(event)
        if (startMatch != null) {
            val (streamId, start) = startMatch
            // Preemption may only be inferred from states the glasses emit AFTER
            // start_stream has run stopAllServices() (see PREEMPTION_PROVEN_STATES).
            // ERROR must not fire it: a command-level preflight rejection (missing
            // URL, low battery, no WiFi) carries this start's streamId but is sent
            // BEFORE stopAllServices, so older starts were not preempted — and
            // rejecting one that already resolved and started its keep-alive
            // monitor would strand a live stream without keep-alives. STOPPED
            // must not fire it either: it is the stop-ack shape and proves
            // nothing about the start path having run.
            if (!event.streamId.isNullOrBlank() && event.state in PREEMPTION_PROVEN_STATES) {
                rejectPreemptedStreamStarts(start.seq)
            }
            when (event.state) {
                // `reconnected` also proves the stream is live: when an async start
                // failure triggers the glasses' publisher retry, a successful retry
                // reports `reconnected` instead of `streaming`.
                StreamState.STREAMING,
                StreamState.RECONNECTED -> {
                    pendingStreamStarts.remove(streamId, start)
                    start.pending.resolve(event)
                }
                StreamState.RECONNECT_FAILED,
                StreamState.STOPPED -> {
                    pendingStreamStarts.remove(streamId, start)
                    start.pending.reject(
                        streamStatusException(start.lastError ?: event, "stream_start_failed")
                    )
                }
                StreamState.ERROR -> {
                    if (!event.streamId.isNullOrBlank() && event.willRetry == true) {
                        // The glasses flag errors their publisher will retry with
                        // `willRetry` (emitting side lands in PR #3488), so keep the
                        // start pending for the retry's verdict — `reconnected` or
                        // `streaming` on success, `reconnect_failed` or the
                        // streamId-less `stopped` wind-down (which reports these
                        // stashed details) on failure.
                        start.lastError = event
                    } else {
                        // An id-less error is the glasses' command-level rejection
                        // (missing URL, low battery, no WiFi) emitted before any
                        // publisher starts; an id-carrying error without `willRetry`
                        // is terminal (`camera_busy` emits an error and nothing else).
                        // Old firmware never sends `willRetry`, so its errors always
                        // fail fast here — the shipped pre-#3487 Android behavior.
                        pendingStreamStarts.remove(streamId, start)
                        start.pending.reject(streamStatusException(event, "stream_start_failed"))
                    }
                }
                else -> Unit
            }
        }

        val stop = synchronized(oneShotLock) { pendingStreamStop }
        if (stop != null && streamStatusMatches(event, stop.streamId)) {
            when {
                isAlreadyStoppedStreamStatus(event) -> {
                    synchronized(oneShotLock) {
                        if (pendingStreamStop === stop) {
                            pendingStreamStop = null
                        }
                    }
                    rejectStreamStartsSupersededByStop(stop.seq)
                    stop.pending.resolve(stoppedStreamEvent(event, stop.streamId))
                }
                event.state == StreamState.ERROR || event.state == StreamState.RECONNECT_FAILED -> {
                    synchronized(oneShotLock) {
                        if (pendingStreamStop === stop) {
                            pendingStreamStop = null
                        }
                    }
                    stop.pending.reject(streamStatusException(event, "stream_stop_failed"))
                }
                else -> Unit
            }
        }
    }

    // The glasses process BLE commands FIFO and every start_stream begins by
    // stopping whatever runs, so an id-carrying status for start X in one of
    // these states proves every lower-seq start has already been preempted.
    // Their only verdict on current firmware is a streamId-less stopped, which
    // the id-less heuristic deliberately ignores — without this they would run
    // out the 30s timeout instead of failing fast.
    private fun rejectPreemptedStreamStarts(winnerSeq: Long) {
        for ((streamId, start) in pendingStreamStarts) {
            if (start.seq < winnerSeq && pendingStreamStarts.remove(streamId, start)) {
                start.pending.reject(
                    BluetoothSdkException(
                        "stream_preempted",
                        "start stream $streamId was preempted by a newer start_stream; " +
                            "the glasses run a single stream and the last request wins.",
                    )
                )
            }
        }
    }

    // The glasses process BLE commands FIFO, so this stop's ack also settles
    // every start sent before it: whatever those starts brought up (or would
    // have brought up) has been stopped, and no further status will arrive
    // for them. Without this they would run out the 30s start timeout.
    // Starts sent after the stop keep waiting for their own statuses.
    private fun rejectStreamStartsSupersededByStop(stopSeq: Long) {
        for ((streamId, start) in pendingStreamStarts) {
            if (start.seq < stopSeq && pendingStreamStarts.remove(streamId, start)) {
                start.pending.reject(
                    BluetoothSdkException(
                        "stream_stopped",
                        "start stream $streamId was superseded by a stop_stream issued after it.",
                    )
                )
            }
        }
    }

    private fun matchingStreamStart(event: StreamStatusEvent): Pair<String, PendingStreamStart>? {
        val streamId = event.streamId
        if (!streamId.isNullOrBlank()) {
            val start = pendingStreamStarts[streamId] ?: return null
            return streamId to start
        }
        if (event.state == StreamState.ERROR) {
            // An id-less error is a command-level preflight rejection (missing
            // URL, low battery, no WiFi) emitted synchronously, while lifecycle
            // statuses arrive async — so with overlapping starts the wire is
            // genuinely ambiguous about which start it answers. Attribute it to
            // the newest pending start: the common case is a later start
            // failing preflight while an earlier one is already emitting
            // lifecycle statuses, and at worst this swaps which start carries
            // the error instead of letting both time out.
            val entry = pendingStreamStarts.entries.maxByOrNull { it.value.seq } ?: return null
            return entry.key to entry.value
        }
        if (pendingStreamStarts.size == 1) {
            // firstOrNull: timeouts and other handler threads mutate the
            // ConcurrentHashMap concurrently, so the map can empty between the
            // size check and this read; bail out instead of throwing.
            val entry = pendingStreamStarts.entries.firstOrNull() ?: return null
            // A streamId-less STOPPED is the glasses' stop-ack for a PREVIOUS
            // stream (their stop ack carries no streamId), not a verdict on the
            // pending start — a start_stream that replaces a running publisher
            // emits exactly this sequence (stopped -> initializing -> streaming).
            // Attributing it here would reject a start that is about to succeed.
            // After a stashed `willRetry` error for the pending start, though,
            // the stopped is the retrying publisher's wind-down (the stop-ack
            // always precedes any status for the new start), so it is that
            // start's verdict.
            if (event.state == StreamState.STOPPED && entry.value.lastError == null) {
                return null
            }
            return entry.key to entry.value
        }
        return null
    }

    private fun streamStatusMatches(event: StreamStatusEvent, streamId: String?): Boolean =
        streamId.isNullOrBlank() || event.streamId.isNullOrBlank() || event.streamId == streamId

    private fun isAlreadyStoppedStreamStatus(event: StreamStatusEvent): Boolean {
        if (event.state == StreamState.STOPPED) {
            return true
        }
        val details = (event.status as? StreamStatus.Error)?.errorDetails?.lowercase()
        return details in setOf("not_streaming", "already_stopped", "not streaming")
    }

    private fun stoppedStreamEvent(event: StreamStatusEvent, streamId: String?): StreamStatusEvent =
        StreamStatusEvent(
            StreamStatus.Lifecycle(
                state = StreamState.STOPPED,
                streamId = event.streamId ?: streamId,
                timestamp = event.status.timestamp ?: System.currentTimeMillis(),
                resolvedConfig = event.resolvedConfig,
            )
        )

    private fun streamStatusException(event: StreamStatusEvent, code: String): BluetoothSdkException {
        val details = (event.status as? StreamStatus.Error)?.errorDetails
            ?: "Stream status ${event.state.value}"
        return BluetoothSdkException(code, details)
    }

    private fun handlePhotoResponseForRequests(event: PhotoResponseEvent) {
        val pending = pendingPhotoRequests[event.requestId] ?: return
        when (val response = event.response) {
            is PhotoResponse.Success -> pending.resolve(event)
            is PhotoResponse.Error ->
                pending.reject(
                    BluetoothSdkException(
                        response.errorCode ?: "photo_request_failed",
                        response.errorMessage,
                    )
                )
        }
    }

    private fun handleCameraStatusForRequests(event: CameraStatusEvent) {
        val pending = pendingCameraStatusRequests[event.requestId] ?: return
        when (event.state.lowercase()) {
            "ready" -> pending.resolve(event)
            "error" ->
                pending.reject(
                    BluetoothSdkException(
                        event.errorCode ?: "camera_warm_up_failed",
                        event.errorMessage ?: "Camera warm-up failed.",
                    )
                )
            // "warming"/"stopped" are progress updates; leave the pending promise alone.
            else -> {}
        }
    }

    private fun handleVideoRecordingStatusForRequests(event: VideoRecordingStatusEvent) {
        val request = pendingVideoRecordingRequests[event.requestId] ?: return
        if (event.success) {
            if (event.status == request.expectedStatus) {
                if (request.waitForUpload) {
                    request.stoppedEvent = event
                    if (request.uploadSucceeded) {
                        request.pending.resolve(event)
                    }
                } else {
                    request.pending.resolve(event)
                }
            }
        } else {
            request.pending.reject(
                BluetoothSdkException(
                    event.status.ifBlank { "video_recording_failed" },
                    event.details ?: "Video recording command failed.",
                )
            )
        }
    }

    private fun handleMediaUploadForRequests(event: MediaUploadEvent) {
        if (!event.isVideo) return
        val request = pendingVideoRecordingRequests[event.requestId] ?: return
        if (!request.waitForUpload) return
        if (event.isSuccess) {
            val stoppedEvent = request.stoppedEvent
            if (stoppedEvent != null) {
                request.pending.resolve(stoppedEvent)
            } else {
                request.uploadSucceeded = true
            }
        } else {
            request.pending.reject(
                BluetoothSdkException(
                    "video_upload_failed",
                    event.errorMessage ?: "Video upload failed.",
                )
            )
        }
    }

    private fun handleRgbLedResponseForRequests(event: RgbLedControlResponseEvent) {
        val pending = pendingRgbLedRequests[event.requestId] ?: return
        if (event.state == "success") {
            pending.resolve(event)
        } else {
            pending.reject(
                BluetoothSdkException(
                    event.errorCode ?: "rgb_led_control_failed",
                    event.errorCode ?: "RGB LED command failed.",
                )
            )
        }
    }

    private fun handleSettingsAckForRequests(event: SettingsAckEvent) {
        val pending = pendingSettingsRequests[event.requestId] ?: return
        if (isFailureStatus(event.status)) {
            pending.reject(
                BluetoothSdkException(
                    event.errorCode ?: "${event.setting.ifBlank { "settings" }}_failed",
                    event.errorMessage ?: "Settings command ${event.setting.ifBlank { event.requestId }} failed.",
                )
            )
        } else {
            pending.resolve(event)
        }
    }

    private fun isFailureStatus(status: String): Boolean =
        status.lowercase() in setOf("error", "failed", "failure", "rejected")

    private fun handleWifiScanResultsForRequests(results: List<WifiScanResult>) {
        val request = synchronized(oneShotLock) { pendingWifiScan } ?: return
        synchronized(oneShotLock) {
            if (pendingWifiScan === request) {
                pendingWifiScan = null
            }
        }
        request.pending.resolve(results)
    }

    // scanId-echoing glasses: results for another scan are ignored instead of
    // resolving the pending request, and matching chunks accumulate until the
    // glasses flag the scan complete.
    private fun handleCorrelatedWifiScanChunk(
        scanId: String,
        results: List<WifiScanResult>,
        scanComplete: Boolean,
    ) {
        val request: PendingWifiScan
        val accumulated: List<WifiScanResult>
        synchronized(oneShotLock) {
            request = pendingWifiScan?.takeIf { it.scanId == scanId } ?: return
            for (network in results) {
                if (request.accumulated.none { it.ssid == network.ssid }) {
                    request.accumulated.add(network)
                }
            }
            accumulated = request.accumulated.toList()
            if (accumulated.isNotEmpty()) {
                request.latestResults = accumulated
            }
            if (!scanComplete) return
            if (pendingWifiScan === request) {
                pendingWifiScan = null
            }
        }
        request.pending.resolve(accumulated)
    }

    private fun updateWifiScanLatestResults(results: List<WifiScanResult>) {
        if (results.isEmpty()) return
        synchronized(oneShotLock) {
            pendingWifiScan?.latestResults = results
        }
    }

    private fun handleWifiStatusForRequests(event: WifiStatusEvent) {
        val request = synchronized(oneShotLock) { pendingWifiStatus } ?: return
        // A wifi_status carrying the explicit error field is the glasses' failure
        // verdict for the in-flight connect: reject now instead of running out the
        // request timeout. Only the error field counts as failure — the glasses'
        // connect sequence emits a debounced bare connected=false ~1-2s after
        // credentials while association is still in progress, and rejecting on that
        // would kill every connect attempt early.
        if (request.operation == WifiStatusOperation.CONNECT && event.error != null) {
            synchronized(oneShotLock) {
                if (pendingWifiStatus === request) {
                    pendingWifiStatus = null
                }
            }
            request.pending.reject(
                BluetoothSdkException(
                    event.error,
                    "Glasses failed to join \"${request.ssid}\": ${event.error}",
                )
            )
            return
        }
        if (!wifiStatusMatches(event.status, request)) return
        synchronized(oneShotLock) {
            if (pendingWifiStatus === request) {
                pendingWifiStatus = null
            }
        }
        request.pending.resolve(event)
    }

    private fun wifiStatusMatches(status: WifiStatus, request: PendingWifiStatusRequest): Boolean =
        when (request.operation) {
            WifiStatusOperation.CONNECT ->
                status is WifiStatus.Connected && status.ssid == request.ssid
            WifiStatusOperation.FORGET ->
                status == WifiStatus.Disconnected || (status is WifiStatus.Connected && status.ssid != request.ssid)
        }

    private fun handleHotspotStatusForRequests(event: HotspotStatusEvent) {
        val request = synchronized(oneShotLock) { pendingHotspotStatus } ?: return
        if (!hotspotStatusMatches(event.status, request.enabled)) return
        synchronized(oneShotLock) {
            if (pendingHotspotStatus === request) {
                pendingHotspotStatus = null
            }
        }
        request.pending.resolve(event)
    }

    private fun hotspotStatusMatches(status: HotspotStatus, enabled: Boolean): Boolean =
        if (enabled) {
            status is HotspotStatus.Enabled
        } else {
            status == HotspotStatus.Disabled
        }

    private fun handleHotspotErrorForRequests(event: HotspotErrorEvent) {
        val request = synchronized(oneShotLock) { pendingHotspotStatus } ?: return
        synchronized(oneShotLock) {
            if (pendingHotspotStatus === request) {
                pendingHotspotStatus = null
            }
        }
        request.pending.reject(
            BluetoothSdkException(
                "hotspot_command_failed",
                event.message ?: "Hotspot command failed.",
            )
        )
    }

    private fun sendNextStreamKeepAlive(tracker: ActiveStreamKeepAlive) {
        var timeoutEvent: StreamStatusEvent? = null
        var request: StreamKeepAliveRequest? = null

        synchronized(streamKeepAliveLock) {
            if (activeStreamKeepAlive !== tracker) {
                return
            }

            if (tracker.armed && tracker.pendingAckId != null) {
                tracker.missedAckCount += 1
                if (tracker.missedAckCount >= MAX_MISSED_STREAM_KEEP_ALIVE_ACKS) {
                    activeStreamKeepAlive = null
                    tracker.nextTick?.let { mainHandler.removeCallbacks(it) }
                    timeoutEvent =
                            StreamStatusEvent(
                                    StreamStatus.Error(
                                            streamId = tracker.streamId,
                                            errorDetails =
                                                    "Stream keep-alive timed out after ${tracker.missedAckCount} missed ACKs",
                                            timestamp = System.currentTimeMillis(),
                                            resolvedConfig = null,
                                    )
                            )
                    return@synchronized
                }
            }

            val ackId = "ack-${System.currentTimeMillis()}"
            tracker.pendingAckId = ackId
            request = StreamKeepAliveRequest(streamId = tracker.streamId, ackId = ackId)
            val nextTick = Runnable { sendNextStreamKeepAlive(tracker) }
            tracker.nextTick = nextTick
            mainHandler.postDelayed(nextTick, tracker.intervalMs)
        }

        timeoutEvent?.let { event ->
            dispatchToListeners { it.onStreamStatus(event) }
            stopStreamKeepAliveMonitor()
            deviceManager.stopStream()
            return
        }

        request?.let { keepAlive ->
            deviceManager.keepStreamAlive(keepAlive.toMap().toMutableMap())
        }
    }

    private fun handleStreamKeepAliveAck(event: KeepAliveAckEvent): Boolean {
        synchronized(streamKeepAliveLock) {
            val tracker = activeStreamKeepAlive ?: return false
            if (event.streamId != tracker.streamId || event.ackId != tracker.pendingAckId) {
                return false
            }
            tracker.pendingAckId = null
            tracker.missedAckCount = 0
            return true
        }
    }

    private fun handleStreamStatusForKeepAlive(status: StreamStatus) {
        val streamId = status.streamId
        val activeStreamId = synchronized(streamKeepAliveLock) { activeStreamKeepAlive?.streamId }
        if (streamId == null || activeStreamId != streamId) {
            return
        }
        when (status.state) {
            StreamState.STOPPED,
            StreamState.STOPPING,
            StreamState.ERROR,
            StreamState.RECONNECT_FAILED -> stopStreamKeepAliveMonitor()
            // A non-terminal status means the stream is live or coming up and the glasses can
            // now ACK; arm the missed-ACK detector from here so a slow startup before the first
            // ACK can't trip a false keep-alive timeout. On the arming transition, drop any
            // pre-arm bookkeeping so a stale unacked id (sent before the glasses could ACK)
            // can't immediately count as a miss.
            else ->
                    synchronized(streamKeepAliveLock) {
                        activeStreamKeepAlive?.let {
                            if (it.streamId == streamId && !it.armed) {
                                it.armed = true
                                it.pendingAckId = null
                                it.missedAckCount = 0
                            }
                        }
                    }
        }
    }
}



