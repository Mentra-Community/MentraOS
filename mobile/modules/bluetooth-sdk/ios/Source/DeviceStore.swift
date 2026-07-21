//
//  DeviceStore.swift
//  BluetoothSDK
//
//  Centralized observable state store for glasses and Bluetooth SDK settings
//

import Foundation

@MainActor
class DeviceStore {
    static let shared = DeviceStore()
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
        store.set("glasses", "connectionState", ConnTypes.DISCONNECTED)
        store.set("glasses", "deviceModel", "")
        store.set("glasses", "firmwareVersion", "")
        store.set("glasses", "micEnabled", false)
        store.set("glasses", "voiceActivityDetectionEnabled", BluetoothSdkDefaults.voiceActivityDetectionEnabled)
        store.set("glasses", "bluetoothClassicConnected", false)
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
        store.set("bluetooth", "systemMicUnavailable", false)
        store.set("bluetooth", "searching", false)
        store.set("bluetooth", "searchingController", false)
        store.set("bluetooth", "micEnabled", false)
        store.set("bluetooth", "currentMic", "")
        store.set("bluetooth", "searchResults", [])
        store.set("bluetooth", "wifiScanResults", [])
        store.set("bluetooth", "micRanking", MicMap.map["auto"]!)
        store.set("bluetooth", "lastLog", [])
        store.set("bluetooth", "otherBtConnected", false)

