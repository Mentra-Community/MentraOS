import AVFoundation
import Foundation
import MentraBluetoothSDK
import UIKit

struct ExampleEvent: Identifiable {
    let id = UUID()
    let time: String
    let tag: String
    let text: String
}

struct ExampleActionError: LocalizedError {
    let message: String
    var errorDescription: String? {
        message
    }
}

private struct GalleryServerCheck {
    let reachable: Bool
    let status: String
    let eventTag: String
    let eventText: String
}

private func describeSettingsAck(_ ack: SettingsAckEvent) -> String {
    var parts = ["\(ack.setting) \(ack.status)"]
    if let fov = ack.values["fov"] {
        parts.append("fov=\(fov)")
    }
    if let roiPosition = ack.values["roiPosition"] {
        parts.append("roi=\(roiPosition)")
    }
    if let errorCode = ack.errorCode {
        parts.append(errorCode)
    }
    return parts.joined(separator: " ")
}

private func describeCameraFovResult(_ result: CameraFovResult) -> String {
    "applied fov=\(result.fov) roi=\(result.roiPosition.label) request=\(result.requestId)"
}

private let defaultPhotoUploadUrl = "http://<computer-ip>:8787/upload"
let scanModelOptions: [DeviceModel] = [.mentraLive, .g2]
let photoExposureMinNs = 1_000_000
let photoExposureMaxNs = 33_333_333
let photoExposureDefaultNs = 8_333_333
let photoIsoMin = 100
let photoIsoMax = 6400
let photoIsoDefault = 200
let cameraFovMin = 62
let cameraFovMax = 118
let cameraFovDefault = 102
let cameraRoiPositions: [(label: String, value: Int)] = [("Center", 0), ("Bottom", 1), ("Top", 2)]

enum PhotoDestination {
    case macBookServer
    case thisPhone
}

struct PhotoPreviewDetails {
    let byteCount: Int?
    let contentType: String?
    let error: String?
    let height: Int?
    let previewUrl: String?
    let requestId: String?
    let source: String
    let state: String
    let timestamp: Int?
    let uploadUrl: String?
    let uploadedAt: String?
    let width: Int?

    func acknowledged(requestId: String, source: String, timestamp: Int, uploadUrl: String) -> PhotoPreviewDetails {
        PhotoPreviewDetails(
            byteCount: byteCount,
            contentType: contentType,
            error: error,
            height: height,
            previewUrl: previewUrl,
            requestId: requestId,
            source: source,
            state: state == "preview" ? "preview" : "acknowledged",
            timestamp: timestamp,
            uploadUrl: uploadUrl,
            uploadedAt: uploadedAt,
            width: width
        )
    }

    func uploaded(
        byteCount: Int?,
        contentType: String? = nil,
        height: Int? = nil,
        previewUrl: String,
        requestId: String?,
        source: String,
        uploadedAt: String? = nil,
        width: Int? = nil
    ) -> PhotoPreviewDetails {
        PhotoPreviewDetails(
            byteCount: byteCount ?? self.byteCount,
            contentType: contentType ?? self.contentType,
            error: error,
            height: height ?? self.height,
            previewUrl: previewUrl,
            requestId: requestId ?? self.requestId,
            source: source,
            state: "preview",
            timestamp: timestamp,
            uploadUrl: uploadUrl,
            uploadedAt: uploadedAt ?? self.uploadedAt,
            width: width ?? self.width
        )
    }

    static func waiting(source: String) -> PhotoPreviewDetails {
        PhotoPreviewDetails(byteCount: nil, contentType: nil, error: nil, height: nil, previewUrl: nil, requestId: nil, source: source, state: "acknowledged", timestamp: nil, uploadUrl: nil, uploadedAt: nil, width: nil)
    }

    static func failed(requestId: String, source: String, error: String, timestamp: Int) -> PhotoPreviewDetails {
        PhotoPreviewDetails(byteCount: nil, contentType: nil, error: error, height: nil, previewUrl: nil, requestId: requestId, source: source, state: "error", timestamp: timestamp, uploadUrl: nil, uploadedAt: nil, width: nil)
    }
}

func deviceModelLabel(_ model: DeviceModel) -> String {
    switch model {
    case .mentraLive:
        return "Mentra Live"
    case .g2:
        return "Even G2"
    case .g1:
        return "Even G1"
    case .mentraNex:
        return "Mentra Nex"
    case .mach1:
        return "Mach1"
    case .z100:
        return "Z100"
    case .frame:
        return "Frame"
    case .r1:
        return "R1"
    case .simulated:
        return "Simulated"
    @unknown default:
        return model.rawValue
    }
}

func roiPositionLabel(_ roiPosition: Int) -> String {
    cameraRoiPositions.first { $0.value == roiPosition }?.label ?? "Center"
}

enum ExampleStreamProtocol: String, CaseIterable {
    case rtmp
    case srt
    case webrtc

    static let defaultUrls = Set(Self.allCases.map(\.defaultUrl))

    var defaultUrl: String {
        switch self {
        case .rtmp:
            return "rtmp://<computer-ip>:1935/live/mentra-live"
        case .srt:
            return "srt://<computer-ip>:8890?streamid=publish:mentra-live"
        case .webrtc:
            return "http://<computer-ip>:8889/mentra-live/whip"
        }
    }

    var inputLabel: String {
        self == .webrtc ? "WHIP" : rawValue.uppercased()
    }
}

@MainActor
final class BluetoothViewModel: NSObject, ObservableObject, MentraBluetoothSDKDelegate, AVAudioPlayerDelegate {
    @Published private(set) var glassesValues: GlassesRuntimeState?
    @Published private(set) var bluetoothValues: PhoneSdkRuntimeState?
    @Published private(set) var discoveredDevices: [Device] = []
    @Published private(set) var selectedDiscoveredDevice: Device?
    @Published private(set) var selectedScanModel: DeviceModel = .mentraLive
    @Published private(set) var events: [ExampleEvent] = [ExampleEvent.make(tag: "LIVE", text: "SDK ready. Scan to discover glasses.")]
    @Published private(set) var activeAction: String?
    @Published private(set) var lastAction = "No actions yet."
    @Published private(set) var cameraStatus = "Camera: phone receiver will start before capture"
    @Published var webhookUrl = defaultPhotoUploadUrl
    @Published private(set) var photoPreviewDetails: PhotoPreviewDetails?
    @Published private(set) var photoPreviewUrl: URL?
    @Published private(set) var photoPreviewImage: UIImage?
    @Published private(set) var photoDestination: PhotoDestination = .thisPhone
    @Published private(set) var photoSize: PhotoSize = .full
    @Published private(set) var photoCompression: PhotoCompression = .none
    @Published private(set) var photoExposureManual = false
    @Published private(set) var photoExposureTimeNs = photoExposureDefaultNs
    @Published private(set) var photoIso = photoIsoDefault
    @Published private(set) var cameraFov = cameraFovDefault
    @Published private(set) var cameraRoiPosition = 0
    @Published private(set) var cameraSettingsApplying = false
    @Published private(set) var cameraSettingsStatus = "Camera settings: default"
    @Published private(set) var phonePhotoServerRunning = false
    @Published private(set) var phonePhotoUploadUrl = "Phone receiver not started"
    @Published var streamProtocol: ExampleStreamProtocol = .webrtc
    @Published var streamUrl = ExampleStreamProtocol.webrtc.defaultUrl
    @Published private(set) var streamFps = 15
    @Published private(set) var streamCloudServerEnabled = false
    @Published private(set) var directStreamReceiverRunning = false
    @Published private(set) var directStreamWhipUrl = "Phone receiver not started"
    @Published private(set) var streamRequested = false
    @Published private(set) var streamPreviewReady = false
    @Published private(set) var streamResolvedConfig: StreamResolvedConfig?
    @Published private(set) var streamStartedAt: Date?
    @Published private(set) var streamStatus = "Ready to start stream"
    @Published private(set) var galleryModeEnabled = false
    @Published private(set) var hotspotEnabled = false
    @Published private(set) var galleryServerReachable: Bool?
    @Published private(set) var galleryServerStatus = "Gallery server: enable hotspot to check"
    @Published private(set) var micRecording = false
    @Published private(set) var micPlaying = false
    @Published private(set) var micElapsedSeconds = 0
    @Published private(set) var pcmFrames = 0
    @Published private(set) var pcmBytes = 0
    @Published private(set) var speaking: Bool?
    @Published private(set) var voiceActivityDetectionEnabled = false
    @Published private(set) var lastMicDurationSeconds: Int?
    @Published private(set) var lastMicBytes = 0
    @Published private(set) var micPlaybackHint: String?
    @Published private(set) var otaStatus: OtaStatusEvent?
    @Published private(set) var otaStatusMessage: String?
    @Published private(set) var otaUpdateAvailable: OtaUpdateAvailableEvent?
    @Published private(set) var ledColor = "green"
    @Published private(set) var ledMode = "Off"
    @Published var rawJsonExpanded = false

    private let micSampleRate = 16000
    private let micChannelCount = 1
    private let micBitsPerSample = 16
    private let mentraBluetoothSdk = MentraBluetoothSDK()
    let directWhipReceiver = GStreamerWhipReceiver()
    private var activePhotoRequestId: String?
    private var activeStreamId: String?
    private var pollGeneration = 0
    private var directPhotoTimeoutTask: Task<Void, Never>?
    private var previewHealthTask: Task<Void, Never>?
    private var directStreamStartTask: Task<Void, Never>?
    private var directStreamStopTask: Task<Void, Never>?
    private var directStreamFirstFrameSeen = false
    private var lastDirectStreamFrameStatusRefresh = Date.distantPast
    private var scanSession: ScanSession?
    private var micStartedAt: Date?
    private var micElapsedTask: Task<Void, Never>?
    private var micPcmData = Data()
    private var micRecordingUrl: URL?
    private var micPlayer: AVAudioPlayer?
    private let validLedColors = Set(["red", "green", "blue", "orange", "white"])
    private let defaultDeviceDefaults = UserDefaults.standard
    private let directWhipProxy = WhipHeaderProxy()
    private nonisolated(unsafe) var photoUploadServer: LocalPhotoUploadServer?

    private enum DefaultDeviceStorage {
        static let version = "mentra.example.defaultDevice.version"
        static let model = "mentra.example.defaultDevice.model"
        static let name = "mentra.example.defaultDevice.name"
        static let identifier = "mentra.example.defaultDevice.identifier"
        static let savedAt = "mentra.example.defaultDevice.savedAt"
    }

    var glassesConnected: Bool {
        isGlassesConnected(glassesValues)
    }

    var glassesWifiConnected: Bool {
        connectedWifiStatus(glassesValues) != nil
    }

    var hasMicRecording: Bool {
        micRecordingUrl != nil && lastMicBytes > 0
    }

