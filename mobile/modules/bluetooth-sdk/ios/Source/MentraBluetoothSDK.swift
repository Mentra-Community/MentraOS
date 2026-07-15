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
    var latestResults: [WifiScanResult] = []

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
    let waitForUpload: Bool
    var stoppedEvent: VideoRecordingStatusEvent?
    var uploadSucceeded = false

    init(expectedStatus: String, pending: PendingResponse<VideoRecordingStatusEvent>, waitForUpload: Bool = false) {
        self.expectedStatus = expectedStatus
        self.pending = pending
        self.waitForUpload = waitForUpload
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
                    BluetoothSdkError(
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
    private static let wifiScanTimeoutMs = 20_000
    private static let otaBesVersionWaitMs = 5_000
    private static let otaMtkVersionWaitMs = 2_000
    private static let otaVersionPollMs = 100
    private static let defaultStreamKeepAliveIntervalSeconds = 5

    public weak var delegate: MentraBluetoothSDKDelegate?

    private let configuration: MentraBluetoothSDKConfiguration
    private var discoveredDeviceNames = Set<String>()
    private var bluetoothAvailabilityListenerId: UUID?
    private var shouldRestoreGlassesOnBluetoothRestore = false
    private var shouldRestoreControllerOnBluetoothRestore = false
    private var bridgeEventSinkId: String?
    private var storeListenerId: String?
    private let defaultDeviceKeys: Set<String> = ["default_wearable", "device_name", "device_address"]
    private let videoUploadStopTimeoutMs = 10 * 60 * 1000
    private var suppressDefaultDeviceEvents = false
    private var defaultDeviceApplyGeneration = 0
    private var activeScanSessions: [UUID: ActiveScanSession] = [:]
    private var activeStreamKeepAlive: ActiveStreamKeepAlive?
    private let analytics: BluetoothSdkAnalytics
    private var pendingPhotoRequests: [String: PendingResponse<PhotoResponseEvent>] = [:]
    private var pendingCameraStatusRequests: [String: PendingResponse<CameraStatusEvent>] = [:]
    private var pendingVideoRecordingRequests: [String: PendingVideoRecordingRequest] = [:]
    private var pendingRgbLedRequests: [String: PendingResponse<RgbLedControlResponseEvent>] = [:]
    private var pendingSettingsRequests: [String: PendingResponse<SettingsAckEvent>] = [:]
    private var pendingStreamStarts: [String: PendingResponse<StreamStatusEvent>] = [:]
    private var pendingStreamStop: (streamId: String?, pending: PendingResponse<StreamStatusEvent>)?
    private var pendingGalleryStatus: PendingResponse<GalleryStatusEvent>?
    private var pendingOtaQuery: PendingResponse<OtaQueryResult>?
    private var pendingOtaStart: PendingResponse<OtaStartAckEvent>?
    private var pendingWifiScan: PendingWifiScan?
    private var wifiScanTask: Task<[WifiScanResult], Error>?
    private var pendingWifiStatus: PendingWifiStatusRequest?
    private var pendingHotspotStatus: PendingHotspotStatusRequest?
    private var pendingVersionInfo: PendingResponse<VersionInfoResult>?
    private var configuredOtaVersionUrl: String?

    public init(configuration: MentraBluetoothSDKConfiguration = .default) {
        self.configuration = configuration
        analytics = BluetoothSdkAnalytics(configuration: configuration.analytics)
        bluetoothAvailabilityListenerId = BluetoothAvailability.shared.addStateListener { [weak self] state in
            Task { @MainActor [weak self] in
                self?.handleBluetoothAvailability(state)
            }
        }
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
        analytics.initializeGlassesStatus(glassesStatus)
        analytics.captureStarted()
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

    private func requireGlassesConnected(operation: String) throws {
        guard glassesStatus.connected else {
            throw BluetoothSdkError(
                code: "glasses_not_connected",
                message: "Cannot \(operation) because glasses are not connected."
            )
        }
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
        clearBluetoothRestoreIntent()
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
        clearBluetoothRestoreIntent()
        guard let device = currentDefaultDevice() else {
            throw BluetoothSdkError(
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
        clearBluetoothRestoreIntent()
        DeviceManager.shared.disconnect()
    }

    func connectSimulated() {
        clearBluetoothRestoreIntent()
        DeviceManager.shared.connectSimulated()
    }

    public func disconnect() {
        clearBluetoothRestoreIntent()
        DeviceManager.shared.disconnect()
    }

    public func forget() {
        clearBluetoothRestoreIntent()
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

    @available(*, deprecated, message: "Sticky action-button photo presets are deprecated. Prefer per-request requestPhoto(...) options (e.g. mode .text for AE ÷3, or explicit per-shot fields). This method still works but will be removed in a future release.")
    public func setPhotoCaptureDefaults(_ settings: PhotoCaptureDefaults) async throws -> SettingsAckEvent {
        try await performSettingsCommand(
            setting: "button_photo",
            updateStore: { _ in
                if settings.resetCaptureTuning == true {
                    // Mirror Android: clear all cached scan-tuning keys so reconnect sync
                    // does not replay stale values after a reset.
                    let cat = ObservableStore.bluetoothCategory
                    for key in ["button_photo_mfnr", "button_photo_zsl", "button_photo_noise_reduction",
                                "button_photo_edge_enhancement", "button_photo_isp_digital_gain",
                                "button_photo_isp_analog_gain", "button_photo_ae_exposure_divisor",
                                "button_photo_iso_cap", "button_photo_compress", "button_photo_sound"] {
                        DeviceStore.shared.remove(cat, key)
                    }
                }
                if let size = settings.size {
                    DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_photo_size", size.rawValue)
                }
                if let mfnr = settings.mfnr {
                    DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_photo_mfnr", mfnr)
                }
                if let zsl = settings.zsl {
                    DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_photo_zsl", zsl)
                }
                if let noiseReduction = settings.noiseReduction {
                    DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_photo_noise_reduction", noiseReduction)
                }
                if let edgeEnhancement = settings.edgeEnhancement {
                    DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_photo_edge_enhancement", edgeEnhancement)
                }
                if let ispDigitalGain = settings.ispDigitalGain {
                    DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_photo_isp_digital_gain", ispDigitalGain)
                }
                if let ispAnalogGain = settings.ispAnalogGain {
                    DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_photo_isp_analog_gain", ispAnalogGain)
                }
                if let aeExposureDivisor = settings.aeExposureDivisor {
                    DeviceStore.shared.set(
                        ObservableStore.bluetoothCategory,
                        "button_photo_ae_exposure_divisor",
                        aeExposureDivisor
                    )
                }
                if let isoCap = settings.isoCap {
                    DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_photo_iso_cap", isoCap)
                }
                if let compress = settings.compress {
                    DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_photo_compress", compress)
                }
                if let sound = settings.sound {
                    DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_photo_sound", sound)
                }
            },
            send: { requestId in
                try DeviceManager.shared.sendButtonPhotoSettings(requestId: requestId, settings: settings)
            }
        )
    }

    public func setVideoRecordingDefaults(_ defaults: VideoRecordingDefaults) async throws -> SettingsAckEvent {
        try await performSettingsCommand(
            setting: "button_video_recording",
            updateStore: { _ in
                DeviceStore.shared.set(
                    ObservableStore.bluetoothCategory,
                    "button_video_settings",
                    ["width": defaults.width, "height": defaults.height, "fps": defaults.fps]
                )
                // Keep legacy cache keys readable for older internal callers during migration.
                DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_video_width", defaults.width)
                DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_video_height", defaults.height)
                DeviceStore.shared.set(ObservableStore.bluetoothCategory, "button_video_fps", defaults.fps)
            },
            send: { requestId in
                try DeviceManager.shared.sendButtonVideoRecordingSettings(
                    requestId: requestId,
                    width: defaults.width,
                    height: defaults.height,
                    fps: defaults.fps
                )
            }
        )
    }

    public func setMaxVideoRecordingDuration(minutes: Int) async throws -> SettingsAckEvent {
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

    public func setCameraTuningConfig(anrOn: Bool, gainOn: Bool) async throws -> SettingsAckEvent {
        return try await performSettingsCommand(
            setting: "camera_tuning",
            updateStore: { _ in },
            send: { requestId in
                try DeviceManager.shared.sendCameraTuningConfig(
                    requestId: requestId,
                    anrOn: anrOn,
                    gainOn: gainOn
                )
            }
        )
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
            throw BluetoothSdkError(
                code: "invalid_volume_level",
                message: "Glasses media volume must be between 0 and 15."
            )
        }
        return try GlassesMediaVolumeSetResult(values: await DeviceManager.shared.setGlassesMediaVolume(level: level))
    }

    public func requestWifiScan() async throws -> [WifiScanResult] {
        if let existing = wifiScanTask {
            // Join the in-flight scan instead of failing with request_in_flight;
            // the scan screen auto-starts a scan on mount and can be pushed twice.
            return try await existing.value
        }
        let pending = PendingResponse<[WifiScanResult]>(operation: "WiFi scan request")
        let request = PendingWifiScan(pending: pending)
        pendingWifiScan = request
        DeviceManager.shared.requestWifiScan()
        let task = Task { @MainActor [weak self] () async throws -> [WifiScanResult] in
            defer {
                if let self {
                    if self.pendingWifiScan === request {
                        self.pendingWifiScan = nil
                    }
                    self.wifiScanTask = nil
                }
            }
            do {
                // The glasses wait up to 15s for scan-results broadcasts before sending
                // scan_complete, so give them longer than that before falling back.
                return try await pending.wait(timeoutMs: MentraBluetoothSDK.wifiScanTimeoutMs)
            } catch {
                if (error as? BluetoothSdkError)?.code == "request_timeout",
                   !request.latestResults.isEmpty {
                    return request.latestResults
                }
                throw error
            }
        }
        wifiScanTask = task
        return try await task.value
    }

    public func sendWifiCredentials(ssid: String, password: String) async throws -> WifiStatusEvent {
        guard pendingWifiStatus == nil else {
            throw BluetoothSdkError(
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
            throw BluetoothSdkError(
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
            throw BluetoothSdkError(
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
        let routedRequest = nonBlankRequestId(request.requestId).map { request.withRequestId($0) }
            ?? request.withRequestId(generatedCameraRequestId("photo"))
        Bridge.log(
            "NATIVE: PHOTO PIPELINE [3b/6] MentraBluetoothSdk.requestPhoto requestId=\(routedRequest.requestId)"
        )
        let pending = PendingResponse<PhotoResponseEvent>(operation: "photo request \(routedRequest.requestId)")
        pendingPhotoRequests[routedRequest.requestId] = pending
        DeviceManager.shared.requestPhoto(routedRequest)
        do {
            let event = try await pending.wait()
            pendingPhotoRequests.removeValue(forKey: routedRequest.requestId)
            return event
        } catch {
            pendingPhotoRequests.removeValue(forKey: routedRequest.requestId)
            throw error
        }
    }

    public func warmUpCamera(
        requestId: String? = nil,
        size: PhotoSize,
        exposureTimeNs: Double?,
        durationMs: Int
    ) async throws -> CameraStatusEvent {
        let effectiveRequestId = nonBlankRequestId(requestId) ?? generatedCameraRequestId("warm")
        let pending = PendingResponse<CameraStatusEvent>(operation: "camera warm up \(effectiveRequestId)")
        pendingCameraStatusRequests[effectiveRequestId] = pending
        do {
            // Inside the catch so an unsupported-device throw also clears the pending entry.
            try DeviceManager.shared.warmUpCamera(
                requestId: effectiveRequestId,
                size: size,
                exposureTimeNs: exposureTimeNs,
                durationMs: durationMs
            )
            let event = try await pending.wait()
            pendingCameraStatusRequests.removeValue(forKey: effectiveRequestId)
            return event
        } catch {
            pendingCameraStatusRequests.removeValue(forKey: effectiveRequestId)
            throw error
        }
    }

    public func queryGalleryStatus() async throws -> GalleryStatusEvent {
        if pendingGalleryStatus != nil {
            throw BluetoothSdkError(
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
        try await startStream(request, startSdkKeepAlive: true)
    }

    func startExternallyManagedStream(_ request: StreamRequest) async throws -> StreamStatusEvent {
        try await startStream(request, startSdkKeepAlive: false)
    }

    private func startStream(_ request: StreamRequest, startSdkKeepAlive: Bool) async throws -> StreamStatusEvent {
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
            if startSdkKeepAlive {
                startStreamKeepAliveMonitor(
                    streamId: streamId,
                    intervalSeconds: Self.defaultStreamKeepAliveIntervalSeconds
                )
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
            throw BluetoothSdkError(
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
            throw BluetoothSdkError(code: "missing_request_id", message: "requestId is required to start video recording.")
        }
        try requireGlassesConnected(operation: "start video recording")
        let pending = PendingResponse<VideoRecordingStatusEvent>(
            operation: "start video recording \(request.requestId)"
        )
        guard pendingVideoRecordingRequests[request.requestId] == nil else {
            throw BluetoothSdkError(
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
            request.fps,
            request.maxRecordingTimeMinutes
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

    public func stopVideoRecording(
        requestId: String, webhookUrl: String? = nil, authToken: String? = nil
    ) async throws -> VideoRecordingStatusEvent {
        guard !requestId.isEmpty else {
            throw BluetoothSdkError(code: "missing_request_id", message: "requestId is required to stop video recording.")
        }
        try requireGlassesConnected(operation: "stop video recording")
        let pending = PendingResponse<VideoRecordingStatusEvent>(operation: "stop video recording \(requestId)")
        guard pendingVideoRecordingRequests[requestId] == nil else {
            throw BluetoothSdkError(
                code: "request_in_flight",
                message: "A video recording command is already waiting for requestId \(requestId)."
            )
        }
        let waitForUpload = !(webhookUrl?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        pendingVideoRecordingRequests[requestId] = PendingVideoRecordingRequest(
            expectedStatus: "recording_stopped",
            pending: pending,
            waitForUpload: waitForUpload
        )
        DeviceManager.shared.stopVideoRecording(requestId, webhookUrl, authToken)
        do {
            let timeoutMs = waitForUpload ? videoUploadStopTimeoutMs : 15_000
            let event = try await pending.wait(timeoutMs: timeoutMs)
            pendingVideoRecordingRequests.removeValue(forKey: requestId)
            return event
        } catch {
            pendingVideoRecordingRequests.removeValue(forKey: requestId)
            throw error
        }
    }

    public func requestVersionInfo() async throws -> VersionInfoResult {
        guard pendingVersionInfo == nil else {
            throw BluetoothSdkError(
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

    func setOtaVersionUrl(_ otaVersionUrl: String) throws {
        configuredOtaVersionUrl = try OtaManifestChecker.normalizeHttpUrl(otaVersionUrl)
    }

    func getOtaVersionUrl() throws -> String {
        try configuredOtaVersionUrl ?? OtaManifestDefaults.defaultOtaVersionUrl()
    }

    /// Fetch the configured OTA manifest and return whether any ASG/BES/MTK update is available.
    public func checkForOtaUpdate() async throws -> Bool {
        let status = await getFreshGlassesStatus()
        guard status.connected else {
            throw BluetoothSdkError(
                code: "glasses_not_connected",
                message: "Cannot check OTA update because glasses are not connected."
            )
        }
        guard !status.buildNumber.isEmpty else {
            throw BluetoothSdkError(
                code: "missing_glasses_version",
                message: "Cannot check OTA update because glasses build number is unavailable."
            )
        }

        let manifestUrl = try resolveOtaVersionUrl(status: status)
        let manifest = try await OtaManifestChecker.fetch(manifestUrl)
        let otaStatus = try await waitForOtaManifestStatus(status, manifest: manifest)
        return try OtaManifestChecker.hasUpdate(
            currentBuildNumber: otaStatus.buildNumber,
            currentMtkVersion: otaStatus.mtkFirmwareVersion,
            currentBesVersion: otaStatus.besFirmwareVersion,
            manifest: manifest
        )
    }

    /// Ask connected Mentra Live glasses to report the current OTA install/session status.
    private func queryOtaStatus() async throws -> OtaQueryResult {
        try await performOtaQuery(operation: "OTA status query") {
            DeviceManager.shared.sendOtaQueryStatus()
        }
    }

    private func performOtaQuery(
        operation: String,
        sendRequest: () -> Void
    ) async throws -> OtaQueryResult {
        if pendingOtaQuery != nil {
            throw BluetoothSdkError(
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
        let status = await getFreshGlassesStatus()
        let otaVersionUrl = try resolveOtaVersionUrl(status: status)
        return try await startOtaUpdate(otaVersionUrl: otaVersionUrl)
    }

    private func startOtaCommand(otaVersionUrl: String) async throws -> OtaStartAckEvent {
        if pendingOtaStart != nil {
            throw BluetoothSdkError(
                code: "request_in_flight",
                message: "An OTA start command is already waiting for a glasses response."
            )
        }
        let pending = PendingResponse<OtaStartAckEvent>(operation: "OTA start command")
        pendingOtaStart = pending
        DeviceManager.shared.sendOtaStart(otaVersionUrl: otaVersionUrl)
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

    func startOtaUpdate(otaVersionUrl: String) async throws -> OtaStartAckEvent {
        try await startOtaCommand(otaVersionUrl: otaVersionUrl)
    }

    func sendOtaQueryStatus() async throws -> OtaQueryResult { try await queryOtaStatus() }

    private func getFreshGlassesStatus() async -> GlassesStatus {
        let status = glassesStatus
        if !status.connected || !status.buildNumber.isEmpty {
            return status
        }

        do {
            let versionInfo = try await requestVersionInfo()
            let values = status.values.merging(versionInfo.dictionary) { existing, new in
                if let newString = new as? String, newString.isEmpty {
                    return existing
                }
                return new
            }
            return GlassesStatus(values: values)
        } catch {
            return status
        }
    }

    private func waitForOtaManifestStatus(_ initialStatus: GlassesStatus, manifest: OtaManifest) async throws -> GlassesStatus {
        var status = initialStatus
        if OtaManifestChecker.hasBesFirmware(manifest), status.besFirmwareVersion.isEmpty {
            status = await waitForGlassesStatus(status, timeoutMs: Self.otaBesVersionWaitMs) {
                !$0.connected || !$0.besFirmwareVersion.isEmpty
            }
        }

        if OtaManifestChecker.hasMtkPatches(manifest), status.mtkFirmwareVersion.isEmpty {
            status = await waitForGlassesStatus(status, timeoutMs: Self.otaMtkVersionWaitMs) {
                !$0.connected || !$0.mtkFirmwareVersion.isEmpty
            }
        }

        guard status.connected else {
            throw BluetoothSdkError(
                code: "glasses_not_connected",
                message: "Cannot check OTA update because glasses disconnected."
            )
        }
        return status
    }

    private func waitForGlassesStatus(
        _ initialStatus: GlassesStatus,
        timeoutMs: Int,
        isReady: (GlassesStatus) -> Bool
    ) async -> GlassesStatus {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000)
        var status = initialStatus
        while Date() < deadline {
            status = glassesStatus
            if isReady(status) {
                return status
            }

            let remainingMs = max(0, Int(deadline.timeIntervalSinceNow * 1_000))
            let sleepMs = min(Self.otaVersionPollMs, remainingMs)
            if sleepMs <= 0 {
                break
            }
            try? await Task.sleep(nanoseconds: UInt64(sleepMs) * 1_000_000)
        }
        return glassesStatus
    }

    private func resolveOtaVersionUrl(status: GlassesStatus) throws -> String {
        let deviceUrl = status.otaVersionUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        if isLegacyAsgOtaStartBuild(status.buildNumber) {
            return OtaManifestDefaults.legacyProdOtaVersionUrl
        }
        // SDK consumers are pinned to the manifest built for their SDK version.
        // A future glasses-advertised URL should not silently change that pairing.
        if let configuredOtaVersionUrl {
            return configuredOtaVersionUrl
        }
        return try OtaManifestDefaults.defaultOtaVersionUrl()
    }

    private func isLegacyAsgOtaStartBuild(_ buildNumber: String) -> Bool {
        guard let parsed = Int(buildNumber) else { return false }
        return parsed < 39
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
        if let bluetoothAvailabilityListenerId {
            BluetoothAvailability.shared.removeStateListener(bluetoothAvailabilityListenerId)
            self.bluetoothAvailabilityListenerId = nil
        }
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

    private func handleBluetoothAvailability(_ state: CBManagerState) {
        switch state {
        case .poweredOff, .resetting, .unauthorized, .unsupported:
            handleBluetoothUnavailable()
        case .poweredOn:
            handleBluetoothRestored()
        case .unknown:
            break
        @unknown default:
            handleBluetoothUnavailable()
        }
    }

    private func handleBluetoothUnavailable() {
        cancelActiveScanSessions(reason: .cancelled)
        clearBluetoothDiscoveryState()
        disconnectActiveConnections()
    }

    private func disconnectActiveConnections() {
        if glassesStatus.controllerConnected {
            DeviceManager.shared.disconnectController()
            shouldRestoreControllerOnBluetoothRestore = true
        }
        if glassesStatus.deviceModel == DeviceTypes.SIMULATED
            || DeviceManager.shared.sgc?.type.contains(DeviceTypes.SIMULATED) == true
        {
            return
        }
        if glassesStatus.connected || glassesStatus.connectionState != .disconnected {
            DeviceManager.shared.disconnect()
            shouldRestoreGlassesOnBluetoothRestore = true
        }
    }

    /// Reconnect only what `handleBluetoothUnavailable` tore down, never a
    /// connection the user closed themselves (explicit connect/disconnect
    /// calls clear the restore intent).
    private func handleBluetoothRestored() {
        let restoreGlasses = shouldRestoreGlassesOnBluetoothRestore
        let restoreController = shouldRestoreControllerOnBluetoothRestore
        clearBluetoothRestoreIntent()

        if restoreGlasses, !glassesStatus.connected, glassesStatus.connectionState == .disconnected {
            DeviceManager.shared.connectDefault() // also restores the controller
        } else if restoreController, !glassesStatus.controllerConnected {
            DeviceManager.shared.connectDefaultController()
        }
    }

    private func clearBluetoothRestoreIntent() {
        shouldRestoreGlassesOnBluetoothRestore = false
        shouldRestoreControllerOnBluetoothRestore = false
    }

    private func clearBluetoothDiscoveryState() {
        discoveredDeviceNames.removeAll()
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "searching", false)
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "searchingController", false)
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "searchResults", [] as [[String: Any]])
    }

    private func cancelActiveScanSessions(reason: ScanStopReason) {
        let ids = Array(activeScanSessions.keys)
        guard !ids.isEmpty else {
            if bluetoothStatus.searching || bluetoothStatus.searchingController {
                stopScan(reason: reason)
            }
            return
        }
        for (index, id) in ids.enumerated() {
            // Stop the underlying scan once (first session); the rest only
            // complete their callbacks.
            finishScanSession(id, reason: reason, shouldStopScan: index == 0)
        }
    }

    private func startStreamKeepAliveMonitor(streamId: String, intervalSeconds requestedIntervalSeconds: Int) {
        let intervalSeconds = requestedIntervalSeconds > 0 ? requestedIntervalSeconds : Self.defaultStreamKeepAliveIntervalSeconds
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
            case .reconnectFailed, .stopped:
                pendingStreamStarts.removeValue(forKey: streamId)
                pending.reject(streamStatusError(event, code: "stream_start_failed"))
            case .error:
                // The glasses publisher automatically retries transient transport
                // errors. Keep the start pending so a subsequent `streaming`
                // status can resolve it; `reconnectFailed` or the request timeout
                // still terminates a publisher that cannot recover.
                break
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

    private func streamStatusError(_ event: StreamStatusEvent, code: String) -> BluetoothSdkError {
        let message: String
        if case let .error(_, errorDetails, _, _) = event.status {
            message = errorDetails
        } else {
            message = "Stream status \(event.state.rawValue)"
        }
        return BluetoothSdkError(code: code, message: message)
    }

    private func handlePhotoResponseForRequests(_ event: PhotoResponseEvent) {
        guard let pending = pendingPhotoRequests[event.requestId] else { return }
        switch event.response {
        case .success:
            pending.resolve(event)
        case let .error(_, errorCode, errorMessage, _):
            pending.reject(
                BluetoothSdkError(
                    code: errorCode ?? "photo_request_failed",
                    message: errorMessage
                )
            )
        }
    }

    private func handleCameraStatusForRequests(_ event: CameraStatusEvent) {
        guard let pending = pendingCameraStatusRequests[event.requestId] else { return }
        switch event.state.lowercased() {
        case "ready":
            pending.resolve(event)
        case "error":
            pending.reject(
                BluetoothSdkError(
                    code: event.errorCode ?? "camera_warm_up_failed",
                    message: event.errorMessage ?? "Camera warm-up failed."
                )
            )
        default:
            // "warming"/"stopped" are progress updates; leave the pending promise alone.
            break
        }
    }

    private func handleVideoRecordingStatusForRequests(_ event: VideoRecordingStatusEvent) {
        guard let request = pendingVideoRecordingRequests[event.requestId] else { return }
        if event.success {
            if event.status == request.expectedStatus {
                if request.waitForUpload {
                    request.stoppedEvent = event
                    if request.uploadSucceeded {
                        request.pending.resolve(event)
                    }
                } else {
                    request.pending.resolve(event)
                }
            }
        } else {
            request.pending.reject(
                BluetoothSdkError(
                    code: event.status.isEmpty ? "video_recording_failed" : event.status,
                    message: event.details ?? "Video recording command failed."
                )
            )
        }
    }

    private func handleMediaUploadForRequests(_ event: MediaUploadEvent) {
        guard event.isVideo, let request = pendingVideoRecordingRequests[event.requestId], request.waitForUpload else {
            return
        }
        if event.isSuccess {
            if let stoppedEvent = request.stoppedEvent {
                request.pending.resolve(stoppedEvent)
            } else {
                request.uploadSucceeded = true
            }
        } else {
            request.pending.reject(
                BluetoothSdkError(
                    code: "video_upload_failed",
                    message: event.errorMessage ?? "Video upload failed."
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
                BluetoothSdkError(
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
                BluetoothSdkError(
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

    private func updateWifiScanLatestResults(_ results: [WifiScanResult]) {
        guard !results.isEmpty else { return }
        pendingWifiScan?.latestResults = results
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
            BluetoothSdkError(
                code: "hotspot_command_failed",
                message: event.message ?? "Hotspot command failed."
            )
        )
    }

    private func dispatchStoreUpdate(_ category: String, _ changes: [String: Any]) {
        switch ObservableStore.normalizeCategory(category) {
        case "glasses":
            analytics.observeGlassesStatus(glassesStatus)
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
            updateWifiScanLatestResults(networks)
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
        case "camera_status":
            let event = CameraStatusEvent(values: data)
            handleCameraStatusForRequests(event)
            delegate?.mentraBluetoothSDK(self, didReceive: .cameraStatus(event))
        case "video_recording_status":
            let event = VideoRecordingStatusEvent(values: data)
            handleVideoRecordingStatusForRequests(event)
            delegate?.mentraBluetoothSDK(self, didReceive: .videoRecordingStatus(event))
        case "media_success", "media_error":
            let event = MediaUploadEvent(values: data)
            handleMediaUploadForRequests(event)
            delegate?.mentraBluetoothSDK(self, didReceive: .mediaUpload(event))
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
                didFail: BluetoothSdkError(
                    code: "pair_failure",
                    message: data["error"] as? String ?? data.description
                )
            )
        default:
            delegate?.mentraBluetoothSDK(self, didReceive: .raw(name: eventName, values: data))
        }
    }
}
