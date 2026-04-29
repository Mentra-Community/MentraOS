import ExpoModulesCore

public class BluetoothSdkModule: Module, MentraBluetoothSDKDelegate {
    private var sdk: MentraBluetoothSDK?

    public func definition() -> ModuleDefinition {
        Name("BluetoothSdk")

        // Define events that can be sent to JavaScript
        Events(
            "glasses_status",
            "bluetooth_status",
            "log",
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
            "incident_log_report",
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
            "ws_text",
            "ws_bin",
            "mic_pcm",
            "mic_lc3",
            "stream_status",
            "keep_alive_ack",
            "mtk_update_complete",
            "ota_update_available",
            "ota_progress",
            "send_command_to_ble",
            "receive_command_from_ble",
            "miniapp_selected"
        )

        OnCreate {
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

        AsyncFunction("getGlassesStatus") {
            await MainActor.run {
                self.bluetoothSdk().glassesStatus.values
            }
        }

        AsyncFunction("getBluetoothStatus") {
            await MainActor.run {
                self.bluetoothSdk().bluetoothStatus.values
            }
        }

        AsyncFunction("update") { (category: String, values: [String: Any]) in
            await MainActor.run {
                let normalizedCategory = ObservableStore.normalizeCategory(category)
                for (key, value) in values {
                    DeviceStore.shared.apply(normalizedCategory, key, value)
                }
            }
        }

        // MARK: - Display Commands

        AsyncFunction("displayEvent") { (params: [String: Any]) in
            let sdk = await MainActor.run { self.bluetoothSdk() }
            try? await sdk.displayEvent(MentraDisplayEventRequest(values: params))
        }

        AsyncFunction("displayText") { (params: [String: Any]) in
            let request = MentraDisplayTextRequest(
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
            await MainActor.run {
                self.bluetoothSdk().connectDefault()
            }
        }

        AsyncFunction("connectByName") { (deviceName: String) in
            await MainActor.run {
                self.bluetoothSdk().connectByName(deviceName)
            }
        }

        AsyncFunction("connectDevice") { (deviceModel: String, deviceName: String) in
            await MainActor.run {
                self.bluetoothSdk().connect(model: MentraDeviceModel.fromDeviceType(deviceModel), name: deviceName)
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

        AsyncFunction("findCompatibleDevices") { (deviceModel: String) in
            await MainActor.run {
                self.bluetoothSdk().startScan(model: MentraDeviceModel.fromDeviceType(deviceModel))
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

        // MARK: - Incident Reporting

        AsyncFunction("requestIncidentLogs") { (incidentId: String) in
            await MainActor.run {
                self.bluetoothSdk().requestIncidentLogs(incidentId)
            }
        }

        AsyncFunction("completeIncidentLogReport") { (transferId: String, success: Bool) in
            await MainActor.run {
                self.bluetoothSdk().completeIncidentLogReport(transferId: transferId, success: success)
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
                    MentraPhotoRequest(
                        requestId: requestId,
                        appId: appId,
                        size: size,
                        webhookUrl: webhookUrl,
                        authToken: authToken,
                        compress: compress,
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
                    MentraVideoRecordingRequest(requestId: requestId, save: save, flash: flash, sound: sound)
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
                self.bluetoothSdk().startStream(MentraStreamRequest(values: params))
            }
        }

        AsyncFunction("stopStream") {
            await MainActor.run {
                self.bluetoothSdk().stopStream()
            }
        }

        AsyncFunction("keepStreamAlive") { (params: [String: Any]) in
            await MainActor.run {
                self.bluetoothSdk().keepStreamAlive(MentraStreamKeepAliveRequest(values: params))
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
                ontime: Int, offtime: Int, count: Int
            ) in
            await MainActor.run {
                DeviceManager.shared.rgbLedControl(
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
                DeviceManager.shared.setMicState()
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
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateGlassesStatus status: MentraGlassesStatusUpdate) {
        sendEvent("glasses_status", status.values)
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateBluetoothStatus status: MentraBluetoothStatusUpdate) {
        sendEvent("bluetooth_status", status.values)
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didDiscover _: MentraDiscoveredDevice) {}

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didStopScan reason: MentraScanStopReason) {
        guard reason == .completed else { return }
        sendEvent("compatible_glasses_search_stop", ["type": "compatible_glasses_search_stop"])
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceive event: MentraBluetoothEvent) {
        switch event {
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
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didChangeDefaultDevice _: MentraPairedDevice?) {}

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didLog message: String) {
        sendEvent("log", ["message": message])
    }

    @MainActor
    public func mentraBluetoothSDK(_: MentraBluetoothSDK, didFail error: MentraBluetoothError) {
        sendEvent("pair_failure", ["error": error.message])
    }
}