    override init() {
        super.init()
        mentraBluetoothSdk.delegate = self
        directWhipReceiver.onStateChanged = { [weak self] message in
            Task { @MainActor in
                self?.handleDirectReceiverStatus(message)
            }
        }
        directWhipReceiver.onFrameRendered = { [weak self] in
            Task { @MainActor in
                self?.markDirectStreamFrameReceived()
            }
        }
        photoUploadServer = LocalPhotoUploadServer(
            onLog: { [weak self] message in
                Task { @MainActor in
                    self?.append(tag: "HTTP", text: message)
                }
            },
            onUpload: { [weak self] upload in
                Task { @MainActor in
                    self?.handleDirectPhotoUpload(upload)
                }
            }
        )
        let savedDefaultDevice = loadPersistedDefaultDevice()
        if let savedDevice = savedDefaultDevice {
            mentraBluetoothSdk.setDefaultDevice(savedDevice)
        }
        glassesValues = mentraBluetoothSdk.glasses
        hotspotEnabled = enabledHotspotStatus(glassesValues) != nil
        refreshGalleryServerStatusForCurrentHotspot(defaultStatus: "Gallery server: enable hotspot to check")
        applySdkState(mentraBluetoothSdk.sdkState)
        if let value = ProcessInfo.processInfo.environment["MENTRA_PHOTO_WEBHOOK_URL"] {
            webhookUrl = value
        }
        if savedDefaultDevice != nil {
            scheduleAutoConnectDefaultOnStartup()
        }
    }

    deinit {
        previewHealthTask?.cancel()
        directPhotoTimeoutTask?.cancel()
        directStreamStartTask?.cancel()
        directStreamStopTask?.cancel()
        micElapsedTask?.cancel()
        directWhipProxy.stop()
        directWhipReceiver.stop()
        photoUploadServer?.stop()
        let scanSession = scanSession
        Task { @MainActor [mentraBluetoothSdk] in
            scanSession?.stop()
            mentraBluetoothSdk.invalidate()
        }
    }

    func startScan() {
        let model = selectedScanModel
        runAction("Scan \(deviceModelLabel(model))") {
            scanSession?.stop()
            discoveredDevices.removeAll()
            selectedDiscoveredDevice = nil
            scanSession = try mentraBluetoothSdk.scan(
                model: model,
                timeout: 10,
                onResults: { [weak self] devices in
                    self?.discoveredDevices = devices
                }
            )
        }
    }

    func connect() {
        runAction("Connect") {
            if let device = selectedDiscoveredDevice ?? discoveredDevices.first {
                try mentraBluetoothSdk.connect(to: device)
            } else if hasSavedConnectionTarget(bluetoothValues) {
                try mentraBluetoothSdk.connectDefault()
            } else {
                throw ExampleActionError(message: "Scan first to choose nearby glasses.")
            }
        }
    }

    func selectDiscoveredDevice(_ device: Device) {
        selectedDiscoveredDevice = device
        lastAction = "Selected: \(device.name)"
    }

    func selectScanModel(_ model: DeviceModel) {
        guard selectedScanModel != model else { return }
        scanSession?.stop()
        scanSession = nil
        discoveredDevices.removeAll()
        selectedDiscoveredDevice = nil
        selectedScanModel = model
        lastAction = "Selected scan model: \(deviceModelLabel(model))"
    }

    func connect(_ device: Device) {
        selectedDiscoveredDevice = device
        runAction("Connect \(device.name)") {
            try mentraBluetoothSdk.connect(to: device)
        }
    }

    func disconnect() {
        let label = "Disconnect"
        guard activeAction != label else { return }
        activeAction = label
        lastAction = "Running: \(label)"
        append(tag: "TX", text: label)
        activeStreamId = nil
        applyDisconnectedState(status: "Disconnecting")
        Task { @MainActor [weak self] in
            await Task.yield()
            guard let self else { return }
            self.mentraBluetoothSdk.disconnect()
            self.lastAction = "Requested: \(label)"
            self.activeAction = nil
        }
    }

    func clearDefaultDevice() {
        runAction("Clear default") {
            mentraBluetoothSdk.clearDefaultDevice()
            bluetoothValues = mentraBluetoothSdk.sdkState
            selectedDiscoveredDevice = nil
        }
    }

    func displayHello() {
        runAction("Display Hello") {
            try requireDisplaySupport("display text")
            Task {
                try? await mentraBluetoothSdk.displayText("Hello from Mentra Bluetooth SDK")
            }
        }
    }

    func clearDisplay() {
        runAction("Clear Display") {
            try requireDisplaySupport("clear the display")
            Task { try? await mentraBluetoothSdk.clearDisplay() }
        }
    }

    func checkForOtaUpdate() {
        runAsyncAction("Check OTA") { [self] in
            try requireConnected("check OTA")
            try requireGlassesWifi("check for OTA updates")
            handleOtaQueryResult(try await mentraBluetoothSdk.checkForOtaUpdate())
        }
    }

    func startOtaUpdate() {
        runAsyncAction("Start OTA") { [self] in
            try requireConnected("start OTA")
            try requireGlassesWifi("start OTA updates")
            _ = try await mentraBluetoothSdk.startOtaUpdate()
            append(tag: "LIVE", text: "OTA start acknowledged")
        }
    }

    func setGalleryModeEnabled(_ enabled: Bool) {
        runAsyncAction(enabled ? "Save in gallery mode" : "Report button events") { [self] in
            try requireConnected("change gallery mode")
            let ack = try await mentraBluetoothSdk.setGalleryModeEnabled(enabled)
            append(tag: "LIVE", text: "settings_ack \(describeSettingsAck(ack))")
            galleryModeEnabled = enabled
        }
    }

    func setVoiceActivityDetectionEnabled(_ enabled: Bool) {
        runAction(enabled ? "Enable voice activity detection" : "Disable voice activity detection") {
            try requireConnected("change voice activity detection")
            voiceActivityDetectionEnabled = enabled
            Task { try? await mentraBluetoothSdk.setVoiceActivityDetectionEnabled(enabled) }
        }
    }

    func setPhotoDestination(_ destination: PhotoDestination) {
        guard photoDestination != destination else { return }
        if destination == .macBookServer {
            stopPhonePhotoServer()
            cameraStatus = "Camera: enter a Photo upload URL"
        } else {
            cameraStatus = "Camera: phone receiver will start before capture"
        }
        photoDestination = destination
    }

    func setPhotoSize(_ size: PhotoSize) {
        photoSize = size
    }

    func setPhotoCompression(_ compression: PhotoCompression) {
        photoCompression = compression
    }

    func setPhotoExposureManual(_ enabled: Bool) {
        photoExposureManual = enabled
    }

    func setPhotoExposureTimeNs(_ exposureTimeNs: Int) {
        photoExposureTimeNs = min(max(exposureTimeNs, photoExposureMinNs), photoExposureMaxNs)
    }

    func setPhotoIso(_ iso: Int) {
        photoIso = min(max(iso, photoIsoMin), photoIsoMax)
    }

    func setCameraFov(_ fov: Int) {
        cameraFov = min(max(fov, cameraFovMin), cameraFovMax)
        if cameraFov == cameraFovMax {
            cameraRoiPosition = 0
        }
    }

    func setCameraRoiPosition(_ roiPosition: Int) {
        cameraRoiPosition = cameraFov == cameraFovMax ? 0 : min(max(roiPosition, 0), 2)
    }

    func applyCameraSettings() {
        guard !cameraSettingsApplying else {
            append(tag: "TX", text: "camera_fov already applying")
            return
        }
        runAsyncAction("Apply camera settings") { [self] in
            try requireConnected("apply camera settings")
            let fov = cameraFov
            let roiPosition = fov == cameraFovMax ? 0 : cameraRoiPosition
            cameraSettingsApplying = true
            cameraSettingsStatus = "Camera settings: applying FOV/ROI on glasses"
            defer { cameraSettingsApplying = false }
            do {
                let result = try await mentraBluetoothSdk.setCameraFov(
                    CameraFov(fov: fov, roiPosition: CameraRoiPosition.from(rawValue: roiPosition))
                )
                append(tag: "LIVE", text: "camera_fov \(describeCameraFovResult(result))")
                cameraSettingsStatus = "Camera settings: applied; field of view \(result.fov)°, \(roiPositionLabel(result.roiPosition.rawValue)) crop"
            } catch {
                cameraSettingsStatus = "Camera settings: failed - \(error.localizedDescription)"
                throw error
            }
        }
    }

    func captureAndUpload() {
        runAsyncAction("Capture & upload") { [self] in
            try requireConnected("capture photos")
            try requireGlassesWifi("capture photos")
            if photoDestination == .thisPhone {
                try await captureAndUploadToPhone()
                return
            }
            let uploadUrl = webhookUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            if let validationMessage = photoUploadValidationMessage(uploadUrl) {
                cameraStatus = "Camera: \(validationMessage)"
                throw ExampleActionError(message: validationMessage)
            }
            guard let statusUrl = photoStatusUrl(uploadUrl, requestId: "") else {
                let message = "Enter a valid http:// or https:// Photo upload URL."
                cameraStatus = "Camera: \(message)"
                throw ExampleActionError(message: message)
            }
            let requestId = "photo-\(Int(Date().timeIntervalSince1970 * 1000))"
            activePhotoRequestId = requestId
            pollGeneration += 1
            let generation = pollGeneration
            photoPreviewDetails = nil
            photoPreviewUrl = nil
            photoPreviewImage = nil
            cameraStatus = "Camera: webhook upload requested (\(requestId))"
            let responseEvent = try await mentraBluetoothSdk.requestPhoto(
                PhotoRequest(
                    requestId: requestId,
                    appId: "com.mentra.examples.ios",
                    size: photoSize,
                    webhookUrl: uploadUrl,
                    compress: photoCompression,
                    sound: true,
                    exposureTimeNs: photoExposureManual ? Double(photoExposureTimeNs) : nil,
                    iso: photoExposureManual ? photoIso : nil
                )
            )
            handlePhotoResponse(responseEvent.response)
            pollPhotoPreview(requestId: requestId, statusUrl: statusUrl.deletingLastPathComponent().appendingPathComponent("\(requestId).json"), generation: generation)
        }
    }

