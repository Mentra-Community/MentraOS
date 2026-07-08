@file:Suppress("FunctionName")

package com.mentra.bluetoothsdk

import com.mentra.bluetoothsdk.debug.BleTraceLogger
import com.mentra.bluetoothsdk.utils.DeviceTypes
import com.mentra.bluetoothsdk.utils.audio.PcmStreamManager
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.modules.ModuleDefinitionBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// Expo has no module-level error mapper, so SDK-backed registrations translate
// core exceptions here while keeping Expo types out of the native SDK API.
private inline fun <T> withExpoSdkError(block: () -> T): T =
        try {
            block()
        } catch (error: BluetoothSdkException) {
            throw CodedException(error.code, error.message ?: error.code, error)
        }

private suspend inline fun <T> withExpoSdkErrorSuspend(crossinline block: suspend () -> T): T =
        try {
            block()
        } catch (error: BluetoothSdkException) {
            throw CodedException(error.code, error.message ?: error.code, error)
        }

private inline fun <reified R> ModuleDefinitionBuilder.SdkAsyncFunction(
    name: String,
    crossinline body: () -> R,
) = AsyncFunction<R>(name) { withExpoSdkError { body() } }

private inline fun <reified R, reified P0> ModuleDefinitionBuilder.SdkAsyncFunction(
    name: String,
    crossinline body: (P0) -> R,
) = AsyncFunction<R, P0>(name) { p0 -> withExpoSdkError { body(p0) } }

private inline fun <reified R, reified P0, reified P1> ModuleDefinitionBuilder.SdkAsyncFunction(
    name: String,
    crossinline body: (P0, P1) -> R,
) = AsyncFunction<R, P0, P1>(name) { p0, p1 -> withExpoSdkError { body(p0, p1) } }

private inline fun <reified R, reified P0, reified P1, reified P2> ModuleDefinitionBuilder.SdkAsyncFunction(
    name: String,
    crossinline body: (P0, P1, P2) -> R,
) = AsyncFunction<R, P0, P1, P2>(name) { p0, p1, p2 -> withExpoSdkError { body(p0, p1, p2) } }

private inline fun <reified R, reified P0, reified P1, reified P2, reified P3>
    ModuleDefinitionBuilder.SdkAsyncFunction(
        name: String,
        crossinline body: (P0, P1, P2, P3) -> R,
    ) = AsyncFunction<R, P0, P1, P2, P3>(name) { p0, p1, p2, p3 ->
        withExpoSdkError { body(p0, p1, p2, p3) }
    }

private inline fun <
    reified R,
    reified P0,
    reified P1,
    reified P2,
    reified P3,
    reified P4,
    reified P5,
    reified P6,
> ModuleDefinitionBuilder.SdkAsyncFunction(
    name: String,
    crossinline body: (P0, P1, P2, P3, P4, P5, P6) -> R,
) = AsyncFunction<R, P0, P1, P2, P3, P4, P5, P6>(name) { p0, p1, p2, p3, p4, p5, p6 ->
    withExpoSdkError { body(p0, p1, p2, p3, p4, p5, p6) }
}

private inline fun <reified R> ModuleDefinitionBuilder.SdkFunction(
    name: String,
    crossinline body: () -> R,
) = Function<R>(name) { withExpoSdkError { body() } }

private inline fun <reified R, reified P0> ModuleDefinitionBuilder.SdkFunction(
    name: String,
    crossinline body: (P0) -> R,
) = Function<R, P0>(name) { p0 -> withExpoSdkError { body(p0) } }

private inline fun <reified R> ModuleDefinitionBuilder.SdkCoroutineFunction(
    name: String,
    crossinline body: suspend () -> R,
) = AsyncFunction(name) Coroutine { -> withExpoSdkErrorSuspend { body() } }

class BluetoothSdkModule : Module() {
    private var sdk: MentraBluetoothSdk? = null
    private var deviceManager: DeviceManager? = null
    private val sdkListener =
            object : MentraBluetoothSdkListener {
                override fun onGlassesChanged(glasses: GlassesRuntimeState) {
                    sendEvent(
                            "glasses_status",
                            sdk?.getRawGlassesStatus()?.toMap()
                                    ?: GlassesStatus.fromMap(DeviceStore.store.getCategory("glasses")).toMap()
                    )
                }

