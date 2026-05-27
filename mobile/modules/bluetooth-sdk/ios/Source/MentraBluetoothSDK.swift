import CoreBluetooth
import Foundation

@MainActor
private final class ActiveStreamKeepAlive {
    let streamId: String
    let intervalSeconds: Int
    var pendingAckId: String?
    var missedAckCount = 0
    var task: Task<Void, Never>?

    init(streamId: String, intervalSeconds: Int) {
        self.streamId = streamId
        self.intervalSeconds = intervalSeconds
    }
}

@MainActor
private final class ActiveScanSession {
    let model: DeviceModel
    let onResults: ([Device]) -> Void
    let onComplete: ([Device]) -> Void
    var latestResults: [Device] = []
    var timeoutTask: Task<Void, Never>?
    weak var publicSession: ScanSession?

    init(
        model: DeviceModel,
        onResults: @escaping ([Device]) -> Void,
        onComplete: @escaping ([Device]) -> Void
    ) {
        self.model = model
        self.onResults = onResults
        self.onComplete = onComplete
    }
}

@MainActor
public final class MentraBluetoothSDK {
    public weak var delegate: MentraBluetoothSDKDelegate?

    private let configuration: MentraBluetoothSDKConfiguration
    private var discoveredDeviceNames = Set<String>()
    private var bridgeEventSinkId: String?
    private var storeListenerId: String?
    private let defaultDeviceKeys: Set<String> = ["default_wearable", "device_name", "device_address"]
    private var suppressDefaultDeviceEvents = false
    private var defaultDeviceApplyGeneration = 0
    private var activeScanSessions: [UUID: ActiveScanSession] = [:]
    private var activeStreamKeepAlive: ActiveStreamKeepAlive?

    public init(configuration: MentraBluetoothSDKConfiguration = .default) {
        self.configuration = configuration
        _ = BluetoothAvailability.shared
        bridgeEventSinkId = Bridge.addEventSink { [weak self] eventName, data in
            Task { @MainActor [weak self] in
                self?.dispatchBridgeEvent(eventName, data)
            }
        }
        storeListenerId = DeviceStore.shared.store.addListener { [weak self] category, changes in
            Task { @MainActor [weak self] in
                self?.dispatchStoreUpdate(category, changes)
            }
        }
    }

    public var state: MentraBluetoothState {
        MentraBluetoothState(glassesStatus: glassesStatus, bluetoothStatus: bluetoothStatus)
    }

    public var glasses: GlassesRuntimeState {
        state.glasses
    }

    public var sdkState: PhoneSdkRuntimeState {
        state.sdk
    }

    public var scanState: BluetoothScanState {
        state.scan
    }

    var glassesStatus: GlassesStatus {
        GlassesStatus(values: DeviceStore.shared.store.getCategory("glasses"))
    }

    var bluetoothStatus: BluetoothStatus {
        BluetoothStatus(values: DeviceStore.shared.store.getCategory(ObservableStore.bluetoothCategory))
    }

    public var defaultDevice: Device? {
        currentDefaultDevice()
    }

    public func getDefaultDevice() -> Device? {
        currentDefaultDevice()
    }

