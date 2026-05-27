package com.mentra.bluetoothsdk

import com.mentra.bluetoothsdk.utils.DeviceTypes
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

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

                override fun onStreamStatus(event: StreamStatusEvent) {
                    sendEvent("stream_status", event.values)
                }

                override fun onKeepAliveAck(event: KeepAliveAckEvent) {
                    sendEvent("keep_alive_ack", event.values)
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
            "head_up",
            "voice_activity_detection_status",
            "speaking_status",
            "battery_status",
            "local_transcription",
            "wifi_status_change",
            "hotspot_status_change",
            "hotspot_error",
            "photo_response",
            "gallery_status",
            "compatible_glasses_search_stop",
            "heartbeat_sent",
            "heartbeat_received",
            "send_command_to_ble",
            "receive_command_from_ble",
            "swipe_volume_status",
            "switch_status",
            "rgb_led_control_response",
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
            "ota_update_available",
            "ota_progress",
            "ota_start_ack",
            "ota_status",
            // Nex / BLE debug (NexEventUtils → Bridge.sendTypedMessage)
            "send_command_to_ble",
            "receive_command_from_ble",
            "miniapp_selected",
            "captions_tester_incident",
        )

        OnCreate {
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            sdk = MentraBluetoothSdk.create(context, sdkListener)
            deviceManager = DeviceManager.getInstance()
        }

        OnDestroy {
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

        AsyncFunction("displayEvent") { params: Map<String, Any> ->
            sdk?.displayEvent(DisplayEventRequest(params))
        }

        AsyncFunction("displayText") { text: String, x: Int?, y: Int?, size: Int? ->
            sdk?.displayText(
                    text = text,
                    x = x ?: 0,
                    y = y ?: 0,
                    size = size ?: 24,
            )
        }

        AsyncFunction("clearDisplay") { sdk?.clearDisplay() }

        // MARK: - Connection Commands

        AsyncFunction("connectDefault") { sdk?.connectDefault() }

        AsyncFunction("connectDefaultWithOptions") { options: Map<String, Any> ->
            sdk?.connectDefault(options.toMentraConnectOptions())
        }

        AsyncFunction("setDefaultDevice") { device: Map<String, Any>? ->
            sdk?.setDefaultDevice(device.toMentraDevice())
        }

        AsyncFunction("clearDefaultDevice") { sdk?.clearDefaultDevice() }

        AsyncFunction("connectWithOptions") { device: Map<String, Any>, options: Map<String, Any> ->
            sdk?.connect(
                    device.toMentraDevice() ?: throw IllegalArgumentException("connect requires a Device with model and name."),
                    options.toMentraConnectOptions(),
            )
        }

        AsyncFunction("connectSimulated") { sdk?.connectSimulated() }

        AsyncFunction("disconnect") { sdk?.disconnect() }

        AsyncFunction("forget") { sdk?.forget() }

        AsyncFunction("connectDefaultController") { deviceManager?.connectDefaultController() }

        AsyncFunction("disconnectController") { deviceManager?.disconnectController() }

        AsyncFunction("forgetController") { deviceManager?.forgetController() }

        AsyncFunction("startScan") { model: String ->
            sdk?.startScan(DeviceModel.fromDeviceType(model))
        }

        AsyncFunction("stopScan") { sdk?.stopScan() }

        AsyncFunction("cancelConnectionAttempt") { sdk?.cancelConnectionAttempt() }

        AsyncFunction("showDashboard") { sdk?.showDashboard() }

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

        AsyncFunction("sendIncidentId") { incidentId: String, apiBaseUrl: String? ->
            sdk?.sendIncidentId(incidentId, apiBaseUrl)
        }

        // MARK: - WiFi Commands

        AsyncFunction("requestWifiScan") { sdk?.requestWifiScan() }

        AsyncFunction("sendWifiCredentials") { ssid: String, password: String ->
            sdk?.sendWifiCredentials(ssid, password)
        }

        AsyncFunction("forgetWifiNetwork") { ssid: String -> sdk?.forgetWifiNetwork(ssid) }

        AsyncFunction("setHotspotState") { enabled: Boolean ->
            sdk?.setHotspotState(enabled)
        }

        AsyncFunction("setSystemTime") { timestampMs: Double ->
            sdk?.setSystemTime(timestampMs.toLong())
        }

        // MARK: - Gallery Commands

        AsyncFunction("setGalleryModeEnabled") { enabled: Boolean ->
            sdk?.setGalleryModeEnabled(enabled)
        }

        AsyncFunction("setVoiceActivityDetectionEnabled") { enabled: Boolean ->
            sdk?.setVoiceActivityDetectionEnabled(enabled)
        }

        AsyncFunction("queryGalleryStatus") { sdk?.queryGalleryStatus() }

        AsyncFunction("requestPhoto") { params: Map<String, Any?> ->
            // JS may pass null for optional fields; Map<String, Any> rejects null values at the bridge.
            val sanitized =
                    params.mapNotNull { (key, value) ->
                        if (value == null) null else key to value
                    }.toMap()
            val req = PhotoRequest.fromMap(sanitized)
            Bridge.log(
                    "NATIVE: PHOTO PIPELINE [3/6] BluetoothSdk.requestPhoto requestId=${req.requestId} appId=${req.appId} size=${req.size} compress=${req.compress} flash=${req.flash} sound=${req.sound} exposureTimeNs=${req.exposureTimeNs}"
            )
            val activeSdk = sdk
            if (activeSdk == null) {
                Bridge.log(
                        "NATIVE: PHOTO PIPELINE — sdk is null; requestPhoto dropped requestId=${req.requestId}"
                )
            } else {
                activeSdk.requestPhoto(req)
            }
        }

        // MARK: - OTA Commands

        AsyncFunction("sendOtaStart") { sdk?.sendOtaStart() }

        AsyncFunction("sendOtaQueryStatus") { sdk?.sendOtaQueryStatus() }

        AsyncFunction("retryOtaVersionCheck") { sdk?.retryOtaVersionCheck() }

        // MARK: - Version Info Commands

        AsyncFunction("requestVersionInfo") { sdk?.requestVersionInfo() }

        // MARK: - Power Control Commands

        AsyncFunction("sendShutdown") { sdk?.sendShutdown() }

        AsyncFunction("sendReboot") { sdk?.sendReboot() }

        // MARK: - Video Recording Commands

        AsyncFunction("startVideoRecording") { requestId: String, save: Boolean, sound: Boolean ->
            sdk?.startVideoRecording(VideoRecordingRequest(requestId, save, sound))
        }

        AsyncFunction("stopVideoRecording") { requestId: String ->
            sdk?.stopVideoRecording(requestId)
        }

        // MARK: - Stream Commands

        AsyncFunction("startStream") { params: Map<String, Any> ->
            sdk?.startStream(StreamRequest.fromMap(params))
        }

        AsyncFunction("stopStream") { sdk?.stopStream() }

        AsyncFunction("keepStreamAlive") { params: Map<String, Any> ->
            sdk?.keepStreamAlive(StreamKeepAliveRequest.fromMap(params))
        }

        // MARK: - Microphone Commands

        AsyncFunction("setMicState") {
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

        AsyncFunction("restartTranscriber") { deviceManager?.restartTranscriber() }

        // MARK: - Audio Playback Monitoring

        AsyncFunction("setOwnAppAudioPlaying") { playing: Boolean ->
            sdk?.setOwnAppAudioPlaying(playing)
        }

        AsyncFunction("getGlassesMediaVolume") {
            val cm = deviceManager ?: throw IllegalStateException("device_manager_null")
            cm.getGlassesMediaVolumeBlocking()
        }

        AsyncFunction("setGlassesMediaVolume") { level: Int ->
            val cm = deviceManager ?: throw IllegalStateException("device_manager_null")
            cm.setGlassesMediaVolumeBlocking(level)
        }

        // MARK: - RGB LED Control

        AsyncFunction("rgbLedControl") {
                requestId: String,
                packageName: String?,
                action: String,
                color: String?,
                onDurationMs: Int,
                offDurationMs: Int,
                count: Int ->
            sdk?.rgbLedControl(
                    RgbLedRequest(
                            requestId = requestId,
                            packageName = packageName,
                            action = RgbLedAction.fromValue(action),
                            color = RgbLedColor.fromValue(color),
                            onDurationMs = onDurationMs,
                            offDurationMs = offDurationMs,
                            count = count,
                    )
            )
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

        AsyncFunction("extractTarBz2") { sourcePath: String, destinationPath: String ->
            com.mentra.bluetoothsdk.stt.STTTools.extractTarBz2(sourcePath, destinationPath)
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

private fun Map<String, Any>?.toMentraConnectOptions(): ConnectOptions {
    val values = this ?: return ConnectOptions()
    return ConnectOptions(
            saveAsDefault = values["saveAsDefault"] as? Boolean ?: true,
            cancelExistingConnectionAttempt = values["cancelExistingConnectionAttempt"] as? Boolean ?: true,
    )
}
