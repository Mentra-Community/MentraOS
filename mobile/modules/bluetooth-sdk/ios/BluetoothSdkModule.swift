import ExpoModulesCore
import Foundation

public class CoreModule: Module, MentraBluetoothSDKDelegate {
    private var sdk: MentraBluetoothSDK?

    public func definition() -> ModuleDefinition {
        Name("Core")

        // Define events that can be sent to JavaScript
        Events(
            "glasses_status",
            "core_status",
            "log",
            "device_discovered",
            "default_device_changed",
            // Individual event handlers
            "glasses_not_ready",
            "button_press",
            "touch_event",
            "head_up",
            "vad_status",
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
            "ota_progress",
            "ota_start_ack",
            "ota_status",
            "send_command_to_ble",
            "receive_command_from_ble",
            "miniapp_selected",
            "captions_tester_incident"
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

        Function("getCoreStatus") { () -> [String: Any] in
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
                    GlassesStore.shared.apply(normalizedCategory, key, value)
                }
            }
        }

        // MARK: - Display Commands

        AsyncFunction("displayEvent") { (params: [String: Any]) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            try? await sdk.displayEvent(DisplayEventRequest(values: params))
        }

        AsyncFunction("displayText") { (params: [String: Any]) in
            let request = DisplayTextRequest(
                text: params["text"] as? String ?? "",
                x: intValue(params["x"], defaultValue: 0),
                y: intValue(params["y"], defaultValue: 0),
                size: intValue(params["size"], defaultValue: 24)
            )
            let sdk = await MainActor.run { self.bluetoothSdk() }
            try? await sdk.displayText(request)
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
                CoreManager.shared.connectDefaultController()
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
                CoreManager.shared.disconnectController()
            }
        }

        AsyncFunction("forget") {
            await MainActor.run {
                self.bluetoothSdk().forget()
            }
        }

        AsyncFunction("forgetController") {
            await MainActor.run {
                CoreManager.shared.forgetController()
            }
        }

        AsyncFunction("startScan") { (params: [String: Any]) in
            try await MainActor.run {
                let model = params["model"] as? String ?? DeviceTypes.LIVE
                try self.bluetoothSdk().startScan(model: DeviceModel.fromDeviceType(model))
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

        Function("getMemoryMB") { () -> Double in
            MemoryMonitor.currentMemoryMB()
        }

        Function("jscSpawn") { (count: Int) -> Int in
            JSCExperiment.spawn(count: count)
        }

        Function("jscKillAll") { () -> Void in
            JSCExperiment.killAll()
        }

        Function("jscAliveCount") { () -> Int in
            JSCExperiment.aliveCount()
        }

        Function("jscSpawnAndMeasure") { (count: Int, baselineMB: Double) -> [String: Any] in
            JSCExperiment.spawnAndMeasure(count: count, baselineMB: baselineMB)
        }

        Function("jscRunBenchmark") { () -> Void in
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
            await MainActor.run {
                self.bluetoothSdk().requestWifiScan()
            }
        }

        AsyncFunction("sendWifiCredentials") { (ssid: String, password: String) in
            await MainActor.run {
                self.bluetoothSdk().sendWifiCredentials(ssid: ssid, password: password)
            }
        }

        AsyncFunction("forgetWifiNetwork") { (ssid: String) in
            await MainActor.run {
                self.bluetoothSdk().forgetWifiNetwork(ssid: ssid)
            }
        }

        AsyncFunction("setHotspotState") { (enabled: Bool) in
            await MainActor.run {
                self.bluetoothSdk().setHotspotState(enabled: enabled)
            }
        }

        // MARK: - Gallery Commands

        AsyncFunction("setGalleryMode") { (mode: String) in
            let galleryMode: GalleryMode
            switch mode.lowercased() {
            case "auto":
                galleryMode = .auto
            case "manual":
                galleryMode = .manual
            default:
                throw BluetoothError(
                    code: "invalid_gallery_mode",
                    message: "setGalleryMode mode must be \"auto\" or \"manual\"."
                )
            }
            let sdk = await MainActor.run { self.bluetoothSdk() }
            try await sdk.setGalleryMode(galleryMode)
        }

        AsyncFunction("queryGalleryStatus") {
            await MainActor.run {
                self.bluetoothSdk().queryGalleryStatus()
            }
        }

        AsyncFunction("photoRequest") {
            (
                requestId: String, appId: String, size: String, webhookUrl: String?,
                authToken: String?, compress: String?, flash: Bool, sound: Bool
            ) in
            await MainActor.run {
                self.bluetoothSdk().requestPhoto(
                    PhotoRequest(
                        requestId: requestId,
                        appId: appId,
                        size: PhotoSize(rawValue: size) ?? .medium,
                        webhookUrl: webhookUrl,
                        authToken: authToken,
                        compress: compress.flatMap(PhotoCompression.init(rawValue:)),
                        flash: flash,
                        sound: sound
                    )
                )
            }
        }

        // MARK: - OTA Commands

        AsyncFunction("sendOtaStart") {
            await MainActor.run {
                self.bluetoothSdk().sendOtaStart()
            }
        }

        AsyncFunction("sendOtaQueryStatus") {
            await MainActor.run {
                self.bluetoothSdk().sendOtaQueryStatus()
            }
        }

        // MARK: - Version Info Commands

        AsyncFunction("requestVersionInfo") {
            await MainActor.run {
                self.bluetoothSdk().requestVersionInfo()
            }
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

        AsyncFunction("startVideoRecording") { (requestId: String, save: Bool, flash: Bool, sound: Bool) in
            await MainActor.run {
                self.bluetoothSdk().startVideoRecording(
                    VideoRecordingRequest(requestId: requestId, save: save, flash: flash, sound: sound)
                )
            }
        }

        AsyncFunction("stopVideoRecording") { (requestId: String) in
            await MainActor.run {
                self.bluetoothSdk().stopVideoRecording(requestId: requestId)
            }
        }

        // MARK: - Stream Commands

        AsyncFunction("startStream") { (params: [String: Any]) in
            await MainActor.run {
                self.bluetoothSdk().startStream(StreamRequest(values: params))
            }
        }

        AsyncFunction("stopStream") {
            await MainActor.run {
                self.bluetoothSdk().stopStream()
            }
        }

        AsyncFunction("keepStreamAlive") { (params: [String: Any]) in
            await MainActor.run {
                self.bluetoothSdk().keepStreamAlive(StreamKeepAliveRequest(values: params))
            }
        }

        // MARK: - Audio Playback Monitoring

        AsyncFunction("setOwnAppAudioPlaying") { (playing: Bool) in
            await MainActor.run {
                self.bluetoothSdk().setOwnAppAudioPlaying(playing)
            }
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
                self.bluetoothSdk().rgbLedControl(
                    RgbLedRequest(
                        requestId: requestId,
                        packageName: packageName,
                        action: RgbLedAction(rawValue: action) ?? .off,
                        color: color.flatMap(RgbLedColor.init(rawValue:)),
                        ontime: ontime,
                        offtime: offtime,
                        count: count
                    )
                )
            }
        }

        // MARK: - Microphone Commands

        AsyncFunction("setMicState") { (sendPcmData: Bool, sendTranscript: Bool, bypassVad: Bool) in
            await MainActor.run {
                self.bluetoothSdk().setMicState(
                    MicConfiguration(
                        sendPcmData: sendPcmData,
                        sendTranscript: sendTranscript,
                        bypassVad: bypassVad
                    )
                )
            }
        }

        AsyncFunction("restartTranscriber") {
            await MainActor.run {
                CoreManager.shared.restartTranscriber()
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

    private func intValue(_ value: Any?, defaultValue: Int) -> Int {
        switch value {
        case let value as Int:
            return value
        case let value as Double:
            return Int(value)
        case let value as NSNumber:
            return value.intValue
        default:
            return defaultValue
        }
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateGlassesStatus status: GlassesStatusUpdate) {
        sendEvent("glasses_status", status.dictionary)
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateBluetoothStatus status: BluetoothStatusUpdate) {
        sendEvent("core_status", status.values)
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
                "device_model": deviceModel,
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
        case let .wifiStatus(status):
            sendEvent("wifi_status_change", status.values)
        case let .hotspotStatus(status):
            sendEvent("hotspot_status_change", status.values)
        case let .hotspotError(error):
            sendEvent("hotspot_error", error.values)
        case let .photoResponse(response):
            sendEvent("photo_response", response.values)
        case let .streamStatus(status):
            sendEvent("stream_status", status.values)
        case let .keepAliveAck(ack):
            sendEvent("keep_alive_ack", ack.values)
        case let .localTranscription(transcription):
            sendEvent("local_transcription", transcription.values)
        case let .raw(name, values):
            sendEvent(name, values)
        }
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicPcm frame: Data) {
        sendEvent("mic_pcm", ["pcm": frame])
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicLc3 frame: Data) {
        sendEvent("mic_lc3", ["lc3": frame])
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
