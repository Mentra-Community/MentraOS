import CryptoKit
import ExpoModulesCore
import Foundation

public class BluetoothSdkModule: Module, MentraBluetoothSDKDelegate {
    private var sdk: MentraBluetoothSDK?

    public func definition() -> ModuleDefinition {
        Name("BluetoothSdk")

        // Define events that can be sent to JavaScript
        Events(
            "glasses_status",
            "bluetooth_status",
            "log",
            "device_discovered",
            "default_device_changed",
            // Individual event handlers
            "glasses_not_ready",
            "button_press",
            "touch_event",
            "accel_event",
            "CompassHeadingEvent",
            "CompassCalibrationEvent",
            "head_up",
            "voice_activity_detection_status",
            "speaking_status",
            "battery_status",
            "wifi_status_change",
            "wifi_scan_result",
            "hotspot_status_change",
            "hotspot_error",
            "photo_response",
            "photo_status",
            "camera_status",
            "video_recording_status",
            "media_success",
            "media_error",
            "gallery_status",
            "compatible_glasses_search_stop",
            "heartbeat_sent",
            "heartbeat_received",
            "swipe_volume_status",
            "switch_status",
            "rgb_led_control_response",
            "settings_ack",
            "version_info",
            "pair_failure",
            "pairing_info",
            "entering_pairing_mode",
            "owner_replaced",
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
            "mic_health",
            "stream_status",
            "keep_alive_ack",
            "mtk_update_complete",
            "glasses_session_changed",
            "ota_progress",
            "ota_start_ack",
            "ota_status",
            "ar99_ota_status",
            "send_command_to_ble",
            "receive_command_from_ble",
            "miniapp_selected",
            "captions_tester_incident",
            "extraction_progress"
        )

        OnCreate {
            JSCExperiment.maybeAutoBenchmark()
            Task { @MainActor [weak self] in
                _ = self?.bluetoothSdk()
            }
        }

        OnDestroy {
            Task {
                await PcmStreamManager.abortAll()
            }
            Task { @MainActor [weak self] in
                self?.sdk?.invalidate()
                self?.sdk = nil
            }
        }

        // MARK: - Observable Store Functions

        Function("getGlassesStatus") { () -> [String: Any] in
            self.readOnMainActor {
                self.bluetoothSdk().glassesStatus.dictionary
            }
        }

        Function("getBluetoothStatus") { () -> [String: Any] in
            self.readOnMainActor {
                self.bluetoothSdk().bluetoothStatus.values
            }
        }

        Function("getDefaultDevice") { () -> [String: Any]? in
            self.readOnMainActor {
                self.bluetoothSdk().getDefaultDevice()?.dictionary
            }
        }

        AsyncFunction("update") { (category: String, values: [String: Any]) in
            await MainActor.run {
                let normalizedCategory = ObservableStore.normalizeCategory(category)
                for (key, value) in values {
                    if value is NSNull { continue }
                    DeviceStore.shared.apply(normalizedCategory, key, value)
                }
            }
        }

        // MARK: - Display Commands

        AsyncFunction("displayEvent") { (params: [String: Any]) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            try? await sdk.displayEvent(DisplayEventRequest(values: params))
        }

        AsyncFunction("displayText") { (text: String, x: Int?, y: Int?, size: Int?) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            try? await sdk.displayText(text, x: x ?? 0, y: y ?? 0, size: size ?? 24)
        }

        // MARK: - Connection Commands

        AsyncFunction("connectDefault") {
            try await MainActor.run {
                try self.bluetoothSdk().connectDefault()
            }
        }

        AsyncFunction("connectDefaultWithOptions") { (options: [String: Any]) in
            try await MainActor.run {
                try self.bluetoothSdk().connectDefault(options: ConnectOptions(dictionary: options))
            }
        }

        AsyncFunction("setDefaultDevice") { (device: [String: Any]?) in
            await MainActor.run {
                self.bluetoothSdk().setDefaultDevice(Device(dictionary: device))
            }
        }

        AsyncFunction("clearDefaultDevice") {
            await MainActor.run {
                self.bluetoothSdk().clearDefaultDevice()
            }
        }

        AsyncFunction("connectWithOptions") { (device: [String: Any], options: [String: Any]) in
            try await MainActor.run {
                guard let target = Device(dictionary: device) else {
                    throw BluetoothSdkError(
                        code: "invalid_device",
                        message: "connect requires a Device with model and name."
                    )
                }
                try self.bluetoothSdk().connect(to: target, options: ConnectOptions(dictionary: options))
            }
        }

        AsyncFunction("connectDefaultController") {
            await MainActor.run {
                DeviceManager.shared.connectDefaultController()
            }
        }

        AsyncFunction("connectSimulated") {
            await MainActor.run {
                self.bluetoothSdk().connectSimulated()
            }
        }

        AsyncFunction("disconnect") {
            await MainActor.run {
                self.bluetoothSdk().disconnect()
            }
        }

        AsyncFunction("disconnectController") {
            await MainActor.run {
                DeviceManager.shared.disconnectController()
            }
        }

        AsyncFunction("forget") {
            await MainActor.run {
                self.bluetoothSdk().forget()
            }
        }

        AsyncFunction("forgetController") {
            await MainActor.run {
                DeviceManager.shared.forgetController()
            }
        }

        AsyncFunction("startScan") { (model: String) in
            try await MainActor.run {
                try self.bluetoothSdk().startScan(model: DeviceModel.fromDeviceType(model))
            }
        }

        AsyncFunction("stopScan") {
            await MainActor.run {
                self.bluetoothSdk().stopScan()
            }
        }

        AsyncFunction("cancelConnectionAttempt") {
            await MainActor.run {
                self.bluetoothSdk().cancelConnectionAttempt()
            }
        }

        AsyncFunction("showDashboard") {
            await MainActor.run {
                self.bluetoothSdk().showDashboard()
            }
        }

        AsyncFunction("ping") {
            await MainActor.run {
                DeviceManager.shared.ping()
            }
        }

        AsyncFunction("dbg1") {
            await MainActor.run {
                DeviceManager.shared.dbg1()
                DeviceManager.shared.sgc?.dbg1()
            }
        }

        AsyncFunction("dbg2") {
            await MainActor.run {
                DeviceManager.shared.dbg2()
                DeviceManager.shared.sgc?.dbg2()
            }
        }

        Function("getMemoryMB") { () -> Double in
            MemoryMonitor.currentMemoryMB()
        }

        Function("jscSpawn") { (count: Int) -> Int in
            JSCExperiment.spawn(count: count)
        }

        Function("jscKillAll") { () in
            JSCExperiment.killAll()
        }

        Function("jscAliveCount") { () -> Int in
            JSCExperiment.aliveCount()
        }

        Function("jscSpawnAndMeasure") { (count: Int, baselineMB: Double) -> [String: Any] in
            JSCExperiment.spawnAndMeasure(count: count, baselineMB: baselineMB)
        }

        Function("jscRunBenchmark") { () in
            JSCExperiment.runBenchmark()
        }

        // MARK: - Incident Reporting

        AsyncFunction("sendIncidentId") { (incidentId: String, apiBaseUrl: String?) in
            await MainActor.run {
                self.bluetoothSdk().sendIncidentId(incidentId, apiBaseUrl: apiBaseUrl)
            }
        }

        // MARK: - WiFi Commands

        AsyncFunction("requestWifiScan") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.requestWifiScan().map(\.dictionary)
        }