    private func captureAndUploadToPhone() async throws {
        let uploadUrl = try startPhonePhotoServer()
        let requestId = "photo-\(Int(Date().timeIntervalSince1970 * 1000))"
        activePhotoRequestId = requestId
        pollGeneration += 1
        directPhotoTimeoutTask?.cancel()
        directPhotoTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 75_000_000_000)
            await MainActor.run {
                guard let self, self.activePhotoRequestId == requestId else { return }
                self.activePhotoRequestId = nil
                self.cameraStatus = "Camera: timed out waiting for phone upload"
                self.append(tag: "TX", text: "phone photo upload timed out \(requestId)")
            }
        }
        photoPreviewDetails = nil
        photoPreviewUrl = nil
        photoPreviewImage = nil
        cameraStatus = "Camera: requested phone upload (\(requestId))"
        let responseEvent = try await mentraBluetoothSdk.requestPhoto(
            PhotoRequest(
                requestId: requestId,
                appId: "com.mentra.examples.ios",
                size: photoSize,
                webhookUrl: uploadUrl,
                compress: photoCompression,
                sound: true,
                exposureTimeNs: photoExposureManual ? Double(photoExposureTimeNs) : nil,
                iso: photoExposureManual ? photoIso : nil
            )
        )
        handlePhotoResponse(responseEvent.response)
        append(tag: "TX", text: "requestPhoto requestId=\(requestId) webhookUrl=\(uploadUrl)")
    }

    private func startPhonePhotoServer() throws -> String {
        guard let host = bestLocalIPv4Address() else {
            let message = "No phone LAN IP found. Connect this iPhone to Wi-Fi or a network reachable by the glasses."
            cameraStatus = "Camera: \(message)"
            throw ExampleActionError(message: message)
        }
        let photoUploadServer = photoUploadServer!
        if photoUploadServer.running, phonePhotoUploadUrl.hasPrefix("http://\(host):") {
            return phonePhotoUploadUrl
        }

        cameraStatus = "Camera: starting phone upload receiver"
        phonePhotoServerRunning = false
        phonePhotoUploadUrl = "Starting phone receiver"

        var lastError: Error?
        for port in [UInt16(8787), 8788, 8789, 8790] {
            do {
                let actualPort = try photoUploadServer.start(port: port)
                let url = "http://\(host):\(actualPort)/upload"
                phonePhotoServerRunning = true
                phonePhotoUploadUrl = url
                cameraStatus = "Camera: phone receiver ready"
                append(tag: "HTTP", text: "phone photo receiver \(url)")
                return url
            } catch {
                lastError = error
                append(tag: "HTTP", text: "photo receiver port \(port) unavailable: \(error.localizedDescription)")
            }
        }

        let message = lastError?.localizedDescription ?? "No local photo receiver port was available."
        phonePhotoServerRunning = false
        phonePhotoUploadUrl = "Phone receiver failed"
        cameraStatus = "Camera: phone receiver failed: \(message)"
        throw ExampleActionError(message: "Phone photo receiver failed: \(message)")
    }

    private func stopPhonePhotoServer() {
        directPhotoTimeoutTask?.cancel()
        directPhotoTimeoutTask = nil
        photoUploadServer?.stop()
        phonePhotoServerRunning = false
        phonePhotoUploadUrl = "Phone receiver not started"
    }

    private func handleDirectPhotoUpload(_ upload: LocalPhotoUpload) {
        if let activePhotoRequestId, let requestId = upload.requestId, requestId != activePhotoRequestId {
            append(tag: "LIVE", text: "ignoring stale phone upload \(requestId)")
            return
        }
        directPhotoTimeoutTask?.cancel()
        directPhotoTimeoutTask = nil
        activePhotoRequestId = nil
        photoPreviewUrl = upload.fileURL
        photoPreviewImage = UIImage(contentsOfFile: upload.fileURL.path)
        photoPreviewDetails = (photoPreviewDetails ?? .waiting(source: "Phone receiver")).uploaded(
            byteCount: upload.byteCount,
            contentType: "image/jpeg",
            height: photoPreviewImage.map { Int($0.size.height * $0.scale) },
            previewUrl: upload.fileURL.absoluteString,
            requestId: upload.requestId,
            source: "Phone receiver",
            width: photoPreviewImage.map { Int($0.size.width * $0.scale) }
        )
        cameraStatus = "Camera: received phone upload \(upload.requestId ?? "")"
        append(tag: "LIVE", text: "phone photo ready \(upload.byteCount) bytes")
    }

    func testWebhook() {
        runAction("Test webhook") {
            if photoDestination == .thisPhone {
                _ = try startPhonePhotoServer()
                cameraStatus = "Camera: phone receiver ready at \(phonePhotoUploadUrl)"
                return
            }
            let uploadUrl = webhookUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            if let validationMessage = photoUploadValidationMessage(uploadUrl) {
                cameraStatus = "Camera: \(validationMessage)"
                append(tag: "TX", text: "Test webhook failed: \(validationMessage)")
                throw ExampleActionError(message: validationMessage)
            }
            guard let healthUrl = webhookHealthUrl(uploadUrl) else {
                let message = "Enter a valid http:// or https:// Photo upload URL."
                cameraStatus = "Camera: \(message)"
                append(tag: "TX", text: "Test webhook failed: invalid URL")
                throw ExampleActionError(message: message)
            }

            cameraStatus = "Camera: testing local webhook"
            Task {
                do {
                    var request = URLRequest(url: URL(string: "\(healthUrl.absoluteString)?poll=\(Int(Date().timeIntervalSince1970 * 1000))")!)
                    request.cachePolicy = .reloadIgnoringLocalCacheData
                    request.timeoutInterval = 3
                    let (_, response) = try await URLSession.shared.data(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        cameraStatus = "Camera: webhook test failed: invalid response"
                        append(tag: "LIVE", text: "webhook test failed: invalid response")
                        return
                    }
                    guard (200 ..< 300).contains(http.statusCode) else {
                        cameraStatus = "Camera: webhook returned HTTP \(http.statusCode)"
                        append(tag: "LIVE", text: "webhook returned HTTP \(http.statusCode)")
                        return
                    }
                    cameraStatus = "Camera: webhook reachable (\(healthUrl.host ?? "server"))"
                    append(tag: "LIVE", text: "webhook reachable \(healthUrl.absoluteString)")
                } catch {
                    cameraStatus = "Camera: webhook test failed: \(error.localizedDescription)"
                    append(tag: "LIVE", text: "webhook test failed: \(error.localizedDescription)")
                }
            }
        }
    }

    func toggleStream() {
        if streamRequested || streamStartedAt != nil {
            runAsyncAction("Stop stream") { [self] in
                stopPreviewHealthPoll()
                if isDirectPhoneWebRtcSelected {
                    directStreamStartTask?.cancel()
                    directStreamStartTask = nil
                    if glassesConnected {
                        let status = try await mentraBluetoothSdk.stopStream()
                        append(tag: "LIVE", text: "stream \(summarize(status.values))")
                        streamStatus = "Stopping WebRTC direct phone stream"
                        directStreamStopTask?.cancel()
                        directStreamStopTask = Task { [weak self] in
                            try? await Task.sleep(nanoseconds: 5_000_000_000)
                            await MainActor.run {
                                guard let self,
                                      self.isDirectPhoneWebRtcSelected,
                                      self.directStreamReceiverRunning
                                else {
                                    return
                                }
                                self.activeStreamId = nil
                                self.stopDirectPhoneStreamReceiver(status: "WebRTC direct phone stopped")
                                self.streamRequested = false
                                self.streamResolvedConfig = nil
                                self.streamStartedAt = nil
                            }
                        }
                        return
                    }
                    stopDirectPhoneStreamReceiver(status: "Stopped")
                    activeStreamId = nil
                    streamRequested = false
                    streamPreviewReady = false
                    streamResolvedConfig = nil
                    streamStartedAt = nil
                    streamStatus = "Stopped"
                    return
                }
                if glassesConnected {
                    let status = try await mentraBluetoothSdk.stopStream()
                    append(tag: "LIVE", text: "stream \(summarize(status.values))")
                }
                activeStreamId = nil
                streamRequested = false
                streamPreviewReady = false
                streamResolvedConfig = nil
                streamStartedAt = nil
                streamStatus = "Stopped"
            }
            return
        }

        runAsyncAction("Start stream") { [self] in
            try requireConnected("start streaming")
            try requireGlassesWifi("start streaming")
            if isDirectPhoneWebRtcSelected {
                try startDirectPhoneWebRtcStream()
                return
            }
            let url = streamUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            if let validationMessage = streamUrlValidationMessage(url) {
                streamStatus = validationMessage
                throw ExampleActionError(message: validationMessage)
            }
            let streamId = "ios-\(Int(Date().timeIntervalSince1970 * 1000))"
            let selectedProtocol = streamProtocol
            if selectedProtocol == .rtmp || selectedProtocol == .srt || selectedProtocol == .webrtc {
                streamStatus = "Checking local \(selectedProtocol.rawValue.uppercased()) server"
                Task {
                    do {
                        if selectedProtocol == .rtmp {
                            try await checkLocalRtmpServer(rtmpUrl: url)
                        } else if selectedProtocol == .srt {
                            try await checkLocalSrtServer(srtUrl: url)
                        } else {
                            try await checkLocalWebrtcServer(whipUrl: url)
                        }
                        guard streamUrl.trimmingCharacters(in: .whitespacesAndNewlines) == url,
                              streamProtocol == selectedProtocol,
                              !streamRequested,
                              streamStartedAt == nil
                        else { return }
                        try await startStream(streamUrl: url, streamId: streamId, protocol: selectedProtocol)
                    } catch {
                        let message = error.localizedDescription
                        streamStatus = message
                        append(tag: "TX", text: "stream failed: \(message)")
                    }
                }
                return
            }
            try await startStream(streamUrl: url, streamId: streamId, protocol: selectedProtocol)
        }
    }

    private func startDirectPhoneWebRtcStream() throws {
        stopPreviewHealthPoll()
        directStreamStopTask?.cancel()
        directStreamStopTask = nil
        stopDirectPhoneStreamReceiver(status: "Starting phone receiver")
        guard let host = bestLocalIPv4Address() else {
            let message = "No phone LAN IP found. Connect this iPhone to Wi-Fi or a network reachable by the glasses."
            streamStatus = message
            throw ExampleActionError(message: message)
        }

        var lastError: Error?
        for ports in [(publicPort: 8190, backendPort: 8191), (publicPort: 8192, backendPort: 8193), (publicPort: 8194, backendPort: 8195)] {
            do {
                try directWhipReceiver.start(withAdvertisedHost: "127.0.0.1", port: ports.backendPort)
                try directWhipProxy.start(listenPort: UInt16(ports.publicPort), backendPort: UInt16(ports.backendPort))
                let streamId = "ios-gst-\(Int(Date().timeIntervalSince1970 * 1000))"
                let url = "http://\(host):\(ports.publicPort)/whip/endpoint"
                activeStreamId = streamId
                directStreamFirstFrameSeen = false
                lastDirectStreamFrameStatusRefresh = .distantPast
                directStreamReceiverRunning = true
                directStreamWhipUrl = url
                streamPreviewReady = false
                streamRequested = true
                streamStartedAt = nil
                streamStatus = "WebRTC phone receiver ready; starting stream"
                append(tag: "STREAM", text: "phone WHIP receiver \(url) -> GStreamer \(ports.backendPort)")
                directStreamStartTask?.cancel()
                directStreamStartTask = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    guard let self,
                          self.activeStreamId == streamId,
                          self.directStreamReceiverRunning,
                          self.streamRequested
                    else {
                        return
                    }
                    do {
                        try await self.sendDirectPhoneStartStream(streamUrl: url, streamId: streamId)
                    } catch {
                        self.streamStatus = "WebRTC stream failed: \(error.localizedDescription)"
                        self.append(tag: "TX", text: "direct phone stream failed: \(error.localizedDescription)")
                    }
                }
                return
            } catch {
                lastError = error
                directWhipProxy.stop()
                directWhipReceiver.stop()
                append(tag: "GST", text: "port pair \(ports.publicPort)->\(ports.backendPort) unavailable: \(error.localizedDescription)")
            }
        }

        let message = lastError?.localizedDescription ?? "No local WHIP port pair was available."
        directStreamReceiverRunning = false
        directStreamWhipUrl = "Phone receiver failed"
        streamPreviewReady = false
        streamResolvedConfig = nil
        streamRequested = false
        streamStatus = "WebRTC phone receiver failed: \(message)"
        throw ExampleActionError(message: "WebRTC phone receiver failed: \(message)")
    }

    private func sendDirectPhoneStartStream(streamUrl: String, streamId: String) async throws {
        let status = try await mentraBluetoothSdk.startStream(
            StreamRequest(
                streamUrl: streamUrl,
                streamId: streamId,
                video: StreamVideoConfig(fps: streamFps)
            )
        )
        append(tag: "LIVE", text: "stream \(summarize(status.values))")
        streamRequested = true
        streamStartedAt = streamStartedAt ?? Date()
        streamStatus = "WebRTC stream requested; waiting for phone preview"
        append(tag: "TX", text: "startStream direct phone \(streamUrl)")
    }

    private func stopDirectPhoneStreamReceiver(status: String) {
        directStreamStartTask?.cancel()
        directStreamStartTask = nil
        directStreamStopTask?.cancel()
        directStreamStopTask = nil
        directStreamFirstFrameSeen = false
        lastDirectStreamFrameStatusRefresh = .distantPast
        directWhipProxy.stop()
        directWhipReceiver.stop()
        directStreamReceiverRunning = false
        directStreamWhipUrl = "Phone receiver not started"
        streamPreviewReady = false
        streamStatus = status
    }

    private func handleDirectReceiverStatus(_ message: String) {
        append(tag: "GST", text: message)
        guard isDirectPhoneWebRtcSelected, directStreamReceiverRunning else { return }
        if message.hasPrefix("Rendered ") {
            markDirectStreamFrameReceived()
        } else if !streamPreviewReady {
            streamStatus = "WebRTC phone receiver: \(message)"
        }
    }

    private func markDirectStreamFrameReceived() {
        guard isDirectPhoneWebRtcSelected, directStreamReceiverRunning else { return }
        let firstFrame = !directStreamFirstFrameSeen
        let now = Date()
        guard firstFrame || now.timeIntervalSince(lastDirectStreamFrameStatusRefresh) >= 1 else {
            return
        }
        directStreamFirstFrameSeen = true
        streamPreviewReady = true
        streamStartedAt = streamStartedAt ?? Date()
        streamStatus = "WebRTC direct phone live"
        if firstFrame {
            append(tag: "LIVE", text: "first WebRTC frame received on phone")
        }
        lastDirectStreamFrameStatusRefresh = now
    }

    private func startStream(streamUrl: String, streamId: String, protocol selectedProtocol: ExampleStreamProtocol) async throws {
        let status = try await mentraBluetoothSdk.startStream(
            StreamRequest(
                streamUrl: streamUrl,
                streamId: streamId,
                video: StreamVideoConfig(fps: streamFps)
            )
        )
        append(tag: "LIVE", text: "stream \(summarize(status.values))")
        activeStreamId = streamId
        streamRequested = true
        streamPreviewReady = false
        streamStatus = "Starting \(selectedProtocol.rawValue.uppercased()) stream; waiting for preview"
        startPreviewReadinessPoll(streamUrl: streamUrl, protocol: selectedProtocol, streamId: streamId)
    }

    private func startPreviewReadinessPoll(streamUrl: String, protocol selectedProtocol: ExampleStreamProtocol, streamId: String) {
        Task {
            for _ in 0 ..< 30 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard activeStreamId == streamId else { return }
                if await streamPreviewIsReady(streamUrl: streamUrl, protocol: selectedProtocol) {
                    streamPreviewReady = true
                    streamStatus = "\(selectedProtocol.rawValue.uppercased()) preview ready"
                    append(tag: "LIVE", text: "\(selectedProtocol.rawValue.uppercased()) preview ready")
                    startPreviewHealthPoll(streamUrl: streamUrl, protocol: selectedProtocol, streamId: streamId)
                    return
                }
            }
            guard activeStreamId == streamId else { return }
            streamStatus = "Stream requested; preview is still starting"
            append(tag: "TX", text: "\(selectedProtocol.rawValue.uppercased()) preview did not become ready")
        }
    }

    private func startPreviewHealthPoll(streamUrl: String, protocol selectedProtocol: ExampleStreamProtocol, streamId: String) {
        stopPreviewHealthPoll()
        previewHealthTask = Task {
            var lastReady = true
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard activeStreamId == streamId else { return }
                let ready = await streamPreviewIsReady(streamUrl: streamUrl, protocol: selectedProtocol)
                guard activeStreamId == streamId else { return }
                if ready, !lastReady {
                    streamPreviewReady = true
                    streamStatus = "\(selectedProtocol.rawValue.uppercased()) preview ready"
                    append(tag: "LIVE", text: "\(selectedProtocol.rawValue.uppercased()) preview ready")
                } else if !ready, lastReady {
                    streamPreviewReady = false
                    streamStatus = "\(selectedProtocol.rawValue.uppercased()) media path lost; preview may be frozen"
                    append(tag: "TX", text: "\(selectedProtocol.rawValue.uppercased()) media path lost")
                }
                lastReady = ready
            }
        }
    }

    private func stopPreviewHealthPoll() {
        previewHealthTask?.cancel()
        previewHealthTask = nil
    }

    @discardableResult
    private func stopStreamForConfigurationChange(status: String) -> Bool {
        let streamActive = streamRequested || streamStartedAt != nil || directStreamReceiverRunning
        guard streamActive else { return false }

        stopPreviewHealthPoll()
        directStreamStartTask?.cancel()
        directStreamStartTask = nil
        directStreamStopTask?.cancel()
        directStreamStopTask = nil
        if glassesConnected {
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let status = try await self.mentraBluetoothSdk.stopStream()
                    self.append(tag: "LIVE", text: "stream \(summarize(status.values))")
                } catch {
                    self.append(tag: "TX", text: "stopStream before configuration change failed: \(error.localizedDescription)")
                }
            }
            append(tag: "TX", text: "stopStream before stream configuration change")
        }
        activeStreamId = nil
        if directStreamReceiverRunning {
            stopDirectPhoneStreamReceiver(status: status)
        } else {
            directStreamFirstFrameSeen = false
            streamPreviewReady = false
            streamStatus = status
        }
        streamRequested = false
        streamPreviewReady = false
        streamResolvedConfig = nil
        streamStartedAt = nil
        return true
    }

    func selectStreamProtocol(_ nextProtocol: ExampleStreamProtocol) {
        guard streamProtocol != nextProtocol else { return }
        let currentUrl = streamUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let shouldUseDefault = currentUrl.isEmpty || ExampleStreamProtocol.defaultUrls.contains(currentUrl)
        let stoppedStream = stopStreamForConfigurationChange(status: "Stopped before changing stream protocol")
        streamProtocol = nextProtocol
        streamResolvedConfig = nil
        if shouldUseDefault {
            streamUrl = nextProtocol.defaultUrl
        }
        if stoppedStream {
            streamStatus = "Ready to start stream"
        }
    }

    func setStreamCloudServerEnabled(_ enabled: Bool) {
        guard streamCloudServerEnabled != enabled else { return }
        stopStreamForConfigurationChange(status: "Stopped before changing stream destination")
        streamResolvedConfig = nil
        if enabled {
            let currentUrl = streamUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            let shouldUseDefault = currentUrl.isEmpty || ExampleStreamProtocol.defaultUrls.contains(currentUrl)
            streamCloudServerEnabled = true
            if shouldUseDefault {
                streamUrl = streamProtocol.defaultUrl
            }
            streamStatus = "Ready to start stream"
            streamPreviewReady = false
            streamResolvedConfig = nil
            return
        }

        streamCloudServerEnabled = false
        streamStatus = "Ready to stream WebRTC to this phone"
        streamPreviewReady = false
        streamResolvedConfig = nil
    }

    func setStreamUrl(_ nextUrl: String) {
        guard streamUrl != nextUrl else { return }
        let stoppedStream = stopStreamForConfigurationChange(status: "Stopped before changing stream URL")
        streamUrl = nextUrl
        streamResolvedConfig = nil
        if stoppedStream {
            streamStatus = "Ready to start stream"
        }
    }

    func setStreamFps(_ fps: Int) {
        guard !streamRequested, streamStartedAt == nil else { return }
        streamFps = min(24, max(1, fps))
    }

    func requestWifiScan() {
        runAsyncAction("Scan Wi-Fi") { [self] in
            try requireConnected("scan Wi-Fi")
            let networks = try await mentraBluetoothSdk.requestWifiScan()
            append(tag: "LIVE", text: "Wi-Fi scan returned \(networks.count) network\(networks.count == 1 ? "" : "s")")
        }
    }

    func sendWifiCredentials(ssid: String, password: String, requiresPassword: Bool) {
        runAsyncAction("Connect Wi-Fi \(ssid)") { [self] in
            try requireConnected("send Wi-Fi credentials")
            if requiresPassword, password.isEmpty {
                throw ExampleActionError(message: "Enter the Wi-Fi password before connecting to \(ssid).")
            }
            let status = try await mentraBluetoothSdk.sendWifiCredentials(ssid: ssid, password: requiresPassword ? password : "")
            append(tag: "LIVE", text: "Wi-Fi \(summarize(status.values))")
        }
    }

    func forgetCurrentWifiNetwork() {
        runAsyncAction("Forget current Wi-Fi") { [self] in
            try requireConnected("forget Wi-Fi network")
            guard let wifi = connectedWifiStatus(glassesValues) else {
                throw ExampleActionError(message: "No connected Wi-Fi network to forget.")
            }
            let status = try await mentraBluetoothSdk.forgetWifiNetwork(ssid: wifi.ssid)
            append(tag: "LIVE", text: "Wi-Fi \(summarize(status.values))")
        }
    }

    func toggleHotspot() {
        runAsyncAction(hotspotEnabled ? "Disable hotspot" : "Enable hotspot") { [self] in
            try requireConnected("toggle hotspot")
            let current = enabledHotspotStatus(glassesValues) != nil || (glassesValues == nil && hotspotEnabled)
            let next = !current
            let status = try await mentraBluetoothSdk.setHotspotState(enabled: next)
            append(tag: "LIVE", text: "hotspot \(summarize(status.values))")
        }
    }

    func openGalleryServer() {
        runAction("Open gallery server") {
            let baseUrl = try requireGalleryServerUrl()
            galleryServerReachable = nil
            galleryServerStatus = "Gallery server: checking \(baseUrl)"
            Task { [weak self] in
                guard let self else { return }
                let result = await self.checkGalleryServerReachability(baseUrl)
                self.galleryServerReachable = result.reachable
                self.galleryServerStatus = result.status
                self.append(tag: result.eventTag, text: result.eventText)
                if result.reachable, let url = URL(string: baseUrl) {
                    await UIApplication.shared.open(url)
                }
            }
        }
    }

    func copyGalleryServerUrl() {
        runAction("Copy gallery URL") {
            let baseUrl = try requireGalleryServerUrl()
            UIPasteboard.general.string = baseUrl
            galleryServerStatus = "Gallery server: copied \(baseUrl)"
        }
    }

    func copyGalleryHotspotPassword() {
        runAction("Copy hotspot password") {
            let password = galleryHotspotPasswordLabel(glassesValues)
            UIPasteboard.general.string = password
            galleryServerStatus = "Hotspot password copied: \(password)"
        }
    }

    func openWifiSettings() {
        runAction("Show hotspot join help") {
            let ssid = galleryHotspotSsidLabel(glassesValues)
            let password = galleryHotspotPasswordLabel(glassesValues)
            UIPasteboard.general.string = password
            let message = "Password copied. Open iOS Settings > Wi-Fi, join \(ssid) with password \(password), then return and tap Open."
            galleryServerStatus = message
            append(tag: "LIVE", text: message)
        }
    }

    func toggleMic() {
        runAction(micRecording ? "Stop microphone" : "Start microphone") {
            if micRecording {
                stopMicRecording()
            } else {
                try startMicRecording()
            }
        }
    }

    func playMicRecording() {
        runAction(micPlaying ? "Stop mic playback" : "Play mic recording") {
            if micPlaying {
                stopMicPlayback()
                return
            }
            try startMicPlayback()
        }
    }

    func openBluetoothSettings() {
        append(tag: "LIVE", text: "Open iOS Settings > Bluetooth and select the glasses as the audio output.")
        micPlaybackHint = "Select the glasses in iOS Bluetooth settings, then return here and press Play."
        guard let bluetoothSettingsUrl = URL(string: "App-Prefs:root=Bluetooth") else { return }
        UIApplication.shared.open(bluetoothSettingsUrl) { success in
            if !success, let appSettingsUrl = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(appSettingsUrl)
            }
        }
    }

    func selectLedMode(_ mode: String) {
        runAsyncAction("RGB LED \(mode)") { [self] in
            try requireConnected("control the RGB LED")
            ledMode = mode
            try await sendRgbLedRequest(mode: mode, color: ledColor)
        }
    }

    func selectLedColor(_ color: String) {
        runAsyncAction("RGB LED color \(color.uppercased())") { [self] in
            try requireConnected("control the RGB LED")
            guard validLedColors.contains(color) else {
                throw ExampleActionError(message: "Unsupported RGB LED color: \(color)")
            }
            ledColor = color
            if ledMode != "Off" {
                try await sendRgbLedRequest(mode: ledMode, color: color)
            }
        }
    }

    private func sendRgbLedRequest(mode: String, color: String) async throws {
        let request = rgbLedRequest(for: mode, color: color)
        let response = try await mentraBluetoothSdk.rgbLedControl(
            RgbLedRequest(
                requestId: "rgb-\(Int(Date().timeIntervalSince1970 * 1000))",
                packageName: "com.mentra.examples.ios",
                action: request.action,
                color: request.color,
                onDurationMs: request.onDurationMs,
                offDurationMs: request.offDurationMs,
                count: request.count
            )
        )
        append(tag: "LIVE", text: "RGB LED ack \(response.requestId)")
    }

    private func rgbLedRequest(for mode: String, color: String) -> (action: RgbLedAction, color: RgbLedColor?, onDurationMs: Int, offDurationMs: Int, count: Int) {
        let ledColor = RgbLedColor(rawValue: color) ?? .red
        switch mode {
        case "Solid":
            return (.on, ledColor, 30000, 0, 1)
        case "Pulse":
            return (.on, ledColor, 900, 900, 6)
        case "Blink":
            return (.on, ledColor, 250, 250, 12)
        default:
            return (.off, nil, 0, 0, 0)
        }
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateGlasses glasses: GlassesRuntimeState) {
        glassesValues = glasses
        hotspotEnabled = enabledHotspotStatus(glasses) != nil
        if !glasses.connected {
            applyDisconnectedState(status: "Disconnected")
        }
        refreshGalleryServerStatusForCurrentHotspot(defaultStatus: hotspotEnabled ? galleryServerStatus : "Gallery server: hotspot off")
        append(tag: "STORE", text: summarize(glasses))
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateSdkState sdkState: PhoneSdkRuntimeState) {
        applySdkState(sdkState)
        append(tag: "BLE", text: summarize(sdkState))
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateScan scan: BluetoothScanState) {
        discoveredDevices = scan.devices
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didDiscover device: Device) {
        append(tag: "BLE", text: "discovered \(device.name)")
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didChangeDefaultDevice device: Device?) {
        savePersistedDefaultDevice(device)
        bluetoothValues = mentraBluetoothSdk.sdkState
        if let device {
            append(tag: "BLE", text: "saved default \(device.name)")
        }
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceive event: BluetoothEvent) {
        switch event {
        case let .buttonPress(button):
            append(tag: "LIVE", text: "button \(button.buttonId): \(button.pressType)")
        case let .touch(touch):
            append(tag: "LIVE", text: "\(touch.isSwipe ? "swipe" : "touch") \(touch.gestureName ?? summarize(touch.values))")
        case let .voiceActivityDetectionStatus(status):
            voiceActivityDetectionEnabled = status.voiceActivityDetectionEnabled
            append(tag: "LIVE", text: "voice activity detection \(status.voiceActivityDetectionEnabled ? "enabled" : "disabled")")
        case let .speakingStatus(status):
            speaking = status.speaking
        case let .wifiStatus(status):
            applyWifiStatus(status)
        case let .hotspotStatus(status):
            handleRawEvent(name: "hotspot_status_change", values: status.values)
        case let .hotspotError(error):
            handleRawEvent(name: "hotspot_error", values: error.values)
        case .photoResponse:
            break
        case let .streamStatus(status):
            handleStreamStatus(status.status)
        case .otaUpdateAvailable, .otaStartAck, .settingsAck, .rgbLedControlResponse:
            break
        case let .otaStatus(event):
            applyOtaStatus(event)
        case let .raw(name, values):
            handleRawEvent(name: name, values: values)
        default:
            append(tag: "LIVE", text: event.description)
        }
    }

    private func handleOtaQueryResult(_ result: OtaQueryResult) {
        if result.type == "ota_update_available" {
            let event = OtaUpdateAvailableEvent(values: result.values)
            otaStatus = nil
            otaStatusMessage = nil
            otaUpdateAvailable = event
            append(tag: "LIVE", text: "OTA available \(event.versionName ?? "unknown") (\(event.updates.joined(separator: ", ")))")
            return
        }

        let event = OtaStatusEvent(values: result.values)
        applyOtaStatus(event)
    }

    private func applyOtaStatus(_ event: OtaStatusEvent) {
        guard isDisplayableOtaStatus(event) else {
            otaStatus = nil
            otaStatusMessage = "No active OTA"
            otaUpdateAvailable = nil
            append(tag: "LIVE", text: "OTA idle")
            return
        }

        otaStatus = event
        otaStatusMessage = nil
        if event.status == "complete" || event.status == "failed" {
            otaUpdateAvailable = nil
        }
        append(tag: "LIVE", text: "OTA \(event.status.isEmpty ? "status" : event.status) \(event.overallPercent)%")
    }

    private func applyWifiStatus(_ event: WifiStatusEvent) {
        glassesValues = glassesValues?.withWifi(event.status) ?? mentraBluetoothSdk.glasses
        let label: String
        switch event.status {
        case let .connected(ssid, _):
            label = ssid
        case .disconnected:
            label = "disconnected"
        }
        append(tag: "STORE", text: "Wi-Fi \(label)")
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicPcm event: MicPcmEvent) {
        guard micRecording else { return }
        let frame = event.pcm
        micPcmData.append(frame)
        pcmFrames += 1
        pcmBytes += frame.count
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicLc3 event: MicLc3Event) {
        guard micRecording else { return }
        append(
            tag: "LIVE",
            text: "received LC3 mic frame while PCM recording is enabled (\(event.lc3.count) bytes, \(event.frameDurationMs)ms)"
        )
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didLog message: String) {
        append(tag: "LIVE", text: message)
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didFail error: BluetoothError) {
        append(tag: "TX", text: error.description)
    }

    private func runAction(_ label: String, _ action: () throws -> Void) {
        activeAction = label
        lastAction = "Running: \(label)"
        append(tag: "TX", text: label)
        do {
            try action()
            lastAction = "Requested: \(label)"
        } catch {
            lastAction = "Failed: \(label) - \(error.localizedDescription)"
            append(tag: "TX", text: "\(label) failed: \(error.localizedDescription)")
        }
        activeAction = nil
    }

    private func runAsyncAction(_ label: String, _ action: @escaping () async throws -> Void) {
        activeAction = label
        lastAction = "Running: \(label)"
        append(tag: "TX", text: label)
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await action()
                lastAction = "Requested: \(label)"
            } catch {
                lastAction = "Failed: \(label) - \(error.localizedDescription)"
                append(tag: "TX", text: "\(label) failed: \(error.localizedDescription)")
            }
            if activeAction == label {
                activeAction = nil
            }
        }
    }

    private func scheduleAutoConnectDefaultOnStartup() {
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            self?.autoConnectDefaultOnStartup()
        }
    }

    private func autoConnectDefaultOnStartup() {
        guard !glassesConnected, hasSavedConnectionTarget(bluetoothValues) else { return }
        runAction("Auto-connect default") {
            try mentraBluetoothSdk.connectDefault()
        }
    }

    private func requireConnected(_ feature: String) throws {
        guard glassesConnected else {
            let message = "Connect glasses first to \(feature)."
            if feature.contains("photo") || feature.contains("capture") {
                cameraStatus = message
            }
            if feature.contains("stream") {
                streamStatus = message
            }
            append(tag: "TX", text: message)
            throw ExampleActionError(message: message)
        }
    }

    private func requireGlassesWifi(_ feature: String) throws {
        guard glassesWifiConnected else {
            let message = "Connect the glasses to Wi-Fi from the System tab before you \(feature)."
            if feature.contains("photo") || feature.contains("capture") {
                cameraStatus = "Camera: \(message)"
            }
            if feature.contains("stream") {
                streamStatus = message
            }
            append(tag: "TX", text: message)
            throw ExampleActionError(message: message)
        }
    }

    private func requireGalleryServerUrl() throws -> String {
        guard let baseUrl = galleryServerUrl(glassesValues, fallbackEnabled: hotspotEnabled) else {
            throw ExampleActionError(message: "Enable the glasses hotspot first.")
        }
        return baseUrl
    }

    private func refreshGalleryServerStatusForCurrentHotspot(defaultStatus: String) {
        galleryServerReachable = nil
        if let baseUrl = galleryServerUrl(glassesValues, fallbackEnabled: hotspotEnabled) {
            galleryServerStatus = "Gallery server: \(baseUrl)"
        } else {
            galleryServerStatus = defaultStatus
        }
    }

    private func checkGalleryServerReachability(_ baseUrl: String) async -> GalleryServerCheck {
        guard let statusUrl = URL(string: "\(baseUrl)/api/status?poll=\(Int(Date().timeIntervalSince1970 * 1000))") else {
            return GalleryServerCheck(
                reachable: false,
                status: "Gallery server: invalid URL",
                eventTag: "TX",
                eventText: "gallery server invalid URL \(baseUrl)"
            )
        }

        do {
            var request = URLRequest(url: statusUrl, timeoutInterval: 1.5)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
            request.setValue("no-cache", forHTTPHeaderField: "Pragma")
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200 ... 299).contains(code) {
                let totalPhotos = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])
                    .flatMap { intValue($0, "total_photos") }
                return GalleryServerCheck(
                    reachable: true,
                    status: totalPhotos.map { "Gallery server: reachable · \($0) items" } ?? "Gallery server: reachable",
                    eventTag: "LIVE",
                    eventText: "gallery server reachable \(baseUrl)"
                )
            }
            return GalleryServerCheck(
                reachable: false,
                status: "Gallery server: HTTP \(code)",
                eventTag: "TX",
                eventText: "gallery server HTTP \(code)"
            )
        } catch {
            return GalleryServerCheck(
                reachable: false,
                status: "Gallery server: not reachable. Join \(galleryHotspotSsidLabel(glassesValues)) and retry.",
                eventTag: "TX",
                eventText: "gallery server unreachable: \(error.localizedDescription)"
            )
        }
    }

    private func requireDisplaySupport(_ feature: String) throws {
        try requireConnected(feature)
        guard supportsDisplay(glassesValues) else {
            throw ExampleActionError(message: "This glasses model has no display, so \(feature) is unavailable.")
        }
    }

    private func applySdkState(_ status: PhoneSdkRuntimeState) {
        bluetoothValues = status
        galleryModeEnabled = status.galleryMode.enabled
    }

    private func loadPersistedDefaultDevice() -> Device? {
        guard let model = defaultDeviceDefaults.string(forKey: DefaultDeviceStorage.model), !model.isEmpty else {
            return nil
        }
        guard let name = defaultDeviceDefaults.string(forKey: DefaultDeviceStorage.name), !name.isEmpty else {
            return nil
        }
        let identifier = defaultDeviceDefaults.string(forKey: DefaultDeviceStorage.identifier).flatMap {
            $0.isEmpty ? nil : $0
        }
        return Device(
            model: DeviceModel.fromDeviceType(model),
            name: name,
            identifier: identifier
        )
    }

    private func savePersistedDefaultDevice(_ device: Device?) {
        guard let device, !device.name.isEmpty else {
            defaultDeviceDefaults.removeObject(forKey: DefaultDeviceStorage.version)
            defaultDeviceDefaults.removeObject(forKey: DefaultDeviceStorage.model)
            defaultDeviceDefaults.removeObject(forKey: DefaultDeviceStorage.name)
            defaultDeviceDefaults.removeObject(forKey: DefaultDeviceStorage.identifier)
            defaultDeviceDefaults.removeObject(forKey: DefaultDeviceStorage.savedAt)
            return
        }

        defaultDeviceDefaults.set(1, forKey: DefaultDeviceStorage.version)
        defaultDeviceDefaults.set(device.model.deviceType, forKey: DefaultDeviceStorage.model)
        defaultDeviceDefaults.set(device.name, forKey: DefaultDeviceStorage.name)
        defaultDeviceDefaults.set(device.identifier ?? "", forKey: DefaultDeviceStorage.identifier)
        defaultDeviceDefaults.set(Date().timeIntervalSince1970, forKey: DefaultDeviceStorage.savedAt)
    }

    private func applyDisconnectedState(status: String) {
        glassesValues = .disconnected(connection: .disconnected)
        stopPreviewHealthPoll()
        activeStreamId = nil
        streamRequested = false
        streamPreviewReady = false
        streamResolvedConfig = nil
        streamStartedAt = nil
        streamStatus = status
        micRecording = false
        stopMicElapsedTimer()
        stopMicPlayback()
        hotspotEnabled = false
        galleryServerReachable = nil
        galleryServerStatus = "Gallery server: connect glasses first"
        otaStatus = nil
        otaStatusMessage = nil
        otaUpdateAvailable = nil
        if activePhotoRequestId != nil {
            activePhotoRequestId = nil
            pollGeneration += 1
            cameraStatus = "Disconnected before photo upload completed"
        }
    }

    private func startMicRecording() throws {
        try requireConnected("stream microphone audio")
        stopMicPlayback()
        micPcmData.removeAll(keepingCapacity: true)
        micRecordingUrl = nil
        micPlaybackHint = nil
        lastMicDurationSeconds = nil
        lastMicBytes = 0
        pcmFrames = 0
        pcmBytes = 0
        micElapsedSeconds = 0
        micStartedAt = Date()
        mentraBluetoothSdk.setMicState(enabled: true, useGlassesMic: true)
        micRecording = true
        startMicElapsedTimer()
    }

    private func stopMicRecording() {
        if glassesConnected {
            mentraBluetoothSdk.setMicState(enabled: false)
        }
        micRecording = false
        stopMicElapsedTimer()
        let capturedPcm = micPcmData
        let capturedBytes = capturedPcm.count

        guard !capturedPcm.isEmpty else {
            micRecordingUrl = nil
            lastMicDurationSeconds = nil
            lastMicBytes = 0
            micPlaybackHint = "No speech audio captured. Keep the glasses connected, speak while recording, and try again."
            append(tag: "LIVE", text: "microphone stopped with no PCM data")
            return
        }

        do {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("mentra-mic-last.wav")
            try wavData(from: capturedPcm).write(to: url, options: [.atomic])
            micRecordingUrl = url
            lastMicDurationSeconds = max(micElapsedSeconds, Int((Double(capturedBytes) / Double(micSampleRate * micChannelCount * micBitsPerSample / 8)).rounded(.up)))
            lastMicBytes = capturedBytes
            micPlaybackHint = nil
            append(tag: "LIVE", text: "saved microphone WAV \(capturedBytes) bytes")
        } catch {
            micRecordingUrl = nil
            lastMicDurationSeconds = nil
            lastMicBytes = 0
            micPlaybackHint = "Failed to save microphone WAV: \(error.localizedDescription)"
            append(tag: "TX", text: "failed to save microphone WAV: \(error.localizedDescription)")
        }
    }

    private func startMicPlayback(restart: Bool = false) throws {
        guard let url = micRecordingUrl, lastMicBytes > 0 else {
            throw ExampleActionError(message: "Record microphone audio before playback.")
        }
        stopMicPlayback()

        do {
            let routeName = try requireGlassesAudioRoute()
            let player = try AVAudioPlayer(contentsOf: url)
            player.delegate = self
            player.prepareToPlay()
            if restart {
                player.currentTime = 0
            }
            micPlayer = player
            micPlaying = true
            micPlaybackHint = nil
            mentraBluetoothSdk.setOwnAppAudioPlaying(true)
            if !player.play() {
                stopMicPlayback()
                throw ExampleActionError(message: "Could not start mic playback.")
            }
            append(tag: "LIVE", text: "playing through \(routeName)")
        } catch {
            stopMicPlayback()
            micPlaybackHint = error.localizedDescription
            throw error
        }
    }

    private func stopMicPlayback() {
        let wasPlaying = micPlaying
        micPlayer?.stop()
        micPlayer = nil
        if micPlaying {
            mentraBluetoothSdk.setOwnAppAudioPlaying(false)
        }
        micPlaying = false
        if wasPlaying {
            micPlaybackHint = nil
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private func requireGlassesAudioRoute() throws -> String {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [.duckOthers])
        try session.setActive(true)

        if let bluetoothOutput = session.currentRoute.outputs.first(where: isBluetoothAudioOutput) {
            return bluetoothOutput.portName
        }

        throw ExampleActionError(
            message: "Pair/select the glasses in iOS Settings > Bluetooth before playback. iOS apps cannot trigger classic Bluetooth audio pairing."
        )
    }

    nonisolated func audioPlayerDidFinishPlaying(_: AVAudioPlayer, successfully _: Bool) {
        Task { @MainActor [weak self] in
            self?.stopMicPlayback()
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_: AVAudioPlayer, error: Error?) {
        let message = error?.localizedDescription ?? "decode error"
        Task { @MainActor [weak self] in
            self?.append(tag: "TX", text: "mic playback failed: \(message)")
            self?.stopMicPlayback()
        }
    }

    private func isBluetoothAudioOutput(_ output: AVAudioSessionPortDescription) -> Bool {
        output.portType == .bluetoothA2DP ||
            output.portType == .bluetoothHFP ||
            output.portType == .bluetoothLE
    }

    private func startMicElapsedTimer() {
        stopMicElapsedTimer()
        micElapsedTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard let self, let micStartedAt = self.micStartedAt else { return }
                self.micElapsedSeconds = max(0, Int(Date().timeIntervalSince(micStartedAt)))
            }
        }
    }

    private func stopMicElapsedTimer() {
        micElapsedTask?.cancel()
        micElapsedTask = nil
        micStartedAt = nil
    }

    private func wavData(from pcmData: Data) -> Data {
        var data = Data()
        appendAscii("RIFF", to: &data)
        appendUInt32(UInt32(36 + pcmData.count), to: &data)
        appendAscii("WAVE", to: &data)
        appendAscii("fmt ", to: &data)
        appendUInt32(16, to: &data)
        appendUInt16(1, to: &data)
        appendUInt16(UInt16(micChannelCount), to: &data)
        appendUInt32(UInt32(micSampleRate), to: &data)
        appendUInt32(UInt32(micSampleRate * micChannelCount * micBitsPerSample / 8), to: &data)
        appendUInt16(UInt16(micChannelCount * micBitsPerSample / 8), to: &data)
        appendUInt16(UInt16(micBitsPerSample), to: &data)
        appendAscii("data", to: &data)
        appendUInt32(UInt32(pcmData.count), to: &data)
        data.append(pcmData)
        return data
    }

    private func appendAscii(_ text: String, to data: inout Data) {
        data.append(text.data(using: .ascii) ?? Data())
    }

    private func appendUInt16(_ value: UInt16, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }

    private func appendUInt32(_ value: UInt32, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }

    private func append(tag: String, text: String) {
        events = [ExampleEvent.make(tag: tag, text: text)] + events
        events = Array(events.prefix(30))
    }

    private func handleRawEvent(name: String, values: [String: Any]) {
        switch name {
        case "button_press":
            append(tag: "LIVE", text: "button \(stringValue(values, "buttonId") ?? ""): \(stringValue(values, "pressType") ?? "")")
        case "touch_event":
            append(tag: "LIVE", text: "touch \(summarize(values))")
        case "battery_status":
            glassesValues = glassesValues?.withBattery(
                level: intValue(values, "level") ?? -1,
                charging: boolValue(values, "charging") ?? false
            )
            append(tag: "STORE", text: "battery \(intValue(values, "level") ?? -1)%")
        case "hotspot_status_change":
            let hotspot = HotspotStatus(values: values) ?? .disabled
            let enabled = enabledHotspotStatus(hotspot) != nil
            hotspotEnabled = enabled
            glassesValues = glassesValues?.withHotspot(hotspot)
            refreshGalleryServerStatusForCurrentHotspot(defaultStatus: "Gallery server: hotspot off")
            append(tag: "STORE", text: "hotspot \(summarize(values))")
        case "hotspot_error":
            hotspotEnabled = false
            galleryServerReachable = false
            galleryServerStatus = "Gallery server: hotspot error"
            glassesValues = glassesValues?.withHotspot(.disabled)
            append(tag: "TX", text: "hotspot error \(summarize(values))")
        case "photo_response":
            break
        case "stream_status":
            handleStreamStatus(StreamStatus(values: values))
        default:
            append(tag: "LIVE", text: "\(name) \(summarize(values))")
        }
    }

    private func applyStreamStatus(_ status: StreamStatus) {
        switch status.state {
        case .streaming, .initializing, .reconnecting, .reconnected:
            streamRequested = true
            if streamStartedAt == nil {
                streamStartedAt = Date()
            }
            if let streamId = status.streamId {
                activeStreamId = streamId
            }
        case .stopped, .stopping, .error, .reconnectFailed:
            streamRequested = false
            streamPreviewReady = false
            streamResolvedConfig = nil
            streamStartedAt = nil
            activeStreamId = nil
            stopPreviewHealthPoll()
            if directStreamReceiverRunning {
                stopDirectPhoneStreamReceiver(status: "WebRTC direct phone stopped")
            }
        }
    }

    private func handleStreamStatus(_ status: StreamStatus) {
        applyStreamStatus(status)
        if let resolvedConfig = status.resolvedConfig {
            streamResolvedConfig = resolvedConfig
        }
        let summary = summarize(status.values)
        if isDirectPhoneWebRtcSelected {
            if status.state == .stopped || status.state == .stopping || status.state == .reconnectFailed {
                streamStatus = "WebRTC direct phone stopped"
            } else if status.state == .error {
                streamStatus = "WebRTC direct phone error: \(summary)"
            } else if streamPreviewReady {
                streamStatus = "WebRTC direct phone live"
            } else {
                streamStatus = "WebRTC stream requested; waiting for phone preview"
            }
        } else {
            streamStatus = summary
        }
        append(tag: "LIVE", text: "stream \(summary)")
    }

    private func handlePhotoResponse(_ response: PhotoResponse) {
        let requestId = response.requestId
        if let activePhotoRequestId, requestId != activePhotoRequestId {
            append(tag: "LIVE", text: "ignoring stale photo \(requestId)")
            return
        }
        let uploadTarget = photoDestination == .thisPhone ? "phone receiver" : "cloud webhook"
        let source = photoDestination == .thisPhone ? "Phone receiver" : "Cloud server"
        switch response {
        case let .success(requestId, uploadUrl, _, _, _, _, timestamp):
            photoPreviewDetails = (photoPreviewDetails ?? .waiting(source: source)).acknowledged(
                requestId: requestId,
                source: source,
                timestamp: timestamp,
                uploadUrl: uploadUrl
            )
            cameraStatus = "Camera: photo delivered to \(uploadTarget)"
        case let .error(requestId, errorCode, errorMessage, timestamp):
            photoPreviewDetails = .failed(
                requestId: requestId,
                source: source,
                error: errorCode ?? errorMessage,
                timestamp: timestamp
            )
            cameraStatus = "Camera: photo failed (\(errorCode ?? errorMessage))"
        }
        append(tag: "LIVE", text: "photo response \(requestId)")
    }

    private func pollPhotoPreview(requestId: String, statusUrl: URL, generation: Int) {
        Task {
            for attempt in 0 ..< 45 {
                guard activePhotoRequestId == requestId, pollGeneration == generation else { return }
                do {
                    let cacheBusted = URL(string: "\(statusUrl.absoluteString)?poll=\(Int(Date().timeIntervalSince1970 * 1000))")!
                    let (data, response) = try await URLSession.shared.data(from: cacheBusted)
                    if let http = response as? HTTPURLResponse, http.statusCode == 200,
                       let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let photoUrl = stringValue(json, "photoUrl"),
                       let url = URL(string: photoUrl)
                    {
                        photoPreviewUrl = url
                        photoPreviewImage = nil
                        photoPreviewDetails = (photoPreviewDetails ?? .waiting(source: "Cloud server")).uploaded(
                            byteCount: intValue(json, "bytes"),
                            contentType: stringValue(json, "contentType"),
                            previewUrl: photoUrl,
                            requestId: stringValue(json, "requestId") ?? requestId,
                            source: "Cloud server",
                            uploadedAt: stringValue(json, "uploadedAt")
                        )
                        cameraStatus = "Camera: loaded photo preview"
                        activePhotoRequestId = nil
                        append(tag: "LIVE", text: "local photo ready \(photoUrl)")
                        return
                    }
                    if attempt == 0 || attempt % 10 == 9 {
                        append(tag: "LIVE", text: "waiting for upload \(requestId)")
                    }
                } catch {
                    if attempt == 0 || attempt % 10 == 9 {
                        append(tag: "LIVE", text: "waiting for local photo server")
                    }
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            if activePhotoRequestId == requestId {
                cameraStatus = "Camera: timed out waiting for local server upload"
            }
        }
    }

    private var isDirectPhoneWebRtcSelected: Bool {
        !streamCloudServerEnabled
    }
}

extension ExampleEvent {
    static func make(tag: String, text: String) -> ExampleEvent {
        ExampleEvent(
            time: DateFormatter.exampleEventTime.string(from: Date()),
            tag: tag,
            text: text
        )
    }
}

extension DateFormatter {
    static let exampleEventTime: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
}

extension Array {
    func ifEmpty(_ fallback: [Element]) -> [Element] {
        isEmpty ? fallback : self
    }
}

func stringValue(_ values: [String: Any], _ key: String) -> String? {
    guard let value = values[key] as? String else { return nil }
    return value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : value
}

func intValue(_ values: [String: Any], _ key: String) -> Int? {
    if let int = values[key] as? Int { return int }
    if let number = values[key] as? NSNumber { return number.intValue }
    return nil
}

func boolValue(_ values: [String: Any], _ key: String) -> Bool? {
    if let bool = values[key] as? Bool { return bool }
    if let number = values[key] as? NSNumber { return number.boolValue }
    return nil
}

extension String {
    var nonEmpty: String? {
        isEmpty ? nil : self
    }
}

func connectionLabel(_ status: GlassesRuntimeState?) -> String {
    status?.connection.rawValue ?? (isGlassesConnected(status) ? "CONNECTED" : "WAITING")
}

func isGlassesConnected(_ status: GlassesRuntimeState?) -> Bool {
    status?.connected == true
}

func connectedGlassesInfo(_ status: GlassesRuntimeState?) -> ConnectedGlassesInfo? {
    status?.device
}

func modelLabel(_ status: GlassesRuntimeState?) -> String {
    connectedGlassesInfo(status)?.deviceModel.map(deviceModelLabel) ?? "Mentra Live"
}

func deviceLabel(_ status: GlassesRuntimeState?) -> String {
    let device = connectedGlassesInfo(status)
    if let value = device?.bluetoothName, !value.isEmpty { return value }
    if let value = device?.serialNumber, !value.isEmpty { return value }
    if let value = device?.deviceModel { return deviceModelLabel(value) }
    return "Mentra Live"
}

func supportsDisplay(_ status: GlassesRuntimeState?) -> Bool {
    let device = connectedGlassesInfo(status)
    let model = [
        device?.deviceModel?.deviceType,
        device?.bluetoothName,
    ]
    .compactMap { $0 }
    .joined(separator: " ")
    .lowercased()

    if model.contains("g1") || model.contains("g2") || model.contains("nex") || model.contains("mach")
        || model.contains("z100") || model.contains("vuzix") || model.contains("display") || model.contains("frame")
    {
        return true
    }
    if model.contains("live") || model.contains("r1") || model.contains("ring") {
        return false
    }
    return false
}

func discoveredDeviceKey(_ device: Device) -> String {
    device.id
}

func batteryLevel(_ status: GlassesRuntimeState?) -> Int? {
    guard isGlassesConnected(status), let level = status?.battery?.level, level >= 0 else { return nil }
    return min(level, 100)
}

func batteryLabel(_ status: GlassesRuntimeState?) -> String {
    guard let level = batteryLevel(status) else {
        return status?.connected == false || status?.connection == .disconnected ? "Not connected" : "Waiting for status"
    }
    return "\(level)%\(status?.battery?.charging == true ? " charging" : "")"
}

func wifiLabel(_ status: GlassesRuntimeState?) -> String {
    switch status?.wifi {
    case let .connected(ssid, _):
        return ssid
    case .disconnected:
        return isGlassesConnected(status) ? "Not connected" : "Unknown"
    case .none:
        return "Unknown"
    }
}

func connectedWifiStatus(_ status: GlassesRuntimeState?) -> (ssid: String, localIp: String?)? {
    guard case let .connected(ssid, localIp) = status?.wifi else {
        return nil
    }
    return (ssid, localIp)
}

func isDisplayableOtaStatus(_ status: OtaStatusEvent) -> Bool {
    status.status != "idle" || !(status.errorMessage ?? "").isEmpty
}

func enabledHotspotStatus(_ hotspot: HotspotStatus) -> (ssid: String, password: String, localIp: String)? {
    guard case let .enabled(ssid, password, localIp) = hotspot else {
        return nil
    }
    return (ssid, password, localIp)
}

func enabledHotspotStatus(_ status: GlassesRuntimeState?) -> (ssid: String, password: String, localIp: String)? {
    guard let hotspot = status?.hotspot else {
        return nil
    }
    return enabledHotspotStatus(hotspot)
}

func hotspotLabel(_ status: GlassesRuntimeState?, fallbackEnabled: Bool) -> String {
    if let hotspot = enabledHotspotStatus(status) {
        return "\(hotspot.ssid) · \(hotspot.localIp)"
    }
    return status == nil && fallbackEnabled ? "waiting for SSID" : "disabled"
}

private let mentraLiveDefaultHotspotPassword = "00001111"

func galleryServerUrl(_ status: GlassesRuntimeState?, fallbackEnabled: Bool) -> String? {
    let hotspot = enabledHotspotStatus(status)
    guard hotspot != nil || (status == nil && fallbackEnabled) else { return nil }

    let gateway = hotspot?.localIp ?? "192.168.43.1"
    return "http://\(gateway):8089"
}

func galleryHotspotSsidLabel(_ status: GlassesRuntimeState?) -> String {
    guard let ssid = enabledHotspotStatus(status)?.ssid else {
        return "the glasses hotspot"
    }
    return "Wi-Fi \(ssid)"
}

func galleryHotspotPasswordLabel(_ status: GlassesRuntimeState?) -> String {
    enabledHotspotStatus(status)?.password ?? mentraLiveDefaultHotspotPassword
}

func firmwareLabel(_ status: GlassesRuntimeState?) -> String {
    status?.firmware?.version ?? "Unknown"
}

func firmwareSubLabel(_ status: GlassesRuntimeState?) -> String {
    guard let firmware = status?.firmware else {
        return "not reported"
    }
    switch firmware.source {
    case .firmware:
        return "reported"
    case .bes:
        return "BES firmware"
    case .mtk:
        return "MTK firmware"
    case .app:
        guard let appVersion = firmware.appVersion else { return "not reported" }
        return "ASG app \(appVersion)"
    case .unknown:
        return "not reported"
    }
}

func rssiLabel(_ status: GlassesRuntimeState?) -> String {
    guard let signal = status?.signal?.strengthDbm else { return "Unknown" }
    return "\(signal) dBm"
}

func rssiUpdatedLabel(_ status: GlassesRuntimeState?) -> String {
    guard let updatedAt = status?.signal?.updatedAt, updatedAt > 0 else { return "signal" }
    let date = Date(timeIntervalSince1970: TimeInterval(updatedAt) / 1000)
    return "updated \(DateFormatter.exampleEventTime.string(from: date))"
}

func bluetoothSearchLabel(_ status: PhoneSdkRuntimeState?) -> String {
    status?.searching == true ? "Scanning" : "Idle"
}

func hasSavedConnectionTarget(_ status: PhoneSdkRuntimeState?) -> Bool {
    status?.defaultDevice != nil
}

func savedConnectionTargetName(_ status: PhoneSdkRuntimeState?) -> String {
    status?.defaultDevice?.name ?? "Saved glasses"
}

func savedConnectionTargetDetail(_ status: PhoneSdkRuntimeState?) -> String {
    let model = status?.defaultDevice?.model.deviceType ?? "Saved model"
    return "\(model) · mentraBluetoothSdk.connectDefault()"
}

func wifiScanResults(_ status: PhoneSdkRuntimeState?) -> [WifiScanResult] {
    status?.wifiScanResults ?? []
}

extension GlassesRuntimeState {
    func withBattery(level: Int, charging: Bool) -> GlassesRuntimeState {
        guard case let .connected(_, connection, device, firmware, hotspot, ready, signal, voiceActivityDetectionEnabled, wifi) = self else {
            return self
        }
        return .connected(
            battery: GlassesBatteryState(charging: charging, level: level >= 0 ? level : nil),
            connection: connection,
            device: device,
            firmware: firmware,
            hotspot: hotspot,
            ready: ready,
            signal: signal,
            voiceActivityDetectionEnabled: voiceActivityDetectionEnabled,
            wifi: wifi
        )
    }

    func withWifi(_ wifi: WifiStatus) -> GlassesRuntimeState {
        guard case let .connected(battery, connection, device, firmware, hotspot, ready, signal, voiceActivityDetectionEnabled, _) = self else {
            return self
        }
        return .connected(
            battery: battery,
            connection: connection,
            device: device,
            firmware: firmware,
            hotspot: hotspot,
            ready: ready,
            signal: signal,
            voiceActivityDetectionEnabled: voiceActivityDetectionEnabled,
            wifi: wifi
        )
    }

    func withHotspot(_ hotspot: HotspotStatus) -> GlassesRuntimeState {
        guard case let .connected(battery, connection, device, firmware, _, ready, signal, voiceActivityDetectionEnabled, wifi) = self else {
            return self
        }
        return .connected(
            battery: battery,
            connection: connection,
            device: device,
            firmware: firmware,
            hotspot: hotspot,
            ready: ready,
            signal: signal,
            voiceActivityDetectionEnabled: voiceActivityDetectionEnabled,
            wifi: wifi
        )
    }
}

func elapsedText(_ date: Date?) -> String {
    guard let date else { return "00:00:00" }
    let seconds = max(0, Int(Date().timeIntervalSince(date)))
    return durationLabel(seconds)
}

func durationLabel(_ seconds: Int) -> String {
    let seconds = max(0, seconds)
    return String(format: "%02d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
}

func summarize(_ values: [String: Any]) -> String {
    let parts = values.prefix(3).map { "\($0.key): \($0.value)" }
    return parts.isEmpty ? "empty update" : parts.joined(separator: ", ")
}

func summarize(_ status: GlassesRuntimeState) -> String {
    let parts = [
        "connection: \(status.connection.rawValue)",
        "ready: \(status.ready)",
        status.battery?.level.map { "battery: \($0)%" },
        status.wifi.map { _ in "wifi: \(wifiLabel(status))" },
        status.hotspot.map { hotspot -> String in
            switch hotspot {
            case let .enabled(ssid, _, localIp):
                return "hotspot: \(ssid) · \(localIp)"
            case .disabled:
                return "hotspot: disabled"
            }
        },
        status.signal?.strengthDbm.map { "signal: \($0) dBm" },
    ].compactMap { $0 }.prefix(3)
    return parts.joined(separator: ", ")
}

func summarize(_ status: PhoneSdkRuntimeState) -> String {
    let parts = [
        "searching: \(status.searching)",
        "wifiScanResults: \(status.wifiScanResults.count)",
        "galleryModeEnabled: \(status.galleryMode.enabled)",
        status.defaultDevice.map { "defaultDevice: \($0.name)" },
    ].compactMap { $0 }.prefix(3)
    return parts.joined(separator: ", ")
}

func photoStatusUrl(_ uploadUrlText: String, requestId: String) -> URL? {
    guard let uploadUrl = URL(string: uploadUrlText),
          uploadUrl.scheme == "http" || uploadUrl.scheme == "https",
          let host = uploadUrl.host
    else { return nil }
    var components = URLComponents()
    components.scheme = uploadUrl.scheme
    components.host = host
    components.port = uploadUrl.port
    components.path = "/uploads/\(requestId).json"
    return components.url
}

func webhookHealthUrl(_ uploadUrlText: String) -> URL? {
    guard let uploadUrl = URL(string: uploadUrlText),
          uploadUrl.scheme == "http" || uploadUrl.scheme == "https",
          let host = uploadUrl.host
    else { return nil }
    var components = URLComponents()
    components.scheme = uploadUrl.scheme
    components.host = host
    components.port = uploadUrl.port
    components.path = "/"
    return components.url
}

func photoUploadValidationMessage(_ uploadUrlText: String) -> String? {
    let value = uploadUrlText.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.isEmpty {
        return "Enter the cloud server Photo upload URL."
    }
    if value.contains("<computer-ip>") {
        return "Replace <computer-ip> with the cloud server IP."
    }
    return nil
}

func checkLocalRtmpServer(rtmpUrl: String) async throws {
    guard isValidRtmpUrl(rtmpUrl) else {
        throw ExampleActionError(message: "Enter a valid rtmp:// or rtmps:// publish URL.")
    }
    guard let previewUrl = rtmpHlsPreviewUrl(rtmpUrl) else { return }
    try await checkHttpPreviewServer(url: previewUrl, setupMessage: localRtmpSetupMessage)
}

func checkLocalSrtServer(srtUrl: String) async throws {
    guard isValidSrtUrl(srtUrl) else {
        throw ExampleActionError(message: "Enter a valid srt:// publish URL.")
    }
    guard let previewUrl = srtHlsPreviewUrl(srtUrl) else { return }
    try await checkHttpPreviewServer(url: previewUrl, setupMessage: localSrtSetupMessage)
}

func checkLocalWebrtcServer(whipUrl: String) async throws {
    guard let previewUrl = webrtcPreviewUrl(whipUrl) else {
        throw ExampleActionError(message: "Enter a valid http:// or https:// WHIP URL.")
    }
    try await checkHttpPreviewServer(url: previewUrl, setupMessage: localWebrtcSetupMessage)
}

func streamPreviewIsReady(streamUrl: String, protocol selectedProtocol: ExampleStreamProtocol) async -> Bool {
    switch selectedProtocol {
    case .rtmp:
        guard let previewUrl = rtmpHlsPreviewUrl(streamUrl) else { return false }
        return await hlsPreviewIsReady(previewUrl)
    case .srt:
        guard let previewUrl = srtHlsPreviewUrl(streamUrl) else { return false }
        return await hlsPreviewIsReady(previewUrl)
    case .webrtc:
        guard let previewUrl = webrtcHlsPreviewUrl(streamUrl) else { return false }
        return await hlsPreviewIsReady(previewUrl)
    }
}

private func hlsPreviewIsReady(_ url: URL) async -> Bool {
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 2
    do {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            return false
        }
        return String(data: data, encoding: .utf8)?.contains("#EXTM3U") == true
    } catch {
        return false
    }
}

func checkHttpPreviewServer(url: URL, setupMessage: (String) -> String) async throws {
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 3
    do {
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ExampleActionError(message: setupMessage("invalid response"))
        }
        // MediaMTX may return 404 before a stream exists; any HTTP response means it is reachable.
        _ = http.statusCode
    } catch let error as ExampleActionError {
        throw error
    } catch {
        throw ExampleActionError(message: setupMessage(error.localizedDescription))
    }
}

