package com.mentra.core

import android.net.wifi.WifiManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CoreModule : Module() {
    private val bridge: Bridge by lazy { Bridge.getInstance() }
    private var deviceManager: CoreManager? = null

    override fun definition() = ModuleDefinition {
        Name("Core")

        // Define events that can be sent to JavaScript
        Events(
            "glasses_status",
            "core_status",
            "log",
            // Individual event handlers
            "glasses_not_ready",
            "button_press",
            "touch_event",
            "head_up",
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
            // Initialize Bridge with Android context and event callback
            Bridge.initialize(
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            ) { eventName, data -> sendEvent(eventName, data) }

            // initialize deviceManager after Bridge is ready
            deviceManager = CoreManager.getInstance()

            // Configure observable store event emission
            GlassesStore.store.configure { category, changes ->
                when (category) {
                    "glasses" -> sendEvent("glasses_status", changes)
                    "core" -> sendEvent("core_status", changes)
                }
            }
        }

        // MARK: - Observable Store Functions

        Function("getGlassesStatus") { GlassesStore.store.getCategory("glasses") }

        Function("getCoreStatus") { GlassesStore.store.getCategory("core") }

        Function("set") { category: String, key: String, value: Any? ->
            if (value != null) {
                GlassesStore.apply(category, key, value)
            }
        }

        Function("update") { category: String, values: Map<String, Any?> ->
            values.forEach { (key, value) ->
                if (value != null) {
                    GlassesStore.apply(category, key, value)
                }
            }
            // Persist core_token to SharedPreferences so MentraLive.getCoreToken() finds it
            // (bridge may run this after glasses_ready; prefs survive retries and next connection)
            // TODO: move this to the mantle:
            // if (category == "core") {
            //     values["core_token"]?.let { token ->
            //         val len = (token as? String)?.length ?: 0
            //         android.util.Log.d("CoreModule", "update(core) core_token received, len=$len")
            //         if (token is String && token.isNotEmpty()) {
            //             val ctx = appContext.reactContext ?: appContext.currentActivity
            //             ctx?.let {
            //                 it.getSharedPreferences("augmentos_auth_prefs", android.content.Context.MODE_PRIVATE)
            //                     .edit()
            //                     .putString("core_token", token)
            //                     .apply()
            //                 android.util.Log.d("CoreModule", "Persisted core_token to SharedPreferences, len=${token.length}")
            //             }
            //         }
            //     }
            // }
        }

        // MARK: - Display Commands

        AsyncFunction("displayEvent") { params: Map<String, Any> ->
            deviceManager?.displayEvent(params)
        }

        AsyncFunction("displayText") { params: Map<String, Any> ->
            deviceManager?.displayText(params)
        }

        AsyncFunction("clearDisplay") { deviceManager?.clearDisplay() }

        // MARK: - Connection Commands

        AsyncFunction("connectDefault") { deviceManager?.connectDefault() }

        AsyncFunction("connectByName") { deviceName: String ->
            deviceManager?.connectByName(deviceName)
        }

        AsyncFunction("connectSimulated") { deviceManager?.connectSimulated() }

        AsyncFunction("disconnect") { deviceManager?.disconnect() }

        AsyncFunction("forget") { deviceManager?.forget() }

        AsyncFunction("connectDefaultController") { deviceManager?.connectDefaultController() }

        AsyncFunction("disconnectController") { deviceManager?.disconnectController() }

        AsyncFunction("forgetController") { deviceManager?.forgetController() }

        AsyncFunction("findCompatibleDevices") { deviceModel: String ->
            deviceManager?.findCompatibleDevices(deviceModel)
        }

        AsyncFunction("showDashboard") { deviceManager?.showDashboard() }

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
            deviceManager?.sendIncidentId(incidentId, apiBaseUrl)
        }

        // MARK: - WiFi Commands

        AsyncFunction("requestWifiScan") { deviceManager?.requestWifiScan() }

        AsyncFunction("sendWifiCredentials") { ssid: String, password: String ->
            deviceManager?.sendWifiCredentials(ssid, password)
        }

        AsyncFunction("forgetWifiNetwork") { ssid: String -> deviceManager?.forgetWifiNetwork(ssid) }

        AsyncFunction("setHotspotState") { enabled: Boolean ->
            deviceManager?.setHotspotState(enabled)
        }

        // move to crust:
        // AsyncFunction("logCurrentWifiFrequency") {
        //     val ctx = appContext.reactContext ?: appContext.currentActivity ?: return@AsyncFunction null
        //     val wifiManager = ctx.applicationContext.getSystemService(android.content.Context.WIFI_SERVICE) as? WifiManager
        //     if (wifiManager == null) {
        //         val unavailableMsg = "NATIVE: 📶 WiFi frequency: WifiManager unavailable"
        //         android.util.Log.d("CoreModule", unavailableMsg)
        //         Bridge.log(unavailableMsg)
        //         return@AsyncFunction null
        //     }
        //     val info = wifiManager.connectionInfo
        //     val freqMhz = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) info.frequency else -1
        //     val is5Ghz = freqMhz >= 5000
        //     val frequencyMsg =
        //         "NATIVE: 📶 Current WiFi frequency: ${freqMhz} MHz, 5 GHz: $is5Ghz (SSID: ${info.ssid?.trim('\"') ?: "unknown"})"
        //     android.util.Log.d("CoreModule", frequencyMsg)
        //     Bridge.log(frequencyMsg)
        //     null
        // }

        // MARK: - Gallery Commands

        AsyncFunction("queryGalleryStatus") { deviceManager?.queryGalleryStatus() }

        AsyncFunction("photoRequest") {
                requestId: String,
                appId: String,
                size: String,
                webhookUrl: String,
                authToken: String,
                compress: String,
                flash: Boolean,
                sound: Boolean ->
            deviceManager?.photoRequest(
                    requestId,
                    appId,
                    size,
                    webhookUrl,
                    authToken,
                    compress,
                    flash,
                    sound
            )
        }

        // MARK: - OTA Commands

        AsyncFunction("sendOtaStart") { deviceManager?.sendOtaStart() }
        
        AsyncFunction("sendOtaQueryStatus") { deviceManager?.sendOtaQueryStatus() }

        // MARK: - Version Info Commands

        AsyncFunction("requestVersionInfo") { deviceManager?.requestVersionInfo() }

        // MARK: - Power Control Commands

        AsyncFunction("sendShutdown") { deviceManager?.sendShutdown() }

        AsyncFunction("sendReboot") { deviceManager?.sendReboot() }

        // MARK: - Video Recording Commands

        AsyncFunction("startVideoRecording") { requestId: String, save: Boolean, flash: Boolean, sound: Boolean ->
            deviceManager?.startVideoRecording(requestId, save, flash, sound)
        }

        AsyncFunction("stopVideoRecording") { requestId: String ->
            deviceManager?.stopVideoRecording(requestId)
        }

        // MARK: - Stream Commands

        AsyncFunction("startStream") { params: Map<String, Any> ->
            deviceManager?.startStream(params.toMutableMap())
        }

        AsyncFunction("stopStream") { deviceManager?.stopStream() }

        AsyncFunction("keepStreamAlive") { params: Map<String, Any> ->
            deviceManager?.keepStreamAlive(params.toMutableMap())
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
            // Notify PhoneAudioMonitor that our app started/stopped playing audio
            // This is used to suspend LC3 mic during audio playback to avoid MCU overload
            val context = appContext.reactContext ?: return@AsyncFunction
            com.mentra.core.utils.PhoneAudioMonitor.getInstance(context).setOwnAppAudioPlaying(playing)
        }

        AsyncFunction("getGlassesMediaVolume") {
            val cm = deviceManager ?: throw IllegalStateException("core_manager_null")
            cm.getGlassesMediaVolumeBlocking()
        }

        AsyncFunction("setGlassesMediaVolume") { level: Int ->
            val cm = deviceManager ?: throw IllegalStateException("core_manager_null")
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
    }
}