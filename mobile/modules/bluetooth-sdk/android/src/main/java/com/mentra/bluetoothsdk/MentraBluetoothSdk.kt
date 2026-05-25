package com.mentra.bluetoothsdk

import android.bluetooth.BluetoothManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import com.mentra.bluetoothsdk.utils.ControllerTypes
import com.mentra.bluetoothsdk.utils.PhoneAudioMonitor
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean

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
    private val discoveredDeviceNames = mutableSetOf<String>()
    private val bridgeEventSinkId: String
    private val storeListenerId: String
    private var suppressDefaultDeviceEvents = false

    init {
        listeners.add(listener)
        Bridge.initialize(appContext)
        deviceManager = DeviceManager.getInstance()
        bridgeEventSinkId = Bridge.addEventSink { eventName, data -> dispatchBridgeEvent(eventName, data) }
        storeListenerId = DeviceStore.store.addListener { category, changes -> dispatchStoreUpdate(category, changes) }
    }

    companion object {
        private val DEFAULT_DEVICE_KEYS = setOf("default_wearable", "device_name", "device_address")
        private val SCAN_STATE_KEYS = setOf("searching", "searchingController", "searchResults")
        private const val DEFAULT_SCAN_TIMEOUT_MS = 15_000L

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
                ?: throw BluetoothException(
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

    fun setHeadUpAngle(angleDegrees: Int) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "head_up_angle", angleDegrees)
    }

    fun setScreenDisabled(disabled: Boolean) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "screen_disabled", disabled)
    }

    fun setGalleryModeEnabled(enabled: Boolean) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "gallery_mode", enabled)
    }

    fun setVoiceActivityDetectionEnabled(enabled: Boolean) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "voice_activity_detection_enabled", enabled)
    }

    fun setButtonPhotoSettings(size: ButtonPhotoSize) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_size", size.value)
    }

    fun setButtonPhotoSettings(settings: ButtonPhotoSettings) {
        setButtonPhotoSettings(size = settings.size)
    }

    fun setButtonVideoRecordingSettings(width: Int, height: Int, fps: Int) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "button_video_width", width)
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "button_video_height", height)
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "button_video_fps", fps)
    }

    fun setButtonVideoRecordingSettings(settings: ButtonVideoRecordingSettings) {
        setButtonVideoRecordingSettings(width = settings.width, height = settings.height, fps = settings.fps)
    }

    fun setButtonCameraLed(enabled: Boolean) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "button_camera_led", enabled)
    }

    fun setButtonMaxRecordingTime(minutes: Int) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "button_max_recording_time", minutes)
    }

    fun setCameraFov(fov: CameraFov) {
        DeviceStore.apply(
            ObservableStore.BLUETOOTH_CATEGORY,
            "camera_fov",
            mapOf("fov" to fov.fov, "roi_position" to fov.roiPosition),
        )
    }

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

    fun requestWifiScan() {
        deviceManager.requestWifiScan()
    }

    fun sendWifiCredentials(ssid: String, password: String) {
        deviceManager.sendWifiCredentials(ssid, password)
    }

    fun forgetWifiNetwork(ssid: String) {
        deviceManager.forgetWifiNetwork(ssid)
    }

    fun setHotspotState(enabled: Boolean) {
        deviceManager.setHotspotState(enabled)
    }

    fun requestPhoto(request: PhotoRequest) {
        Bridge.log(
            "NATIVE: PHOTO PIPELINE [3b/6] MentraBluetoothSdk.requestPhoto requestId=${request.requestId} appId=${request.appId}"
        )
        deviceManager.requestPhoto(
            request.requestId,
            request.appId,
            request.size.value,
            request.webhookUrl,
            request.authToken,
            request.compress.value,
            request.flash,
            request.sound,
            request.exposureTimeNs,
        )
    }

    fun queryGalleryStatus() {
        deviceManager.queryGalleryStatus()
    }

    fun startStream(request: StreamRequest) {
        deviceManager.startStream(request.toMap().toMutableMap())
    }

    fun keepStreamAlive(request: StreamKeepAliveRequest) {
        deviceManager.keepStreamAlive(request.toMap().toMutableMap())
    }

    fun rgbLedControl(request: RgbLedRequest) {
        deviceManager.rgbLedControl(
            request.requestId,
            request.packageName,
            request.action.value,
            request.color?.value,
            request.onDurationMs,
            request.offDurationMs,
            request.count,
        )
    }

    fun stopStream() {
        deviceManager.stopStream()
    }

    fun startVideoRecording(request: VideoRecordingRequest) {
        deviceManager.startVideoRecording(request.requestId, request.save, request.sound)
    }

    fun stopVideoRecording(requestId: String) {
        deviceManager.stopVideoRecording(requestId)
    }

    fun requestVersionInfo() {
        deviceManager.requestVersionInfo()
    }

    internal fun sendOtaStart() {
        deviceManager.sendOtaStart()
    }

    internal fun sendOtaQueryStatus() {
        deviceManager.sendOtaQueryStatus()
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
        Bridge.removeEventSink(bridgeEventSinkId)
        DeviceStore.store.removeListener(storeListenerId)
        listeners.clear()
    }

    private fun dispatchStoreUpdate(category: String, changes: Map<String, Any>) {
        when (ObservableStore.normalizeCategory(category)) {
            "glasses" -> {
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
        return Device(
            model = DeviceModel.fromDeviceType(model),
            name = name,
            address = address,
        )
    }

    private fun requireBluetoothReady(operation: String) {
        val bluetoothManager = appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter =
            bluetoothManager?.adapter
                ?: throw BluetoothException(
                    "bluetooth_unsupported",
                    "This phone does not support Bluetooth.",
                )
        val enabled =
            try {
                adapter.isEnabled
            } catch (error: SecurityException) {
                throw BluetoothException(
                    "bluetooth_permission_denied",
                    "Allow Bluetooth permission to $operation.",
                    error,
                )
            }
        if (!enabled) {
            throw BluetoothException(
                "bluetooth_powered_off",
                "Turn on phone Bluetooth to $operation.",
            )
        }
    }

    private fun Throwable.toBluetoothError(defaultCode: String): BluetoothError =
        if (this is BluetoothException) {
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
                                data["voiceActivityDetectionEnabled"] as? Boolean ?: true,
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
            "wifi_status_change" -> dispatchToListeners { it.onWifiStatusChanged(WifiStatusEvent(data)) }
            "hotspot_status_change" -> dispatchToListeners { it.onHotspotStatusChanged(HotspotStatusEvent(data)) }
            "hotspot_error" -> dispatchToListeners { it.onHotspotError(HotspotErrorEvent(data)) }
            "gallery_status" -> dispatchToListeners { it.onGalleryStatus(GalleryStatusEvent(data)) }
            "photo_response" -> dispatchToListeners { it.onPhotoResponse(PhotoResponseEvent(data)) }
            "stream_status" -> dispatchToListeners { it.onStreamStatus(StreamStatusEvent(data)) }
            "keep_alive_ack" -> dispatchToListeners { it.onKeepAliveAck(KeepAliveAckEvent(data)) }
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
}
