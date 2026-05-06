import AVFoundation
import Foundation
import MentraBluetoothSDK

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
            return "srt://srt.example.com:4201?streamid=YOUR_STREAM_ID&passphrase=YOUR_PASSPHRASE"
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
    @Published private(set) var glassesValues: [String: Any] = [:]
    @Published private(set) var bluetoothValues: [String: Any] = [:]
    @Published private(set) var discoveredDevices: [MentraDiscoveredDevice] = []
    @Published private(set) var selectedDiscoveredDevice: MentraDiscoveredDevice?
    @Published private(set) var events: [ExampleEvent] = [ExampleEvent.make(tag: "LIVE", text: "SDK ready. Scan to discover glasses.")]
    @Published private(set) var activeAction: String?
    @Published private(set) var lastAction = "No actions yet."
    @Published private(set) var cameraStatus = "Camera: enter the local webhook /upload URL"
    @Published var webhookUrl = ""
    @Published private(set) var photoPreviewUrl: URL?
    @Published private(set) var photoSize: MentraPhotoSize = .medium
    @Published private(set) var photoCompression: MentraPhotoCompression = .medium
    @Published private(set) var photoFlash = false
    @Published var streamProtocol: ExampleStreamProtocol = .rtmp
    @Published var streamUrl = ExampleStreamProtocol.rtmp.defaultUrl
    @Published private(set) var streamStartedAt: Date?
    @Published private(set) var streamStatus = "Ready to start stream"
    @Published private(set) var galleryModeAuto = false
    @Published private(set) var hotspotEnabled = false
    @Published private(set) var micRecording = false
    @Published private(set) var micPlaying = false
    @Published private(set) var micElapsedSeconds = 0
    @Published private(set) var pcmFrames = 0
    @Published private(set) var pcmBytes = 0
    @Published private(set) var lastMicDurationSeconds: Int?
    @Published private(set) var lastMicBytes = 0
    @Published private(set) var ledColor = "green"
    @Published private(set) var ledMode = "Off"
    @Published var rawJsonExpanded = false

    private let micSampleRate = 16000
    private let micChannelCount = 1
    private let micBitsPerSample = 16
    private let sdk = MentraBluetoothSDK()
    private var activePhotoRequestId: String?
    private var activeStreamId: String?
    private var pollGeneration = 0
    private var keepAliveTask: Task<Void, Never>?
    private var micStartedAt: Date?
    private var micElapsedTask: Task<Void, Never>?
    private var micPcmData = Data()
    private var micRecordingUrl: URL?
    private var micPlayer: AVAudioPlayer?
    private let validLedColors = Set(["red", "green", "blue", "orange", "white"])

    var glassesConnected: Bool {
        isGlassesConnected(glassesValues)
    }

    var hasMicRecording: Bool {
        micRecordingUrl != nil && lastMicBytes > 0
    }

    override init() {
        super.init()
        sdk.delegate = self
        glassesValues = sdk.glassesStatus.values
        hotspotEnabled = boolValue(glassesValues, "hotspotEnabled") ?? false
        applyBluetoothStatus(sdk.bluetoothStatus.values)
        if let value = ProcessInfo.processInfo.environment["MENTRA_PHOTO_WEBHOOK_URL"] {
            webhookUrl = value
        }
    }

    deinit {
        micElapsedTask?.cancel()
        Task { @MainActor [sdk] in sdk.invalidate() }
    }

    func startScan() {
        runAction("Scan") {
            discoveredDevices.removeAll()
            selectedDiscoveredDevice = nil
            sdk.startScan(model: .mentraLive)
        }
    }

    func connect() {
        runAction("Connect") {
            if let device = selectedDiscoveredDevice ?? discoveredDevices.first {
                sdk.connect(to: device)
            } else if hasSavedConnectionTarget(bluetoothValues) {
                sdk.connectDefault()
            } else {
                throw ExampleActionError(message: "Scan first to choose nearby glasses.")
            }
        }
    }

    func selectDiscoveredDevice(_ device: MentraDiscoveredDevice) {
        selectedDiscoveredDevice = device
        lastAction = "Selected: \(device.name)"
    }

    func connect(_ device: MentraDiscoveredDevice) {
        selectedDiscoveredDevice = device
        runAction("Connect \(device.name)") {
            sdk.connect(to: device)
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
            self.sdk.disconnect()
            self.lastAction = "Requested: \(label)"
            self.activeAction = nil
        }
    }

    func displayHello() {
        runAction("Display Hello") {
            try requireDisplaySupport("display text")
            Task {
                try? await sdk.displayText(MentraDisplayTextRequest(text: "Hello from Mentra Bluetooth SDK"))
            }
        }
    }

    func clearDisplay() {
        runAction("Clear Display") {
            try requireDisplaySupport("clear the display")
            Task { try? await sdk.clearDisplay() }
        }
    }

    func setGalleryModeAuto(_ enabled: Bool) {
        runAction(enabled ? "Save in gallery mode" : "Report button events") {
            try requireConnected("change gallery mode")
            galleryModeAuto = enabled
            Task { try? await sdk.setGalleryMode(enabled ? .auto : .manual) }
        }
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
            let uploadUrl = webhookUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let statusUrl = photoStatusUrl(uploadUrl, requestId: "") else {
                cameraStatus = "Camera: enter a webhook URL like http://<computer-ip>:8787/upload"
                return
            }
            let requestId = "photo-\(Int(Date().timeIntervalSince1970 * 1000))"
            activePhotoRequestId = requestId
            pollGeneration += 1
            let generation = pollGeneration
            photoPreviewUrl = nil
            cameraStatus = "Camera: webhook upload requested (\(requestId))"
            sdk.requestPhoto(
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

    func testWebhook() {
        runAction("Test webhook") {
            let uploadUrl = webhookUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let healthUrl = webhookHealthUrl(uploadUrl) else {
                cameraStatus = "Camera: enter a webhook URL like http://<computer-ip>:8787/upload"
                append(tag: "TX", text: "Test webhook failed: invalid URL")
                return
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
        if streamStartedAt != nil {
            runAction("Stop stream") {
                stopKeepAlive()
                if glassesConnected {
                    sdk.stopStream()
                }
                activeStreamId = nil
                streamStartedAt = nil
                streamStatus = "Stopped"
            }
            return
        }

        runAction("Start stream") {
            try requireConnected("start streaming")
            let url = streamUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            if let validationMessage = streamUrlValidationMessage(url) {
                streamStatus = validationMessage
                throw ExampleActionError(message: validationMessage)
            }
            let streamId = "ios-\(Int(Date().timeIntervalSince1970 * 1000))"
            let selectedProtocol = streamProtocol
            if selectedProtocol == .rtmp || selectedProtocol == .webrtc {
                startStream(streamUrl: url, streamId: streamId, protocol: selectedProtocol)
                Task {
                    do {
                        if selectedProtocol == .rtmp {
                            try await checkLocalRtmpServer(rtmpUrl: url)
                        } else {
                            try await checkLocalWebrtcServer(whipUrl: url)
                        }
                    } catch {
                        let message = error.localizedDescription
                        append(tag: "TX", text: "Preview check warning: \(message)")
                        if activeStreamId == streamId {
                            streamStatus = "Stream requested; preview unavailable: \(message)"
                        }
                    }
                }
                return
            }
            startStream(streamUrl: url, streamId: streamId, protocol: selectedProtocol)
        }
    }

    private func startStream(streamUrl: String, streamId: String, protocol selectedProtocol: ExampleStreamProtocol) {
        sdk.startStream(
            MentraStreamRequest(
                streamUrl: streamUrl,
                streamId: streamId,
                keepAlive: true,
                keepAliveIntervalSeconds: 15
            )
        )
        activeStreamId = streamId
        streamStatus = "Requested \(selectedProtocol.rawValue.uppercased()) stream; waiting for glasses"
    }

    func selectStreamProtocol(_ nextProtocol: ExampleStreamProtocol) {
        let currentUrl = streamUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let shouldUseDefault = currentUrl.isEmpty || ExampleStreamProtocol.defaultUrls.contains(currentUrl)
        streamProtocol = nextProtocol
        if shouldUseDefault {
            streamUrl = nextProtocol.defaultUrl
        }
    }

    func requestWifiScan() {
        runAction("Scan Wi-Fi") {
            try requireConnected("scan Wi-Fi")
            sdk.requestWifiScan()
        }
    }

    func sendWifiCredentials(ssid: String, password: String, requiresPassword: Bool) {
        runAction("Connect Wi-Fi \(ssid)") {
            try requireConnected("send Wi-Fi credentials")
            if requiresPassword, password.isEmpty {
                throw ExampleActionError(message: "Enter the Wi-Fi password before connecting to \(ssid).")
            }
            sdk.sendWifiCredentials(ssid: ssid, password: requiresPassword ? password : "")
        }
    }

    func forgetCurrentWifiNetwork() {
        runAction("Forget current Wi-Fi") {
            try requireConnected("forget Wi-Fi network")
            guard boolValue(glassesValues, "wifiConnected") == true,
                  let ssid = stringValue(glassesValues, "wifiSsid"),
                  !ssid.isEmpty
            else {
                throw ExampleActionError(message: "No connected Wi-Fi network to forget.")
            }
            sdk.forgetWifiNetwork(ssid: ssid)
        }
    }

    func toggleHotspot() {
        runAction(hotspotEnabled ? "Disable hotspot" : "Enable hotspot") {
            try requireConnected("toggle hotspot")
            let current = boolValue(glassesValues, "hotspotEnabled") ?? hotspotEnabled
            let next = !current
            sdk.setHotspotState(enabled: next)
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
        sdk.rgbLedControl(
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
        glassesValues.merge(status.values) { _, new in new }
        if let enabled = boolValue(status.values, "hotspotEnabled") {
            hotspotEnabled = enabled
        }
        if isDisconnectedStatus(status.values) {
            applyDisconnectedState(status: "Disconnected")
        }
        append(tag: "STORE", text: summarize(status.values))
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateBluetoothStatus status: MentraBluetoothStatusUpdate) {
        applyBluetoothStatus(status.values)
        append(tag: "BLE", text: summarize(status.values))
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didDiscover device: MentraDiscoveredDevice) {
        if !discoveredDevices.contains(where: { discoveredDeviceKey($0) == discoveredDeviceKey(device) }) {
            discoveredDevices.append(device)
        }
        if selectedDiscoveredDevice == nil {
            selectedDiscoveredDevice = device
        }
        append(tag: "BLE", text: "discovered \(device.name)")
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceive event: MentraBluetoothEvent) {
        switch event {
        case let .buttonPress(button):
            append(tag: "LIVE", text: "button \(button.buttonId): \(button.pressType)")
        case let .touch(touch):
            append(tag: "LIVE", text: "\(touch.isSwipe ? "swipe" : "touch") \(touch.gestureName ?? summarize(touch.values))")
        case let .hotspotStatus(status):
            handleRawEvent(name: "hotspot_status_change", values: status.values)
        case let .hotspotError(error):
            handleRawEvent(name: "hotspot_error", values: error.values)
        case let .photoResponse(response):
            handlePhotoResponse(response.values)
        case let .streamStatus(status):
            applyStreamStatus(status.values)
            streamStatus = summarize(status.values)
            append(tag: "LIVE", text: "stream \(summarize(status.values))")
        case let .raw(name, values):
            handleRawEvent(name: name, values: values)
        default:
            append(tag: "LIVE", text: event.description)
        }
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicPcm frame: Data) {
        guard micRecording else { return }
        micPcmData.append(frame)
        pcmFrames += 1
        pcmBytes += frame.count
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicLc3 frame: Data) {
        guard micRecording else { return }
        pcmFrames += 1
        pcmBytes += frame.count
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

    private func requireDisplaySupport(_ feature: String) throws {
        try requireConnected(feature)
        guard supportsDisplay(glassesValues) else {
            throw ExampleActionError(message: "This glasses model has no display, so \(feature) is unavailable.")
        }
    }

    private func applyBluetoothStatus(_ values: [String: Any]) {
        bluetoothValues.merge(values) { _, new in new }
        if let galleryMode = boolValue(values, "gallery_mode") {
            galleryModeAuto = galleryMode
        }
    }

    private func applyDisconnectedState(status: String) {
        glassesValues = disconnectedGlassesValues()
        stopKeepAlive()
        activeStreamId = nil
        streamStartedAt = nil
        streamStatus = status
        micRecording = false
        stopMicElapsedTimer()
        stopMicPlayback()
        hotspotEnabled = false
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
        lastMicDurationSeconds = nil
        lastMicBytes = 0
        pcmFrames = 0
        pcmBytes = 0
        micElapsedSeconds = 0
        micStartedAt = Date()
        sdk.setMicState(MentraMicConfiguration(sendPcmData: true, sendTranscript: false, bypassVad: true))
        micRecording = true
        startMicElapsedTimer()
    }

    private func stopMicRecording() {
        if glassesConnected {
            sdk.setMicState(MentraMicConfiguration(sendPcmData: false, sendTranscript: false, bypassVad: true))
        }
        micRecording = false
        stopMicElapsedTimer()
        lastMicDurationSeconds = max(micElapsedSeconds, Int((Double(pcmBytes) / Double(micSampleRate * micChannelCount * micBitsPerSample / 8)).rounded(.up)))
        lastMicBytes = pcmBytes

        guard !micPcmData.isEmpty else {
            micRecordingUrl = nil
            lastMicDurationSeconds = nil
            lastMicBytes = 0
            append(tag: "LIVE", text: "microphone stopped with no PCM frames")
            return
        }

        do {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("mentra-mic-last.wav")
            try wavData(from: micPcmData).write(to: url, options: [.atomic])
            micRecordingUrl = url
            append(tag: "LIVE", text: "saved microphone WAV \(pcmBytes) bytes")
        } catch {
            micRecordingUrl = nil
            append(tag: "TX", text: "failed to save microphone WAV: \(error.localizedDescription)")
        }
    }

    private func startMicPlayback(restart: Bool = false) throws {
        guard let url = micRecordingUrl, lastMicBytes > 0 else {
            throw ExampleActionError(message: "Record microphone audio before playback.")
        }
        stopMicPlayback()

        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.duckOthers])
            try AVAudioSession.sharedInstance().setActive(true)
            let player = try AVAudioPlayer(contentsOf: url)
            player.delegate = self
            player.prepareToPlay()
            if restart {
                player.currentTime = 0
            }
            micPlayer = player
            micPlaying = true
            sdk.setOwnAppAudioPlaying(true)
            if !player.play() {
                stopMicPlayback()
                throw ExampleActionError(message: "Could not start mic playback.")
            }
        } catch {
            stopMicPlayback()
            throw error
        }
    }

    private func stopMicPlayback() {
        micPlayer?.stop()
        micPlayer = nil
        if micPlaying {
            sdk.setOwnAppAudioPlaying(false)
        }
        micPlaying = false
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    func audioPlayerDidFinishPlaying(_: AVAudioPlayer, successfully _: Bool) {
        stopMicPlayback()
    }

    func audioPlayerDecodeErrorDidOccur(_: AVAudioPlayer, error: Error?) {
        append(tag: "TX", text: "mic playback failed: \(error?.localizedDescription ?? "decode error")")
        stopMicPlayback()
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
            glassesValues["batteryLevel"] = intValue(values, "level") ?? -1
            glassesValues["charging"] = boolValue(values, "charging") ?? false
            append(tag: "STORE", text: "battery \(intValue(values, "level") ?? -1)%")
        case "wifi_status_change":
            glassesValues.merge(values) { _, new in new }
            append(tag: "STORE", text: "Wi-Fi \(summarize(values))")
        case "hotspot_status_change":
            let enabled = boolValue(values, "enabled") ?? false
            hotspotEnabled = enabled
            glassesValues["hotspotEnabled"] = enabled
            glassesValues["hotspotSsid"] = stringValue(values, "ssid") ?? ""
            glassesValues["hotspotPassword"] = stringValue(values, "password") ?? ""
            glassesValues["hotspotGatewayIp"] = stringValue(values, "local_ip") ?? ""
            append(tag: "STORE", text: "hotspot \(summarize(values))")
        case "hotspot_error":
            hotspotEnabled = false
            glassesValues["hotspotEnabled"] = false
            append(tag: "TX", text: "hotspot error \(summarize(values))")
        case "photo_response":
            handlePhotoResponse(values)
        case "stream_status":
            applyStreamStatus(values)
            streamStatus = summarize(values)
            append(tag: "LIVE", text: "stream \(summarize(values))")
        default:
            append(tag: "LIVE", text: "\(name) \(summarize(values))")
        }
    }

    private func applyStreamStatus(_ values: [String: Any]) {
        switch stringValue(values, "status") {
        case "streaming", "initializing", "starting":
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
            streamStartedAt = nil
            activeStreamId = nil
            stopKeepAlive()
        default:
            break
        }
    }

    private func handlePhotoResponse(_ values: [String: Any]) {
        let requestId = stringValue(values, "requestId") ?? stringValue(values, "request_id")
        if let activePhotoRequestId, let requestId, requestId != activePhotoRequestId {
            append(tag: "LIVE", text: "ignoring stale photo \(requestId)")
            return
        }
        if boolValue(values, "success") == false {
            cameraStatus = "Camera: glasses reported \(stringValue(values, "errorCode") ?? "error"); waiting for upload"
        } else {
            cameraStatus = "Camera: photo acknowledged; waiting for local upload"
        }
        append(tag: "LIVE", text: "photo response \(requestId ?? "")")
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
                self.sdk.keepStreamAlive(
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
    values[key] as? String
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

func connectionLabel(_ values: [String: Any]) -> String {
    stringValue(values, "connectionState") ?? (isGlassesConnected(values) ? "CONNECTED" : "WAITING")
}

func isGlassesConnected(_ values: [String: Any]) -> Bool {
    if let state = stringValue(values, "connectionState")?.lowercased() {
        if state == "connected" { return true }
        if state == "disconnected" { return false }
    }
    return boolValue(values, "connected") == true
}

func isDisconnectedStatus(_ values: [String: Any]) -> Bool {
    if let state = stringValue(values, "connectionState")?.lowercased() {
        return state == "disconnected"
    }
    return boolValue(values, "connected") == false
}

func modelLabel(_ values: [String: Any]) -> String {
    stringValue(values, "deviceModel") ?? "Mentra Live"
}

func deviceLabel(_ values: [String: Any]) -> String {
    stringValue(values, "bluetoothName") ?? stringValue(values, "serialNumber") ?? stringValue(values, "deviceModel") ?? "Mentra Live"
}

func supportsDisplay(_ values: [String: Any]) -> Bool {
    for key in ["supportsDisplay", "hasDisplay", "displaySupported", "display"] {
        if let value = boolValue(values, key) {
            return value
        }
    }
    for key in ["features", "deviceFeatures", "capabilities"] {
        if let nested = values[key] as? [String: Any],
           let value = boolValue(nested, "display")
        {
            return value
        }
    }

    let model = [
        stringValue(values, "deviceModel"),
        stringValue(values, "bluetoothName"),
        stringValue(values, "defaultWearable"),
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

func discoveredDeviceKey(_ device: MentraDiscoveredDevice) -> String {
    device.identifier ?? device.name
}

func batteryLevel(_ values: [String: Any]) -> Int? {
    guard isGlassesConnected(values), let level = intValue(values, "batteryLevel"), level >= 0 else { return nil }
    return min(level, 100)
}

func batteryLabel(_ values: [String: Any]) -> String {
    guard let level = batteryLevel(values) else {
        return isDisconnectedStatus(values) ? "Not connected" : "Waiting for status"
    }
    return "\(level)%\(boolValue(values, "charging") == true ? " charging" : "")"
}

func wifiLabel(_ values: [String: Any]) -> String {
    if boolValue(values, "wifiConnected") == true {
        return stringValue(values, "wifiSsid") ?? "Connected"
    }
    return isGlassesConnected(values) ? "Not connected" : "Unknown"
}

func hotspotLabel(_ values: [String: Any], fallbackEnabled: Bool) -> String {
    let enabled = boolValue(values, "hotspotEnabled") ?? fallbackEnabled
    guard enabled else { return "disabled" }

    guard let ssid = stringValue(values, "hotspotSsid"), !ssid.isEmpty else {
        return "waiting for SSID"
    }

    if let ip = stringValue(values, "hotspotGatewayIp"), !ip.isEmpty {
        return "\(ssid) · \(ip)"
    }
    return ssid
}

func firmwareLabel(_ values: [String: Any]) -> String {
    stringValue(values, "fwVersion")
        ?? stringValue(values, "firmwareVersion")
        ?? stringValue(values, "deviceFirmwareVersion")
        ?? stringValue(values, "rightFirmwareVersion")
        ?? stringValue(values, "leftFirmwareVersion")
        ?? stringValue(values, "besFwVersion")
        ?? stringValue(values, "mtkFwVersion")
        ?? "Unknown"
}

func firmwareSubLabel(_ values: [String: Any]) -> String {
    if stringValue(values, "fwVersion") != nil || stringValue(values, "firmwareVersion") != nil {
        return "reported"
    }
    if stringValue(values, "deviceFirmwareVersion") != nil {
        return "device firmware"
    }
    if stringValue(values, "rightFirmwareVersion") != nil {
        return "right firmware"
    }
    if stringValue(values, "leftFirmwareVersion") != nil {
        return "left firmware"
    }
    if stringValue(values, "besFwVersion") != nil {
        return "BES firmware"
    }
    if stringValue(values, "mtkFwVersion") != nil {
        return "MTK firmware"
    }
    if let appVersion = stringValue(values, "appVersion") {
        return "ASG app \(appVersion)"
    }
    return "not reported"
}

func rssiLabel(_ values: [String: Any]) -> String {
    intValue(values, "signalStrength").map { "\($0) dBm" } ?? "Unknown"
}

func bluetoothSearchLabel(_ values: [String: Any]) -> String {
    let count = (values["searchResults"] as? [[String: Any]])?.count ?? 0
    return "\(boolValue(values, "searching") == true ? "Scanning" : "Idle") · \(count) result\(count == 1 ? "" : "s")"
}

func hasSavedConnectionTarget(_ values: [String: Any]) -> Bool {
    guard let model = stringValue(values, "default_wearable"), !model.isEmpty else { return false }
    guard let name = stringValue(values, "device_name"), !name.isEmpty else { return false }
    return true
}

func savedConnectionTargetName(_ values: [String: Any]) -> String {
    stringValue(values, "device_name") ?? "Saved glasses"
}

func savedConnectionTargetDetail(_ values: [String: Any]) -> String {
    let model = stringValue(values, "default_wearable") ?? "Saved model"
    return "\(model) · BluetoothSdk.connectDefault()"
}

func wifiScanResults(_ values: [String: Any]) -> [[String: Any]] {
    values["wifiScanResults"] as? [[String: Any]] ?? []
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

func disconnectedGlassesValues() -> [String: Any] {
        [
            "connected": false,
            "connectionState": "DISCONNECTED",
            "fullyBooted": false,
            "batteryLevel": -1,
            "charging": false,
            "hotspotEnabled": false,
            "hotspotGatewayIp": "",
            "hotspotPassword": "",
            "hotspotSsid": "",
            "wifiConnected": false,
            "wifiSsid": "",
            "wifiLocalIp": "",
    ]
}

func summarize(_ values: [String: Any]) -> String {
    let parts = values.prefix(3).map { "\($0.key): \($0.value)" }
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

func checkLocalRtmpServer(rtmpUrl: String) async throws {
    guard isValidRtmpUrl(rtmpUrl) else {
        throw ExampleActionError(message: "Enter a valid rtmp:// or rtmps:// publish URL.")
    }
    guard let previewUrl = rtmpHlsPreviewUrl(rtmpUrl) else { return }
    try await checkHttpPreviewServer(url: previewUrl, setupMessage: localRtmpSetupMessage)
}

func checkLocalWebrtcServer(whipUrl: String) async throws {
    guard let previewUrl = webrtcPreviewUrl(whipUrl) else {
        throw ExampleActionError(message: "Enter a valid http:// or https:// WHIP URL.")
    }
    try await checkHttpPreviewServer(url: previewUrl, setupMessage: localWebrtcSetupMessage)
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

func isValidRtmpUrl(_ rtmpUrlText: String) -> Bool {
    guard let components = URLComponents(string: rtmpUrlText) else { return false }
    return (components.scheme == "rtmp" || components.scheme == "rtmps") && components.host != nil
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

func localRtmpSetupMessage(_ detail: String) -> String {
    "Local RTMP/HLS server not reachable (\(detail)). Run python3 examples/local-demo-cloud/server.py and paste the printed RTMP publish URL."
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
