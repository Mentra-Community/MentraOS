import CoreBluetooth
import Foundation

@MainActor
private final class ActiveStreamKeepAlive {
    let streamId: String
    let intervalSeconds: Int
    var pendingAckId: String?
    var missedAckCount = 0
    var task: Task<Void, Never>?
    // Missed-ACK counting only begins once the stream is confirmed live/coming up, so a slow
    // startup (glasses can't ACK until they reach starting/streaming) can't trip a false
    // keep-alive timeout before the stream is ever up.
    var armed = false

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
private final class PendingWifiScan {
    let pending: PendingResponse<[WifiScanResult]>

    init(pending: PendingResponse<[WifiScanResult]>) {
        self.pending = pending
    }
}

private enum WifiStatusOperation {
    case connect
    case forget
}

@MainActor
private final class PendingWifiStatusRequest {
    let operation: WifiStatusOperation
    let ssid: String
    let pending: PendingResponse<WifiStatusEvent>

    init(operation: WifiStatusOperation, ssid: String, pending: PendingResponse<WifiStatusEvent>) {
        self.operation = operation
        self.ssid = ssid
        self.pending = pending
    }
}

@MainActor
private final class PendingHotspotStatusRequest {
    let enabled: Bool
    let pending: PendingResponse<HotspotStatusEvent>

    init(enabled: Bool, pending: PendingResponse<HotspotStatusEvent>) {
        self.enabled = enabled
        self.pending = pending
    }
}

@MainActor
private final class PendingVideoRecordingRequest {
    let expectedStatus: String
    let pending: PendingResponse<VideoRecordingStatusEvent>

    init(expectedStatus: String, pending: PendingResponse<VideoRecordingStatusEvent>) {
        self.expectedStatus = expectedStatus
        self.pending = pending
    }
}

@MainActor
private final class PendingResponse<T> {
    private let operation: String
    private var continuation: CheckedContinuation<T, Error>?
    private var timeoutTask: Task<Void, Never>?
    private var result: Result<T, Error>?
    private var completed = false

    init(operation: String) {
        self.operation = operation
    }

    func resolve(_ value: T) {
        guard !completed else { return }
        completed = true
        result = .success(value)
        timeoutTask?.cancel()
        continuation?.resume(returning: value)
        continuation = nil
    }

    func reject(_ error: Error) {
        guard !completed else { return }
        completed = true
        result = .failure(error)
        timeoutTask?.cancel()
        continuation?.resume(throwing: error)
        continuation = nil
    }