                override fun onSdkStateChanged(sdkState: PhoneSdkRuntimeState) {
                    sendEvent(
                            "bluetooth_status",
                            sdk?.getRawBluetoothStatus()?.toMap()
                                    ?: BluetoothStatus.fromMap(
                                                    DeviceStore.store.getCategory(ObservableStore.BLUETOOTH_CATEGORY)
                                            )
                                            .toMap()
                    )
                }

                override fun onDeviceDiscovered(device: Device) {
                    sendEvent("device_discovered", device.toMap())
                }

                override fun onDefaultDeviceChanged(device: Device?) {
                    val event =
                            buildMap<String, Any> {
                                device?.let { put("device", it.toMap()) }
                            }
                    sendEvent("default_device_changed", event)
                }

                override fun onScanStopped(reason: ScanStopReason) {
                    if (reason == ScanStopReason.COMPLETED) {
                        val status = sdk?.getRawBluetoothStatus()
                        val deviceModel =
                                status?.pendingWearable?.takeIf { it.isNotBlank() }
                                        ?: status?.defaultWearable
                                        ?: ""
                        sendEvent(
                                "compatible_glasses_search_stop",
                                mapOf(
                                        "type" to "compatible_glasses_search_stop",
                                        "deviceModel" to deviceModel,
                                )
                        )
                    }
                }

                override fun onButtonPress(event: ButtonPressEvent) {
                    sendEvent(
                            "button_press",
                            mapOf(
                                    "buttonId" to event.buttonId,
                                    "pressType" to event.pressType,
                                    "timestamp" to (event.timestamp ?: System.currentTimeMillis())
                            )
                    )
                }

                override fun onTouch(event: TouchEvent) {
                    sendEvent("touch_event", event.values)
                }

                override fun onHeadUpChanged(headUp: Boolean) {
                    sendEvent("head_up", mapOf("up" to headUp))
                }

                override fun onVoiceActivityDetectionStatus(event: VoiceActivityDetectionStatusEvent) {
                    sendEvent("voice_activity_detection_status", event.values)
                }

                override fun onSpeakingStatus(event: SpeakingStatusEvent) {
                    sendEvent("speaking_status", event.values)
                }

                override fun onBatteryStatus(event: BatteryStatusEvent) {
                    sendEvent("battery_status", event.values)
                }

                override fun onWifiStatusChanged(event: WifiStatusEvent) {
                    sendEvent("wifi_status_change", event.values)
                }

                override fun onHotspotStatusChanged(event: HotspotStatusEvent) {
                    sendEvent("hotspot_status_change", event.values)
                }

                override fun onHotspotError(event: HotspotErrorEvent) {
                    sendEvent("hotspot_error", event.values)
                }

                override fun onGalleryStatus(event: GalleryStatusEvent) {
                    sendEvent("gallery_status", event.values)
                }

                override fun onPhotoResponse(event: PhotoResponseEvent) {
                    sendEvent("photo_response", event.values)
                }

                override fun onPhotoStatus(event: PhotoStatusEvent) {
                    sendEvent("photo_status", event.values)
                }

                override fun onCameraStatus(event: CameraStatusEvent) {
                    sendEvent("camera_status", event.values)
                }

                override fun onVideoRecordingStatus(event: VideoRecordingStatusEvent) {
                    sendEvent("video_recording_status", event.values)
                }

                override fun onMediaUpload(event: MediaUploadEvent) {
                    sendEvent(event.type, event.values)
                }

                override fun onRgbLedControlResponse(event: RgbLedControlResponseEvent) {
                    sendEvent("rgb_led_control_response", event.values)
                }

                override fun onStreamStatus(event: StreamStatusEvent) {
                    sendEvent("stream_status", event.values)
                }

                override fun onKeepAliveAck(event: KeepAliveAckEvent) {
                    sendEvent("keep_alive_ack", event.values)
                }

