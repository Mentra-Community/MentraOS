package com.mentra.core

import com.mentra.core.utils.DeviceTypes
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CoreModule : Module() {
    private var sdk: MentraBluetoothSdk? = null
    private var deviceManager: CoreManager? = null
    private val sdkListener =
            object : MentraBluetoothSdkListener {
                override fun onGlassesStatusChanged(status: MentraGlassesStatusUpdate) {
                    sendEvent("glasses_status", status.toMap())
                }

                override fun onBluetoothStatusChanged(status: MentraBluetoothStatusUpdate) {
                    sendEvent("core_status", status.toMap())
                }

                override fun onDeviceDiscovered(device: MentraDevice) {
                    sendEvent("device_discovered", device.toMap())
                }

                override fun onDefaultDeviceChanged(device: MentraDevice?) {
                    val event =
                            buildMap<String, Any> {
                                device?.let { put("device", it.toMap()) }
                            }
                    sendEvent("default_device_changed", event)
                }

                override fun onScanStopped(reason: MentraScanStopReason) {
                    if (reason == MentraScanStopReason.COMPLETED) {
                        sendEvent("compatible_glasses_search_stop", mapOf("type" to "compatible_glasses_search_stop"))
                    }
                }

                override fun onButtonPress(event: MentraButtonPressEvent) {
                    sendEvent(
                            "button_press",
                            mapOf(
                                    "buttonId" to event.buttonId,
                                    "pressType" to event.pressType,
                                    "timestamp" to (event.timestamp ?: System.currentTimeMillis())
                            )
                    )
                }

                override fun onTouch(event: MentraTouchEvent) {
                    sendEvent("touch_event", event.values)
                }

                override fun onHeadUpChanged(headUp: Boolean) {
                    sendEvent("head_up", mapOf("up" to headUp))
                }

                override fun onBatteryStatus(event: MentraBatteryStatusEvent) {
                    sendEvent("battery_status", event.values)
                }

                override fun onWifiStatusChanged(event: MentraWifiStatusEvent) {
                    sendEvent("wifi_status_change", event.values)
                }

                override fun onHotspotStatusChanged(event: MentraHotspotStatusEvent) {
                    sendEvent("hotspot_status_change", event.values)
                }

                override fun onHotspotError(event: MentraHotspotErrorEvent) {
                    sendEvent("hotspot_error", event.values)
                }

                override fun onGalleryStatus(event: MentraGalleryStatusEvent) {
                    sendEvent("gallery_status", event.values)
                }

                override fun onPhotoResponse(event: MentraPhotoResponseEvent) {
                    sendEvent("photo_response", event.values)
                }

                override fun onStreamStatus(event: MentraStreamStatusEvent) {
                    sendEvent("stream_status", event.values)
                }

                override fun onMicPcm(frame: ByteArray) {
                    sendEvent("mic_pcm", mapOf("pcm" to frame))
                }

                override fun onMicLc3(frame: ByteArray) {
                    sendEvent("mic_lc3", mapOf("lc3" to frame))
                }

                override fun onLocalTranscription(event: MentraLocalTranscriptionEvent) {
                    sendEvent("local_transcription", event.values)
                }

                override fun onLog(message: String) {
                    sendEvent("log", mapOf("message" to message))
                }

                override fun onError(error: MentraBluetoothError) {
                    sendEvent("pair_failure", mapOf("error" to error.message))
                }

                override fun onRawEvent(eventName: String, values: Map<String, Any>) {
                    sendEvent(eventName, values)
                }
            }

    override fun definition() = ModuleDefinition {
        Name("Core")

        // Define events that can be sent to JavaScript
        Events(
            "glasses_status",
            "core_status",
            "log",
            "device_discovered",
            "default_device_changed",
            // Individual event handlers
            "glasses_not_ready",
            "button_press",
            "touch_event",
            "head_up",
            "vad_status",
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
            deviceManager = CoreManager.getInstance()
        }

        OnDestroy {
            sdk?.close()
            sdk = null
            deviceManager = null
        }

        // MARK: - Observable Store Functions

        Function("getGlassesStatus") { sdk?.getGlassesStatus()?.toMap() ?: GlassesStore.store.getCategory("glasses") }

        Function("getCoreStatus") {
            sdk?.getBluetoothStatus()?.toMap() ?: GlassesStore.store.getCategory(ObservableStore.CORE_CATEGORY)
        }

        Function("getDefaultDevice") { sdk?.getDefaultDevice()?.toMap() }

        Function("set") { category: String, key: String, value: Any ->
            GlassesStore.apply(category, key, value)
        }

        Function("update") { category: String, values: Map<String, Any> ->
            val normalizedCategory = ObservableStore.normalizeCategory(category)
            values.forEach { (key, value) -> GlassesStore.apply(normalizedCategory, key, value) }
        }

        // MARK: - Display Commands

        AsyncFunction("displayEvent") { params: Map<String, Any> ->
            sdk?.displayEvent(MentraDisplayEventRequest(params))
        }

        AsyncFunction("displayText") { params: Map<String, Any> ->
            sdk?.displayText(
                    MentraDisplayTextRequest(
                            text = params["text"] as? String ?: "",
                            x = (params["x"] as? Number)?.toInt() ?: 0,
                            y = (params["y"] as? Number)?.toInt() ?: 0,
                            size = (params["size"] as? Number)?.toInt() ?: 24,
                    )
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

        AsyncFunction("connectByName") { deviceName: String ->
            sdk?.connectByName(deviceName)
        }

        AsyncFunction("connectWithOptions") { device: Map<String, Any>, options: Map<String, Any> ->
            sdk?.connect(
                    device.toMentraDevice() ?: throw IllegalArgumentException("connect requires a MentraDevice with model and name."),
                    options.toMentraConnectOptions(),
            )
        }

        AsyncFunction("connectDevice") { deviceModel: String, deviceName: String ->
            sdk?.connectByName(MentraDeviceModel.fromDeviceType(deviceModel), deviceName)
        }

        AsyncFunction("connectSimulated") { sdk?.connectSimulated() }

        AsyncFunction("disconnect") { sdk?.disconnect() }

        AsyncFunction("forget") { sdk?.forget() }

        AsyncFunction("connectDefaultController") { deviceManager?.connectDefaultController() }

        AsyncFunction("disconnectController") { deviceManager?.disconnectController() }

        AsyncFunction("forgetController") { deviceManager?.forgetController() }

        AsyncFunction("startScan") { params: Map<String, Any> ->
            val model = params["model"] as? String ?: params["deviceModel"] as? String ?: DeviceTypes.LIVE
            sdk?.startScan(MentraDeviceModel.fromDeviceType(model))
        }

        AsyncFunction("cancelConnectionAttempt") { sdk?.cancelConnectionAttempt() }

        AsyncFunction("findCompatibleDevices") { deviceModel: String ->
            sdk?.startScan(MentraDeviceModel.fromDeviceType(deviceModel))
        }

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

        // MARK: - Gallery Commands

        AsyncFunction("setGalleryMode") { mode: String ->
            val galleryMode =
                    when (mode.lowercase()) {
                        "auto" -> MentraGalleryMode.AUTO
                        "manual" -> MentraGalleryMode.MANUAL
                        else -> throw IllegalArgumentException("setGalleryMode mode must be \"auto\" or \"manual\".")
                    }
            sdk?.setGalleryMode(galleryMode)
        }

        AsyncFunction("queryGalleryStatus") { sdk?.queryGalleryStatus() }

        AsyncFunction("photoRequest") {
                requestId: String,
                appId: String,
                size: String,
                webhookUrl: String,
                authToken: String?,
                compress: String,
                flash: Boolean,
                sound: Boolean ->
            sdk?.requestPhoto(
                    MentraPhotoRequest(
                            requestId = requestId,
                            appId = appId,
                            size = MentraPhotoSize.fromValue(size),
                            webhookUrl = webhookUrl,
                            authToken = authToken,
                            compress = MentraPhotoCompression.fromValue(compress),
                            flash = flash,
                            sound = sound,
                    )
            )
        }

        // MARK: - OTA Commands

        AsyncFunction("sendOtaStart") { sdk?.sendOtaStart() }

        AsyncFunction("sendOtaQueryStatus") { sdk?.sendOtaQueryStatus() }

        // MARK: - Version Info Commands

        AsyncFunction("requestVersionInfo") { sdk?.requestVersionInfo() }

        // MARK: - Power Control Commands

        AsyncFunction("sendShutdown") { sdk?.sendShutdown() }

        AsyncFunction("sendReboot") { sdk?.sendReboot() }

        // MARK: - Video Recording Commands

        AsyncFunction("startVideoRecording") { requestId: String, save: Boolean, flash: Boolean, sound: Boolean ->
            sdk?.startVideoRecording(MentraVideoRecordingRequest(requestId, save, flash, sound))
        }

        AsyncFunction("stopVideoRecording") { requestId: String ->
            sdk?.stopVideoRecording(requestId)
        }

        // MARK: - Stream Commands

        AsyncFunction("startStream") { params: Map<String, Any> ->
            sdk?.startStream(MentraStreamRequest.fromMap(params))
        }

        AsyncFunction("stopStream") { sdk?.stopStream() }

        AsyncFunction("keepStreamAlive") { params: Map<String, Any> ->
            sdk?.keepStreamAlive(MentraStreamKeepAliveRequest.fromMap(params))
        }

        // MARK: - Microphone Commands

        AsyncFunction("setMicState") {
                sendPcmData: Boolean,
                sendTranscript: Boolean,
                bypassVad: Boolean ->
            sdk?.setMicState(
                    MentraMicConfig(
                            sendPcmData = sendPcmData,
                            sendTranscript = sendTranscript,
                            bypassVad = bypassVad,
                    )
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
                ontime: Int,
                offtime: Int,
                count: Int ->
            sdk?.rgbLedControl(
                    MentraRgbLedRequest(
                            requestId = requestId,
                            packageName = packageName,
                            action = MentraRgbLedAction.fromValue(action),
                            color = MentraRgbLedColor.fromValue(color),
                            ontime = ontime,
                            offtime = offtime,
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
            com.mentra.core.stt.STTTools.setSttModelDetails(context, path, languageCode)
        }

        AsyncFunction("getSttModelPath") { ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            com.mentra.core.stt.STTTools.getSttModelPath(context)
        }

        AsyncFunction("checkSttModelAvailable") { ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            com.mentra.core.stt.STTTools.checkSTTModelAvailable(context)
        }

        AsyncFunction("validateSttModel") { path: String ->
            com.mentra.core.stt.STTTools.validateSTTModel(path)
        }

        AsyncFunction("extractTarBz2") { sourcePath: String, destinationPath: String ->
            com.mentra.core.stt.STTTools.extractTarBz2(sourcePath, destinationPath)
        }

        // MARK: - Settings Navigation

        AsyncFunction("openBluetoothSettings") {
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            val intent = android.content.Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS)
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        }

        // Check if location services are enabled (required for WiFi operations on Android)
        AsyncFunction("isLocationServicesEnabled") {
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            val locationManager =
                    context.getSystemService(android.content.Context.LOCATION_SERVICE) as
                            android.location.LocationManager
            // Check if either GPS or Network location provider is enabled
            val providerEnabled = locationManager.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER) ||
                    locationManager.isProviderEnabled(
                            android.location.LocationManager.NETWORK_PROVIDER
                    )
            if (!providerEnabled) {
                // Fallback: check the system-level location toggle directly.
                // GPS_PROVIDER/NETWORK_PROVIDER can report disabled on devices without
                // Google Play Services or without a GPS chip, even when location is toggled on.
                // isLocationEnabled requires API 28+; on older devices just trust the provider check.
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                    val systemEnabled = locationManager.isLocationEnabled
                    if (systemEnabled) {
                        android.util.Log.w("CoreModule", "Location providers (GPS/Network) report disabled but system location toggle is ON. Device may lack GMS or GPS hardware.")
                    }
                    systemEnabled
                } else {
                    false
                }
            } else {
                true
            }
        }

        AsyncFunction("openLocationSettings") {
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            val intent =
                    android.content.Intent(
                            android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS
                    )
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        }

        AsyncFunction("showLocationServicesDialog") {
            val activity = appContext.currentActivity
            if (activity == null) {
                val context =
                        appContext.reactContext
                                ?: throw IllegalStateException("No context available")
                val intent =
                        android.content.Intent(
                                android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS
                        )
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                return@AsyncFunction true
            }

            val locationRequest =
                    com.google.android.gms.location.LocationRequest.Builder(
                                    com.google.android.gms.location.Priority.PRIORITY_HIGH_ACCURACY,
                                    10000
                            )
                            .build()

            val builder =
                    com.google.android.gms.location.LocationSettingsRequest.Builder()
                            .addLocationRequest(locationRequest)
                            .setAlwaysShow(true)

            val client =
                    com.google.android.gms.location.LocationServices.getSettingsClient(activity)
            val task = client.checkLocationSettings(builder.build())

            task.addOnSuccessListener { true }
            task.addOnFailureListener { exception ->
                if (exception is com.google.android.gms.common.api.ResolvableApiException) {
                    try {
                        exception.startResolutionForResult(activity, 1001)
                    } catch (sendEx: android.content.IntentSender.SendIntentException) {
                        // Fallback
                        val intent =
                                android.content.Intent(
                                        android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS
                                )
                        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                        activity.startActivity(intent)
                    }
                } else {
                    val intent =
                            android.content.Intent(
                                    android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS
                            )
                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    activity.startActivity(intent)
                }
            }
            true
        }

        AsyncFunction("openAppSettings") {
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            val intent =
                    android.content.Intent(
                            android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS
                    )
            intent.data = android.net.Uri.parse("package:${context.packageName}")
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        }

    }
}

private fun Map<String, Any>?.toMentraDevice(): MentraDevice? {
    val values = this ?: return null
    val model = values["model"] as? String ?: values["deviceModel"] as? String ?: return null
    val name = values["name"] as? String ?: values["deviceName"] as? String ?: return null
    val address = values["address"] as? String ?: values["deviceAddress"] as? String
    val rssi = (values["rssi"] as? Number)?.toInt()
    val id = values["id"] as? String
    return MentraDevice(
            model = MentraDeviceModel.fromDeviceType(model),
            name = name,
            address = address?.takeIf { it.isNotBlank() },
            rssi = rssi,
            id = id?.takeIf { it.isNotBlank() } ?: address?.takeIf { it.isNotBlank() } ?: "$model:$name",
    )
}

private fun Map<String, Any>?.toMentraConnectOptions(): MentraConnectOptions {
    val values = this ?: return MentraConnectOptions()
    return MentraConnectOptions(
            saveAsDefault = values["saveAsDefault"] as? Boolean ?: true,
            cancelExistingConnectionAttempt = values["cancelExistingConnectionAttempt"] as? Boolean ?: true,
    )
}
