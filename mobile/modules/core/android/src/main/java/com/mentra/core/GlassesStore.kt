package com.mentra.core

import com.mentra.core.utils.DeviceTypes
import com.mentra.core.utils.MicMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Centralized observable state store for glasses and core settings */
object GlassesStore {

    val store = ObservableStore()

    init {
        // SETTINGS are snake_case
        // CORE STATE is camelCase

        // GLASSES STATE:
        store.set("glasses", "batteryLevel", -1)
        store.set("glasses", "charging", false)
        store.set("glasses", "fullyBooted", false)
        store.set("glasses", "connected", false)
        store.set("glasses", "connectionState", "disconnected")
        store.set("glasses", "deviceModel", "")
        store.set("glasses", "firmwareVersion", "")
        store.set("glasses", "micEnabled", false)
        store.set("glasses", "btcConnected", false)
        store.set("glasses", "caseRemoved", true)
        store.set("glasses", "caseOpen", true)
        store.set("glasses", "caseCharging", false)
        store.set("glasses", "caseBatteryLevel", -1)
        store.set("glasses", "headUp", false)
        store.set("glasses", "serialNumber", "")
        store.set("glasses", "style", "")
        store.set("glasses", "color", "")
        store.set("glasses", "wifiSsid", "")
        store.set("glasses", "wifiConnected", false)
        store.set("glasses", "wifiLocalIp", "")
        store.set("glasses", "hotspotEnabled", false)
        store.set("glasses", "hotspotSsid", "")
        store.set("glasses", "hotspotPassword", "")
        store.set("glasses", "hotspotGatewayIp", "")
        store.set("glasses", "bluetoothName", "")

        // CORE STATE:
        store.set("core", "systemMicUnavailable", false)
        store.set("core", "searching", false)
        store.set("core", "micEnabled", false)
        store.set("core", "currentMic", "")
        store.set("core", "searchResults", emptyList<Any>())
        store.set("core", "wifiScanResults", emptyList<Any>())
        store.set("core", "micRanking", MicMap.map["auto"]!!)
        store.set("core", "lastLog", mutableListOf<String>())

        // CORE SETTINGS:
        store.set("core", "default_wearable", "")
        store.set("core", "pending_wearable", "")
        store.set("core", "device_name", "")
        store.set("core", "device_address", "")
        store.set("core", "offline_mode", false)
        store.set("core", "screen_disabled", false)
        store.set("core", "preferred_mic", "auto")
        store.set("core", "power_saving_mode", false)
        store.set("core", "always_on_status_bar", false)
        store.set("core", "enforce_local_transcription", false)
        store.set("core", "sensing_enabled", true)
        store.set("core", "metric_system", false)
        store.set("core", "brightness", 50)
        store.set("core", "auto_brightness", true)
        store.set("core", "dashboard_height", 4)
        store.set("core", "dashboard_depth", 5)
        store.set("core", "head_up_angle", 30)
        store.set("core", "contextual_dashboard", true)
        store.set("core", "gallery_mode", false)
        store.set("core", "screen_disabled", false)
        store.set("core", "button_mode", "photo")
        store.set("core", "button_photo_size", "medium")
        store.set("core", "button_camera_led", true)
        store.set("core", "button_max_recording_time", 10)
        store.set("core", "button_video_width", 1280)
        store.set("core", "button_video_height", 720)
        store.set("core", "button_video_fps", 30)
        store.set("core", "preferred_mic", "auto")
        store.set("core", "lc3_frame_size", 60)
        store.set("core", "auth_email", "")
        store.set("core", "auth_token", "")
    }

    fun get(category: String, key: String): Any? {
        return store.get(category, key)
    }

    fun set(category: String, key: String, value: Any) {
        store.set(category, key, value)
    }

