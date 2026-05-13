import ExpoModulesCore

public class CoreModule: Module {
    public func definition() -> ModuleDefinition {
        Name("Core")

        OnCreate {
        }

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
            "wifi_status_change",
            "hotspot_status_change",
            "hotspot_error",
            "photo_response",
            "gallery_status",
            "compatible_glasses_search_stop",
            "heartbeat_sent",
            "heartbeat_received",
            "swipe_volume_status",
            "switch_status",
            "rgb_led_control_response",
            "pair_failure",
            "audio_pairing_needed",
            "audio_connected",
            "audio_disconnected",
            "save_setting",
            "local_transcription",
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
            "ota_start_ack",
            "ota_status",
            "send_command_to_ble",
            "receive_command_from_ble",
            "miniapp_selected",
            "captions_tester_incident"
        )

        OnCreate {
            // Initialize Bridge with event callback
            Bridge.initialize { [weak self] eventName, data in
                self?.sendEvent(eventName, data)
            }

            // Configure observable store event emission
            Task { @MainActor [weak self] in
                GlassesStore.shared.store.configure { [weak self] category, changes in
                    switch category {
                    case "glasses":
                        self?.sendEvent("glasses_status", changes)
                    case "core":
                        self?.sendEvent("core_status", changes)
                    default:
                        break
                    }
                }
            }
        }

        // MARK: - Observable Store Functions

        AsyncFunction("getGlassesStatus") {
            await MainActor.run {
                GlassesStore.shared.store.getCategory("glasses")
            }
        }

        AsyncFunction("getCoreStatus") {
            await MainActor.run {
                GlassesStore.shared.store.getCategory("core")
            }
        }

        AsyncFunction("update") { (category: String, values: [String: Any]) in
            await MainActor.run {
                for (key, value) in values {
                    if value is NSNull { continue }
                    GlassesStore.shared.apply(category, key, value)
                }
            }
        }

        // MARK: - Display Commands

        AsyncFunction("displayEvent") { (params: [String: Any]) in
            await MainActor.run {
                CoreManager.shared.displayEvent(params)
            }
        }

        AsyncFunction("displayText") { (params: [String: Any]) in
            await MainActor.run {
                CoreManager.shared.displayText(params)
            }
        }

        // MARK: - Connection Commands

        AsyncFunction("connectDefault") {
            await MainActor.run {
                CoreManager.shared.connectDefault()
            }
        }

        AsyncFunction("connectByName") { (deviceName: String) in
            await MainActor.run {
                CoreManager.shared.connectByName(deviceName)
            }
        }

        AsyncFunction("connectDefaultController") {
            await MainActor.run {
                CoreManager.shared.connectDefaultController()
            }
        }

        AsyncFunction("connectSimulated") {
            await MainActor.run {
                CoreManager.shared.connectSimulated()
            }
        }

        AsyncFunction("disconnect") {
            await MainActor.run {
                CoreManager.shared.disconnect()
            }
        }

        AsyncFunction("disconnectController") {
            await MainActor.run {
                CoreManager.shared.disconnectController()
            }
        }

        AsyncFunction("forget") {
            await MainActor.run {
                CoreManager.shared.forget()
            }
        }

        AsyncFunction("forgetController") {
            await MainActor.run {
                CoreManager.shared.forgetController()
            }
        }

        AsyncFunction("findCompatibleDevices") { (deviceModel: String) in
            await MainActor.run {
                CoreManager.shared.findCompatibleDevices(deviceModel)
            }
        }

        AsyncFunction("showDashboard") {
            await MainActor.run {
                CoreManager.shared.showDashboard()
            }
        }

        AsyncFunction("ping") {
            await MainActor.run {
                CoreManager.shared.ping()
            }
        }

        AsyncFunction("dbg1") {
            await MainActor.run {
                CoreManager.shared.dbg1()
                CoreManager.shared.sgc?.dbg1()
            }
        }

        AsyncFunction("dbg2") {
            await MainActor.run {
                CoreManager.shared.dbg2()
                CoreManager.shared.sgc?.dbg2()
            }
        }