func rtmpHlsPreviewUrl(_ rtmpUrlText: String) -> URL? {
    guard var components = URLComponents(string: rtmpUrlText),
          components.scheme == "rtmp" || components.scheme == "rtmps",
          let host = components.host,
          isLocalPreviewHost(host)
    else { return nil }
    components.scheme = components.scheme == "rtmps" ? "https" : "http"
    components.port = 8888
    let streamPath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    components.path = streamPath.isEmpty ? "/index.m3u8" : "/\(streamPath)/index.m3u8"
    components.query = nil
    return components.url
}

func srtHlsPreviewUrl(_ srtUrlText: String) -> URL? {
    guard let components = URLComponents(string: srtUrlText),
          components.scheme == "srt",
          let host = components.host,
          isLocalPreviewHost(host),
          let streamPath = srtStreamPath(components)
    else { return nil }

    var previewComponents = URLComponents()
    previewComponents.scheme = "http"
    previewComponents.host = host
    previewComponents.port = 8888
    previewComponents.path = "/\(streamPath)/index.m3u8"
    return previewComponents.url
}

private func srtStreamPath(_ components: URLComponents) -> String? {
    guard let streamId = components.queryItems?.first(where: { $0.name.lowercased() == "streamid" })?.value else {
        return nil
    }
    let pieces = streamId.split(separator: ":", omittingEmptySubsequences: false)
    let path = ["publish", "read"].contains(pieces.first?.lowercased() ?? "") && pieces.count > 1
        ? String(pieces[1])
        : streamId
    let trimmedPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    return trimmedPath.isEmpty ? nil : trimmedPath
}

