import ExpoModulesCore
import Photos

public class CoreModule: Module {
    public func definition() -> ModuleDefinition {
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
            "phone_notification",
            "phone_notification_dismissed",
            "ws_text",
            "ws_bin",
            "mic_data",
            "rtmp_stream_status",
            "keep_alive_ack",
            "mtk_update_complete",
            "ota_update_available",
            "ota_progress"
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

        AsyncFunction("forget") {
            await MainActor.run {
                CoreManager.shared.forget()
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
                authToken: String?, compress: String?, silent: Bool
            ) in
            await MainActor.run {
                CoreManager.shared.photoRequest(
                    requestId, appId, size, webhookUrl, authToken, compress, silent
                )
            }
        }

        // MARK: - OTA Commands

        AsyncFunction("sendOtaStart") {
            await MainActor.run {
                CoreManager.shared.sendOtaStart()
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

        AsyncFunction("startBufferRecording") {
            await MainActor.run {
                CoreManager.shared.startBufferRecording()
            }
        }

        AsyncFunction("stopBufferRecording") {
            await MainActor.run {
                CoreManager.shared.stopBufferRecording()
            }
        }

        AsyncFunction("saveBufferVideo") { (requestId: String, durationSeconds: Int) in
            await MainActor.run {
                CoreManager.shared.saveBufferVideo(requestId, durationSeconds)
            }
        }

        AsyncFunction("startVideoRecording") { (requestId: String, save: Bool, silent: Bool) in
            await MainActor.run {
                CoreManager.shared.startVideoRecording(requestId, save, silent)
            }
        }

        AsyncFunction("stopVideoRecording") { (requestId: String) in
            await MainActor.run {
                CoreManager.shared.stopVideoRecording(requestId)
            }
        }

        // MARK: - RTMP Stream Commands

        AsyncFunction("startRtmpStream") { (params: [String: Any]) in
            await MainActor.run {
                CoreManager.shared.startRtmpStream(params)
            }
        }

        AsyncFunction("stopRtmpStream") {
            await MainActor.run {
                CoreManager.shared.stopRtmpStream()
            }
        }

        AsyncFunction("keepRtmpStreamAlive") { (params: [String: Any]) in
            await MainActor.run {
                CoreManager.shared.keepRtmpStreamAlive(params)
            }
        }

        // MARK: - Microphone Commands

        AsyncFunction("setMicState") { (sendPcmData: Bool, sendTranscript: Bool, bypassVad: Bool) in
            await MainActor.run {
                CoreManager.shared.setMicState(sendPcmData, sendTranscript, bypassVad)
            }
        }

        AsyncFunction("restartTranscriber") {
            await MainActor.run {
                CoreManager.shared.restartTranscriber()
            }
        }

        // MARK: - Audio Playback Monitoring

        AsyncFunction("setOwnAppAudioPlaying") { (playing: Bool) in
            // Notify PhoneAudioMonitor that our app started/stopped playing audio
            // This is used to suspend LC3 mic during audio playback to avoid MCU overload
            PhoneAudioMonitor.getInstance().setOwnAppAudioPlaying(playing)
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

        // MARK: - STT Commands

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

        // MARK: - Media Library Commands

        AsyncFunction("saveToGalleryWithDate") {
            (filePath: String, captureTimeMillis: Int64?) -> [String: Any] in
            let fileURL = URL(fileURLWithPath: filePath)

            guard FileManager.default.fileExists(atPath: filePath) else {
                return ["success": false, "error": "File does not exist"]
            }

            var assetIdentifier: String?
            let semaphore = DispatchSemaphore(value: 0)
            var resultError: Error?

            PHPhotoLibrary.shared().performChanges {
                let creationRequest: PHAssetChangeRequest
                let pathExtension = fileURL.pathExtension.lowercased()

                if ["mp4", "mov", "avi", "m4v"].contains(pathExtension) {
                    // Video
                    creationRequest = PHAssetChangeRequest.creationRequestForAssetFromVideo(
                        atFileURL: fileURL)!
                } else {
                    // Photo
                    creationRequest = PHAssetChangeRequest.creationRequestForAssetFromImage(
                        atFileURL: fileURL)!
                }

                // Set the creation date if provided
                if let captureMillis = captureTimeMillis {
                    let captureDate = Date(
                        timeIntervalSince1970: TimeInterval(captureMillis) / 1000.0)
                    creationRequest.creationDate = captureDate
                    Bridge.log("CoreModule: Setting creation date to: \(captureDate)")
                }

                assetIdentifier = creationRequest.placeholderForCreatedAsset?.localIdentifier
            } completionHandler: { _, error in
                resultError = error
                semaphore.signal()
            }

            semaphore.wait()

            if let error = resultError {
                Bridge.log("CoreModule: Error saving to gallery: \(error.localizedDescription)")
                return ["success": false, "error": error.localizedDescription]
            }

            Bridge.log("CoreModule: Successfully saved to gallery with proper creation date")
            return ["success": true, "identifier": assetIdentifier ?? ""]
        }
    }
}