                override fun onOtaStartAck(event: OtaStartAckEvent) {
                    sendEvent("ota_start_ack", event.values)
                }

                override fun onOtaStatus(event: OtaStatusEvent) {
                    sendEvent("ota_status", event.values)
                }

                override fun onSettingsAck(event: SettingsAckEvent) {
                    sendEvent("settings_ack", event.values)
                }

                override fun onVersionInfo(event: VersionInfoResult) {
                    sendEvent("version_info", event.toMap() + mapOf("type" to "version_info"))
                }

                override fun onMicPcm(event: MicPcmEvent) {
                    sendEvent("mic_pcm", event.toMap())
                }

                override fun onMicLc3(event: MicLc3Event) {
                    sendEvent("mic_lc3", event.toMap())
                }

                override fun onLocalTranscription(event: LocalTranscriptionEvent) {
                    sendEvent("local_transcription", event.values)
                }

                override fun onLog(message: String) {
                    sendEvent("log", mapOf("message" to message))
                }

                override fun onError(error: BluetoothError) {
                    sendEvent("pair_failure", mapOf("error" to error.message))
                }

                override fun onRawEvent(eventName: String, values: Map<String, Any>) {
                    sendEvent(eventName, values)
                }
        }

    private fun requireSdk(): MentraBluetoothSdk =
            sdk
                    ?: throw CodedException(
                            "sdk_not_initialized",
                            "Bluetooth SDK is not initialized.",
                            null,
                    )

