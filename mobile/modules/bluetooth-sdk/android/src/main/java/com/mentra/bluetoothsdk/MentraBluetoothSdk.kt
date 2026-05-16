package com.mentra.core

import android.bluetooth.BluetoothManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import com.mentra.core.utils.ControllerTypes
import com.mentra.core.utils.PhoneAudioMonitor
import java.util.Collections

class MentraBluetoothSdk private constructor(
    context: Context,
    private val config: MentraBluetoothSdkConfig,
    listener: MentraBluetoothSdkListener,
) : AutoCloseable {
    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val deviceManager: CoreManager
    private val listeners =
        Collections.synchronizedSet(mutableSetOf<MentraBluetoothSdkListener>())
    private val discoveredDeviceNames = mutableSetOf<String>()
    private val bridgeEventSinkId: String
    private val storeListenerId: String
    private var suppressDefaultDeviceEvents = false

    init {
        listeners.add(listener)
        Bridge.initialize(appContext)
        deviceManager = CoreManager.getInstance()
        bridgeEventSinkId = Bridge.addEventSink { eventName, data -> dispatchBridgeEvent(eventName, data) }
        storeListenerId = GlassesStore.store.addListener { category, changes -> dispatchStoreUpdate(category, changes) }
    }

    companion object {
        private val DEFAULT_DEVICE_KEYS = setOf("default_wearable", "device_name", "device_address")

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

    fun getGlassesStatus(): GlassesStatus =
        GlassesStatus.fromMap(GlassesStore.store.getCategory("glasses"))

    fun getBluetoothStatus(): BluetoothStatus =
        BluetoothStatus.fromMap(GlassesStore.store.getCategory(ObservableStore.CORE_CATEGORY))

    fun getDefaultDevice(): Device? = currentDefaultDevice()

    fun setDefaultDevice(device: Device?) {
        if (device == null) {
            clearDefaultDevice()
            return
        }
        suppressDefaultDeviceEvents = true
        try {
            GlassesStore.apply(ObservableStore.CORE_CATEGORY, "default_wearable", device.model.deviceType)
            GlassesStore.apply(ObservableStore.CORE_CATEGORY, "device_name", device.name)
            GlassesStore.apply(ObservableStore.CORE_CATEGORY, "device_address", device.address ?: "")
        } finally {
            suppressDefaultDeviceEvents = false
        }
        dispatchDefaultDeviceChanged()
    }

    fun clearDefaultDevice() {
        suppressDefaultDeviceEvents = true
        try {
            GlassesStore.apply(ObservableStore.CORE_CATEGORY, "default_wearable", "")
            GlassesStore.apply(ObservableStore.CORE_CATEGORY, "device_name", "")
            GlassesStore.apply(ObservableStore.CORE_CATEGORY, "device_address", "")
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
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "searching", true)
        deviceManager.findCompatibleDevices(model.deviceType)
    }

    fun stopScan() {
        deviceManager.stopScan()
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "searching", false)
        dispatchToListeners { it.onScanStopped(ScanStopReason.CANCELLED) }
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
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "pending_wearable", device.model.deviceType)
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

    fun connectSimulated() {
        deviceManager.connectSimulated()
    }

    fun disconnect() {
        deviceManager.disconnect()
    }

    fun forget() {
        deviceManager.forget()
    }

    fun displayText(request: DisplayTextRequest) {
        deviceManager.displayText(request.toMap())
    }

    fun displayEvent(request: DisplayEventRequest) {
        deviceManager.displayEvent(request.toMap())
    }

    fun clearDisplay() {
        deviceManager.clearDisplay()
    }

    fun showDashboard() {
        deviceManager.showDashboard()
    }

    @JvmOverloads
    fun setBrightness(level: Int, autoMode: Boolean? = null) {
        autoMode?.let { GlassesStore.apply(ObservableStore.CORE_CATEGORY, "auto_brightness", it) }
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "brightness", level)
    }

    fun setAutoBrightness(enabled: Boolean) {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "auto_brightness", enabled)
    }

    fun setDashboardPosition(request: DashboardPositionRequest) {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "dashboard_height", request.height)
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "dashboard_depth", request.depth)
    }

    fun setDashboardMenu(items: List<DashboardMenuItem>) {
        GlassesStore.apply(
            ObservableStore.CORE_CATEGORY,
            "menu_apps",
            items.map { it.toMap() },
        )
    }

    fun setHeadUpAngle(angleDegrees: Int) {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "head_up_angle", angleDegrees)
    }

    fun setScreenDisabled(disabled: Boolean) {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "screen_disabled", disabled)
    }

    fun setGalleryMode(mode: GalleryMode) {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "gallery_mode", mode == GalleryMode.AUTO)
    }

    fun setButtonPhotoSettings(settings: ButtonPhotoSettings) {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "button_photo_size", settings.size.value)
    }

    fun setButtonVideoRecordingSettings(settings: ButtonVideoRecordingSettings) {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "button_video_width", settings.width)
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "button_video_height", settings.height)
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "button_video_fps", settings.fps)
    }

    fun setButtonCameraLed(enabled: Boolean) {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "button_camera_led", enabled)
    }

    fun setButtonMaxRecordingTime(minutes: Int) {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "button_max_recording_time", minutes)
    }

    fun setCameraFov(fov: CameraFov) {
        GlassesStore.apply(
            ObservableStore.CORE_CATEGORY,
            "camera_fov",
            mapOf("fov" to fov.fov, "roi_position" to fov.roiPosition),
        )
    }

    fun setMicState(config: MicConfig) {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "should_send_pcm", config.sendPcmData)
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "should_send_lc3", config.sendLc3Data)
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "should_send_transcript", config.sendTranscript)
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "bypass_vad", config.bypassVad)
        deviceManager.setMicState()
    }

    fun setPreferredMic(preferredMic: MicPreference) {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "preferred_mic", preferredMic.value)
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
        deviceManager.photoRequest(
            request.requestId,
            request.appId,
            request.size.value,
            request.webhookUrl,
            request.authToken,
            request.compress.value,
            request.flash,
            request.sound,
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
            request.ontime,
            request.offtime,
            request.count,
        )
    }

    fun stopStream() {
        deviceManager.stopStream()
    }

    fun startVideoRecording(request: VideoRecordingRequest) {
        deviceManager.startVideoRecording(request.requestId, request.save, request.flash, request.sound)
    }

    fun stopVideoRecording(requestId: String) {
        deviceManager.stopVideoRecording(requestId)
    }

    fun requestVersionInfo() {
        deviceManager.requestVersionInfo()
    }

    fun sendOtaStart() {
        deviceManager.sendOtaStart()
    }

    fun sendOtaQueryStatus() {
        deviceManager.sendOtaQueryStatus()
    }

    fun sendShutdown() {
        deviceManager.sendShutdown()
    }

    fun sendReboot() {
        deviceManager.sendReboot()
    }

    fun sendIncidentId(incidentId: String, apiBaseUrl: String? = null) {
        deviceManager.sendIncidentId(incidentId, apiBaseUrl)
    }

    override fun close() {
        Bridge.removeEventSink(bridgeEventSinkId)
        GlassesStore.store.removeListener(storeListenerId)
        listeners.clear()
    }

    private fun dispatchStoreUpdate(category: String, changes: Map<String, Any>) {
        when (ObservableStore.normalizeCategory(category)) {
            "glasses" ->
                dispatchToListeners {
                    it.onGlassesStatusChanged(GlassesStatusUpdate.fromMap(glassesStatusChanges(changes)))
                }
            ObservableStore.CORE_CATEGORY -> {
                dispatchToListeners {
                    it.onBluetoothStatusChanged(BluetoothStatusUpdate.fromMap(changes))
                }
                if (!suppressDefaultDeviceEvents && changes.keys.any { it in DEFAULT_DEVICE_KEYS }) {
                    dispatchDefaultDeviceChanged()
                }
                dispatchDiscoveredDevices(changes["searchResults"])
            }
        }
    }

    private fun glassesStatusChanges(changes: Map<String, Any>): Map<String, Any> {
        var merged = changes

        if (changes.keys.any { it in setOf("wifiConnected", "wifiSsid", "wifiLocalIp") }) {
            merged =
                merged +
                    mapOf(
                        "wifiConnected" to ((GlassesStore.get("glasses", "wifiConnected") as? Boolean) ?: false),
                        "wifiSsid" to ((GlassesStore.get("glasses", "wifiSsid") as? String) ?: ""),
                        "wifiLocalIp" to ((GlassesStore.get("glasses", "wifiLocalIp") as? String) ?: ""),
                    )
        }

        if (changes.containsKey("signalStrengthUpdatedAt") && !changes.containsKey("signalStrength")) {
            val signalStrength = (GlassesStore.get("glasses", "signalStrength") as? Number)?.toInt() ?: -1
            merged = merged + ("signalStrength" to signalStrength)
        }

        return merged
    }

    private fun dispatchDefaultDeviceChanged() {
        val defaultDevice = currentDefaultDevice()
        dispatchToListeners { it.onDefaultDeviceChanged(defaultDevice) }
    }

    private fun currentDefaultDevice(): Device? {
        val core = GlassesStore.store.getCategory(ObservableStore.CORE_CATEGORY)
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

    private fun dispatchDiscoveredDevices(rawSearchResults: Any?) {
        val results = rawSearchResults as? List<*> ?: return
        results.forEach { rawResult ->
            val result = rawResult as? Map<*, *> ?: return@forEach
            val name = result["deviceName"] as? String ?: result["name"] as? String ?: return@forEach
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
            "mic_pcm" -> (data["pcm"] as? ByteArray)?.let { frame ->
                dispatchToListeners { it.onMicPcm(frame) }
            }
            "mic_lc3" -> (data["lc3"] as? ByteArray)?.let { frame ->
                dispatchToListeners { it.onMicLc3(frame) }
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