        AsyncFunction("sendWifiCredentials") { (ssid: String, password: String) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.sendWifiCredentials(ssid: ssid, password: password).values
        }

        AsyncFunction("forgetWifiNetwork") { (ssid: String) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.forgetWifiNetwork(ssid: ssid).values
        }

        AsyncFunction("setHotspotState") { (enabled: Bool) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.setHotspotState(enabled: enabled).values
        }

        AsyncFunction("setWifiAdbState") { (enabled: Bool) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            try await sdk.setWifiAdbState(enabled: enabled)
        }

        AsyncFunction("setSystemTime") { (timestampMs: Double) in
            let maxTimestamp = Double(Int64.max).nextDown
            guard timestampMs.isFinite,
                  timestampMs >= Double(Int64.min),
                  timestampMs <= maxTimestamp
            else {
                throw BluetoothSdkError(
                    code: "invalid_timestamp",
                    message: "setSystemTime timestampMs must be a finite Int64 millisecond timestamp."
                )
            }
            let timestamp = Int64(timestampMs)
            await MainActor.run {
                self.bluetoothSdk().setSystemTime(timestampMs: timestamp)
            }
        }

        // MARK: - Gallery Commands

        AsyncFunction("setGalleryModeEnabled") { (enabled: Bool) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.setGalleryModeEnabled(enabled).values
        }