    override fun definition() = ModuleDefinition {
        Name("BluetoothSdk")

        // Define events that can be sent to JavaScript
        Events(
            "glasses_status",
            "bluetooth_status",
            "log",
            "device_discovered",
            "default_device_changed",
            // Individual event handlers
            "glasses_not_ready",
            "button_press",
            "touch_event",
            "accel_event",
            "CompassHeadingEvent",
            "CompassCalibrationEvent",
            "head_up",
            "voice_activity_detection_status",
            "speaking_status",
            "battery_status",
            "local_transcription",
            "wifi_status_change",
            "wifi_scan_result",
            "hotspot_status_change",
            "hotspot_error",
            "photo_response",
            "photo_status",
            "camera_status",
            "video_recording_status",
            "media_success",
            "media_error",
            "gallery_status",
            "compatible_glasses_search_stop",
            "heartbeat_sent",
            "heartbeat_received",
            "send_command_to_ble",
            "receive_command_from_ble",
            "swipe_volume_status",
            "switch_status",
            "rgb_led_control_response",
            "settings_ack",
            "version_info",
            "pair_failure",
            "audio_pairing_needed",
            "audio_connected",
            "audio_disconnected",
            "save_setting",
            "phone_notification",
            "phone_notification_dismissed",
            "ws_text",
            "ws_bin",
            "mic_pcm",
            "mic_lc3",
            "stream_status",
            "keep_alive_ack",
            "mtk_update_complete",
            "ota_progress",
            "ota_start_ack",
            "ota_status",
            // Nex / BLE debug (NexEventUtils → Bridge.sendTypedMessage)
            "send_command_to_ble",
            "receive_command_from_ble",
            "miniapp_selected",
            "captions_tester_incident",
            "extraction_progress",
        )

        OnCreate {
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            BleTraceLogger.logLifecycle(context, "BluetoothSdkModule", "module_create")
            sdk =
                    MentraBluetoothSdk.create(
                            context,
                            MentraBluetoothSdkConfig(
                                    analytics = BluetoothSdkAnalyticsConfig().withSurface("react_native")
                            ),
                            sdkListener,
                    )
            deviceManager = DeviceManager.getInstance()
        }

        OnDestroy {
            BleTraceLogger.logLifecycle(
                    appContext.reactContext ?: appContext.currentActivity,
                    "BluetoothSdkModule",
                    "module_destroy"
            )
            sdk?.close()
            sdk = null
            deviceManager = null
        }

        // MARK: - Observable Store Functions

        Function("getGlassesStatus") {
            sdk?.getRawGlassesStatus()?.toMap()
                    ?: GlassesStatus.fromMap(DeviceStore.store.getCategory("glasses")).toMap()
        }

        Function("getBluetoothStatus") {
            sdk?.getRawBluetoothStatus()?.toMap()
                    ?: BluetoothStatus.fromMap(DeviceStore.store.getCategory(ObservableStore.BLUETOOTH_CATEGORY))
                            .toMap()
        }

        Function("getDefaultDevice") { sdk?.getDefaultDevice()?.toMap() }

        Function("set") { category: String, key: String, value: Any? ->
            if (value != null) {
                DeviceStore.apply(category, key, value)
            }
        }

        Function("update") { category: String, values: Map<String, Any?> ->
            val normalizedCategory = ObservableStore.normalizeCategory(category)
            values.forEach { (key, value) ->
                if (value != null) {
                    DeviceStore.apply(normalizedCategory, key, value)
                }
            }
            // Persist core_token to SharedPreferences so MentraLive.getCoreToken() finds it
            // (bridge may run this after glasses_ready; prefs survive retries and next connection)
            // TODO: move this to the mantle:
            // if (category == "bluetooth") {
            //     values["core_token"]?.let { token ->
            //         val len = (token as? String)?.length ?: 0
            //         android.util.Log.d("BluetoothSdkModule", "update(core) core_token received, len=$len")
            //         if (token is String && token.isNotEmpty()) {
            //             val ctx = appContext.reactContext ?: appContext.currentActivity
            //             ctx?.let {
            //                 it.getSharedPreferences("augmentos_auth_prefs", android.content.Context.MODE_PRIVATE)
            //                     .edit()
            //                     .putString("core_token", token)
            //                     .apply()
            //                 android.util.Log.d("BluetoothSdkModule", "Persisted core_token to SharedPreferences, len=${token.length}")
            //             }
            //         }
            //     }
            // }
        }

        // MARK: - Display Commands

        SdkAsyncFunction("displayEvent") { params: Map<String, Any> ->
            sdk?.displayEvent(DisplayEventRequest(params))
        }

        SdkAsyncFunction("displayText") { text: String, x: Int?, y: Int?, size: Int? ->
            sdk?.displayText(
                    text = text,
                    x = x ?: 0,
                    y = y ?: 0,
                    size = size ?: 24,
            )
        }

        SdkAsyncFunction("clearDisplay") { -> sdk?.clearDisplay() }

        // MARK: - Connection Commands

        SdkAsyncFunction("connectDefault") { -> sdk?.connectDefault() }

        SdkAsyncFunction("connectDefaultWithOptions") { options: Map<String, Any> ->
            sdk?.connectDefault(options.toMentraConnectOptions())
        }

        SdkAsyncFunction("setDefaultDevice") { device: Map<String, Any>? ->
            sdk?.setDefaultDevice(device.toMentraDevice())
        }

        SdkAsyncFunction("clearDefaultDevice") { -> sdk?.clearDefaultDevice() }

        SdkAsyncFunction("connectWithOptions") { device: Map<String, Any>, options: Map<String, Any> ->
            sdk?.connect(
                    device.toMentraDevice()
                            ?: throw IllegalArgumentException("connect requires a Device with model and name."),
                    options.toMentraConnectOptions(),
            )
        }

        SdkAsyncFunction("connectSimulated") { -> sdk?.connectSimulated() }

        SdkAsyncFunction("disconnect") { -> sdk?.disconnect() }

        SdkAsyncFunction("forget") { -> sdk?.forget() }

        AsyncFunction("connectDefaultController") { deviceManager?.connectDefaultController() }

        AsyncFunction("disconnectController") { deviceManager?.disconnectController() }

        AsyncFunction("forgetController") { deviceManager?.forgetController() }

        SdkAsyncFunction("startScan") { model: String ->
            sdk?.startScan(DeviceModel.fromDeviceType(model))
        }

        SdkAsyncFunction("stopScan") { -> sdk?.stopScan() }

        SdkAsyncFunction("cancelConnectionAttempt") { -> sdk?.cancelConnectionAttempt() }

        SdkAsyncFunction("showDashboard") { -> sdk?.showDashboard() }

        AsyncFunction("ping") { deviceManager?.ping() }

        AsyncFunction("dbg1") {
            deviceManager?.dbg1()
            deviceManager?.sgc?.dbg1()
        }
        AsyncFunction("dbg2") {
            deviceManager?.dbg2()
            deviceManager?.sgc?.dbg2()
        }

        // Stub on Android — iOS uses this for the jetsam stress test.
        Function("getMemoryMB") { -> 0.0 }

        // MARK: - Incident Reporting

        SdkAsyncFunction("sendIncidentId") { incidentId: String, apiBaseUrl: String? ->
            sdk?.sendIncidentId(incidentId, apiBaseUrl)
        }

        // MARK: - WiFi Commands

        SdkAsyncFunction("requestWifiScan") { -> requireSdk().requestWifiScan().map { it.toMap() } }

        SdkAsyncFunction("sendWifiCredentials") { ssid: String, password: String ->
            requireSdk().sendWifiCredentials(ssid, password).values
        }

        SdkAsyncFunction("forgetWifiNetwork") { ssid: String ->
            requireSdk().forgetWifiNetwork(ssid).values
        }

        SdkAsyncFunction("setHotspotState") { enabled: Boolean ->
            requireSdk().setHotspotState(enabled).values
        }

        SdkAsyncFunction("setSystemTime") { timestampMs: Double ->
            sdk?.setSystemTime(timestampMs.toLong())
        }

        // MARK: - Gallery Commands

        SdkAsyncFunction("setGalleryModeEnabled") { enabled: Boolean ->
            requireSdk().setGalleryModeEnabled(enabled).values
        }

        SdkAsyncFunction("setVoiceActivityDetectionEnabled") { enabled: Boolean ->
            sdk?.setVoiceActivityDetectionEnabled(enabled)
        }

        @Suppress("DEPRECATION")
        SdkAsyncFunction("setPhotoCaptureDefaults") { params: Map<String, Any?> ->
            requireSdk().setPhotoCaptureDefaults(params.toPhotoCaptureDefaults()).values
        }

        SdkAsyncFunction("setVideoRecordingDefaults") { width: Int, height: Int, fps: Int ->
            requireSdk().setVideoRecordingDefaults(VideoRecordingDefaults(width, height, fps)).values
        }

        SdkAsyncFunction("setMaxVideoRecordingDuration") { minutes: Int ->
            requireSdk().setMaxVideoRecordingDuration(minutes).values
        }

        SdkAsyncFunction("setCameraFov") { fov: Map<String, Any> ->
            val value = (fov["fov"] as? Number)?.toInt() ?: CameraFov.DEFAULT_FOV
            val roiPosition = CameraRoiPosition.fromValue(
                (fov["roiPosition"] as? Number)?.toInt()
                    ?: (fov["roi_position"] as? Number)?.toInt(),
            )
            requireSdk().setCameraFov(CameraFov(value, roiPosition)).values
        }

        SdkAsyncFunction("setCameraTuningConfig") { anrOn: Boolean, gainOn: Boolean ->
            requireSdk().setCameraTuningConfig(anrOn, gainOn).values
        }

        SdkAsyncFunction("queryGalleryStatus") { -> requireSdk().queryGalleryStatus().values }

        SdkAsyncFunction("requestPhoto") { params: Map<String, Any?> ->
            // JS may pass null for optional fields; Map<String, Any> rejects null values at the bridge.
            val sanitized =
                    params.mapNotNull { (key, value) ->
                        if (value == null) null else key to value
                    }.toMap()
            val req = PhotoRequest.fromMap(sanitized)
            Bridge.log(
                    "NATIVE: PHOTO PIPELINE [3/6] BluetoothSdk.requestPhoto requestId=${req.requestId} size=${req.size} mode=${req.mode.value} compress=${req.compress} sound=${req.sound} exposureTimeNs=${req.exposureTimeNs} iso=${req.iso}"
            )
            requireSdk().requestPhoto(req).values
        }

        SdkAsyncFunction("warmUpCamera") { params: Map<String, Any?> ->
            val requestId = params["requestId"] as? String
            val size = PhotoSize.fromValue(params["size"] as? String)
            val exposureRaw = (params["exposureTimeNs"] as? Number)?.toDouble()
            val exposureTimeNs =
                if (exposureRaw != null && exposureRaw.isFinite() && exposureRaw > 0) exposureRaw.toLong() else null
            val durationRaw = (params["durationMs"] as? Number)?.toInt() ?: 0
            val durationMs = if (durationRaw > 0) durationRaw else 15000
            requireSdk().warmUpCamera(requestId, size, exposureTimeNs, durationMs).values
        }

        // MARK: - OTA Commands

        SdkFunction("setOtaVersionUrl") { otaVersionUrl: String ->
            requireSdk().setOtaVersionUrl(otaVersionUrl)
        }

        SdkFunction("getOtaVersionUrl") { -> requireSdk().getOtaVersionUrl() }

        // Runs on Dispatchers.IO, not the shared Expo AsyncFunctionQueue:
        // manifest fetches and version waits can block for several seconds.
        SdkCoroutineFunction("checkForOtaUpdate") {
            withContext(Dispatchers.IO) { requireSdk().checkForOtaUpdate() }
        }

        SdkAsyncFunction("startOtaUpdate") { otaVersionUrl: String? ->
            val sdk = requireSdk()
            if (otaVersionUrl.isNullOrBlank()) {
                sdk.startOtaUpdate().values
            } else {
                sdk.startOtaUpdate(otaVersionUrl).values
            }
        }

        SdkAsyncFunction("sendOtaQueryStatus") { -> requireSdk().sendOtaQueryStatus().values }

        // MARK: - Version Info Commands

        SdkAsyncFunction("requestVersionInfo") { -> requireSdk().requestVersionInfo().toMap() }

        // MARK: - Power Control Commands

        SdkAsyncFunction("sendShutdown") { -> sdk?.sendShutdown() }

        SdkAsyncFunction("sendReboot") { -> sdk?.sendReboot() }

        // MARK: - Video Recording Commands

        SdkAsyncFunction("startVideoRecording") {
                requestId: String,
                save: Boolean,
                sound: Boolean,
                settings: Map<String, Any?>? ->
            // Optional per-recording {width,height,fps}. Absent fields stay 0, which
            // the glasses treat as "use the saved button-video default". JS numbers
            // arrive as Double across the bridge, so coerce to Int.
            fun dim(key: String): Int = (settings?.get(key) as? Number)?.toInt() ?: 0
            requireSdk().startVideoRecording(
                    VideoRecordingRequest(
                            requestId,
                            save,
                            sound,
                            dim("width"),
                            dim("height"),
                            dim("fps"),
                            dim("maxRecordingTimeMinutes"),
                    )
            ).values
        }

        // webhookUrl/authToken are supplied at stop (not start) so the token is
        // fresh when the upload runs. Empty/null webhook = keep on device.
        SdkAsyncFunction("stopVideoRecording") {
                requestId: String,
                webhookUrl: String?,
                authToken: String? ->
            requireSdk().stopVideoRecording(requestId, webhookUrl, authToken).values
        }

        // MARK: - Stream Commands

        SdkAsyncFunction("startStream") { params: Map<String, Any> ->
            requireSdk().startStream(StreamRequest.fromMap(params)).values
        }

        SdkAsyncFunction("startExternallyManagedStream") { params: Map<String, Any> ->
            requireSdk().startExternallyManagedStream(StreamRequest.fromMap(params)).values
        }

        SdkAsyncFunction("stopStream") { -> requireSdk().stopStream().values }

        SdkAsyncFunction("sendExternallyManagedStreamKeepAlive") { params: Map<String, Any> ->
            sdk?.sendExternallyManagedStreamKeepAlive(StreamKeepAliveRequest.fromMap(params))
        }

        // MARK: - Microphone Commands

        SdkAsyncFunction("setMicState") {
                enabled: Boolean,
                useGlassesMic: Boolean?,
                sendTranscript: Boolean?,
                sendLc3Data: Boolean? ->
            sdk?.setMicState(
                    enabled = enabled,
                    useGlassesMic = useGlassesMic ?: true,
                    sendTranscript = sendTranscript ?: false,
                    sendLc3Data = sendLc3Data ?: false,
            )
        }

        // Runs on Dispatchers.IO, not the shared Expo AsyncFunctionQueue: restart()
        // does a synchronous JNI model reload that would otherwise block every other
        // native call in the app until it completes.
        AsyncFunction("restartTranscriber") Coroutine { ->
            withContext(Dispatchers.IO) { deviceManager?.restartTranscriber() }
        }

        // MARK: - Audio Playback Monitoring

        SdkAsyncFunction("setOwnAppAudioPlaying") { playing: Boolean ->
            sdk?.setOwnAppAudioPlaying(playing)
        }

        // MARK: - Live PCM output stream (miniapp speaker.createStream)
        //
        // MentraOS-internal. 16-bit LE PCM chunks into a streaming AudioTrack
        // (USAGE_MEDIA → follows the media route, e.g. A2DP to glasses).
        // write/close run *blocking on Dispatchers.IO*, not the shared Expo
        // AsyncFunctionQueue: write intentionally blocks for backpressure and
        // close blocks until the backlog drains — either would otherwise stall
        // every other native call queued behind them.

        AsyncFunction("pcmStreamOpen") { streamId: String, sampleRate: Int, channels: Int, volume: Double ->
            PcmStreamManager.open(streamId, sampleRate, channels, volume.toFloat())
        }

        AsyncFunction("pcmStreamWrite") Coroutine { streamId: String, base64: String ->
            withContext(Dispatchers.IO) {
                mapOf("bufferedMs" to PcmStreamManager.write(streamId, base64))
            }
        }

        AsyncFunction("pcmStreamClose") Coroutine { streamId: String ->
            withContext(Dispatchers.IO) {
                mapOf("durationMs" to PcmStreamManager.close(streamId))
            }
        }

        AsyncFunction("pcmStreamAbort") { streamId: String ->
            PcmStreamManager.abort(streamId)
        }

        // *Blocking on Dispatchers.IO, not the shared AsyncFunctionQueue: these wait on
        // a CountDownLatch (up to 5s) for a BLE round-trip, which would otherwise stall
        // every other native call queued behind them.
        AsyncFunction("getGlassesMediaVolume") Coroutine { ->
            val cm = deviceManager ?: throw IllegalStateException("device_manager_null")
            withContext(Dispatchers.IO) { cm.getGlassesMediaVolumeBlocking() }
        }

        AsyncFunction("setGlassesMediaVolume") Coroutine { level: Int ->
            val cm = deviceManager ?: throw IllegalStateException("device_manager_null")
            withContext(Dispatchers.IO) { cm.setGlassesMediaVolumeBlocking(level) }
        }

        // MARK: - RGB LED Control

        SdkAsyncFunction("rgbLedControl") {
                requestId: String,
                packageName: String?,
                action: String,
                color: String?,
                onDurationMs: Int,
                offDurationMs: Int,
                count: Int ->
            requireSdk().rgbLedControl(
                    RgbLedRequest(
                            requestId = requestId,
                            packageName = packageName,
                            action = RgbLedAction.fromValue(action),
                            color = RgbLedColor.fromValue(color),
                            onDurationMs = onDurationMs,
                            offDurationMs = offDurationMs,
                            count = count,
                    )
            ).values
        }

        // MARK: - STT Commands

        AsyncFunction("setSttModelDetails") { path: String, languageCode: String ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            com.mentra.bluetoothsdk.stt.STTTools.setSttModelDetails(context, path, languageCode)
        }

        AsyncFunction("getSttModelPath") { ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            com.mentra.bluetoothsdk.stt.STTTools.getSttModelPath(context)
        }

        AsyncFunction("checkSttModelAvailable") { ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            com.mentra.bluetoothsdk.stt.STTTools.checkSTTModelAvailable(context)
        }

        AsyncFunction("validateSttModel") { path: String ->
            com.mentra.bluetoothsdk.stt.STTTools.validateSTTModel(path)
        }

        // Runs on Dispatchers.IO, not the shared Expo AsyncFunctionQueue: bz2/tar
        // extraction of the 100–350MB model is a multi-minute, CPU-bound job. On the
        // shared queue it froze every other native call in the app until it finished.
        AsyncFunction("extractTarBz2") Coroutine { sourcePath: String, destinationPath: String ->
            withContext(Dispatchers.IO) {
                com.mentra.bluetoothsdk.stt.STTTools.extractTarBz2(sourcePath, destinationPath)
            }
        }

        // MARK: - TTS Commands

        AsyncFunction("setTtsModelDetails") { path: String, languageCode: String ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            com.mentra.core.tts.TTSTools.setTtsModelDetails(context, path, languageCode)
        }

        AsyncFunction("getTtsModelPath") { ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            com.mentra.core.tts.TTSTools.getTtsModelPath(context)
        }

        AsyncFunction("getTtsModelLanguage") { ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            com.mentra.core.tts.TTSTools.getTtsModelLanguage(context)
        }

        AsyncFunction("checkTtsModelAvailable") { ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            com.mentra.core.tts.TTSTools.checkTTSModelAvailable(context)
        }

        AsyncFunction("validateTtsModel") { path: String ->
            com.mentra.core.tts.TTSTools.validateTTSModel(path)
        }

        // Runs on Dispatchers.IO, not the shared Expo AsyncFunctionQueue: TTS synthesis
        // is a synchronous JNI call that would otherwise block other native calls.
        AsyncFunction("generateTtsAudio") Coroutine {
                text: String,
                modelPath: String,
                outputPath: String,
                speakerId: Int,
                speed: Double ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            withContext(Dispatchers.IO) {
                com.mentra.core.tts.TTSTools.generateTtsAudio(
                        context,
                        text,
                        modelPath,
                        outputPath,
                        speakerId,
                        speed.toFloat()
                )
            }
        }
    }
}

