package com.mentra.bluetoothsdk

import android.net.wifi.WifiManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BluetoothSdkModule : Module() {
    private var sdk: MentraBluetoothSdk? = null
    private var deviceManager: DeviceManager? = null
    private val sdkListener =
            object : MentraBluetoothSdkListener {
                override fun onGlassesStatusChanged(status: MentraGlassesStatusUpdate) {
                    sendEvent("glasses_status", status.values)
                }

                override fun onBluetoothStatusChanged(status: MentraBluetoothStatusUpdate) {
                    sendEvent("bluetooth_status", status.values)
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
                    val body = mutableMapOf<String, Any>(
                            "code" to error.code,
                            "message" to error.message
                    )
                    body.putAll(error.values)
                    sendEvent("bluetooth_error", body)
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
            "ws_text",
            "ws_bin",
            "mic_pcm",
            "mic_lc3",
            "stream_status",
            "bluetooth_error",
            "keep_alive_ack",
            "mtk_update_complete",
            "ota_update_available",
            "ota_progress",
            // Nex / BLE debug (NexEventUtils → Bridge.sendTypedMessage)
            "send_command_to_ble",
            "receive_command_from_ble",
            "miniapp_selected",
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

        Function("getGlassesStatus") { sdk?.getGlassesStatus()?.values ?: DeviceStore.store.getCategory("glasses") }

        Function("getBluetoothStatus") {
            sdk?.getBluetoothStatus()?.values ?: DeviceStore.store.getCategory(ObservableStore.BLUETOOTH_CATEGORY)
        }

        Function("getKnownDevices") { deviceModel: String? ->
            sdk?.getKnownDevices(deviceModel?.let { MentraDeviceModel.fromDeviceType(it) })
                    ?.map {
                        mapOf(
                                "deviceModel" to it.model.deviceType,
                                "deviceName" to it.name,
                                "deviceAddress" to it.address,
                                "bonded" to it.bonded,
                                "connected" to it.connected,
                        )
                    }
                    ?: emptyList<Map<String, Any>>()
        }

        Function("set") { category: String, key: String, value: Any ->
            DeviceStore.apply(category, key, value)
        }

        Function("update") { category: String, values: Map<String, Any> ->
            val normalizedCategory = ObservableStore.normalizeCategory(category)
            values.forEach { (key, value) -> DeviceStore.apply(normalizedCategory, key, value) }
            // Persist core_token to SharedPreferences so MentraLive.getCoreToken() finds it
            // (bridge may run this after glasses_ready; prefs survive retries and next connection)
            if (normalizedCategory == ObservableStore.BLUETOOTH_CATEGORY) {
                values["core_token"]?.let { token ->
                    val len = (token as? String)?.length ?: 0
                    android.util.Log.d("BluetoothSdkModule", "update(bluetooth) core_token received, len=$len")
                    if (token is String && token.isNotEmpty()) {
                        val ctx = appContext.reactContext ?: appContext.currentActivity
                        ctx?.let {
                            it.getSharedPreferences("augmentos_auth_prefs", android.content.Context.MODE_PRIVATE)
                                .edit()
                                .putString("core_token", token)
                                .apply()
                            android.util.Log.d("BluetoothSdkModule", "Persisted core_token to SharedPreferences, len=${token.length}")
                        }
                    }
                }
            }
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

        AsyncFunction("connectByName") { deviceName: String ->
            sdk?.connectByName(deviceName)
        }

        AsyncFunction("connectDevice") { deviceModel: String, deviceName: String ->
            sdk?.connectByName(MentraDeviceModel.fromDeviceType(deviceModel), deviceName)
        }

        AsyncFunction("connectDeviceByAddress") { deviceModel: String, deviceAddress: String, deviceName: String? ->
            sdk?.connectByAddress(MentraDeviceModel.fromDeviceType(deviceModel), deviceAddress, deviceName)
        }

        AsyncFunction("connectSimulated") { sdk?.connectSimulated() }

        AsyncFunction("disconnect") { sdk?.disconnect() }

        AsyncFunction("forget") { sdk?.forget() }

        AsyncFunction("connectDefaultController") { deviceManager?.connectDefaultController() }

        AsyncFunction("disconnectController") { deviceManager?.disconnectController() }

        AsyncFunction("forgetController") { deviceManager?.forgetController() }

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

        AsyncFunction("logCurrentWifiFrequency") {
            val ctx = appContext.reactContext ?: appContext.currentActivity ?: return@AsyncFunction null
            val wifiManager = ctx.applicationContext.getSystemService(android.content.Context.WIFI_SERVICE) as? WifiManager
            if (wifiManager == null) {
                val unavailableMsg = "NATIVE: 📶 WiFi frequency: WifiManager unavailable"
                android.util.Log.d("BluetoothSdkModule", unavailableMsg)
                Bridge.log(unavailableMsg)
                return@AsyncFunction null
            }
            val info = wifiManager.connectionInfo
            val freqMhz = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) info.frequency else -1
            val is5Ghz = freqMhz >= 5000
            val frequencyMsg =
                "NATIVE: 📶 Current WiFi frequency: ${freqMhz} MHz, 5 GHz: $is5Ghz (SSID: ${info.ssid?.trim('\"') ?: "unknown"})"
            android.util.Log.d("BluetoothSdkModule", frequencyMsg)
            Bridge.log(frequencyMsg)
            null
        }

        // MARK: - Gallery Commands

        AsyncFunction("queryGalleryStatus") { sdk?.queryGalleryStatus() }

        AsyncFunction("photoRequest") {
                requestId: String,
                appId: String,
                size: String,
                webhookUrl: String,
                authToken: String,
                compress: String,
                flash: Boolean,
                sound: Boolean ->
            sdk?.requestPhoto(
                    MentraPhotoRequest(
                            requestId = requestId,
                            appId = appId,
                            size = size,
                            webhookUrl = webhookUrl,
                            authToken = authToken,
                            compress = compress,
                            flash = flash,
                            sound = sound,
                    )
            )
        }

        // MARK: - OTA Commands

        AsyncFunction("sendOtaStart") { sdk?.sendOtaStart() }

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
            sdk?.startStream(MentraStreamRequest(params))
        }

        AsyncFunction("stopStream") { sdk?.stopStream() }

        AsyncFunction("keepStreamAlive") { params: Map<String, Any> ->
            sdk?.keepStreamAlive(MentraStreamKeepAliveRequest(params))
        }

        // MARK: - Microphone Commands

        AsyncFunction("setMicState") {
                sendPcmData: Boolean,
                sendTranscript: Boolean,
                bypassVad: Boolean ->
            deviceManager?.setMicState()
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
            deviceManager?.rgbLedControl(
                    requestId,
                    packageName,
                    action,
                    color,
                    ontime,
                    offtime,
                    count
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
                        android.util.Log.w("BluetoothSdkModule", "Location providers (GPS/Network) report disabled but system location toggle is ON. Device may lack GMS or GPS hardware.")
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