func isValidRtmpUrl(_ rtmpUrlText: String) -> Bool {
    guard let components = URLComponents(string: rtmpUrlText) else { return false }
    return (components.scheme == "rtmp" || components.scheme == "rtmps") && components.host != nil
}

func isValidSrtUrl(_ srtUrlText: String) -> Bool {
    guard let components = URLComponents(string: srtUrlText) else { return false }
    return components.scheme == "srt" && components.host != nil
}

func isLocalPreviewHost(_ host: String) -> Bool {
    let normalized = host.lowercased()
    if normalized == "localhost" || normalized.hasSuffix(".local") || normalized.hasPrefix("192.168.") || normalized.hasPrefix("10.") || normalized.hasPrefix("169.254.") {
        return true
    }
    let parts = normalized.split(separator: ".").compactMap { Int($0) }
    return parts.count == 4 && parts[0] == 172 && (16 ... 31).contains(parts[1])
}

func webrtcPreviewUrl(_ whipUrlText: String) -> URL? {
    guard var components = URLComponents(string: whipUrlText),
          components.scheme == "http" || components.scheme == "https",
          components.host != nil
    else { return nil }
    if components.path.hasSuffix("/whip") {
        components.path = String(components.path.dropLast("/whip".count))
    }
    if components.path.isEmpty {
        components.path = "/"
    }
    components.query = nil
    return components.url
}