private fun Map<String, Any>?.toMentraDevice(): Device? {
    val values = this ?: return null
    val model = values["model"] as? String ?: return null
    val name = values["name"] as? String ?: return null
    val address = values["address"] as? String
    val rssi = (values["rssi"] as? Number)?.toInt()
    val id = values["id"] as? String
    return Device(
            model = DeviceModel.fromDeviceType(model),
            name = name,
            address = address?.takeIf { it.isNotBlank() },
            rssi = rssi,
            id = id?.takeIf { it.isNotBlank() } ?: address?.takeIf { it.isNotBlank() } ?: "$model:$name",
    )
}

private fun Map<String, Any?>.toPhotoCaptureDefaults(): PhotoCaptureDefaults =
        PhotoCaptureDefaults(
                size = (this["size"] as? String)?.let { PhotoSize.fromValue(it) },
                mfnr = this["mfnr"] as? Boolean,
                zsl = this["zsl"] as? Boolean,
                noiseReduction = this["noiseReduction"] as? Boolean,
                edgeEnhancement = this["edgeEnhancement"] as? Boolean,
                ispDigitalGain = (this["ispDigitalGain"] as? Number)?.toInt(),
                ispAnalogGain = this["ispAnalogGain"] as? String,
                aeExposureDivisor = (this["aeExposureDivisor"] as? Number)?.toInt(),
                isoCap = (this["isoCap"] as? Number)?.toInt(),
                compress = this["compress"] as? String,
                sound = this["sound"] as? Boolean,
                resetCaptureTuning = this["resetCaptureTuning"] as? Boolean == true,
        )

private fun Map<String, Any>?.toMentraConnectOptions(): ConnectOptions {
    val values = this ?: return ConnectOptions()
    return ConnectOptions(
            saveAsDefault = values["saveAsDefault"] as? Boolean ?: true,
            cancelExistingConnectionAttempt = values["cancelExistingConnectionAttempt"] as? Boolean ?: true,
    )
}