    public func setDefaultDevice(_ device: Device?) {
        guard let device else {
            clearDefaultDevice()
            return
        }
        defaultDeviceApplyGeneration += 1
        let generation = defaultDeviceApplyGeneration
        suppressDefaultDeviceEvents = true
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "default_wearable", device.model.deviceType)
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "device_name", device.name)
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "device_address", device.identifier ?? "")
        finishDefaultDeviceApply(generation: generation)
    }

    public func clearDefaultDevice() {
        defaultDeviceApplyGeneration += 1
        let generation = defaultDeviceApplyGeneration
        suppressDefaultDeviceEvents = true
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "default_wearable", "")
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "device_name", "")
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "device_address", "")
        finishDefaultDeviceApply(generation: generation)
    }

    public func startScan(model: DeviceModel) throws {
        if model != .simulated {
            try BluetoothAvailability.shared.requirePoweredOn(operation: "scan for glasses")
        }
        discoveredDeviceNames.removeAll()
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "searching", true)
        DeviceManager.shared.findCompatibleDevices(model.deviceType)
    }

    public func stopScan() {
        stopScan(reason: .cancelled)
    }

    private func stopScan(reason: ScanStopReason) {
        DeviceManager.shared.stopScan()
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "searching", false)
        delegate?.mentraBluetoothSDK(self, didStopScan: reason)
    }

    @discardableResult
    public func scan(
        model: DeviceModel,
        timeout: TimeInterval = 15,
        onResults: @escaping ([Device]) -> Void,
        onComplete: @escaping ([Device]) -> Void = { _ in }
    ) throws -> ScanSession {
        let normalizedTimeout = timeout > 0 && timeout.isFinite ? timeout : 15
        let id = UUID()
        let activeSession = ActiveScanSession(
            model: model,
            onResults: onResults,
            onComplete: onComplete
        )
        let publicSession = ScanSession { [weak self] in
            self?.finishScanSession(id, reason: .cancelled, shouldStopScan: true)
        }
        activeSession.publicSession = publicSession
        activeScanSessions[id] = activeSession

        do {
            emitScanResults([], forSession: id)
            try startScan(model: model)
            emitScanResults(bluetoothStatus.searchResults.filter { $0.model == model }, forSession: id)
            activeSession.timeoutTask = Task { [weak self] in
                let nanoseconds = UInt64(normalizedTimeout * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nanoseconds)
                await self?.finishScanSession(id, reason: .completed, shouldStopScan: true)
            }
            return publicSession
        } catch {
            activeScanSessions[id] = nil
            publicSession.markStopped()
            throw error
        }
    }

    public func connect(to device: Device, options: ConnectOptions = ConnectOptions()) throws {
        if device.model != .simulated {
            try BluetoothAvailability.shared.requirePoweredOn(operation: "connect to glasses")
        }
        let isController = ControllerTypes.ALL.contains(device.model.deviceType)
        if options.cancelExistingConnectionAttempt {
            if isController {
                DeviceManager.shared.disconnectController()
            } else {
                cancelConnectionAttempt()
            }
        }
        if options.saveAsDefault && !isController {
            setDefaultDevice(device)
        }
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "pending_wearable", device.model.deviceType)
        DeviceManager.shared.connectByName(device.name)
    }

    public func connectDefault(options: ConnectOptions = ConnectOptions()) throws {
        guard let device = currentDefaultDevice() else {
            throw BluetoothError(
                code: "default_device_missing",
                message: "Set a default glasses device before calling connectDefault."
            )
        }
        if device.model != .simulated {
            try BluetoothAvailability.shared.requirePoweredOn(operation: "connect to glasses")
        }
        if options.cancelExistingConnectionAttempt {
            cancelConnectionAttempt()
        }
        DeviceManager.shared.connectDefault()
    }

    public func cancelConnectionAttempt() {
        DeviceManager.shared.disconnect()
    }

    func connectSimulated() {
        DeviceManager.shared.connectSimulated()
    }

    public func disconnect() {
        DeviceManager.shared.disconnect()
    }

    public func forget() {
        DeviceManager.shared.forget()
    }

    public func displayText(_ text: String, x: Int = 0, y: Int = 0, size: Int = 24) async throws {
        try await displayText(DisplayTextRequest(text: text, x: x, y: y, size: size))
    }

    public func displayText(_ request: DisplayTextRequest) async throws {
        DeviceManager.shared.displayText(request.dictionary)
    }

    func displayEvent(_ request: DisplayEventRequest) async throws {
        DeviceManager.shared.displayEvent(request.values)
    }

    public func clearDisplay() async throws {
        DeviceManager.shared.sgc?.clearDisplay()
    }

    public func showDashboard() {
        DeviceManager.shared.showDashboard()
    }

    func setBrightness(_ level: Int, autoMode: Bool? = nil) async throws {
        if let autoMode {
            DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "auto_brightness", autoMode)
        }
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "brightness", level)
    }

    func setAutoBrightness(enabled: Bool) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "auto_brightness", enabled)
    }

    public func setDashboardPosition(height: Int, depth: Int) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "dashboard_height", height)
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "dashboard_depth", depth)
    }

    public func setDashboardPosition(_ request: DashboardPositionRequest) async throws {
        try await setDashboardPosition(height: request.height, depth: request.depth)
    }

    func setDashboardMenu(_ items: [DashboardMenuItem]) async throws {
        DeviceStore.shared.apply(
            ObservableStore.bluetoothCategory,
            "menu_apps",
            items.map(\.dictionary)
        )
    }

    public func setHeadUpAngle(_ angleDegrees: Int) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "head_up_angle", angleDegrees)
    }

    public func setScreenDisabled(_ disabled: Bool) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "screen_disabled", disabled)
    }

    public func setGalleryModeEnabled(_ enabled: Bool) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "gallery_mode", enabled)
    }

    public func setVoiceActivityDetectionEnabled(_ enabled: Bool) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "voice_activity_detection_enabled", enabled)
    }

    public func setButtonPhotoSettings(size: ButtonPhotoSize) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "button_photo_size", size.rawValue)
    }

    public func setButtonPhotoSettings(_ settings: ButtonPhotoSettings) async throws {
        try await setButtonPhotoSettings(size: settings.size)
    }

    public func setButtonVideoRecordingSettings(width: Int, height: Int, fps: Int) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "button_video_width", width)
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "button_video_height", height)
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "button_video_fps", fps)
    }

    public func setButtonVideoRecordingSettings(_ settings: ButtonVideoRecordingSettings) async throws {
        try await setButtonVideoRecordingSettings(width: settings.width, height: settings.height, fps: settings.fps)
    }

    public func setButtonCameraLed(enabled: Bool) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "button_camera_led", enabled)
    }

    public func setButtonMaxRecordingTime(minutes: Int) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "button_max_recording_time", minutes)
    }

    public func setCameraFov(_ fov: CameraFov) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "camera_fov", fov.value)
    }

    public func setMicState(
        enabled: Bool,
        useGlassesMic: Bool = true,
        sendTranscript: Bool = false,
        sendLc3Data: Bool = false
    ) {
        if enabled {
            DeviceStore.shared.apply(
                ObservableStore.bluetoothCategory,
                "preferred_mic",
                useGlassesMic ? MicPreference.glasses.rawValue : MicPreference.phone.rawValue
            )
        }
        applyMicState(
            sendPcmData: enabled,
            sendTranscript: enabled && sendTranscript,
            sendLc3Data: enabled && sendLc3Data
        )
    }

    private func applyMicState(
        sendPcmData: Bool,
        sendTranscript: Bool,
        sendLc3Data: Bool
    ) {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "should_send_pcm", sendPcmData)
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "should_send_lc3", sendLc3Data)
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "should_send_transcript", sendTranscript)
        DeviceManager.shared.setMicState()
    }

    public func setPreferredMic(_ preferredMic: MicPreference) {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "preferred_mic", preferredMic.rawValue)
    }

    public func setOwnAppAudioPlaying(_ playing: Bool) {
        PhoneAudioMonitor.getInstance().setOwnAppAudioPlaying(playing)
    }

    public func getGlassesMediaVolume() async throws -> GlassesMediaVolumeGetResult {
        GlassesMediaVolumeGetResult(values: try await DeviceManager.shared.getGlassesMediaVolume())
    }

    public func setGlassesMediaVolume(_ level: Int) async throws -> GlassesMediaVolumeSetResult {
        guard (0...15).contains(level) else {
            throw BluetoothError(
                code: "invalid_volume_level",
                message: "Glasses media volume must be between 0 and 15."
            )
        }
        return GlassesMediaVolumeSetResult(values: try await DeviceManager.shared.setGlassesMediaVolume(level: level))
    }

    public func requestWifiScan() {
        DeviceManager.shared.requestWifiScan()
    }

    public func sendWifiCredentials(ssid: String, password: String) {
        DeviceManager.shared.sendWifiCredentials(ssid, password)
    }

    public func forgetWifiNetwork(ssid: String) {
        DeviceManager.shared.forgetWifiNetwork(ssid)
    }

    public func setHotspotState(enabled: Bool) {
        DeviceManager.shared.setHotspotState(enabled)
    }

    public func requestPhoto(_ request: PhotoRequest) {
        Bridge.log(
            "NATIVE: PHOTO PIPELINE [3b/6] MentraBluetoothSdk.requestPhoto requestId=\(request.requestId) appId=\(request.appId)"
        )
        DeviceManager.shared.requestPhoto(
            request.requestId,
            request.appId,
            request.size.rawValue,
            request.webhookUrl,
            request.authToken,
            request.compress?.rawValue,
            request.flash,
            request.sound,
            exposureTimeNs: request.exposureTimeNs,
            iso: request.iso
        )
    }

    public func queryGalleryStatus() {
        DeviceManager.shared.queryGalleryStatus()
    }

    public func startStream(_ request: StreamRequest) {
        var values = request.values
        let streamId = stringValue(values, "streamId").flatMap { $0.isEmpty ? nil : $0 } ?? "sdk-\(UUID().uuidString)"
        values["streamId"] = streamId
        stopStreamKeepAliveMonitor()
        DeviceManager.shared.startStream(values)
        if request.keepAlive, !request.isExternallyManagedKeepAlive {
            startStreamKeepAliveMonitor(streamId: streamId, intervalSeconds: request.keepAliveIntervalSeconds)
        }
    }

    func sendCloudStreamKeepAlive(_ request: StreamKeepAliveRequest) {
        DeviceManager.shared.keepStreamAlive(request.values)
    }

    public func rgbLedControl(_ request: RgbLedRequest) {
        DeviceManager.shared.rgbLedControl(
            requestId: request.requestId,
            packageName: request.packageName,
            action: request.action.rawValue,
            color: request.color?.rawValue,
            onDurationMs: request.onDurationMs,
            offDurationMs: request.offDurationMs,
            count: request.count
        )
    }

    public func stopStream() {
        stopStreamKeepAliveMonitor()
        DeviceManager.shared.stopStream()
    }

    public func startVideoRecording(_ request: VideoRecordingRequest) {
        DeviceManager.shared.startVideoRecording(
            request.requestId,
            request.save,
            request.sound
        )
    }

    public func stopVideoRecording(requestId: String) {
        DeviceManager.shared.stopVideoRecording(requestId)
    }

    public func requestVersionInfo() {
        DeviceManager.shared.requestVersionInfo()
    }

    func sendOtaStart() {
        DeviceManager.shared.sendOtaStart()
    }

    func sendOtaQueryStatus() {
        DeviceManager.shared.sendOtaQueryStatus()
    }

    func sendShutdown() {
        DeviceManager.shared.sendShutdown()
    }

    func sendReboot() {
        DeviceManager.shared.sendReboot()
    }

    func sendIncidentId(_ incidentId: String, apiBaseUrl: String? = nil) {
        DeviceManager.shared.sendIncidentId(incidentId, apiBaseUrl: apiBaseUrl)
    }

    public func invalidate() {
        stopStreamKeepAliveMonitor()
        if let bridgeEventSinkId {
            Bridge.removeEventSink(bridgeEventSinkId)
            self.bridgeEventSinkId = nil
        }
        if let storeListenerId {
            DeviceStore.shared.store.removeListener(storeListenerId)
            self.storeListenerId = nil
        }
        delegate = nil
    }

    private func startStreamKeepAliveMonitor(streamId: String, intervalSeconds requestedIntervalSeconds: Int) {
        let intervalSeconds = requestedIntervalSeconds > 0 ? requestedIntervalSeconds : 5
        let tracker = ActiveStreamKeepAlive(streamId: streamId, intervalSeconds: intervalSeconds)
        activeStreamKeepAlive = tracker
        sendNextStreamKeepAlive(for: tracker)
    }

    private func stopStreamKeepAliveMonitor() {
        activeStreamKeepAlive?.task?.cancel()
        activeStreamKeepAlive = nil
    }

    private func sendNextStreamKeepAlive(for tracker: ActiveStreamKeepAlive) {
        guard activeStreamKeepAlive === tracker else { return }

        if tracker.pendingAckId != nil {
            tracker.missedAckCount += 1
            if tracker.missedAckCount >= 3 {
                activeStreamKeepAlive = nil
                tracker.task?.cancel()
                let event = StreamStatusEvent(
                    status: .error(
                        streamId: tracker.streamId,
                        errorDetails: "Stream keep-alive timed out after \(tracker.missedAckCount) missed ACKs",
                        timestamp: Int(Date().timeIntervalSince1970 * 1000),
                        resolvedConfig: nil
                    )
                )
                delegate?.mentraBluetoothSDK(self, didReceive: .streamStatus(event))
                return
            }
        }

        let ackId = "ack-\(Int(Date().timeIntervalSince1970 * 1000))"
        tracker.pendingAckId = ackId
        DeviceManager.shared.keepStreamAlive(
            StreamKeepAliveRequest(streamId: tracker.streamId, ackId: ackId).values
        )

        tracker.task?.cancel()
        tracker.task = Task { @MainActor [weak self, weak tracker] in
            guard let tracker else { return }
            try? await Task.sleep(nanoseconds: UInt64(tracker.intervalSeconds) * 1_000_000_000)
            self?.sendNextStreamKeepAlive(for: tracker)
        }
    }

    private func handleStreamKeepAliveAck(_ event: KeepAliveAckEvent) -> Bool {
        guard let tracker = activeStreamKeepAlive,
              event.streamId == tracker.streamId,
              event.ackId == tracker.pendingAckId
        else {
            return false
        }
        tracker.pendingAckId = nil
        tracker.missedAckCount = 0
        return true
    }

    private func handleStreamStatusForKeepAlive(_ status: StreamStatus) {
        if let streamId = status.streamId,
           activeStreamKeepAlive?.streamId != streamId
        {
            return
        }

        switch status.state {
        case .stopped, .stopping, .error, .reconnectFailed:
            stopStreamKeepAliveMonitor()
        default:
            break
        }
    }

    private func dispatchStoreUpdate(_ category: String, _ changes: [String: Any]) {
        switch ObservableStore.normalizeCategory(category) {
        case "glasses":
            let nextState = state
            delegate?.mentraBluetoothSDK(self, didUpdate: nextState)
            delegate?.mentraBluetoothSDK(self, didUpdateGlasses: nextState.glasses)
        case ObservableStore.bluetoothCategory:
            let nextState = state
            delegate?.mentraBluetoothSDK(self, didUpdate: nextState)
            delegate?.mentraBluetoothSDK(self, didUpdateSdkState: nextState.sdk)
            delegate?.mentraBluetoothSDK(self, didUpdateScan: nextState.scan)
            if !suppressDefaultDeviceEvents && changes.keys.contains(where: { defaultDeviceKeys.contains($0) }) {
                dispatchDefaultDeviceChanged()
            }
            dispatchDiscoveredDevices(changes["searchResults"])
            dispatchScanResults(changes["searchResults"])
        default:
            break
        }
    }

    private func dispatchDefaultDeviceChanged() {
        delegate?.mentraBluetoothSDK(self, didChangeDefaultDevice: currentDefaultDevice())
    }

    private func finishDefaultDeviceApply(generation: Int) {
        Task { @MainActor [weak self] in
            guard let self, generation == self.defaultDeviceApplyGeneration else { return }
            self.suppressDefaultDeviceEvents = false
            self.dispatchDefaultDeviceChanged()
        }
    }

    private func currentDefaultDevice() -> Device? {
        let core = DeviceStore.shared.store.getCategory(ObservableStore.bluetoothCategory)
        guard let model = core["default_wearable"] as? String, !model.isEmpty else { return nil }
        guard let name = core["device_name"] as? String, !name.isEmpty else { return nil }
        let identifier = (core["device_address"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return Device(
            model: DeviceModel.fromDeviceType(model),
            name: name,
            identifier: identifier
        )
    }

    private func dispatchDiscoveredDevices(_ rawSearchResults: Any?) {
        guard let results = rawSearchResults as? [[String: Any]] else { return }
        for result in results {
            guard let name = result["name"] as? String else { continue }
            guard discoveredDeviceNames.insert(name).inserted else { continue }
            guard let device = Device(values: result) else { continue }
            delegate?.mentraBluetoothSDK(self, didDiscover: device)
        }
    }

    private func dispatchScanResults(_ rawSearchResults: Any?) {
        guard let results = rawSearchResults as? [[String: Any]] else { return }
        let devices = results.compactMap(Device.init(values:))
        for id in Array(activeScanSessions.keys) {
            guard let activeSession = activeScanSessions[id] else { continue }
            emitScanResults(devices.filter { $0.model == activeSession.model }, forSession: id)
        }
    }

    private func emitScanResults(_ devices: [Device], forSession id: UUID) {
        guard let activeSession = activeScanSessions[id] else { return }
        activeSession.latestResults = devices
        activeSession.onResults(devices)
    }

    private func finishScanSession(_ id: UUID, reason: ScanStopReason, shouldStopScan: Bool) {
        guard let activeSession = activeScanSessions.removeValue(forKey: id) else { return }
        activeSession.timeoutTask?.cancel()
        activeSession.publicSession?.markStopped()
        if shouldStopScan {
            stopScan(reason: reason)
        }
        activeSession.onComplete(activeSession.latestResults)
    }

    private func dispatchBridgeEvent(_ eventName: String, _ data: [String: Any]) {
        switch eventName {
        case "log":
            delegate?.mentraBluetoothSDK(self, didLog: data["message"] as? String ?? data.description)
        case "button_press":
            let event = ButtonPressEvent(
                buttonId: data["buttonId"] as? String ?? "",
                pressType: data["pressType"] as? String ?? "",
                timestamp: intValue(data["timestamp"])
            )
            delegate?.mentraBluetoothSDK(self, didReceive: .buttonPress(event))
        case "touch_event":
            delegate?.mentraBluetoothSDK(self, didReceive: .touch(TouchEvent(values: data)))
        case "mic_pcm":
            let event = MicPcmEvent(values: data)
            if !event.pcm.isEmpty {
                delegate?.mentraBluetoothSDK(self, didReceiveMicPcm: event)
            }
        case "mic_lc3":
            let event = MicLc3Event(values: data)
            if !event.lc3.isEmpty {
                delegate?.mentraBluetoothSDK(self, didReceiveMicLc3: event)
            }
        case "local_transcription":
            let event = LocalTranscriptionEvent(
                text: data["text"] as? String ?? "",
                isFinal: data["isFinal"] as? Bool ?? false,
                values: data
            )
            delegate?.mentraBluetoothSDK(self, didReceive: .localTranscription(event))
        case "voice_activity_detection_status":
            delegate?.mentraBluetoothSDK(
                self,
                didReceive: .voiceActivityDetectionStatus(VoiceActivityDetectionStatusEvent(values: data))
            )
        case "speaking_status":
            delegate?.mentraBluetoothSDK(
                self,
                didReceive: .speakingStatus(SpeakingStatusEvent(values: data))
            )
        case "hotspot_status_change":
            delegate?.mentraBluetoothSDK(self, didReceive: .hotspotStatus(HotspotStatusEvent(values: data)))
        case "wifi_status_change":
            delegate?.mentraBluetoothSDK(self, didReceive: .wifiStatus(WifiStatusEvent(values: data)))
        case "hotspot_error":
            delegate?.mentraBluetoothSDK(self, didReceive: .hotspotError(HotspotErrorEvent(values: data)))
        case "photo_response":
            delegate?.mentraBluetoothSDK(self, didReceive: .photoResponse(PhotoResponseEvent(values: data)))
        case "photo_status":
            delegate?.mentraBluetoothSDK(self, didReceive: .photoStatus(PhotoStatusEvent(values: data)))
        case "stream_status":
            let event = StreamStatusEvent(values: data)
            handleStreamStatusForKeepAlive(event.status)
            delegate?.mentraBluetoothSDK(self, didReceive: .streamStatus(event))
        case "keep_alive_ack":
            let event = KeepAliveAckEvent(values: data)
            if !handleStreamKeepAliveAck(event) {
                delegate?.mentraBluetoothSDK(self, didReceive: .keepAliveAck(event))
            }
        case "compatible_glasses_search_stop":
            delegate?.mentraBluetoothSDK(self, didStopScan: .completed)
        case "pair_failure":
            delegate?.mentraBluetoothSDK(
                self,
                didFail: BluetoothError(
                    code: "pair_failure",
                    message: data["error"] as? String ?? data.description
                )
            )
        default:
            delegate?.mentraBluetoothSDK(self, didReceive: .raw(name: eventName, values: data))
        }
    }
}