    func wait(timeoutMs: Int = 15_000) async throws -> T {
        if let result {
            return try result.get()
        }
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            timeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: UInt64(timeoutMs) * 1_000_000)
                } catch {
                    return
                }
                self?.reject(
                    BluetoothError(
                        code: "request_timeout",
                        message: "\(self?.operation ?? "Request") timed out waiting for glasses response."
                    )
                )
            }
        }
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
    private var pendingPhotoRequests: [String: PendingResponse<PhotoResponseEvent>] = [:]
    private var pendingVideoRecordingRequests: [String: PendingVideoRecordingRequest] = [:]
    private var pendingRgbLedRequests: [String: PendingResponse<RgbLedControlResponseEvent>] = [:]
    private var pendingSettingsRequests: [String: PendingResponse<SettingsAckEvent>] = [:]
    private var pendingStreamStarts: [String: PendingResponse<StreamStatusEvent>] = [:]
    private var pendingStreamStop: (streamId: String?, pending: PendingResponse<StreamStatusEvent>)?
    private var pendingGalleryStatus: PendingResponse<GalleryStatusEvent>?
    private var pendingOtaQuery: PendingResponse<OtaQueryResult>?
    private var pendingOtaStart: PendingResponse<OtaStartAckEvent>?
    private var pendingWifiScan: PendingWifiScan?
    private var pendingWifiStatus: PendingWifiStatusRequest?
    private var pendingHotspotStatus: PendingHotspotStatusRequest?
    private var pendingVersionInfo: PendingResponse<VersionInfoResult>?

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

    public func showNotificationsPanel() {
        DeviceManager.shared.showNotificationsPanel()
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

    func setCalendarEvents(_ events: [CalendarEvent]) async throws {
        DeviceStore.shared.apply(
            ObservableStore.bluetoothCategory,
            "calendar_events",
            events.map(\.dictionary)
        )
    }

    public func setHeadUpAngle(_ angleDegrees: Int) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "head_up_angle", angleDegrees)
    }

    public func setScreenDisabled(_ disabled: Bool) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "screen_disabled", disabled)
    }

    public func setGalleryModeEnabled(_ enabled: Bool) async throws -> SettingsAckEvent {
        try await performSettingsCommand(
            setting: "gallery_mode",
            updateStore: { _ in DeviceStore.shared.set(ObservableStore.bluetoothCategory, "gallery_mode", enabled) },
            send: { requestId in try DeviceManager.shared.sendGalleryMode(requestId: requestId, enabled: enabled) }
        )
    }

    private func performSettingsCommand(
        setting: String,
        updateStore: (SettingsAckEvent) -> Void,
        send: (String) throws -> Void
    ) async throws -> SettingsAckEvent {
        let requestId = "settings-\(setting)-\(UUID().uuidString)"
        let pending = PendingResponse<SettingsAckEvent>(operation: "set \(setting)")
        pendingSettingsRequests[requestId] = pending
        do {
            try send(requestId)
            let ack = try await pending.wait()
            updateStore(ack)
            pendingSettingsRequests.removeValue(forKey: requestId)
            return ack
        } catch {
            pendingSettingsRequests.removeValue(forKey: requestId)
            throw error
        }
    }

    public func setVoiceActivityDetectionEnabled(_ enabled: Bool) async throws {
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "voice_activity_detection_enabled", enabled)
    }

    public func setButtonPhotoSettings(size: ButtonPhotoSize) async throws -> SettingsAckEvent {
        try await performSettingsCommand(
            setting: "button_photo",
            updateStore: { _ in DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_photo_size", size.rawValue) },
            send: { requestId in try DeviceManager.shared.sendButtonPhotoSettings(requestId: requestId, size: size.rawValue) }
        )
    }

    public func setButtonPhotoSettings(_ settings: ButtonPhotoSettings) async throws -> SettingsAckEvent {
        try await setButtonPhotoSettings(size: settings.size)
    }

    public func setButtonVideoRecordingSettings(width: Int, height: Int, fps: Int) async throws -> SettingsAckEvent {
        try await performSettingsCommand(
            setting: "button_video_recording",
            updateStore: { _ in
                DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_video_width", width)
                DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_video_height", height)
                DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_video_fps", fps)
            },
            send: { requestId in
                try DeviceManager.shared.sendButtonVideoRecordingSettings(
                    requestId: requestId,
                    width: width,
                    height: height,
                    fps: fps
                )
            }
        )
    }

    public func setButtonVideoRecordingSettings(_ settings: ButtonVideoRecordingSettings) async throws -> SettingsAckEvent {
        try await setButtonVideoRecordingSettings(width: settings.width, height: settings.height, fps: settings.fps)
    }

    public func setButtonCameraLed(enabled: Bool) async throws -> SettingsAckEvent {
        try await performSettingsCommand(
            setting: "button_camera_led",
            updateStore: { _ in DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_camera_led", enabled) },
            send: { requestId in try DeviceManager.shared.sendButtonCameraLedSetting(requestId: requestId, enabled: enabled) }
        )
    }

    public func setButtonMaxRecordingTime(minutes: Int) async throws -> SettingsAckEvent {
        try await performSettingsCommand(
            setting: "button_max_recording_time",
            updateStore: { _ in
                DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_max_recording_time", minutes)
            },
            send: { requestId in
                try DeviceManager.shared.sendButtonMaxRecordingTime(requestId: requestId, minutes: minutes)
            }
        )
    }

    public func setCameraFov(_ fov: CameraFov) async throws -> CameraFovResult {
        let ack = try await performSettingsCommand(
            setting: "camera_fov",
            updateStore: { _ in },
            send: { requestId in
                try DeviceManager.shared.sendCameraFovSetting(
                    requestId: requestId,
                    fov: fov.fov,
                    roiPosition: fov.roiPosition.rawValue
                )
            }
        )
        let result = try CameraFovResult.from(ack: ack, fallback: fov)
        DeviceStore.shared.set(
            ObservableStore.bluetoothCategory,
            "camera_fov",
            ["fov": result.fov, "roi_position": result.roiPosition.rawValue]
        )
        return result
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
        try GlassesMediaVolumeGetResult(values: await DeviceManager.shared.getGlassesMediaVolume())
    }

    public func setGlassesMediaVolume(_ level: Int) async throws -> GlassesMediaVolumeSetResult {
        guard (0 ... 15).contains(level) else {
            throw BluetoothError(
                code: "invalid_volume_level",
                message: "Glasses media volume must be between 0 and 15."
            )
        }
        return try GlassesMediaVolumeSetResult(values: await DeviceManager.shared.setGlassesMediaVolume(level: level))
    }

    public func requestWifiScan() async throws -> [WifiScanResult] {
        guard pendingWifiScan == nil else {
            throw BluetoothError(
                code: "request_in_flight",
                message: "A WiFi scan is already waiting for a glasses response."
            )
        }
        let pending = PendingResponse<[WifiScanResult]>(operation: "WiFi scan request")
        pendingWifiScan = PendingWifiScan(pending: pending)
        DeviceManager.shared.requestWifiScan()
        do {
            let results = try await pending.wait()
            if pendingWifiScan?.pending === pending {
                pendingWifiScan = nil
            }
            return results
        } catch {
            if pendingWifiScan?.pending === pending {
                pendingWifiScan = nil
            }
            throw error
        }
    }

    public func sendWifiCredentials(ssid: String, password: String) async throws -> WifiStatusEvent {
        guard pendingWifiStatus == nil else {
            throw BluetoothError(
                code: "request_in_flight",
                message: "A WiFi status command is already waiting for a glasses response."
            )
        }
        let pending = PendingResponse<WifiStatusEvent>(operation: "WiFi connect request")
        pendingWifiStatus = PendingWifiStatusRequest(operation: .connect, ssid: ssid, pending: pending)
        DeviceManager.shared.sendWifiCredentials(ssid, password)
        do {
            let event = try await pending.wait()
            if pendingWifiStatus?.pending === pending {
                pendingWifiStatus = nil
            }
            return event
        } catch {
            if pendingWifiStatus?.pending === pending {
                pendingWifiStatus = nil
            }
            throw error
        }
    }

    public func forgetWifiNetwork(ssid: String) async throws -> WifiStatusEvent {
        guard pendingWifiStatus == nil else {
            throw BluetoothError(
                code: "request_in_flight",
                message: "A WiFi status command is already waiting for a glasses response."
            )
        }
        let pending = PendingResponse<WifiStatusEvent>(operation: "WiFi forget request")
        pendingWifiStatus = PendingWifiStatusRequest(operation: .forget, ssid: ssid, pending: pending)
        DeviceManager.shared.forgetWifiNetwork(ssid)
        do {
            let event = try await pending.wait()
            if pendingWifiStatus?.pending === pending {
                pendingWifiStatus = nil
            }
            return event
        } catch {
            if pendingWifiStatus?.pending === pending {
                pendingWifiStatus = nil
            }
            throw error
        }
    }

    public func setHotspotState(enabled: Bool) async throws -> HotspotStatusEvent {
        guard pendingHotspotStatus == nil else {
            throw BluetoothError(
                code: "request_in_flight",
                message: "A hotspot command is already waiting for a glasses response."
            )
        }
        let pending = PendingResponse<HotspotStatusEvent>(
            operation: "hotspot \(enabled ? "enable" : "disable") request"
        )
        pendingHotspotStatus = PendingHotspotStatusRequest(enabled: enabled, pending: pending)
        DeviceManager.shared.setHotspotState(enabled)
        do {
            let event = try await pending.wait()
            if pendingHotspotStatus?.pending === pending {
                pendingHotspotStatus = nil
            }
            return event
        } catch {
            if pendingHotspotStatus?.pending === pending {
                pendingHotspotStatus = nil
            }
            throw error
        }
    }

    func setSystemTime(timestampMs: Int64) {
        DeviceManager.shared.setSystemTime(timestampMs)
    }

    public func requestPhoto(_ request: PhotoRequest) async throws -> PhotoResponseEvent {
        Bridge.log(
            "NATIVE: PHOTO PIPELINE [3b/6] MentraBluetoothSdk.requestPhoto requestId=\(request.requestId) appId=\(request.appId)"
        )
        let pending = PendingResponse<PhotoResponseEvent>(operation: "photo request \(request.requestId)")
        pendingPhotoRequests[request.requestId] = pending
        DeviceManager.shared.requestPhoto(
            request.requestId,
            request.appId,
            request.size.rawValue,
            request.webhookUrl,
            request.authToken,
            request.compress?.rawValue,
            request.flash,
            request.save,
            request.sound,
            exposureTimeNs: request.exposureTimeNs,
            iso: request.iso
        )
        do {
            let event = try await pending.wait()
            pendingPhotoRequests.removeValue(forKey: request.requestId)
            return event
        } catch {
            pendingPhotoRequests.removeValue(forKey: request.requestId)
            throw error
        }
    }

    public func queryGalleryStatus() async throws -> GalleryStatusEvent {
        if pendingGalleryStatus != nil {
            throw BluetoothError(
                code: "request_in_flight",
                message: "A gallery status query is already waiting for a glasses response."
            )
        }
        let pending = PendingResponse<GalleryStatusEvent>(operation: "gallery status query")
        pendingGalleryStatus = pending
        DeviceManager.shared.queryGalleryStatus()
        do {
            let event = try await pending.wait()
            if pendingGalleryStatus === pending {
                pendingGalleryStatus = nil
            }
            return event
        } catch {
            if pendingGalleryStatus === pending {
                pendingGalleryStatus = nil
            }
            throw error
        }
    }

    public func startStream(_ request: StreamRequest) async throws -> StreamStatusEvent {
        var values = request.values
        let streamId = stringValue(values, "streamId").flatMap { $0.isEmpty ? nil : $0 } ?? "sdk-\(UUID().uuidString)"
        values["streamId"] = streamId
        let pending = PendingResponse<StreamStatusEvent>(operation: "start stream \(streamId)")
        pendingStreamStarts[streamId] = pending
        stopStreamKeepAliveMonitor()
        DeviceManager.shared.startStream(values)
        do {
            let event = try await pending.wait(timeoutMs: 30_000)
            pendingStreamStarts.removeValue(forKey: streamId)
            if request.keepAlive, !request.isExternallyManagedKeepAlive {
                startStreamKeepAliveMonitor(streamId: streamId, intervalSeconds: request.keepAliveIntervalSeconds)
            }
            return event
        } catch {
            pendingStreamStarts.removeValue(forKey: streamId)
            throw error
        }
    }

    func sendExternallyManagedStreamKeepAlive(_ request: StreamKeepAliveRequest) {
        DeviceManager.shared.keepStreamAlive(request.values)
    }

    public func rgbLedControl(_ request: RgbLedRequest) async throws -> RgbLedControlResponseEvent {
        let pending = PendingResponse<RgbLedControlResponseEvent>(operation: "RGB LED command \(request.requestId)")
        pendingRgbLedRequests[request.requestId] = pending
        DeviceManager.shared.rgbLedControl(
            requestId: request.requestId,
            packageName: request.packageName,
            action: request.action.rawValue,
            color: request.color?.rawValue,
            onDurationMs: request.onDurationMs,
            offDurationMs: request.offDurationMs,
            count: request.count
        )
        do {
            let event = try await pending.wait()
            pendingRgbLedRequests.removeValue(forKey: request.requestId)
            return event
        } catch {
            pendingRgbLedRequests.removeValue(forKey: request.requestId)
            throw error
        }
    }

    public func stopStream() async throws -> StreamStatusEvent {
        guard pendingStreamStop == nil else {
            throw BluetoothError(
                code: "request_in_flight",
                message: "A stream stop command is already waiting for a glasses response."
            )
        }
        let pending = PendingResponse<StreamStatusEvent>(operation: "stop stream")
        pendingStreamStop = (streamId: activeStreamKeepAlive?.streamId, pending: pending)
        stopStreamKeepAliveMonitor()
        DeviceManager.shared.stopStream()
        do {
            let event = try await pending.wait(timeoutMs: 15_000)
            if pendingStreamStop?.pending === pending {
                pendingStreamStop = nil
            }
            return event
        } catch {
            if pendingStreamStop?.pending === pending {
                pendingStreamStop = nil
            }
            throw error
        }
    }

    public func startVideoRecording(_ request: VideoRecordingRequest) async throws -> VideoRecordingStatusEvent {
        guard !request.requestId.isEmpty else {
            throw BluetoothError(code: "missing_request_id", message: "requestId is required to start video recording.")
        }
        let pending = PendingResponse<VideoRecordingStatusEvent>(
            operation: "start video recording \(request.requestId)"
        )
        guard pendingVideoRecordingRequests[request.requestId] == nil else {
            throw BluetoothError(
                code: "request_in_flight",
                message: "A video recording command is already waiting for requestId \(request.requestId)."
            )
        }
        pendingVideoRecordingRequests[request.requestId] = PendingVideoRecordingRequest(
            expectedStatus: "recording_started",
            pending: pending
        )
        DeviceManager.shared.startVideoRecording(
            request.requestId,
            request.save,
            request.sound,
            request.width,
            request.height,
            request.fps
        )
        do {
            let event = try await pending.wait()
            pendingVideoRecordingRequests.removeValue(forKey: request.requestId)
            return event
        } catch {
            pendingVideoRecordingRequests.removeValue(forKey: request.requestId)
            throw error
        }
    }

    public func stopVideoRecording(requestId: String) async throws -> VideoRecordingStatusEvent {
        guard !requestId.isEmpty else {
            throw BluetoothError(code: "missing_request_id", message: "requestId is required to stop video recording.")
        }
        let pending = PendingResponse<VideoRecordingStatusEvent>(operation: "stop video recording \(requestId)")
        guard pendingVideoRecordingRequests[requestId] == nil else {
            throw BluetoothError(
                code: "request_in_flight",
                message: "A video recording command is already waiting for requestId \(requestId)."
            )
        }
        pendingVideoRecordingRequests[requestId] = PendingVideoRecordingRequest(
            expectedStatus: "recording_stopped",
            pending: pending
        )
        DeviceManager.shared.stopVideoRecording(requestId)
        do {
            let event = try await pending.wait()
            pendingVideoRecordingRequests.removeValue(forKey: requestId)
            return event
        } catch {
            pendingVideoRecordingRequests.removeValue(forKey: requestId)
            throw error
        }
    }

    public func requestVersionInfo() async throws -> VersionInfoResult {
        guard pendingVersionInfo == nil else {
            throw BluetoothError(
                code: "request_in_flight",
                message: "A version info request is already waiting for a glasses response."
            )
        }
        let pending = PendingResponse<VersionInfoResult>(operation: "version info request")
        pendingVersionInfo = pending
        DeviceManager.shared.requestVersionInfo()
        do {
            let status = try await pending.wait()
            if pendingVersionInfo === pending {
                pendingVersionInfo = nil
            }
            return status
        } catch {
            if pendingVersionInfo === pending {
                pendingVersionInfo = nil
            }
            throw error
        }
    }

    /// Ask connected Mentra Live glasses to check/report OTA availability and status.
    public func checkForOtaUpdate() async throws -> OtaQueryResult {
        try await performOtaQuery(operation: "OTA status query") {
            DeviceManager.shared.sendOtaQueryStatus()
        }
    }

    private func performOtaQuery(
        operation: String,
        sendRequest: () -> Void
    ) async throws -> OtaQueryResult {
        if pendingOtaQuery != nil {
            throw BluetoothError(
                code: "request_in_flight",
                message: "An OTA status query is already waiting for a glasses response."
            )
        }
        let pending = PendingResponse<OtaQueryResult>(operation: operation)
        pendingOtaQuery = pending
        sendRequest()
        do {
            let result = try await pending.wait()
            if pendingOtaQuery === pending {
                pendingOtaQuery = nil
            }
            return result
        } catch {
            if pendingOtaQuery === pending {
                pendingOtaQuery = nil
            }
            throw error
        }
    }

    /// Start the OTA flow after your app has presented the available update to the user.
    public func startOtaUpdate() async throws -> OtaStartAckEvent {
        if pendingOtaStart != nil {
            throw BluetoothError(
                code: "request_in_flight",
                message: "An OTA start command is already waiting for a glasses response."
            )
        }
        let pending = PendingResponse<OtaStartAckEvent>(operation: "OTA start command")
        pendingOtaStart = pending
        DeviceManager.shared.sendOtaStart()
        do {
            let event = try await pending.wait()
            if pendingOtaStart === pending {
                pendingOtaStart = nil
            }
            return event
        } catch {
            if pendingOtaStart === pending {
                pendingOtaStart = nil
            }
            throw error
        }
    }

    /// Re-run the glasses-side OTA version check, mainly after correcting clock skew/TLS failures.
    public func retryOtaVersionCheck() async throws -> OtaQueryResult {
        try await performOtaQuery(operation: "OTA version retry") {
            DeviceManager.shared.retryOtaVersionCheck()
        }
    }

    func sendOtaStart() async throws -> OtaStartAckEvent { try await startOtaUpdate() }

    func sendOtaQueryStatus() async throws -> OtaQueryResult { try await checkForOtaUpdate() }

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

        if tracker.armed, tracker.pendingAckId != nil {
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
                stopStreamKeepAliveMonitor()
                DeviceManager.shared.stopStream()
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
        guard let streamId = status.streamId,
              activeStreamKeepAlive?.streamId == streamId
        else {
            return
        }

        switch status.state {
        case .stopped, .stopping, .error, .reconnectFailed:
            stopStreamKeepAliveMonitor()
        default:
            // A non-terminal status means the stream is live or coming up and the glasses can
            // now ACK; arm the missed-ACK detector from here so a slow startup before the first
            // ACK can't trip a false keep-alive timeout. On the arming transition, drop any
            // pre-arm bookkeeping so a stale unacked id can't immediately count as a miss.
            if let tracker = activeStreamKeepAlive, !tracker.armed {
                tracker.armed = true
                tracker.pendingAckId = nil
                tracker.missedAckCount = 0
            }
        }
    }

    private func handleStreamStatusForRequests(_ event: StreamStatusEvent) {
        if let (streamId, pending) = matchingStreamStart(for: event) {
            switch event.state {
            case .streaming:
                pendingStreamStarts.removeValue(forKey: streamId)
                pending.resolve(event)
            case .error, .reconnectFailed, .stopped:
                pendingStreamStarts.removeValue(forKey: streamId)
                pending.reject(streamStatusError(event, code: "stream_start_failed"))
            default:
                break
            }
        }

        if let stop = pendingStreamStop, streamStatus(event, matches: stop.streamId) {
            if isAlreadyStoppedStreamStatus(event) {
                if pendingStreamStop?.pending === stop.pending {
                    pendingStreamStop = nil
                }
                stop.pending.resolve(stoppedStreamEvent(from: event, fallbackStreamId: stop.streamId))
            } else if event.state == .error || event.state == .reconnectFailed {
                if pendingStreamStop?.pending === stop.pending {
                    pendingStreamStop = nil
                }
                stop.pending.reject(streamStatusError(event, code: "stream_stop_failed"))
            }
        }
    }

    private func matchingStreamStart(for event: StreamStatusEvent) -> (String, PendingResponse<StreamStatusEvent>)? {
        if let streamId = event.streamId, !streamId.isEmpty {
            guard let pending = pendingStreamStarts[streamId] else { return nil }
            return (streamId, pending)
        }
        if pendingStreamStarts.count == 1, let entry = pendingStreamStarts.first {
            return (entry.key, entry.value)
        }
        return nil
    }

    private func streamStatus(_ event: StreamStatusEvent, matches streamId: String?) -> Bool {
        guard let streamId, !streamId.isEmpty else { return true }
        guard let eventStreamId = event.streamId, !eventStreamId.isEmpty else { return true }
        return eventStreamId == streamId
    }

    private func isAlreadyStoppedStreamStatus(_ event: StreamStatusEvent) -> Bool {
        if event.state == .stopped {
            return true
        }
        guard case let .error(_, errorDetails, _, _) = event.status else {
            return false
        }
        return ["not_streaming", "already_stopped", "not streaming"].contains(errorDetails.lowercased())
    }

    private func stoppedStreamEvent(from event: StreamStatusEvent, fallbackStreamId: String?) -> StreamStatusEvent {
        StreamStatusEvent(
            status: .lifecycle(
                state: .stopped,
                streamId: event.streamId ?? fallbackStreamId,
                timestamp: event.status.timestamp ?? Int(Date().timeIntervalSince1970 * 1000),
                resolvedConfig: event.resolvedConfig
            )
        )
    }

    private func streamStatusError(_ event: StreamStatusEvent, code: String) -> BluetoothError {
        let message: String
        if case let .error(_, errorDetails, _, _) = event.status {
            message = errorDetails
        } else {
            message = "Stream status \(event.state.rawValue)"
        }
        return BluetoothError(code: code, message: message)
    }

    private func handlePhotoResponseForRequests(_ event: PhotoResponseEvent) {
        guard let pending = pendingPhotoRequests[event.requestId] else { return }
        switch event.response {
        case .success:
            pending.resolve(event)
        case let .error(_, errorCode, errorMessage, _):
            pending.reject(
                BluetoothError(
                    code: errorCode ?? "photo_request_failed",
                    message: errorMessage
                )
            )
        }
    }

    private func handleVideoRecordingStatusForRequests(_ event: VideoRecordingStatusEvent) {
        guard let request = pendingVideoRecordingRequests[event.requestId] else { return }
        if event.success {
            if event.status == request.expectedStatus {
                request.pending.resolve(event)
            }
        } else {
            request.pending.reject(
                BluetoothError(
                    code: event.status.isEmpty ? "video_recording_failed" : event.status,
                    message: event.details ?? "Video recording command failed."
                )
            )
        }
    }

    private func handleRgbLedResponseForRequests(_ event: RgbLedControlResponseEvent) {
        guard let pending = pendingRgbLedRequests[event.requestId] else { return }
        if event.state == "success" {
            pending.resolve(event)
        } else {
            pending.reject(
                BluetoothError(
                    code: event.errorCode ?? "rgb_led_control_failed",
                    message: event.errorCode ?? "RGB LED command failed."
                )
            )
        }
    }

    private func handleSettingsAckForRequests(_ event: SettingsAckEvent) {
        guard let pending = pendingSettingsRequests[event.requestId] else { return }
        if isFailureStatus(event.status) {
            let fallbackSetting = event.setting.isEmpty ? event.requestId : event.setting
            pending.reject(
                BluetoothError(
                    code: event.errorCode ?? "\(event.setting.isEmpty ? "settings" : event.setting)_failed",
                    message: event.errorMessage ?? "Settings command \(fallbackSetting) failed."
                )
            )
        } else {
            pending.resolve(event)
        }
    }

    private func isFailureStatus(_ status: String) -> Bool {
        ["error", "failed", "failure", "rejected"].contains(status.lowercased())
    }

    private func handleWifiScanResultsForRequests(_ results: [WifiScanResult]) {
        guard let request = pendingWifiScan else { return }
        if pendingWifiScan === request {
            pendingWifiScan = nil
        }
        request.pending.resolve(results)
    }

    private func handleWifiStatusForRequests(_ event: WifiStatusEvent) {
        guard let request = pendingWifiStatus else { return }
        guard wifiStatusMatches(event.status, request: request) else { return }
        if pendingWifiStatus === request {
            pendingWifiStatus = nil
        }
        request.pending.resolve(event)
    }

    private func wifiStatusMatches(_ status: WifiStatus, request: PendingWifiStatusRequest) -> Bool {
        switch request.operation {
        case .connect:
            if case let .connected(ssid, _) = status {
                return ssid == request.ssid
            }
            return false
        case .forget:
            switch status {
            case .disconnected:
                return true
            case let .connected(ssid, _):
                return ssid != request.ssid
            }
        }
    }

    private func handleHotspotStatusForRequests(_ event: HotspotStatusEvent) {
        guard let request = pendingHotspotStatus else { return }
        guard hotspotStatusMatches(event.status, enabled: request.enabled) else { return }
        if pendingHotspotStatus === request {
            pendingHotspotStatus = nil
        }
        request.pending.resolve(event)
    }

    private func hotspotStatusMatches(_ status: HotspotStatus, enabled: Bool) -> Bool {
        if enabled {
            return status.isEnabled
        }
        return status == .disabled
    }

    private func handleHotspotErrorForRequests(_ event: HotspotErrorEvent) {
        guard let request = pendingHotspotStatus else { return }
        if pendingHotspotStatus === request {
            pendingHotspotStatus = nil
        }
        request.pending.reject(
            BluetoothError(
                code: "hotspot_command_failed",
                message: event.message ?? "Hotspot command failed."
            )
        )
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
            let event = HotspotStatusEvent(values: data)
            handleHotspotStatusForRequests(event)
            delegate?.mentraBluetoothSDK(self, didReceive: .hotspotStatus(event))
        case "wifi_status_change":
            let event = WifiStatusEvent(values: data)
            handleWifiStatusForRequests(event)
            delegate?.mentraBluetoothSDK(self, didReceive: .wifiStatus(event))
        case "wifi_scan_result":
            let networks = (data["networks"] as? [[String: Any]])?.map(WifiScanResult.init(values:)) ?? []
            let hasCompletionFlag = data.keys.contains("scanComplete") || data.keys.contains("scan_complete")
            let scanComplete = data["scanComplete"] as? Bool ?? data["scan_complete"] as? Bool ?? false
            if scanComplete || !hasCompletionFlag {
                handleWifiScanResultsForRequests(networks)
            }
            delegate?.mentraBluetoothSDK(self, didReceive: .raw(name: "wifi_scan_result", values: data))
        case "hotspot_error":
            let event = HotspotErrorEvent(values: data)
            handleHotspotErrorForRequests(event)
            delegate?.mentraBluetoothSDK(self, didReceive: .hotspotError(event))
        case "gallery_status":
            let event = GalleryStatusEvent(values: data)
            pendingGalleryStatus?.resolve(event)
            delegate?.mentraBluetoothSDK(self, didReceive: .raw(name: "gallery_status", values: event.values))
        case "photo_response":
            let event = PhotoResponseEvent(values: data)
            handlePhotoResponseForRequests(event)
            delegate?.mentraBluetoothSDK(self, didReceive: .photoResponse(event))
        case "photo_status":
            delegate?.mentraBluetoothSDK(self, didReceive: .photoStatus(PhotoStatusEvent(values: data)))
        case "video_recording_status":
            let event = VideoRecordingStatusEvent(values: data)
            handleVideoRecordingStatusForRequests(event)
            delegate?.mentraBluetoothSDK(self, didReceive: .videoRecordingStatus(event))
        case "rgb_led_control_response":
            let event = RgbLedControlResponseEvent(values: data)
            handleRgbLedResponseForRequests(event)
            delegate?.mentraBluetoothSDK(self, didReceive: .rgbLedControlResponse(event))
        case "stream_status":
            let event = StreamStatusEvent(values: data)
            handleStreamStatusForRequests(event)
            handleStreamStatusForKeepAlive(event.status)
            delegate?.mentraBluetoothSDK(self, didReceive: .streamStatus(event))
        case "keep_alive_ack":
            let event = KeepAliveAckEvent(values: data)
            if !handleStreamKeepAliveAck(event) {
                delegate?.mentraBluetoothSDK(self, didReceive: .keepAliveAck(event))
            }
        case "ota_update_available":
            var resultValues = data
            resultValues["type"] = "ota_update_available"
            pendingOtaQuery?.resolve(OtaQueryResult(values: resultValues))
            delegate?.mentraBluetoothSDK(self, didReceive: .otaUpdateAvailable(OtaUpdateAvailableEvent(values: resultValues)))
        case "ota_start_ack":
            var values = data
            values["type"] = "ota_start_ack"
            let event = OtaStartAckEvent(values: values)
            pendingOtaStart?.resolve(event)
            delegate?.mentraBluetoothSDK(self, didReceive: .otaStartAck(event))
        case "ota_status":
            var resultValues = data
            resultValues["type"] = "ota_status"
            pendingOtaQuery?.resolve(OtaQueryResult(values: resultValues))
            delegate?.mentraBluetoothSDK(self, didReceive: .otaStatus(OtaStatusEvent(values: resultValues)))
        case "settings_ack":
            let event = SettingsAckEvent(values: data)
            handleSettingsAckForRequests(event)
            delegate?.mentraBluetoothSDK(self, didReceive: .settingsAck(event))
        case "version_info":
            let event = VersionInfoResult(values: data)
            pendingVersionInfo?.resolve(event)
            delegate?.mentraBluetoothSDK(self, didReceive: .versionInfo(event))
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
