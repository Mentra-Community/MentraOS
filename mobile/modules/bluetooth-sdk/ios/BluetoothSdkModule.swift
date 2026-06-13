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
            "video_recording_status",
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
            "ota_progress",
            "ota_start_ack",
            "ota_status",
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
                    throw BluetoothError(
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

        AsyncFunction("connectRemoteHarness") {
            await MainActor.run {
                self.bluetoothSdk().connectRemoteHarness()
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

        AsyncFunction("setSystemTime") { (timestampMs: Double) in
            let maxTimestamp = Double(Int64.max).nextDown
            guard timestampMs.isFinite,
                  timestampMs >= Double(Int64.min),
                  timestampMs <= maxTimestamp
            else {
                throw BluetoothError(
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

        AsyncFunction("setButtonPhotoSettings") { (size: String) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.setButtonPhotoSettings(size: ButtonPhotoSize(rawValue: size) ?? .medium).values
        }

        AsyncFunction("setButtonVideoRecordingSettings") { (width: Int, height: Int, fps: Int) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.setButtonVideoRecordingSettings(width: width, height: height, fps: fps).values
        }

        AsyncFunction("setButtonCameraLed") { (enabled: Bool) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.setButtonCameraLed(enabled: enabled).values
        }

        AsyncFunction("setButtonMaxRecordingTime") { (minutes: Int) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.setButtonMaxRecordingTime(minutes: minutes).values
        }

        AsyncFunction("setCameraFov") { (fov: [String: Any]) in
            let value = intValue(fov["fov"]) ?? CameraFov.defaultFov
            let roiPosition = CameraRoiPosition.from(
                rawValue: intValue(fov["roiPosition"]) ?? intValue(fov["roi_position"])
            )
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.setCameraFov(CameraFov(fov: value, roiPosition: roiPosition)).values
        }

        AsyncFunction("queryGalleryStatus") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.queryGalleryStatus().values
        }

        AsyncFunction("requestPhoto") { (params: [String: Any]) in
            let requestId = params["requestId"] as? String ?? ""
            let appId = params["appId"] as? String ?? ""
            Bridge.log(
                "NATIVE: PHOTO PIPELINE [3/6] BluetoothSdk.requestPhoto requestId=\(requestId) appId=\(appId)"
            )
            let size = params["size"] as? String ?? "medium"
            let webhookUrl = params["webhookUrl"] as? String ?? ""
            let authToken = params["authToken"] as? String ?? ""
            let compress = params["compress"] as? String ?? "none"
            let flash = params["flash"] as? Bool ?? true
            let save = params["save"] as? Bool ?? params["saveToGallery"] as? Bool ?? false
            let sound = params["sound"] as? Bool ?? true
            let exposureTimeNs: Double?
            switch params["exposureTimeNs"] {
            case let value as Double:
                exposureTimeNs = value
            case let value as Int:
                exposureTimeNs = Double(value)
            case let value as NSNumber:
                exposureTimeNs = value.doubleValue
            default:
                exposureTimeNs = nil
            }
            let iso: Int?
            switch params["iso"] {
            case let value as Int:
                iso = value > 0 ? value : nil
            case let value as Double:
                // Guard against Int(Double) trapping on out-of-range values.
                iso = (value.isFinite && value > 0 && value < Double(Int.max)) ? Int(value) : nil
            case let value as NSNumber:
                let intValue = value.intValue
                iso = intValue > 0 ? intValue : nil
            default:
                iso = nil
            }

            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.requestPhoto(
                PhotoRequest(
                    requestId: requestId,
                    appId: appId,
                    size: PhotoSize(rawValue: size) ?? .medium,
                    webhookUrl: webhookUrl,
                    authToken: authToken,
                    compress: PhotoCompression(rawValue: compress),
                    flash: flash,
                    save: save,
                    sound: sound,
                    exposureTimeNs: exposureTimeNs,
                    iso: iso
                )
            ).values
        }

        // MARK: - OTA Commands

        AsyncFunction("sendOtaStart") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.sendOtaStart().values
        }

        AsyncFunction("sendOtaQueryStatus") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.sendOtaQueryStatus().values
        }

        AsyncFunction("retryOtaVersionCheck") {
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.retryOtaVersionCheck().values
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
            // Optional per-recording {width,height,fps}. Absent fields stay 0, which
            // the glasses treat as "use the saved button-video default". JS numbers
            // arrive as Double across the bridge, so coerce to Int.
            func dim(_ key: String) -> Int {
                (settings?[key] as? NSNumber)?.intValue ?? 0
            }
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.startVideoRecording(
                VideoRecordingRequest(
                    requestId: requestId, save: save, sound: sound,
                    width: dim("width"), height: dim("height"), fps: dim("fps")
                )
            ).values
        }

        AsyncFunction("stopVideoRecording") { (requestId: String) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.stopVideoRecording(requestId: requestId).values
        }

        // MARK: - Stream Commands

        AsyncFunction("startStream") { (params: [String: Any]) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            return try await sdk.startStream(StreamRequest(values: params)).values
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
    }

    @MainActor
    private func bluetoothSdk() -> MentraBluetoothSDK {
        if let sdk {
            return sdk
        }

        let sdk = MentraBluetoothSDK()
        sdk.delegate = self
        self.sdk = sdk
        return sdk
    }

    private func readOnMainActor<T>(_ body: @MainActor () -> T) -> T {
        if Thread.isMainThread {
            return MainActor.assumeIsolated {
                body()
            }
        }

        return DispatchQueue.main.sync {
            MainActor.assumeIsolated {
                body()
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
        case let .videoRecordingStatus(status):
            sendEvent("video_recording_status", status.values)
        case let .rgbLedControlResponse(response):
            sendEvent("rgb_led_control_response", response.values)
        case let .streamStatus(status):
            sendEvent("stream_status", status.values)
        case let .keepAliveAck(ack):
            sendEvent("keep_alive_ack", ack.values)
        case let .otaUpdateAvailable(event):
            sendEvent("ota_update_available", event.values)
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
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didFail error: BluetoothError) {
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