        AsyncFunction("setVoiceActivityDetectionEnabled") { (enabled: Bool) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            try await sdk.setVoiceActivityDetectionEnabled(enabled)
        }

        AsyncFunction("setLoudnessGateEnabled") { (enabled: Bool) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            try await sdk.setLoudnessGateEnabled(enabled)
        }

        AsyncFunction("setPhotoCaptureDefaults") { (params: [String: Any]) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.setPhotoCaptureDefaults(PhotoCaptureDefaults.from(params: params)).values
        }

        AsyncFunction("setVideoRecordingDefaults") { (width: Int, height: Int, fps: Int) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.setVideoRecordingDefaults(VideoRecordingDefaults(width: width, height: height, fps: fps)).values
        }

        AsyncFunction("setMaxVideoRecordingDuration") { (minutes: Int) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.setMaxVideoRecordingDuration(minutes: minutes).values
        }

        AsyncFunction("setCameraFov") { (fov: [String: Any]) in
            let value = intValue(fov["fov"]) ?? CameraFov.defaultFov
            let roiPosition = CameraRoiPosition.from(
                rawValue: intValue(fov["roiPosition"]) ?? intValue(fov["roi_position"])
            )
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.setCameraFov(CameraFov(fov: value, roiPosition: roiPosition)).values
        }

        AsyncFunction("setLegacyCameraFov") { (fov: [String: Any]) in
            let value = intValue(fov["fov"]) ?? CameraFov.defaultFov
            let roiPosition = CameraRoiPosition.from(
                rawValue: intValue(fov["roiPosition"]) ?? intValue(fov["roi_position"])
            )
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try sdk.setLegacyCameraFov(CameraFov(fov: value, roiPosition: roiPosition)).values
        }

