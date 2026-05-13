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

private let defaultPhotoUploadUrl = "http://<computer-ip>:8787/upload"

enum PhotoDestination {
    case macBookServer
    case thisPhone
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
    @Published private(set) var glassesValues: MentraGlassesStatus?
    @Published private(set) var bluetoothValues: MentraBluetoothStatus?
    @Published private(set) var discoveredDevices: [MentraDevice] = []
    @Published private(set) var selectedDiscoveredDevice: MentraDevice?
    @Published private(set) var events: [ExampleEvent] = [ExampleEvent.make(tag: "LIVE", text: "SDK ready. Scan to discover glasses.")]
    @Published private(set) var activeAction: String?
    @Published private(set) var lastAction = "No actions yet."
    @Published private(set) var cameraStatus = "Camera: phone receiver will start before capture"
    @Published var webhookUrl = defaultPhotoUploadUrl
    @Published private(set) var photoPreviewUrl: URL?
    @Published private(set) var photoPreviewImage: UIImage?
    @Published private(set) var photoDestination: PhotoDestination = .thisPhone
    @Published private(set) var photoSize: MentraPhotoSize = .medium
    @Published private(set) var photoCompression: MentraPhotoCompression = .medium
    @Published private(set) var photoFlash = false
    @Published private(set) var phonePhotoServerRunning = false
    @Published private(set) var phonePhotoUploadUrl = "Phone receiver not started"
    @Published var streamProtocol: ExampleStreamProtocol = .webrtc
    @Published var streamUrl = ExampleStreamProtocol.webrtc.defaultUrl
    @Published private(set) var streamCloudServerEnabled = false
    @Published private(set) var directStreamReceiverRunning = false
    @Published private(set) var directStreamWhipUrl = "Phone receiver not started"
    @Published private(set) var streamRequested = false
    @Published private(set) var streamPreviewReady = false
    @Published private(set) var streamStartedAt: Date?
    @Published private(set) var streamStatus = "Ready to start stream"
    @Published private(set) var galleryModeAuto = false
    @Published private(set) var hotspotEnabled = false
    @Published private(set) var galleryServerReachable: Bool?
    @Published private(set) var galleryServerStatus = "Gallery server: enable hotspot to check"
    @Published private(set) var micRecording = false
    @Published private(set) var micPlaying = false
    @Published private(set) var micElapsedSeconds = 0
    @Published private(set) var pcmFrames = 0
    @Published private(set) var pcmBytes = 0
    @Published private(set) var lastMicDurationSeconds: Int?
    @Published private(set) var lastMicBytes = 0
    @Published private(set) var micPlaybackHint: String?
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
    private var keepAliveTask: Task<Void, Never>?
    private var previewHealthTask: Task<Void, Never>?
    private var directStreamStartTask: Task<Void, Never>?
    private var directStreamStopTask: Task<Void, Never>?
    private var directStreamFirstFrameSeen = false
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
        if let savedDevice = loadPersistedDefaultDevice() {
            mentraBluetoothSdk.setDefaultDevice(savedDevice)
        }
        glassesValues = mentraBluetoothSdk.glassesStatus
        hotspotEnabled = enabledHotspotStatus(glassesValues) != nil
        refreshGalleryServerStatusForCurrentHotspot(defaultStatus: "Gallery server: enable hotspot to check")
        applyBluetoothStatus(mentraBluetoothSdk.bluetoothStatus)
        if let value = ProcessInfo.processInfo.environment["MENTRA_PHOTO_WEBHOOK_URL"] {
            webhookUrl = value
        }
        if hasSavedConnectionTarget(bluetoothValues) {
            Task { @MainActor [weak self] in
                await Task.yield()
                self?.autoConnectDefaultOnStartup()
            }
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
        Task { @MainActor [mentraBluetoothSdk] in
            mentraBluetoothSdk.invalidate()
        }
    }

