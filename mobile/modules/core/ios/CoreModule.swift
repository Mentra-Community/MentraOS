import ExpoModulesCore
import Photos

public class CoreModule: Module {
    public func definition() -> ModuleDefinition {
        Name("Core")

        // Define events that can be sent to JavaScript
        Events("CoreMessageEvent", "onChange")

        OnCreate {
            // Initialize Bridge with event callback
            Bridge.initialize { [weak self] eventName, data in
                self?.sendEvent(eventName, data)
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

        AsyncFunction("getStatus") {
            await MainActor.run {
                CoreManager.shared.getStatus()
            }
        }

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

        AsyncFunction("findCompatibleDevices") { (modelName: String) in
            await MainActor.run {
                CoreManager.shared.findCompatibleDevices(modelName)
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

        // MARK: - Settings Commands

        AsyncFunction("updateSettings") { (params: [String: Any]) in
            await MainActor.run {
                CoreManager.shared.updateSettings(params)
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