        // Returns the current process resident-set-size in MB. Used by the
        // jetsam stress test to plot memory growth as miniapp WebViews are
        // mounted. Cheap (single mach call), safe to poll once a second.
        Function("getMemoryMB") { () -> Double in
            return MemoryMonitor.currentMemoryMB()
        }

        // JSC experiment: measure actual memory cost of N concurrent
        // JSContexts on iOS. Pebble proves 1 context is light, but they
        // don't run N. We do. Sub-questions:
        //   - per-context cost: ~5 MB (extrapolated) or ~50 MB (worst case)?
        //   - linear cost or fixed-cost cliffs?
        //   - does N=50 even fit?
        Function("jscSpawn") { (count: Int) -> Int in
            return JSCExperiment.spawn(count: count)
        }
        Function("jscKillAll") { () -> Void in
            JSCExperiment.killAll()
        }
        Function("jscAliveCount") { () -> Int in
            return JSCExperiment.aliveCount()
        }
        Function("jscSpawnAndMeasure") { (count: Int, baselineMB: Double) -> [String: Any] in
            return JSCExperiment.spawnAndMeasure(count: count, baselineMB: baselineMB)
        }
        Function("jscRunBenchmark") { () -> Void in
            JSCExperiment.runBenchmark()
        }

        // MARK: - Incident Reporting

        AsyncFunction("sendIncidentId") { (incidentId: String, apiBaseUrl: String?) in
            await MainActor.run {
                CoreManager.shared.sendIncidentId(incidentId, apiBaseUrl: apiBaseUrl)
            }
        }

        // MARK: - WiFi Commands

        AsyncFunction("requestWifiScan") {
            await MainActor.run {
                CoreManager.shared.requestWifiScan()
            }
        }

        AsyncFunction("sendWifiCredentials") { (ssid: String, password: String) in
            await MainActor.run {
                CoreManager.shared.sendWifiCredentials(ssid, password)
            }
        }

        AsyncFunction("forgetWifiNetwork") { (ssid: String) in
            await MainActor.run {
                CoreManager.shared.forgetWifiNetwork(ssid)
            }
        }

        AsyncFunction("setHotspotState") { (enabled: Bool) in
            await MainActor.run {
                CoreManager.shared.setHotspotState(enabled)
            }
        }

        // MARK: - Gallery Commands

        AsyncFunction("queryGalleryStatus") {
            await MainActor.run {
                CoreManager.shared.queryGalleryStatus()
            }
        }

        AsyncFunction("photoRequest") {
            (
                requestId: String, appId: String, size: String, webhookUrl: String?,
                authToken: String?, compress: String?, flash: Bool, sound: Bool
            ) in
            await MainActor.run {
                CoreManager.shared.photoRequest(
                    requestId, appId, size, webhookUrl, authToken, compress, flash, sound
                )
            }
        }

        // MARK: - OTA Commands

        AsyncFunction("sendOtaStart") {
            await MainActor.run {
                CoreManager.shared.sendOtaStart()
            }
        }

        AsyncFunction("sendOtaQueryStatus") {
            await MainActor.run {
                CoreManager.shared.sendOtaQueryStatus()
            }
        }

        // MARK: - Version Info Commands

        AsyncFunction("requestVersionInfo") {
            await MainActor.run {
                CoreManager.shared.requestVersionInfo()
            }
        }

        // MARK: - Power Control Commands

        AsyncFunction("sendShutdown") {
            await MainActor.run {
                CoreManager.shared.sendShutdown()
            }
        }

        AsyncFunction("sendReboot") {
            await MainActor.run {
                CoreManager.shared.sendReboot()
            }
        }

        // MARK: - Video Recording Commands

        AsyncFunction("startVideoRecording") { (requestId: String, save: Bool, flash: Bool, sound: Bool) in
            await MainActor.run {
                CoreManager.shared.startVideoRecording(requestId, save, flash, sound)
            }
        }