        AsyncFunction("restoreLegacyCameraFov") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            try sdk.restoreLegacyCameraFov()
        }

        AsyncFunction("setCameraFovOverride") { (params: [String: Any]) in
            guard let leaseId = params["leaseId"] as? String, !leaseId.isEmpty else {
                throw BluetoothSdkError(code: "invalid_request", message: "leaseId is required")
            }
            let value = intValue(params["fov"]) ?? CameraFov.defaultFov
            let roiPosition = CameraRoiPosition.from(
                rawValue: intValue(params["roiPosition"]) ?? intValue(params["roi_position"])
            )
            let ttlMs = intValue(params["ttlMs"]) ?? 300_000
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.setCameraFovOverride(
                leaseId: leaseId,
                fov: CameraFov(fov: value, roiPosition: roiPosition),
                ttlMs: ttlMs
            ).values
        }

        AsyncFunction("releaseCameraFovOverride") { (leaseId: String) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.releaseCameraFovOverride(leaseId: leaseId).values
        }

        AsyncFunction("setCameraTuningConfig") { (anrOn: Bool, gainOn: Bool) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.setCameraTuningConfig(anrOn: anrOn, gainOn: gainOn).values
        }

        AsyncFunction("queryGalleryStatus") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.queryGalleryStatus().values
        }

        AsyncFunction("requestPhoto") { (params: [String: Any]) in
            let req = try PhotoRequest.from(params: params)
            Bridge.log(
                "NATIVE: PHOTO PIPELINE [3/6] BluetoothSdk.requestPhoto requestId=\(req.requestId) size=\(req.size.rawValue) compress=\(req.compress?.rawValue ?? "none") aeDivisor=\(req.aeExposureDivisor.map { String($0) } ?? "nil")"
            )

            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.requestPhoto(req).values
        }

        AsyncFunction("warmUpCamera") { (params: [String: Any]) in
            let requestId = params["requestId"] as? String
            let sizeRaw = params["size"] as? String ?? "medium"
            let size = PhotoSize(normalizedRawValue: sizeRaw)
            let mode = PhotoMode(normalizedRawValue: params["mode"] as? String)
            let exposureTimeNs: Double?
            switch params["exposureTimeNs"] {
            case let value as Double:
                exposureTimeNs = value.isFinite && value > 0 ? value : nil
            case let value as Int:
                exposureTimeNs = value > 0 ? Double(value) : nil
            case let value as NSNumber:
                let d = value.doubleValue
                exposureTimeNs = d.isFinite && d > 0 ? d : nil
            default:
                exposureTimeNs = nil
            }
            let durationRaw = intValue(params["durationMs"]) ?? 0
            let durationMs = durationRaw > 0 ? durationRaw : 15000
            let zsl = params["zsl"] as? Bool
            let mfnr = params["mfnr"] as? Bool

            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.warmUpCamera(
                requestId: requestId,
                size: size,
                mode: mode,
                exposureTimeNs: exposureTimeNs,
                durationMs: durationMs,
                zsl: zsl,
                mfnr: mfnr
            ).values
        }

        AsyncFunction("stopCameraWarmUp") { (requestId: String) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            try sdk.stopCameraWarmUp(requestId: requestId)
        }

        // MARK: - OTA Commands

        Function("setOtaVersionUrl") { (otaVersionUrl: String) in
            try self.readOnMainActor {
                let sdk = self.bluetoothSdk()
                try sdk.setOtaVersionUrl(otaVersionUrl)
            }
        }

        Function("getOtaVersionUrl") {
            try self.readOnMainActor {
                let sdk = self.bluetoothSdk()
                return try sdk.getOtaVersionUrl()
            }
        }

        AsyncFunction("checkForOtaUpdate") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.checkForOtaUpdate()
        }

        AsyncFunction("startOtaUpdate") { (otaVersionUrl: String?) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            if let otaVersionUrl, !otaVersionUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return try await sdk.startOtaUpdate(otaVersionUrl: otaVersionUrl).values
            }
            return try await sdk.startOtaUpdate().values
        }

        AsyncFunction("sendOtaQueryStatus") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.sendOtaQueryStatus().values
        }

        AsyncFunction("startAr99OtaFromFile") { (path: String) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await MainActor.run { try sdk.startAr99OtaFromFile(path) }
        }

        AsyncFunction("cancelAr99Ota") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            await MainActor.run { sdk.cancelAr99Ota() }
        }

        AsyncFunction("sendAr99FactoryReset") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            try await MainActor.run { try sdk.sendAr99FactoryReset() }
        }


        Function("buildAr99OtaSignature") { (secret: String, appName: String, currentVersion: String, serialNumber: String, nonce: String) in
            let raw = secret + appName + "juxinOTA" + currentVersion + serialNumber.trimmingCharacters(in: .whitespacesAndNewlines) + nonce
            let digest = Insecure.MD5.hash(data: Data(raw.utf8))
            return digest.map { String(format: "%02x", $0) }.joined()
        }
        // MARK: - Version Info Commands

        AsyncFunction("requestVersionInfo") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.requestVersionInfo().dictionary
        }

        // MARK: - Power Control Commands

        AsyncFunction("sendShutdown") {
            await MainActor.run {
                self.bluetoothSdk().sendShutdown()
            }
        }

        AsyncFunction("sendReboot") {
            await MainActor.run {
                self.bluetoothSdk().sendReboot()
            }
        }

        // MARK: - Video Recording Commands

        AsyncFunction("startVideoRecording") {
            (requestId: String, save: Bool, sound: Bool, settings: [String: Any]?) in
            /// Optional per-recording {width,height,fps}. Absent fields stay 0, which
            /// the glasses treat as "use the saved button-video default". JS numbers
            /// arrive as Double across the bridge, so coerce to Int.
            func dim(_ key: String) -> Int {
                (settings?[key] as? NSNumber)?.intValue ?? 0
            }
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.startVideoRecording(
                VideoRecordingRequest(
                    requestId: requestId, save: save, sound: sound,
                    width: dim("width"), height: dim("height"), fps: dim("fps"),
                    maxRecordingTimeMinutes: dim("maxRecordingTimeMinutes")
                )
            ).values
        }

        // webhookUrl/authToken are supplied at stop (not start) so the token is
        // fresh when the upload runs. Empty/nil webhook = keep on device.
        AsyncFunction("stopVideoRecording") {
            (requestId: String, webhookUrl: String?, authToken: String?) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.stopVideoRecording(
                requestId: requestId, webhookUrl: webhookUrl, authToken: authToken
            ).values
        }

        AsyncFunction("queryVideoRecordingStatus") { (requestId: String) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.queryVideoRecordingStatus(requestId: requestId).values
        }

        // MARK: - Stream Commands

        AsyncFunction("startStream") { (params: [String: Any]) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.startStream(StreamRequest(values: params)).values
        }

        AsyncFunction("startExternallyManagedStream") { (params: [String: Any]) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.startExternallyManagedStream(StreamRequest(values: params)).values
        }

        AsyncFunction("stopStream") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.stopStream().values
        }

        AsyncFunction("sendExternallyManagedStreamKeepAlive") { (params: [String: Any]) in
            await MainActor.run {
                self.bluetoothSdk().sendExternallyManagedStreamKeepAlive(StreamKeepAliveRequest(values: params))
            }
        }

        // MARK: - Audio Playback Monitoring

        AsyncFunction("setOwnAppAudioPlaying") { (playing: Bool) in
            await MainActor.run {
                self.bluetoothSdk().setOwnAppAudioPlaying(playing)
            }
        }

        // MARK: - Live PCM output stream (miniapp speaker.createStream)

        AsyncFunction("pcmStreamOpen") {
            (streamId: String, sampleRate: Int, channels: Int, volume: Double) async throws in
            try PcmStreamManager.open(
                streamId: streamId,
                sampleRate: sampleRate,
                channels: channels,
                volume: Float(volume)
            )
        }

        AsyncFunction("pcmStreamWrite") {
            (streamId: String, base64: String) async throws -> [String: Int64] in
            try ["bufferedMs": await PcmStreamManager.write(streamId: streamId, base64: base64)]
        }

        AsyncFunction("pcmStreamClose") {
            (streamId: String) async throws -> [String: Int64] in
            try ["durationMs": await PcmStreamManager.close(streamId: streamId)]
        }

        AsyncFunction("pcmStreamAbort") { (streamId: String) async in
            await PcmStreamManager.abort(streamId: streamId)
        }

        AsyncFunction("getGlassesMediaVolume") { () async throws -> [String: Any] in
            try await DeviceManager.shared.getGlassesMediaVolume()
        }

        AsyncFunction("setGlassesMediaVolume") { (level: Int) async throws -> [String: Any] in
            try await DeviceManager.shared.setGlassesMediaVolume(level: level)
        }

        // MARK: - RGB LED Control

        AsyncFunction("rgbLedControl") {
            (
                requestId: String, packageName: String?, action: String, color: String?,
                onDurationMs: Int, offDurationMs: Int, count: Int
            ) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.rgbLedControl(
                RgbLedRequest(
                    requestId: requestId,
                    packageName: packageName,
                    action: RgbLedAction(rawValue: action) ?? .off,
                    color: color.flatMap(RgbLedColor.init(rawValue:)),
                    onDurationMs: onDurationMs,
                    offDurationMs: offDurationMs,
                    count: count
                )
            ).values
        }

        // MARK: - Microphone Commands

        AsyncFunction("setMicState") { (
            enabled: Bool,
            useGlassesMic: Bool?,
            sendTranscript: Bool?,
            sendLc3Data: Bool?
        ) in
            await MainActor.run {
                self.bluetoothSdk().setMicState(
                    enabled: enabled,
                    useGlassesMic: useGlassesMic ?? true,
                    sendTranscript: sendTranscript ?? false,
                    sendLc3Data: sendLc3Data ?? false
                )
            }
        }

        AsyncFunction("restartTranscriber") {
            await MainActor.run {
                DeviceManager.shared.restartTranscriber()
            }
        }

        // MARK: - Display Commands

        AsyncFunction("clearDisplay") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            try? await sdk.clearDisplay()
        }

        // MARK: - STT Model Management

        #if !os(macOS)
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

        // MARK: - TTS Model Management

        AsyncFunction("setTtsModelDetails") { (path: String, languageCode: String) in
            TTSTools.setTtsModelDetails(path, languageCode)
        }

        AsyncFunction("getTtsModelPath") { () -> String in
            return TTSTools.getTtsModelPath()
        }

        AsyncFunction("getTtsModelLanguage") { () -> String in
            return TTSTools.getTtsModelLanguage()
        }

        AsyncFunction("checkTtsModelAvailable") { () -> Bool in
            return TTSTools.checkTTSModelAvailable()
        }

        AsyncFunction("validateTtsModel") { (path: String) -> Bool in
            return TTSTools.validateTTSModel(path)
        }

        AsyncFunction("generateTtsAudio") {
            (text: String, modelPath: String, outputPath: String, speakerId: Int, speed: Double) -> Bool in
            return TTSTools.generateTtsAudio(
                text: text,
                modelPath: modelPath,
                outputPath: outputPath,
                speakerId: speakerId,
                speed: speed
            )
        }
        #endif
    }

    @MainActor
    private func bluetoothSdk() -> MentraBluetoothSDK {
        if let sdk {
            return sdk
        }

        let sdk = MentraBluetoothSDK(
            configuration: MentraBluetoothSDKConfiguration(
                analytics: BluetoothSdkAnalyticsConfiguration().withSurface("react_native")
            )
        )
        sdk.delegate = self
        self.sdk = sdk
        return sdk
    }

    private func readOnMainActor<T>(_ body: @MainActor () throws -> T) rethrows -> T {
        if Thread.isMainThread {
            return try MainActor.assumeIsolated {
                try body()
            }
        }

        return try DispatchQueue.main.sync {
            try MainActor.assumeIsolated {
                try body()
            }
        }
    }

    @MainActor
    public func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlasses _: GlassesRuntimeState) {
        sendEvent("glasses_status", sdk.glassesStatus.dictionary)
    }

    @MainActor
    public func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateSdkState _: PhoneSdkRuntimeState) {
        sendEvent("bluetooth_status", sdk.bluetoothStatus.values)
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didDiscover device: Device) {
        sendEvent("device_discovered", device.dictionary)
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didStopScan reason: ScanStopReason) {
        guard reason == .completed else { return }
        let status = bluetoothSdk().bluetoothStatus
        let deviceModel = status.pendingWearable.isEmpty ? status.defaultWearable : status.pendingWearable
        sendEvent(
            "compatible_glasses_search_stop",
            [
                "type": "compatible_glasses_search_stop",
                "deviceModel": deviceModel,
            ]
        )
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceive event: BluetoothEvent) {
        switch event {
        case let .buttonPress(button):
            sendEvent(
                "button_press",
                [
                    "buttonId": button.buttonId,
                    "pressType": button.pressType,
                    "timestamp": button.timestamp ?? Int(Date().timeIntervalSince1970 * 1000),
                ]
            )
        case let .touch(touch):
            sendEvent("touch_event", touch.values)
        case let .voiceActivityDetectionStatus(status):
            sendEvent("voice_activity_detection_status", status.values)
        case let .speakingStatus(status):
            sendEvent("speaking_status", status.values)
        case let .micHealth(health):
            sendEvent("mic_health", health.values)
        case let .wifiStatus(status):
            sendEvent("wifi_status_change", status.values)
        case let .hotspotStatus(status):
            sendEvent("hotspot_status_change", status.values)
        case let .hotspotError(error):
            sendEvent("hotspot_error", error.values)
        case let .photoResponse(response):
            sendEvent("photo_response", response.values)
        case let .photoStatus(status):
            sendEvent("photo_status", status.values)
        case let .cameraStatus(status):
            sendEvent("camera_status", status.values)
        case let .videoRecordingStatus(status):
            sendEvent("video_recording_status", status.values)
        case let .mediaUpload(event):
            sendEvent(event.type, event.values)
        case let .rgbLedControlResponse(response):
            sendEvent("rgb_led_control_response", response.values)
        case let .streamStatus(status):
            sendEvent("stream_status", status.values)
        case let .keepAliveAck(ack):
            sendEvent("keep_alive_ack", ack.values)
        case let .otaStartAck(event):
            sendEvent("ota_start_ack", event.values)
        case let .otaStatus(event):
            sendEvent("ota_status", event.values)
        case let .settingsAck(event):
            sendEvent("settings_ack", event.values)
        case let .versionInfo(event):
            var values = event.dictionary
            values["type"] = "version_info"
            sendEvent("version_info", values)
        case let .localTranscription(transcription):
            sendEvent("local_transcription", transcription.values)
        case let .raw(name, values):
            sendEvent(name, values)
        }
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicPcm event: MicPcmEvent) {
        sendEvent("mic_pcm", event.values)
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicLc3 event: MicLc3Event) {
        sendEvent("mic_lc3", event.values)
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didChangeDefaultDevice device: Device?) {
        var event: [String: Any] = [:]
        if let device {
            event["device"] = device.dictionary
        }
        sendEvent("default_device_changed", event)
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didLog message: String) {
        sendEvent("log", ["message": message])
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didFail error: BluetoothSdkError) {
        sendEvent("pair_failure", ["error": error.message])
    }
}

private extension Device {
    init?(dictionary values: [String: Any]?) {
        guard let values else { return nil }
        guard let model = values["model"] as? String ?? values["deviceModel"] as? String else { return nil }
        guard let name = values["name"] as? String ?? values["deviceName"] as? String else { return nil }
        let identifier = values["address"] as? String ?? values["deviceAddress"] as? String
        let rssi: Int?
        switch values["rssi"] {
        case let value as Int:
            rssi = value
        case let value as Double:
            rssi = Int(value)
        case let value as NSNumber:
            rssi = value.intValue
        default:
            rssi = nil
        }
        let id = values["id"] as? String
        self.init(
            model: DeviceModel.fromDeviceType(model),
            name: name,
            identifier: identifier?.isEmpty == true ? nil : identifier,
            rssi: rssi,
            id: id
        )
    }
}

private extension ConnectOptions {
    init(dictionary values: [String: Any]?) {
        self.init(
            saveAsDefault: values?["saveAsDefault"] as? Bool ?? true,
            cancelExistingConnectionAttempt: values?["cancelExistingConnectionAttempt"] as? Bool ?? true
        )
    }
}



