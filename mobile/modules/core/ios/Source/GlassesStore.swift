//
//  GlassesStore.swift
//  Core
//
//  Centralized observable state store for glasses and core settings
//

import Foundation

@MainActor
class GlassesStore {
    static let shared = GlassesStore()
    let store = ObservableStore()

    private init() {
        // SETTINGS are snake_case
        // CORE STATE is camelCase

        // GLASSES STATE:
        store.set("glasses", "fullyBooted", false)
        store.set("glasses", "batteryLevel", -1)
        store.set("glasses", "charging", false)
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
        store.set("core", "searchResults", [])
        store.set("core", "wifiScanResults", [])
        store.set("core", "micRanking", MicMap.map["auto"]!)
        store.set("core", "lastLog", [])
        store.set("core", "otherBtConnected", false)

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

    func get(_ category: String, _ key: String) -> Any? {
        return store.get(category, key)
    }

    func set(_ category: String, _ key: String, _ value: Any) {
        store.set(category, key, value)
    }

    // Apply changes with side effects
    func apply(_ category: String, _ key: String, _ value: Any) {
        let oldValue = store.get(category, key)
        store.set(category, key, value)

        // Trigger hardware updates based on setting changes
        switch (category, key) {
        case ("glasses", "fullyBooted"):
            Bridge.log("STORE: Glasses fullyBooted changed to \(value)")
            if let ready = value as? Bool {
                if ready {
                    CoreManager.shared.handleDeviceReady()
                } else {
                    CoreManager.shared.handleDeviceDisconnected()
                }
                // we shouldn't call store.set in this function as this is only intended for side-effects, not driving state updates
            }

        case ("glasses", "headUp"):
            if let headUp = value as? Bool {
                CoreManager.shared.sendCurrentState()
                Bridge.sendHeadUp(headUp)
            }

        // CORE:

        case ("core", "auth_email"):
            if let email = value as? String {
                // CoreManager.shared.sgc?.sendAuthEmail(email)
            }

        case ("core", "auth_token"):
            if let token = value as? String {
                // CoreManager.shared.sgc?.sendAuthToken(token)
            }

        case ("core", "brightness"):
            let b = value as? Int ?? 50
            let auto = store.get("core", "auto_brightness") as? Bool ?? true
            Task {
                CoreManager.shared.sgc?.setBrightness(b, autoMode: auto)
                CoreManager.shared.sgc?.sendTextWall("Set brightness to \(b)%")
                try? await Task.sleep(nanoseconds: 800_000_000) // 0.8 seconds
                CoreManager.shared.sgc?.clearDisplay()
            }

        case ("core", "auto_brightness"):
            let b = store.get("core", "brightness") as? Int ?? 50
            let auto = value as? Bool ?? true
            let autoBrightnessChanged = (oldValue as? Bool) != auto
            Task {
                CoreManager.shared.sgc?.setBrightness(b, autoMode: auto)
                if autoBrightnessChanged {
                    CoreManager.shared.sgc?.sendTextWall(
                        auto ? "Enabled auto brightness" : "Disabled auto brightness"
                    )
                    try? await Task.sleep(nanoseconds: 800_000_000) // 0.8 seconds
                    CoreManager.shared.sgc?.clearDisplay()
                }
            }

        case ("core", "dashboard_height"), ("core", "dashboard_depth"):
            let h = store.get("core", "dashboard_height") as? Int ?? 4
            let d = store.get("core", "dashboard_depth") as? Int ?? 5
            Task { await CoreManager.shared.sgc?.setDashboardPosition(h, d) }

        case ("core", "head_up_angle"):
            if let angle = value as? Int {
                CoreManager.shared.sgc?.setHeadUpAngle(angle)
            }

        case ("core", "gallery_mode"):
            CoreManager.shared.sgc?.sendGalleryMode()

        case ("core", "screen_disabled"):
            if let disabled = value as? Bool {
                if disabled {
                    CoreManager.shared.sgc?.exit()
                } else {
                    CoreManager.shared.sgc?.clearDisplay()
                }
            }

        case ("core", "button_mode"):
            CoreManager.shared.sgc?.sendButtonModeSetting()

        case ("core", "button_photo_size"):
            CoreManager.shared.sgc?.sendButtonPhotoSettings()

        case ("core", "button_camera_led"):
            CoreManager.shared.sgc?.sendButtonCameraLedSetting()

        case ("core", "button_max_recording_time"):
            CoreManager.shared.sgc?.sendButtonMaxRecordingTime()

        case ("core", "button_video_width"), ("core", "button_video_height"),
             ("core", "button_video_fps"):
            CoreManager.shared.sgc?.sendButtonVideoRecordingSettings()

        case ("core", "preferred_mic"):
            if let mic = value as? String {
                apply("core", "micRanking", MicMap.map[mic] ?? MicMap.map["auto"]!)
                CoreManager.shared.setMicState(
                    store.get("core", "should_send_pcm_data") as? Bool ?? false,
                    store.get("core", "should_send_transcript") as? Bool ?? false,
                    store.get("core", "bypass_vad") as? Bool ?? true
                )
            }

        case ("core", "offline_mode"):
            if let offline = value as? Bool {
                // set should_send_transcript to true if offline_mode is true && running is true, otherwise false
                let shouldSendTranscript = offline && (store.get("core", "offline_captions_running") as? Bool) ?? false
                CoreManager.shared.setMicState(
                    store.get("core", "should_send_pcm_data") as? Bool ?? false,
                    store.get("core", "should_send_transcript") as? Bool ?? false,
                    store.get("core", "bypass_vad") as? Bool ?? true
                )
            }

        case ("core", "offline_captions_running"):
            if let running = value as? Bool {
                Bridge.log("GlassesStore: offline_captions_running changed to \(running)")
                // When offline captions are enabled, start the microphone for local transcription
                // When disabled, stop the microphone
                // set should_send_transcript to true if offline_mode is true && running is true, otherwise false
                let shouldSendTranscript = (store.get("core", "offline_mode") as? Bool) ?? false && running
                CoreManager.shared.setMicState(
                    store.get("core", "should_send_pcm_data") as? Bool ?? false,
                    shouldSendTranscript,
                    store.get("core", "bypass_vad") as? Bool ?? true
                )
            }

        case ("core", "enforce_local_transcription"):
            if let enabled = value as? Bool {
                CoreManager.shared.setMicState(
                    store.get("core", "should_send_pcm_data") as? Bool ?? false,
                    store.get("core", "should_send_transcript") as? Bool ?? false,
                    store.get("core", "bypass_vad") as? Bool ?? true
                )
            }

        case ("core", "default_wearable"):
            if let wearable = value as? String {
                Bridge.saveSetting("default_wearable", wearable)
                if wearable == DeviceTypes.SIMULATED {
                    CoreManager.shared.initSGC(wearable)
                }
            }

        case ("core", "device_name"):
            if let name = value as? String {
                CoreManager.shared.checkCurrentAudioDevice()
                // listen for when the audio device is paired and connected
                // CoreManager.shared.setupAudioPairing(deviceName: name)
            }

        case ("core", "lastLog"):
            if let logs = value as? [String] {
                // ensure the list is trimmed to 100 items (remove oldest items)
                // if logs.count > 100 {
                // store.set("core", "lastLog", logs.subList(0, logs.count - 100))
                // }
            }

        default:
            break
        }
    }
}