        // CORE SETTINGS:
        store.set("bluetooth", "default_wearable", "")
        store.set("bluetooth", "pending_wearable", "")
        store.set("bluetooth", "device_name", "")
        store.set("bluetooth", "device_address", "")
        store.set("bluetooth", "default_controller", "")
        store.set("bluetooth", "pending_controller", "")
        store.set("bluetooth", "controller_device_name", "")
        store.set("bluetooth", "screen_disabled", false)
        store.set("bluetooth", "preferred_mic", "auto")
        store.set("bluetooth", "sensing_enabled", true)
        store.set("bluetooth", "power_saving_mode", false)
        store.set("bluetooth", "brightness", 50)
        store.set("bluetooth", "auto_brightness", true)
        store.set("bluetooth", "dashboard_height", 4)
        store.set("bluetooth", "dashboard_depth", 2)
        store.set("bluetooth", "head_up_angle", 30)
        store.set("bluetooth", "imu_enabled", false)
        store.set("bluetooth", "contextual_dashboard", true)
        store.set("bluetooth", "gallery_mode", true)
        store.set("bluetooth", "voice_activity_detection_enabled", BluetoothSdkDefaults.voiceActivityDetectionEnabled)
        // Mentra Nex feature flag (off by default; toggled from Nex Developer Settings):
        store.set("bluetooth", "nex_chinese_captions", false)
        store.set("bluetooth", "screen_disabled", false)
        store.set("bluetooth", "button_photo_size", "max")
        store.set("bluetooth", "button_max_recording_time", 10)
        store.set("bluetooth", "camera_fov", ["fov": 118, "roi_position": 0])
        store.set("bluetooth", "button_video_width", 1280)
        store.set("bluetooth", "button_video_height", 720)
        store.set("bluetooth", "button_video_fps", 30)
        store.set("bluetooth", "preferred_mic", "auto")
        store.set("bluetooth", "lc3_frame_size", 60)
        store.set("bluetooth", "auth_email", "")
        store.set("bluetooth", "core_token", "")
        store.set("bluetooth", "should_send_pcm", false)
        store.set("bluetooth", "should_send_lc3", false)
        store.set("bluetooth", "should_send_transcript", false)
        store.set("bluetooth", "use_native_dashboard", false)
    }

    func get(_ category: String, _ key: String) -> Any? {
        return store.get(category, key)
    }

    func set(_ category: String, _ key: String, _ value: Any) {
        store.set(category, key, value)
    }

    func remove(_ category: String, _ key: String) {
        store.remove(category, key)
    }

    private func scheduleDashboardHeightToGlasses() {
        dashboardHeightDebounceTask?.cancel()
        dashboardHeightDebounceTask = Task { @MainActor in
            try? await Task.yield()
            let h = store.get("bluetooth", "dashboard_height") as? Int ?? 4
            DeviceManager.shared.sgc?.setDashboardHeightOnly(h)
        }
    }

    private func scheduleDashboardDepthToGlasses() {
        dashboardDepthDebounceTask?.cancel()
        dashboardDepthDebounceTask = Task { @MainActor in
            try? await Task.yield()
            let d = store.get("bluetooth", "dashboard_depth") as? Int ?? 2
            DeviceManager.shared.sgc?.setDashboardDepthOnly(d)
        }
    }

    /// Apply changes with side effects
    func apply(_ category: String, _ key: String, _ value: Any) {
        let oldValue = store.get(category, key)
        let storeWouldSkipSet = store.wouldSkipSet(category, key, value)
        store.set(category, key, value)
        if storeWouldSkipSet {
            return
        }

        // Trigger hardware updates based on setting changes
        switch (category, key) {
        case ("glasses", "fullyBooted"):
            Bridge.log("STORE: Glasses fullyBooted changed to \(value)")
            if let ready = value as? Bool {
                if ready {
                    DeviceManager.shared.handleDeviceReady()
                } else {
                    DeviceManager.shared.handleDeviceDisconnected()
                }
                // we shouldn't call store.set in this function as this is only intended for side-effects, not driving state updates
            }

        case ("glasses", "controllerFullyBooted"):
            if let ready = value as? Bool {
                if ready {
                    DeviceManager.shared.handleControllerReady()
                } else {
                    DeviceManager.shared.handleControllerDisconnected()
                }
            }

        case ("glasses", "controllerMacAddress"):
            if let mac = value as? String {
                Task {
                    // give the glasses some extra time to finish booting:
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    await DeviceManager.shared.sgc?.connectController()
                }
            }

        case ("glasses", "headUp"):
            if let headUp = value as? Bool {
                DeviceManager.shared.sendCurrentState()
                Bridge.sendHeadUp(headUp)
            }

        // BLUETOOTH:

        case ("bluetooth", "brightness"):
            let b = value as? Int ?? 50
            let auto = store.get("bluetooth", "auto_brightness") as? Bool ?? true
            Task {
                DeviceManager.shared.sgc?.setBrightness(b, autoMode: auto)
                await DeviceManager.shared.sgc?.sendTextWall("Set brightness to \(b)%")
                try? await Task.sleep(nanoseconds: 800_000_000) // 0.8 seconds
                DeviceManager.shared.sgc?.clearDisplay()
            }

        case ("bluetooth", "auto_brightness"):
            let b = store.get("bluetooth", "brightness") as? Int ?? 50
            let auto = value as? Bool ?? true
            let autoBrightnessChanged = (oldValue as? Bool) != auto
            Task {
                DeviceManager.shared.sgc?.setBrightness(b, autoMode: auto)
                if autoBrightnessChanged {
                    await DeviceManager.shared.sgc?.sendTextWall(
                        auto ? "Enabled auto brightness" : "Disabled auto brightness"
                    )
                    try? await Task.sleep(nanoseconds: 800_000_000) // 0.8 seconds
                    DeviceManager.shared.sgc?.clearDisplay()
                }
            }

        case ("bluetooth", "dashboard_height"):
            scheduleDashboardHeightToGlasses()

        case ("bluetooth", "dashboard_depth"):
            scheduleDashboardDepthToGlasses()

        case ("bluetooth", "head_up_angle"):
            if let angle = value as? Int {
                DeviceManager.shared.sgc?.setHeadUpAngle(angle)
            }

        case ("bluetooth", "imu_enabled"):
            if let enabled = value as? Bool {
                Task { await DeviceManager.shared.sgc?.setImuEnabled(enabled) }
            }

        case ("bluetooth", "menu_apps"):
            if let items = value as? [[String: Any]] {
                DeviceManager.shared.sgc?.setDashboardMenu(items)
            }

        case ("bluetooth", "calendar_events"), ("core", "calendar_events"):
            if let items = value as? [[String: Any]] {
                DeviceManager.shared.sgc?.sendCalendarEvents(items)
            }

        case ("bluetooth", "metric_system"), ("bluetooth", "twelve_hour_time"):
            DeviceManager.shared.sgc?.sendDashboardDisplaySettings()

        case ("bluetooth", "gallery_mode"):
            DeviceManager.shared.sgc?.sendGalleryMode()

        case ("bluetooth", "voice_activity_detection_enabled"):
            DeviceManager.shared.sgc?.sendVoiceActivityDetectionSetting()

        case ("bluetooth", "screen_disabled"):
            if let disabled = value as? Bool {
                if disabled {
                    DeviceManager.shared.sgc?.exit()
                } else {
                    DeviceManager.shared.sgc?.clearDisplay()
                }
            }

        case ("bluetooth", "button_photo_size"):
            DeviceManager.shared.sgc?.sendButtonPhotoSettings()

        case ("bluetooth", "button_max_recording_time"):
            DeviceManager.shared.sgc?.sendButtonMaxRecordingTime()

        case ("bluetooth", "camera_fov"):
            DeviceManager.shared.sgc?.sendCameraFovSetting()

        case ("bluetooth", "button_video_settings"):
            DeviceManager.shared.sgc?.sendButtonVideoRecordingSettings()

        // Legacy scalar keys remain supported for older hosts. New code should write the
        // canonical button_video_settings object so width/height/fps update atomically.
        case ("bluetooth", "button_video_width"), ("bluetooth", "button_video_height"),
             ("bluetooth", "button_video_fps"):
            DeviceManager.shared.sgc?.sendButtonVideoRecordingSettings()

        case ("bluetooth", "preferred_mic"):
            if let mic = value as? String {
                apply("bluetooth", "micRanking", MicMap.map[mic] ?? MicMap.map["auto"]!)
                DeviceManager.shared.setMicState()
            }

        case ("bluetooth", "local_stt_fallback_active"):
            if let active = value as? Bool {
                DeviceManager.shared.setMicState()
            }

        case ("bluetooth", "should_send_pcm"):
            if let pcm = value as? Bool {
                DeviceManager.shared.setMicState()
            }

        case ("bluetooth", "should_send_lc3"):
            if let lc3 = value as? Bool {
                DeviceManager.shared.setMicState()
            }

        case ("bluetooth", "should_send_transcript"):
            if let transcript = value as? Bool {
                DeviceManager.shared.setMicState()
            }

        case ("bluetooth", "default_wearable"):
            if let wearable = value as? String {
                Bridge.saveSetting("default_wearable", wearable)
                if wearable == DeviceTypes.SIMULATED {
                    DeviceManager.shared.initSGC(wearable)
                }
            }

        case ("bluetooth", "device_name"):
            if let name = value as? String {
                DeviceManager.shared.checkCurrentAudioDevice()
                // listen for when the audio device is paired and connected
                // DeviceManager.shared.setupAudioPairing(deviceName: name)
            }

        default:
            break
        }
    }
}