    /** Apply changes with side effects */
    fun apply(category: String, key: String, value: Any) {
        val oldValue = store.get(category, key)
        store.set(category, key, value)

        // Trigger hardware updates based on setting changes
        when (category to key) {
            "glasses" to "fullyBooted" -> {
                if (value is Boolean) {
                    if (value) {
                        CoreManager.getInstance().handleDeviceReady()
                    } else {
                        CoreManager.getInstance().handleDeviceDisconnected()
                    }
                    // we shouldn't call store.set in this function as this is only intended for side-effects, not driving state updates
                }
            }
            "glasses" to "headUp" -> {
                if (value is Boolean) {
                    CoreManager.getInstance().sendCurrentState()
                    Bridge.sendHeadUp(value)
                }
            }

            // CORE:
            "core" to "auth_email" -> {
                if (value is String) {
                    // CoreManager.getInstance().sgc?.sendAuthEmail(value)
                }
            }
            "core" to "auth_token" -> {
                if (value is String) {
                    // CoreManager.getInstance().sgc?.sendAuthToken(value)
                }
            }
            "core" to "isHeadUp" -> {
                (value as? Boolean)?.let { isHeadUp ->
                    // sendCurrentState()
                    CoreManager.getInstance().sendCurrentState()
                    Bridge.sendHeadUp(isHeadUp)
                }
            }
            "core" to "brightness" -> {
                val b = (value as? Number)?.toInt()  ?: 50
                Bridge.log("Yayyieeeeee yashhhh, brightness: ${value} ${b}")
                val auto = (store.get("core", "auto_brightness") as? Boolean) ?: true
                CoroutineScope(Dispatchers.Main).launch {
                    CoreManager.getInstance().sgc?.setBrightness(b, auto)
                    CoreManager.getInstance().sgc?.sendTextWall("Set brightness to $b%")
                    delay(800) // 0.8 seconds
                    CoreManager.getInstance().sgc?.clearDisplay()
                }
            }
            "core" to "auto_brightness" -> {
                val b = (store.get("core", "brightness") as? Int) ?: 50
                val auto = (value as? Boolean) ?: true
                val autoBrightnessChanged = (oldValue as? Boolean) != auto
                CoroutineScope(Dispatchers.Main).launch {
                    CoreManager.getInstance().sgc?.setBrightness(b, auto)
                    if (autoBrightnessChanged) {
                        CoreManager.getInstance()
                                .sgc
                                ?.sendTextWall(
                                        if (auto) "Enabled auto brightness"
                                        else "Disabled auto brightness"
                                )
                        delay(800) // 0.8 seconds
                        CoreManager.getInstance().sgc?.clearDisplay()
                    }
                }
            }
            "core" to "dashboard_height", "core" to "dashboard_depth" -> {
                val h = (store.get("core", "dashboard_height") as? Int) ?: 4
                val d = (store.get("core", "dashboard_depth") as? Int) ?: 5
                CoroutineScope(Dispatchers.Main).launch {
                    CoreManager.getInstance().sgc?.setDashboardPosition(h, d)
                }
            }
            "core" to "head_up_angle" -> {
                (value as? Int)?.let { angle ->
                    CoreManager.getInstance().sgc?.setHeadUpAngle(angle)
                }
            }
            "core" to "gallery_mode" -> {
                CoreManager.getInstance().sgc?.sendGalleryMode()
            }
            "core" to "screen_disabled" -> {
                (value as? Boolean)?.let { disabled ->
                    if (disabled) {
                        CoreManager.getInstance().sgc?.exit()
                    } else {
                        CoreManager.getInstance().sgc?.clearDisplay()
                    }
                }
            }
            "core" to "button_mode" -> {
                CoreManager.getInstance().sgc?.sendButtonModeSetting()
            }
            "core" to "button_photo_size" -> {
                CoreManager.getInstance().sgc?.sendButtonPhotoSettings()
            }
            "core" to "button_camera_led" -> {
                CoreManager.getInstance().sgc?.sendButtonCameraLedSetting()
            }
            "core" to "button_max_recording_time" -> {
                CoreManager.getInstance().sgc?.sendButtonMaxRecordingTime()
            }
            "core" to "button_video_width",
            "core" to "button_video_height",
            "core" to "button_video_fps" -> {
                CoreManager.getInstance().sgc?.sendButtonVideoRecordingSettings()
            }
            "core" to "preferred_mic" -> {
                (value as? String)?.let { mic ->
                    apply("core", "micRanking", MicMap.map[mic] ?: MicMap.map["auto"]!!)
                    CoreManager.getInstance()
                            .setMicState(
                                    (store.get("core", "should_send_pcm_data") as? Boolean)
                                            ?: false,
                                    (store.get("core", "should_send_transcript") as? Boolean)
                                            ?: false,
                                    (store.get("core", "bypass_vad") as? Boolean) ?: true
                            )
                }
            }
            "core" to "offline_mode" -> {
                (value as? Boolean)?.let { offline ->
                    // set should_send_transcript to true if offline_mode is true && running is true, otherwise false
                    val shouldSendTranscript = offline && (store.get("core", "offline_captions_running") as? Boolean) ?: false
                    CoreManager.getInstance()
                            .setMicState(
                                    (store.get("core", "should_send_pcm_data") as? Boolean)
                                            ?: false,
                                    shouldSendTranscript,
                                    (store.get("core", "bypass_vad") as? Boolean) ?: true
                            )
                }
            }
            "core" to "offline_captions_running" -> {
                (value as? Boolean)?.let { running ->
                    Bridge.log("GlassesStore: offline_captions_running changed to $running")
                    // When offline captions are enabled, start the microphone for local transcription
                    // When disabled, stop the microphone
                    // set should_send_transcript to true if offline_mode is true && running is true, otherwise false
                    val shouldSendTranscript = (store.get("core", "offline_mode") as? Boolean) ?: false && running
                    CoreManager.getInstance().setMicState(
                        (store.get("core", "should_send_pcm_data") as? Boolean) ?: false,
                        shouldSendTranscript,
                        (store.get("core", "bypass_vad") as? Boolean) ?: true
                    )
                }
            }
            "core" to "enforce_local_transcription" -> {
                (value as? Boolean)?.let { enabled ->
                    CoreManager.getInstance()
                            .setMicState(
                                    (store.get("core", "should_send_pcm_data") as? Boolean)
                                            ?: false,
                                    (store.get("core", "should_send_transcript") as? Boolean)
                                            ?: false,
                                    (store.get("core", "bypass_vad") as? Boolean) ?: true
                            )
                }
            }
            "core" to "default_wearable" -> {
                (value as? String)?.let { wearable ->
                    Bridge.saveSetting("default_wearable", wearable)
                    if (wearable.contains(DeviceTypes.SIMULATED)) {
                        CoreManager.getInstance().initSGC(wearable)
                    }
                }
            }
            "core" to "device_name" -> {
                // Device name changed - no additional action needed
            }
            "core" to "lastLog" -> {
                (value as? MutableList<String>)?.let { logs ->
                    // ensure the list is trimmed to 100 items (remove oldest items)
                    // if (logs.size > 100) {
                    //     logs.subList(0, logs.size - 100)
                    // }
                    // GlassesStore.store.set("core", "lastLog", logs)
                }
            }
        }
    }
}