func webrtcHlsPreviewUrl(_ whipUrlText: String) -> URL? {
    guard var components = URLComponents(string: whipUrlText),
          components.scheme == "http" || components.scheme == "https",
          let host = components.host,
          isLocalPreviewHost(host)
    else { return nil }
    var path = components.path
    if path.hasSuffix("/whip") {
        path = String(path.dropLast("/whip".count))
    } else if path.hasSuffix("/whep") {
        path = String(path.dropLast("/whep".count))
    }
    let trimmedPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    components.scheme = "http"
    components.port = 8888
    components.path = trimmedPath.isEmpty ? "/index.m3u8" : "/\(trimmedPath)/index.m3u8"
    components.query = nil
    return components.url
}

func localRtmpSetupMessage(_ detail: String) -> String {
    "Local RTMP/HLS server not reachable (\(detail)). Run python3 examples/local-demo-cloud/server.py and paste the printed RTMP publish URL."
}

func localSrtSetupMessage(_ detail: String) -> String {
    "Local SRT/HLS server not reachable (\(detail)). Run python3 examples/local-demo-cloud/server.py and paste the printed SRT publish URL."
}

func localWebrtcSetupMessage(_ detail: String) -> String {
    "Local WebRTC server not reachable (\(detail)). Run python3 examples/local-demo-cloud/server.py and paste the printed WHIP publish URL."
}

func streamUrlValidationMessage(_ streamUrl: String) -> String? {
    if streamUrl.isEmpty {
        return "Stream URL is required."
    }
    if streamUrl.contains("<computer-ip>") {
        return "Replace <computer-ip> with the matching publish URL printed by local demo cloud."
    }
    if streamUrl.contains("<") || streamUrl.contains(">") || streamUrl.contains("YOUR_") {
        return "Replace the placeholder stream URL before starting."
    }
    if let components = URLComponents(string: streamUrl),
       let scheme = components.scheme?.lowercased(),
       scheme == "rtmp" || scheme == "rtmps"
    {
        let pathSegments = components.path.split(separator: "/").filter { !$0.isEmpty }
        if pathSegments.count < 2 {
            return "RTMP URL must include an app and stream key, for example rtmp://<computer-ip>:1935/live/mentra-live."
        }
    }
    return nil
}