    func startScan() {
        runAction("Scan") {
            discoveredDevices.removeAll()
            selectedDiscoveredDevice = nil
            try mentraBluetoothSdk.startScan(model: .mentraLive)
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

    func selectDiscoveredDevice(_ device: MentraDevice) {
        selectedDiscoveredDevice = device
        lastAction = "Selected: \(device.name)"
    }

    func connect(_ device: MentraDevice) {
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
        stopKeepAlive()
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
            bluetoothValues = bluetoothValues?.withDefaultDevice(nil)
            selectedDiscoveredDevice = nil
        }
    }

    func displayHello() {
        runAction("Display Hello") {
            try requireDisplaySupport("display text")
            Task {
                try? await mentraBluetoothSdk.displayText(MentraDisplayTextRequest(text: "Hello from Mentra Bluetooth SDK"))
            }
        }
    }

    func clearDisplay() {
        runAction("Clear Display") {
            try requireDisplaySupport("clear the display")
            Task { try? await mentraBluetoothSdk.clearDisplay() }
        }
    }

    func setGalleryModeAuto(_ enabled: Bool) {
        runAction(enabled ? "Save in gallery mode" : "Report button events") {
            try requireConnected("change gallery mode")
            galleryModeAuto = enabled
            Task { try? await mentraBluetoothSdk.setGalleryMode(enabled ? .auto : .manual) }
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

    func setPhotoSize(_ size: MentraPhotoSize) {
        photoSize = size
    }

    func setPhotoCompression(_ compression: MentraPhotoCompression) {
        photoCompression = compression
    }

    func setPhotoFlash(_ enabled: Bool) {
        photoFlash = enabled
    }

    func captureAndUpload() {
        runAction("Capture & upload") {
            try requireConnected("capture photos")
            try requireGlassesWifi("capture photos")
            if photoDestination == .thisPhone {
                try captureAndUploadToPhone()
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
            photoPreviewUrl = nil
            photoPreviewImage = nil
            cameraStatus = "Camera: webhook upload requested (\(requestId))"
            mentraBluetoothSdk.requestPhoto(
                MentraPhotoRequest(
                    requestId: requestId,
                    appId: "com.mentra.examples.ios",
                    size: photoSize,
                    webhookUrl: uploadUrl,
                    compress: photoCompression,
                    flash: photoFlash,
                    sound: true
                )
            )
            pollPhotoPreview(requestId: requestId, statusUrl: statusUrl.deletingLastPathComponent().appendingPathComponent("\(requestId).json"), generation: generation)
        }
    }

    private func captureAndUploadToPhone() throws {
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
        photoPreviewUrl = nil
        photoPreviewImage = nil
        cameraStatus = "Camera: requested phone upload (\(requestId))"
        mentraBluetoothSdk.requestPhoto(
            MentraPhotoRequest(
                requestId: requestId,
                appId: "com.mentra.examples.ios",
                size: photoSize,
                webhookUrl: uploadUrl,
                compress: photoCompression,
                flash: photoFlash,
                sound: true
            )
        )
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
            runAction("Stop stream") {
                stopKeepAlive()
                stopPreviewHealthPoll()
                if isDirectPhoneWebRtcSelected {
                    directStreamStartTask?.cancel()
                    directStreamStartTask = nil
                    if glassesConnected {
                        mentraBluetoothSdk.stopStream()
                        streamStatus = "Stopping WebRTC direct phone stream"
                        directStreamStopTask?.cancel()
                        directStreamStopTask = Task { [weak self] in
                            try? await Task.sleep(nanoseconds: 5_000_000_000)
                            await MainActor.run {
                                guard let self,
                                      self.isDirectPhoneWebRtcSelected,
                                      self.directStreamReceiverRunning else {
                                    return
                                }
                                self.activeStreamId = nil
                                self.stopDirectPhoneStreamReceiver(status: "WebRTC direct phone stopped")
                                self.streamRequested = false
                                self.streamStartedAt = nil
                            }
                        }
                        return
                    }
                    stopDirectPhoneStreamReceiver(status: "Stopped")
                    activeStreamId = nil
                    streamRequested = false
                    streamPreviewReady = false
                    streamStartedAt = nil
                    streamStatus = "Stopped"
                    return
                }
                if glassesConnected {
                    mentraBluetoothSdk.stopStream()
                }
                activeStreamId = nil
                streamRequested = false
                streamPreviewReady = false
                streamStartedAt = nil
                streamStatus = "Stopped"
            }
            return
        }

        runAction("Start stream") {
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
                        startStream(streamUrl: url, streamId: streamId, protocol: selectedProtocol)
                    } catch {
                        let message = error.localizedDescription
                        streamStatus = message
                        append(tag: "TX", text: "stream failed: \(message)")
                    }
                }
                return
            }
            startStream(streamUrl: url, streamId: streamId, protocol: selectedProtocol)
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
                directStreamReceiverRunning = true
                directStreamWhipUrl = url
                streamPreviewReady = false
                streamRequested = true
                streamStartedAt = nil
                streamStatus = "WebRTC phone receiver ready; starting stream"
                append(tag: "STREAM", text: "phone WHIP receiver \(url) -> GStreamer \(ports.backendPort)")
                directStreamStartTask?.cancel()
                directStreamStartTask = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    await MainActor.run {
                        guard let self,
                              self.activeStreamId == streamId,
                              self.directStreamReceiverRunning,
                              self.streamRequested else {
                            return
                        }
                        self.sendDirectPhoneStartStream(streamUrl: url, streamId: streamId)
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
        streamRequested = false
        streamStatus = "WebRTC phone receiver failed: \(message)"
        throw ExampleActionError(message: "WebRTC phone receiver failed: \(message)")
    }

    private func sendDirectPhoneStartStream(streamUrl: String, streamId: String) {
        mentraBluetoothSdk.startStream(
            MentraStreamRequest(
                streamUrl: streamUrl,
                streamId: streamId,
                keepAlive: true,
                keepAliveIntervalSeconds: 15
            )
        )
        startKeepAlive(streamId: streamId)
        streamRequested = true
        streamStartedAt = streamStartedAt ?? Date()
        streamStatus = "WebRTC stream requested; waiting for first frame"
        append(tag: "TX", text: "startStream direct phone \(streamUrl)")
    }

    private func stopDirectPhoneStreamReceiver(status: String) {
        directStreamStartTask?.cancel()
        directStreamStartTask = nil
        directStreamStopTask?.cancel()
        directStreamStopTask = nil
        directStreamFirstFrameSeen = false
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
            let firstFrame = !directStreamFirstFrameSeen
            directStreamFirstFrameSeen = true
            streamPreviewReady = true
            streamStartedAt = streamStartedAt ?? Date()
            streamStatus = "WebRTC direct phone live"
            if firstFrame {
                append(tag: "LIVE", text: "first WebRTC frame received on phone")
            }
        } else if !streamPreviewReady {
            streamStatus = "WebRTC phone receiver: \(message)"
        }
    }

    private func startStream(streamUrl: String, streamId: String, protocol selectedProtocol: ExampleStreamProtocol) {
        mentraBluetoothSdk.startStream(
            MentraStreamRequest(
                streamUrl: streamUrl,
                streamId: streamId,
                keepAlive: true,
                keepAliveIntervalSeconds: 15
            )
        )
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
                    streamStatus = "\(selectedProtocol.rawValue.uppercased()) media path lost; waiting for preview"
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

        stopKeepAlive()
        stopPreviewHealthPoll()
        directStreamStartTask?.cancel()
        directStreamStartTask = nil
        directStreamStopTask?.cancel()
        directStreamStopTask = nil
        if glassesConnected {
            mentraBluetoothSdk.stopStream()
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
        streamStartedAt = nil
        return true
    }

    func selectStreamProtocol(_ nextProtocol: ExampleStreamProtocol) {
        guard streamProtocol != nextProtocol else { return }
        let currentUrl = streamUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let shouldUseDefault = currentUrl.isEmpty || ExampleStreamProtocol.defaultUrls.contains(currentUrl)
        let stoppedStream = stopStreamForConfigurationChange(status: "Stopped before changing stream protocol")
        streamProtocol = nextProtocol
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
        if enabled {
            let currentUrl = streamUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            let shouldUseDefault = currentUrl.isEmpty || ExampleStreamProtocol.defaultUrls.contains(currentUrl)
            streamCloudServerEnabled = true
            if shouldUseDefault {
                streamUrl = streamProtocol.defaultUrl
            }
            streamStatus = "Ready to start stream"
            streamPreviewReady = false
            return
        }

        streamCloudServerEnabled = false
        streamStatus = "Ready to stream WebRTC to this phone"
        streamPreviewReady = false
    }

    func setStreamUrl(_ nextUrl: String) {
        guard streamUrl != nextUrl else { return }
        let stoppedStream = stopStreamForConfigurationChange(status: "Stopped before changing stream URL")
        streamUrl = nextUrl
        if stoppedStream {
            streamStatus = "Ready to start stream"
        }
    }

    func requestWifiScan() {
        runAction("Scan Wi-Fi") {
            try requireConnected("scan Wi-Fi")
            mentraBluetoothSdk.requestWifiScan()
        }
    }

    func sendWifiCredentials(ssid: String, password: String, requiresPassword: Bool) {
        runAction("Connect Wi-Fi \(ssid)") {
            try requireConnected("send Wi-Fi credentials")
            if requiresPassword, password.isEmpty {
                throw ExampleActionError(message: "Enter the Wi-Fi password before connecting to \(ssid).")
            }
            mentraBluetoothSdk.sendWifiCredentials(ssid: ssid, password: requiresPassword ? password : "")
        }
    }

    func forgetCurrentWifiNetwork() {
        runAction("Forget current Wi-Fi") {
            try requireConnected("forget Wi-Fi network")
            guard let wifi = connectedWifiStatus(glassesValues) else {
                throw ExampleActionError(message: "No connected Wi-Fi network to forget.")
            }
            mentraBluetoothSdk.forgetWifiNetwork(ssid: wifi.ssid)
        }
    }

    func toggleHotspot() {
        runAction(hotspotEnabled ? "Disable hotspot" : "Enable hotspot") {
            try requireConnected("toggle hotspot")
            let current = enabledHotspotStatus(glassesValues) != nil || (glassesValues == nil && hotspotEnabled)
            let next = !current
            mentraBluetoothSdk.setHotspotState(enabled: next)
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
        runAction("RGB LED \(mode)") {
            try requireConnected("control the RGB LED")
            ledMode = mode
            sendRgbLedRequest(mode: mode, color: ledColor)
        }
    }

    func selectLedColor(_ color: String) {
        runAction("RGB LED color \(color.uppercased())") {
            try requireConnected("control the RGB LED")
            guard validLedColors.contains(color) else {
                throw ExampleActionError(message: "Unsupported RGB LED color: \(color)")
            }
            ledColor = color
            if ledMode != "Off" {
                sendRgbLedRequest(mode: ledMode, color: color)
            }
        }
    }

    private func sendRgbLedRequest(mode: String, color: String) {
        let request = rgbLedRequest(for: mode, color: color)
        mentraBluetoothSdk.rgbLedControl(
            MentraRgbLedRequest(
                requestId: "rgb-\(Int(Date().timeIntervalSince1970 * 1000))",
                packageName: "com.mentra.examples.ios",
                action: request.action,
                color: request.color,
                ontime: request.ontime,
                offtime: request.offtime,
                count: request.count
            )
        )
    }

    private func rgbLedRequest(for mode: String, color: String) -> (action: MentraRgbLedAction, color: MentraRgbLedColor?, ontime: Int, offtime: Int, count: Int) {
        let ledColor = MentraRgbLedColor(rawValue: color) ?? .red
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

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateGlassesStatus status: MentraGlassesStatusUpdate) {
        glassesValues = glassesValues?.applying(status) ?? mentraBluetoothSdk.glassesStatus
        if let hotspot = status.hotspot {
            hotspotEnabled = enabledHotspotStatus(hotspot) != nil
            refreshGalleryServerStatusForCurrentHotspot(defaultStatus: "Gallery server: hotspot off")
        }
        if isDisconnectedStatus(status) {
            applyDisconnectedState(status: "Disconnected")
        }
        append(tag: "STORE", text: summarize(status))
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateBluetoothStatus status: MentraBluetoothStatusUpdate) {
        applyBluetoothStatus(status)
        append(tag: "BLE", text: summarize(status))
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didDiscover device: MentraDevice) {
        if !discoveredDevices.contains(where: { discoveredDeviceKey($0) == discoveredDeviceKey(device) }) {
            discoveredDevices.append(device)
        }
        if selectedDiscoveredDevice == nil {
            selectedDiscoveredDevice = device
        }
        append(tag: "BLE", text: "discovered \(device.name)")
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didChangeDefaultDevice device: MentraDevice?) {
        savePersistedDefaultDevice(device)
        bluetoothValues = bluetoothValues?.withDefaultDevice(device)
        if let device {
            append(tag: "BLE", text: "saved default \(device.name)")
        }
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceive event: MentraBluetoothEvent) {
        switch event {
        case let .buttonPress(button):
            append(tag: "LIVE", text: "button \(button.buttonId): \(button.pressType)")
        case let .touch(touch):
            append(tag: "LIVE", text: "\(touch.isSwipe ? "swipe" : "touch") \(touch.gestureName ?? summarize(touch.values))")
        case let .wifiStatus(status):
            applyWifiStatus(status)
        case let .hotspotStatus(status):
            handleRawEvent(name: "hotspot_status_change", values: status.values)
        case let .hotspotError(error):
            handleRawEvent(name: "hotspot_error", values: error.values)
        case let .photoResponse(response):
            handlePhotoResponse(response.response)
        case let .streamStatus(status):
            handleStreamStatus(status.values)
        case let .raw(name, values):
            handleRawEvent(name: name, values: values)
        default:
            append(tag: "LIVE", text: event.description)
        }
    }

    private func applyWifiStatus(_ event: MentraWifiStatusEvent) {
        glassesValues = glassesValues?.withWifi(event.status) ?? mentraBluetoothSdk.glassesStatus
        let label: String
        switch event.status {
        case let .connected(ssid, _):
            label = ssid
        case .disconnected:
            label = "disconnected"
        case .unknown:
            label = "unknown"
        }
        append(tag: "STORE", text: "Wi-Fi \(label)")
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicPcm frame: Data) {
        guard micRecording else { return }
        micPcmData.append(frame)
        pcmFrames += 1
        pcmBytes += frame.count
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicLc3 frame: Data) {
        guard micRecording else { return }
        append(tag: "LIVE", text: "received LC3 mic frame while PCM recording is enabled (\(frame.count) bytes)")
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didLog message: String) {
        append(tag: "LIVE", text: message)
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didFail error: MentraBluetoothError) {
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

    private func applyBluetoothStatus(_ status: MentraBluetoothStatus) {
        bluetoothValues = status
        galleryModeAuto = status.galleryModeAuto
    }

    private func applyBluetoothStatus(_ status: MentraBluetoothStatusUpdate) {
        bluetoothValues = bluetoothValues?.applying(status) ?? mentraBluetoothSdk.bluetoothStatus
        if let galleryMode = status.galleryModeAuto {
            galleryModeAuto = galleryMode
        }
    }

    private func loadPersistedDefaultDevice() -> MentraDevice? {
        guard let model = defaultDeviceDefaults.string(forKey: DefaultDeviceStorage.model), !model.isEmpty else {
            return nil
        }
        guard let name = defaultDeviceDefaults.string(forKey: DefaultDeviceStorage.name), !name.isEmpty else {
            return nil
        }
        let identifier = defaultDeviceDefaults.string(forKey: DefaultDeviceStorage.identifier).flatMap {
            $0.isEmpty ? nil : $0
        }
        return MentraDevice(
            model: MentraDeviceModel.fromDeviceType(model),
            name: name,
            identifier: identifier
        )
    }

    private func savePersistedDefaultDevice(_ device: MentraDevice?) {
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
        glassesValues = glassesValues?.disconnected() ?? mentraBluetoothSdk.glassesStatus.disconnected()
        stopKeepAlive()
        stopPreviewHealthPoll()
        activeStreamId = nil
        streamRequested = false
        streamPreviewReady = false
        streamStartedAt = nil
        streamStatus = status
        micRecording = false
        stopMicElapsedTimer()
        stopMicPlayback()
        hotspotEnabled = false
        galleryServerReachable = nil
        galleryServerStatus = "Gallery server: connect glasses first"
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
        mentraBluetoothSdk.setMicState(MentraMicConfiguration(sendPcmData: true, sendTranscript: false, bypassVad: true))
        micRecording = true
        startMicElapsedTimer()
    }

    private func stopMicRecording() {
        if glassesConnected {
            mentraBluetoothSdk.setMicState(MentraMicConfiguration(sendPcmData: false, sendTranscript: false, bypassVad: true))
        }
        micRecording = false
        stopMicElapsedTimer()
        let capturedPcm = micPcmData
        let capturedBytes = capturedPcm.count

        guard !capturedPcm.isEmpty else {
            micRecordingUrl = nil
            lastMicDurationSeconds = nil
            lastMicBytes = 0
            micPlaybackHint = "No PCM frames captured. Replay is empty; keep the glasses connected and record again."
            append(tag: "LIVE", text: "microphone stopped with no PCM frames")
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
            let hotspot = MentraHotspotStatus(values: values)
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
            handlePhotoResponse(MentraPhotoResponse(values: values))
        case "stream_status":
            handleStreamStatus(values)
        default:
            append(tag: "LIVE", text: "\(name) \(summarize(values))")
        }
    }

    private func applyStreamStatus(_ values: [String: Any]) {
        switch stringValue(values, "status") {
        case "streaming", "initializing", "starting":
            streamRequested = true
            if streamStartedAt == nil {
                streamStartedAt = Date()
            }
            if let streamId = stringValue(values, "streamId") {
                activeStreamId = streamId
            }
            if let activeStreamId, keepAliveTask == nil {
                startKeepAlive(streamId: activeStreamId)
            }
        case "stopped", "stopping", "error", "error_not_streaming":
            streamRequested = false
            streamPreviewReady = false
            streamStartedAt = nil
            activeStreamId = nil
            stopKeepAlive()
            stopPreviewHealthPoll()
            if directStreamReceiverRunning {
                stopDirectPhoneStreamReceiver(status: "WebRTC direct phone stopped")
            }
        default:
            break
        }
    }

    private func handleStreamStatus(_ values: [String: Any]) {
        applyStreamStatus(values)
        let summary = summarize(values)
        let status = stringValue(values, "status")
        if isDirectPhoneWebRtcSelected {
            if status == "stopped" || status == "stopping" {
                streamStatus = "WebRTC direct phone stopped"
            } else if status?.lowercased().hasPrefix("error") == true {
                streamStatus = "WebRTC direct phone error: \(summary)"
            } else if streamPreviewReady {
                streamStatus = "WebRTC direct phone live"
            } else {
                streamStatus = "WebRTC stream requested; waiting for first frame"
            }
        } else {
            streamStatus = summary
        }
        append(tag: "LIVE", text: "stream \(summary)")
    }

    private func handlePhotoResponse(_ response: MentraPhotoResponse) {
        let requestId = response.requestId
        if let activePhotoRequestId, requestId != activePhotoRequestId {
            append(tag: "LIVE", text: "ignoring stale photo \(requestId)")
            return
        }
        let uploadTarget = photoDestination == .thisPhone ? "phone upload" : "local upload"
        switch response {
        case .success:
            cameraStatus = "Camera: photo acknowledged; waiting for \(uploadTarget)"
        case let .error(_, errorCode, errorMessage, _):
            cameraStatus = "Camera: glasses reported \(errorCode ?? errorMessage); waiting for \(uploadTarget)"
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

    private func startKeepAlive(streamId: String) {
        stopKeepAlive()
        keepAliveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard let self else { return }
                self.mentraBluetoothSdk.keepStreamAlive(
                    MentraStreamKeepAliveRequest(
                        streamId: streamId,
                        ackId: "ack-\(Int(Date().timeIntervalSince1970 * 1000))"
                    )
                )
                self.append(tag: "TX", text: "stream keep alive")
            }
        }
    }

    private func stopKeepAlive() {
        keepAliveTask?.cancel()
        keepAliveTask = nil
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

func connectionLabel(_ status: MentraGlassesStatus?) -> String {
    status?.connectionState.nonEmpty ?? (isGlassesConnected(status) ? "CONNECTED" : "WAITING")
}

func isGlassesConnected(_ status: MentraGlassesStatus?) -> Bool {
    if let state = status?.connectionState.lowercased(), !state.isEmpty {
        if state == "connected" { return true }
        if state == "disconnected" { return false }
    }
    return status?.connected == true
}

func isDisconnectedStatus(_ status: MentraGlassesStatusUpdate) -> Bool {
    if let state = status.connectionState?.lowercased() {
        return state == "disconnected"
    }
    return status.connected == false
}

func modelLabel(_ status: MentraGlassesStatus?) -> String {
    status?.deviceModel.nonEmpty ?? "Mentra Live"
}

func deviceLabel(_ status: MentraGlassesStatus?) -> String {
    if let value = status?.bluetoothName, !value.isEmpty { return value }
    if let value = status?.serialNumber, !value.isEmpty { return value }
    if let value = status?.deviceModel, !value.isEmpty { return value }
    return "Mentra Live"
}

func supportsDisplay(_ status: MentraGlassesStatus?) -> Bool {
    let model = [
        status?.deviceModel,
        status?.bluetoothName,
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

func discoveredDeviceKey(_ device: MentraDevice) -> String {
    device.id
}

func batteryLevel(_ status: MentraGlassesStatus?) -> Int? {
    guard isGlassesConnected(status), let level = status?.batteryLevel, level >= 0 else { return nil }
    return min(level, 100)
}

func batteryLabel(_ status: MentraGlassesStatus?) -> String {
    guard let level = batteryLevel(status) else {
        return status?.connected == false || status?.connectionState.lowercased() == "disconnected" ? "Not connected" : "Waiting for status"
    }
    return "\(level)%\(status?.charging == true ? " charging" : "")"
}

func wifiLabel(_ status: MentraGlassesStatus?) -> String {
    switch status?.wifi {
    case let .connected(ssid, _):
        return ssid
    case .disconnected:
        return isGlassesConnected(status) ? "Not connected" : "Unknown"
    case .unknown, .none:
        return "Unknown"
    }
}

func connectedWifiStatus(_ status: MentraGlassesStatus?) -> (ssid: String, localIp: String)? {
    guard case let .connected(ssid, localIp) = status?.wifi else {
        return nil
    }
    return (ssid, localIp)
}

func enabledHotspotStatus(_ hotspot: MentraHotspotStatus) -> (ssid: String, password: String, localIp: String)? {
    guard case let .enabled(ssid, password, localIp) = hotspot else {
        return nil
    }
    return (ssid, password, localIp)
}

func enabledHotspotStatus(_ status: MentraGlassesStatus?) -> (ssid: String, password: String, localIp: String)? {
    guard let hotspot = status?.hotspot else {
        return nil
    }
    return enabledHotspotStatus(hotspot)
}

func hotspotLabel(_ status: MentraGlassesStatus?, fallbackEnabled: Bool) -> String {
    if let hotspot = enabledHotspotStatus(status) {
        return "\(hotspot.ssid) · \(hotspot.localIp)"
    }
    return status == nil && fallbackEnabled ? "waiting for SSID" : "disabled"
}

private let mentraLiveDefaultHotspotPassword = "00001111"

func galleryServerUrl(_ status: MentraGlassesStatus?, fallbackEnabled: Bool) -> String? {
    let hotspot = enabledHotspotStatus(status)
    guard hotspot != nil || (status == nil && fallbackEnabled) else { return nil }

    let gateway = hotspot?.localIp ?? "192.168.43.1"
    return "http://\(gateway):8089"
}

func galleryHotspotSsidLabel(_ status: MentraGlassesStatus?) -> String {
    guard let ssid = enabledHotspotStatus(status)?.ssid else {
        return "the glasses hotspot"
    }
    return "Wi-Fi \(ssid)"
}

func galleryHotspotPasswordLabel(_ status: MentraGlassesStatus?) -> String {
    enabledHotspotStatus(status)?.password ?? mentraLiveDefaultHotspotPassword
}

func firmwareLabel(_ status: MentraGlassesStatus?) -> String {
    if let value = status?.firmwareVersion, !value.isEmpty { return value }
    if let value = status?.besFirmwareVersion, !value.isEmpty { return value }
    if let value = status?.mtkFirmwareVersion, !value.isEmpty { return value }
    return "Unknown"
}

func firmwareSubLabel(_ status: MentraGlassesStatus?) -> String {
    if status?.firmwareVersion.isEmpty == false {
        return "reported"
    }
    if status?.besFirmwareVersion.isEmpty == false {
        return "BES firmware"
    }
    if status?.mtkFirmwareVersion.isEmpty == false {
        return "MTK firmware"
    }
    if let appVersion = status?.appVersion, !appVersion.isEmpty {
        return "ASG app \(appVersion)"
    }
    return "not reported"
}

func rssiLabel(_ status: MentraGlassesStatus?) -> String {
    guard let signal = status?.signalStrength, signal != -1 else { return "Unknown" }
    return "\(signal) dBm"
}

func rssiUpdatedLabel(_ status: MentraGlassesStatus?) -> String {
    guard let updatedAt = status?.signalStrengthUpdatedAt, updatedAt > 0 else { return "signal" }
    let date = Date(timeIntervalSince1970: TimeInterval(updatedAt) / 1000)
    return "updated \(DateFormatter.exampleEventTime.string(from: date))"
}

func bluetoothSearchLabel(_ status: MentraBluetoothStatus?) -> String {
    let count = status?.searchResults.count ?? 0
    return "\(status?.searching == true ? "Scanning" : "Idle") · \(count) result\(count == 1 ? "" : "s")"
}

func hasSavedConnectionTarget(_ status: MentraBluetoothStatus?) -> Bool {
    guard let model = status?.defaultWearable, !model.isEmpty else { return false }
    guard let name = status?.deviceName, !name.isEmpty else { return false }
    return true
}

func savedConnectionTargetName(_ status: MentraBluetoothStatus?) -> String {
    status?.deviceName.nonEmpty ?? "Saved glasses"
}

func savedConnectionTargetDetail(_ status: MentraBluetoothStatus?) -> String {
    let model = status?.defaultWearable.nonEmpty ?? "Saved model"
    return "\(model) · BluetoothSdk.connectDefault()"
}

func wifiScanResults(_ status: MentraBluetoothStatus?) -> [MentraWifiScanResult] {
    status?.wifiScanResults ?? []
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

func summarize(_ status: MentraGlassesStatusUpdate) -> String {
    let wifiSummary: String? = status.wifi.map { wifi in
        switch wifi {
        case let .connected(ssid, _):
            return "wifi: \(ssid)"
        case .disconnected:
            return "wifi: disconnected"
        case .unknown:
            return "wifi: unknown"
        }
    }
    let hotspotSummary: String? = status.hotspot.map { hotspot in
        switch hotspot {
        case let .enabled(ssid, _, localIp):
            return "hotspot: \(ssid) · \(localIp)"
        case .disabled:
            return "hotspot: disabled"
        case .unknown:
            return "hotspot: unknown"
        }
    }
    let signalStrengthUpdatedSummary = status.signalStrengthUpdatedAt.map { timestamp in
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp) / 1000)
        return "RSSI updated: \(DateFormatter.exampleEventTime.string(from: date))"
    }
    let parts = [
        status.connectionState.map { "connectionState: \($0)" },
        status.connected.map { "connected: \($0)" },
        status.fullyBooted.map { "fullyBooted: \($0)" },
        status.batteryLevel.map { "batteryLevel: \($0)" },
        wifiSummary,
        hotspotSummary,
        status.signalStrength.map { "signalStrength: \($0)" },
        signalStrengthUpdatedSummary,
    ].compactMap { $0 }.prefix(3)
    return parts.isEmpty ? "empty update" : parts.joined(separator: ", ")
}

func summarize(_ status: MentraBluetoothStatusUpdate) -> String {
    let parts = [
        status.searching.map { "searching: \($0)" },
        status.searchResults.map { "searchResults: \($0.count)" },
        status.wifiScanResults.map { "wifiScanResults: \($0.count)" },
        status.galleryModeAuto.map { "galleryModeAuto: \($0)" },
        status.defaultWearable.map { "defaultWearable: \($0)" },
        status.deviceName.map { "deviceName: \($0)" },
    ].compactMap { $0 }.prefix(3)
    return parts.isEmpty ? "empty update" : parts.joined(separator: ", ")
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