        AsyncFunction("stopVideoRecording") { (requestId: String) in
            await MainActor.run {
                CoreManager.shared.stopVideoRecording(requestId)
            }
        }

        // MARK: - Stream Commands

        AsyncFunction("startStream") { (params: [String: Any]) in
            await MainActor.run {
                CoreManager.shared.startStream(params)
            }
        }

        AsyncFunction("stopStream") {
            await MainActor.run {
                CoreManager.shared.stopStream()
            }
        }

        AsyncFunction("keepStreamAlive") { (params: [String: Any]) in
            await MainActor.run {
                CoreManager.shared.keepStreamAlive(params)
            }
        }

        // MARK: - Audio Playback Monitoring

        AsyncFunction("setOwnAppAudioPlaying") { (playing: Bool) in
            // Notify PhoneAudioMonitor that our app started/stopped playing audio
            // This is used to suspend LC3 mic during audio playback to avoid MCU overload
            PhoneAudioMonitor.getInstance().setOwnAppAudioPlaying(playing)
        }

        AsyncFunction("getGlassesMediaVolume") { () async throws -> [String: Any] in
            try await CoreManager.shared.getGlassesMediaVolume()
        }

        AsyncFunction("setGlassesMediaVolume") { (level: Int) async throws -> [String: Any] in
            try await CoreManager.shared.setGlassesMediaVolume(level: level)
        }

        // MARK: - RGB LED Control

        AsyncFunction("rgbLedControl") {
            (
                requestId: String, packageName: String?, action: String, color: String?,
                ontime: Int, offtime: Int, count: Int
            ) in
            await MainActor.run {
                CoreManager.shared.rgbLedControl(
                    requestId: requestId,
                    packageName: packageName,
                    action: action,
                    color: color,
                    ontime: ontime,
                    offtime: offtime,
                    count: count
                )
            }
        }

        // MARK: - Microphone Commands

        AsyncFunction("setMicState") { (_: Bool, _: Bool, _: Bool) in
            await MainActor.run {
                CoreManager.shared.setMicState()
            }
        }

        AsyncFunction("restartTranscriber") {
            await MainActor.run {
                CoreManager.shared.restartTranscriber()
            }
        }

        // MARK: - Display Commands

        AsyncFunction("clearDisplay") {
            await MainActor.run {
                CoreManager.shared.sgc?.clearDisplay()
            }
        }

        // MARK: - STT Model Management

        AsyncFunction("setSttModelDetails") { (path: String, languageCode: String) in
            STTTools.setSttModelDetails(path, languageCode)
        }

        AsyncFunction("getSttModelPath") { () -> String in
            return STTTools.getSttModelPath()
        }

        AsyncFunction("checkSttModelAvailable") { () -> Bool in
            return STTTools.checkSTTModelAvailable()
        }

        AsyncFunction("validateSttModel") { (path: String) -> Bool in
            return STTTools.validateSTTModel(path)
        }

        AsyncFunction("extractTarBz2") { (sourcePath: String, destinationPath: String) -> Bool in
            return STTTools.extractTarBz2(sourcePath: sourcePath, destinationPath: destinationPath)
        }

        // MARK: - Beta Build Detection

        AsyncFunction("isBetaBuild") { () -> Bool in
            #if targetEnvironment(simulator)
                return false
            #else
                return Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
            #endif
        }

        // MARK: - Android Stubs

        AsyncFunction("getInstalledApps") { () -> Any in
            return false
        }

        AsyncFunction("hasNotificationListenerPermission") { () -> Any in
            return false
        }

        // Notification management stubs (iOS doesn't support these features)
        Function("setNotificationsEnabled") { (_: Bool) in
            // No-op on iOS
        }

        Function("getNotificationsEnabled") { () -> Bool in
            return false
        }

        Function("setNotificationsBlocklist") { (_: [String]) in
            // No-op on iOS
        }

        Function("getNotificationsBlocklist") { () -> [String] in
            return []
        }

        AsyncFunction("getInstalledAppsForNotifications") { () -> [[String: Any]] in
            return []
        }
    }
}