//
//  DeviceStore.swift
//  BluetoothSDK
//
//  Centralized observable state store for glasses and Bluetooth SDK settings
//

import Foundation

@MainActor
class GlassesStore {
    static let shared = GlassesStore()
    let store = ObservableStore()

    private var dashboardHeightDebounceTask: Task<Void, Never>?
    private var dashboardDepthDebounceTask: Task<Void, Never>?

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
        store.set("glasses", "macAddress", "")
        store.set("glasses", "controllerConnected", false)
        store.set("glasses", "controllerMacAddress", "")
        store.set("glasses", "controllerBatteryLevel", -1)
        store.set("glasses", "controllerSignalStrength", -1)
        store.set("glasses", "signalStrength", -1)
        store.set("glasses", "signalStrengthUpdatedAt", 0)
        store.set("glasses", "ringSignalStrength", -1)

        // CORE STATE:
        store.set("core", "systemMicUnavailable", false)
        store.set("core", "searching", false)
        store.set("core", "searchingController", false)
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
        store.set("core", "screen_disabled", false)
        store.set("core", "preferred_mic", "auto")
        store.set("core", "sensing_enabled", true)
        store.set("core", "brightness", 50)
        store.set("core", "auto_brightness", true)
        store.set("core", "dashboard_height", 4)
        store.set("core", "dashboard_depth", 2)
        store.set("core", "head_up_angle", 30)
        store.set("core", "contextual_dashboard", true)
        store.set("core", "gallery_mode", false)
        store.set("core", "screen_disabled", false)
        store.set("core", "button_photo_size", "medium")
        store.set("core", "button_camera_led", true)
        store.set("core", "button_max_recording_time", 10)
        store.set("core", "camera_fov", ["fov": 118, "roi_position": 0])
        store.set("core", "button_video_width", 1280)
        store.set("core", "button_video_height", 720)
        store.set("core", "button_video_fps", 30)
        store.set("core", "preferred_mic", "auto")
        store.set("core", "lc3_frame_size", 60)
        store.set("core", "auth_email", "")
        store.set("core", "core_token", "")
        store.set("core", "should_send_pcm", false)
        store.set("core", "should_send_lc3", false)
        store.set("core", "should_send_transcript", false)
        store.set("core", "bypass_vad", false)
    }

    func get(_ category: String, _ key: String) -> Any? {
        return store.get(category, key)
    }

    func set(_ category: String, _ key: String, _ value: Any) {
        store.set(category, key, value)
    }

    private func scheduleDashboardHeightToGlasses() {
        dashboardHeightDebounceTask?.cancel()
        dashboardHeightDebounceTask = Task { @MainActor in
            try? await Task.yield()
            let h = store.get("core", "dashboard_height") as? Int ?? 4
            CoreManager.shared.sgc?.setDashboardHeightOnly(h)
        }
    }

    private func scheduleDashboardDepthToGlasses() {
        dashboardDepthDebounceTask?.cancel()
        dashboardDepthDebounceTask = Task { @MainActor in
            try? await Task.yield()
            let d = store.get("core", "dashboard_depth") as? Int ?? 2
            CoreManager.shared.sgc?.setDashboardDepthOnly(d)
        }
    }

    /// Apply changes with side effects
    func apply(_ category: String, _ key: String, _ value: Any) {
        let oldValue = store.get(category, key)
        store.set(category, key, value)

        // Trigger hardware updates based on setting changes
        switch (category, key) {
        case ("glasses", "fullyBooted"):
            Bridge.log("STORE: Glasses fullyBooted changed to \(value)")
            // skip if the value is the same as the old value:
            if let ready = value as? Bool, ready == oldValue as? Bool {
                return
            }
            if let ready = value as? Bool {
                if ready {
                    CoreManager.shared.handleDeviceReady()
                } else {
                    CoreManager.shared.handleDeviceDisconnected()
                }
                // we shouldn't call store.set in this function as this is only intended for side-effects, not driving state updates
            }

        case ("glasses", "controllerFullyBooted"):
            if let ready = value as? Bool {
                if ready {
                    CoreManager.shared.handleControllerReady()
                } else {
                    CoreManager.shared.handleControllerDisconnected()
                }
            }

        case ("glasses", "controllerMacAddress"):
            if let mac = value as? String {
                Task {
                    // give the glasses some extra time to finish booting:
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    await CoreManager.shared.sgc?.connectController()
                }
            }

        case ("glasses", "headUp"):
            if let headUp = value as? Bool {
                CoreManager.shared.sendCurrentState()
                Bridge.sendHeadUp(headUp)
            }

        // BLUETOOTH:

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

        case ("core", "dashboard_height"):
            scheduleDashboardHeightToGlasses()

        case ("core", "dashboard_depth"):
            scheduleDashboardDepthToGlasses()

        case ("core", "head_up_angle"):
            if let angle = value as? Int {
                CoreManager.shared.sgc?.setHeadUpAngle(angle)
            }

        case ("core", "menu_apps"):
            if let items = value as? [[String: Any]] {
                CoreManager.shared.sgc?.setDashboardMenu(items)
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

        case ("core", "button_photo_size"):
            CoreManager.shared.sgc?.sendButtonPhotoSettings()

        case ("core", "button_camera_led"):
            CoreManager.shared.sgc?.sendButtonCameraLedSetting()

        case ("core", "button_max_recording_time"):
            CoreManager.shared.sgc?.sendButtonMaxRecordingTime()

        case ("core", "camera_fov"):
            CoreManager.shared.sgc?.sendCameraFovSetting()

        case ("core", "button_video_width"), ("core", "button_video_height"),
             ("core", "button_video_fps"):
            CoreManager.shared.sgc?.sendButtonVideoRecordingSettings()

        case ("core", "preferred_mic"):
            if let mic = value as? String {
                apply("core", "micRanking", MicMap.map[mic] ?? MicMap.map["auto"]!)
                CoreManager.shared.setMicState()
            }

        case ("core", "offline_captions_running"):
            if let running = value as? Bool {
                CoreManager.shared.setMicState()
            }

        case ("core", "local_stt_fallback_active"):
            if let active = value as? Bool {
                CoreManager.shared.setMicState()
            }

        case ("core", "should_send_pcm"):
            if let pcm = value as? Bool {
                CoreManager.shared.setMicState()
            }

        case ("core", "should_send_lc3"):
            if let lc3 = value as? Bool {
                CoreManager.shared.setMicState()
            }

        case ("core", "should_send_transcript"):
            if let transcript = value as? Bool {
                CoreManager.shared.setMicState()
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

        default:
            break
        }
    }
}
