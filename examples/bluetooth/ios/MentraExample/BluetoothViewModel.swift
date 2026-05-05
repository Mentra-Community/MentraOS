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
    var errorDescription: String? { message }
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
final class BluetoothViewModel: NSObject, ObservableObject, MentraBluetoothSDKDelegate {
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
    @Published var streamProtocol: ExampleStreamProtocol = .rtmp
    @Published var streamUrl = ExampleStreamProtocol.rtmp.defaultUrl
    @Published private(set) var streamStartedAt: Date?
    @Published private(set) var streamStatus = "Ready to start stream"
    @Published private(set) var hotspotEnabled = false
    @Published private(set) var micRecording = false
    @Published private(set) var pcmFrames = 0
    @Published private(set) var pcmBytes = 0
    @Published private(set) var ledMode = "Solid"
    @Published var rawJsonExpanded = false

    private let sdk = MentraBluetoothSDK()
    private var activePhotoRequestId: String?
    private var activeStreamId: String?
    private var pollGeneration = 0
    private var keepAliveTask: Task<Void, Never>?

    var glassesConnected: Bool {
        isGlassesConnected(glassesValues)
    }

    override init() {
        super.init()
        sdk.delegate = self
        glassesValues = sdk.glassesStatus.values
        bluetoothValues = sdk.bluetoothStatus.values
        if let value = ProcessInfo.processInfo.environment["MENTRA_PHOTO_WEBHOOK_URL"] {
            webhookUrl = value
        }
    }

    deinit {
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
            } else {
                sdk.connectDefault()
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
        runAction("Disconnect") {
            stopKeepAlive()
            sdk.disconnect()
            activeStreamId = nil
            applyDisconnectedState(status: "Disconnected")
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

    func applySettings() {
        runAction("Apply Settings") {
            try requireConnected("apply settings")
            Task {
                try? await sdk.setBrightness(72)
                try? await sdk.setDashboardPosition(MentraDashboardPositionRequest(height: 4, depth: 6))
                try? await sdk.setGalleryMode(.auto)
                try? await sdk.setButtonPhotoSettings(MentraButtonPhotoSettings(size: .medium))
                try? await sdk.setButtonVideoRecordingSettings(MentraButtonVideoRecordingSettings(width: 1920, height: 1080, fps: 30))
                try? await sdk.setButtonCameraLed(enabled: true)
                try? await sdk.setButtonMaxRecordingTime(minutes: 5)
                try? await sdk.setCameraFov(.standard)
            }
        }
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
                    size: "medium",
                    webhookUrl: uploadUrl,
                    compress: "medium",
                    flash: false,
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
                    guard (200..<300).contains(http.statusCode) else {
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
            let params: [String: Any] = [
                "type": "start_stream",
                "streamUrl": url,
                "streamId": streamId,
                "protocol": selectedProtocol.rawValue,
                "keepAlive": true,
                "keepAliveIntervalSeconds": 15,
            ]
            if selectedProtocol == .rtmp || selectedProtocol == .webrtc {
                startStream(params, protocol: selectedProtocol)
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
                        if activeStreamId == stringValue(params, "streamId") {
                            streamStatus = "Stream requested; preview unavailable: \(message)"
                        }
                    }
                }
                return
            }
            startStream(params, protocol: selectedProtocol)
        }
    }

    private func startStream(_ params: [String: Any], protocol selectedProtocol: ExampleStreamProtocol) {
        sdk.startStream(MentraStreamRequest(values: params))
        activeStreamId = stringValue(params, "streamId")
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
            if requiresPassword && password.isEmpty {
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
            let next = !hotspotEnabled
            sdk.setHotspotState(enabled: next)
            hotspotEnabled = next
        }
    }

    func toggleMic() {
        runAction(micRecording ? "Stop microphone" : "Start microphone") {
            try requireConnected("stream microphone audio")
            let next = !micRecording
            sdk.setMicState(MentraMicConfiguration(sendPcmData: next, sendTranscript: false, bypassVad: true))
            micRecording = next
            if next {
                pcmFrames = 0
                pcmBytes = 0
            }
        }
    }

    func selectLedMode(_ mode: String) {
        runAction("RGB LED \(mode)") {
            try requireConnected("control the RGB LED")
            ledMode = mode
            sdk.rgbLedControl(
                MentraRgbLedRequest(
                    requestId: "rgb-\(Int(Date().timeIntervalSince1970 * 1000))",
                    packageName: "com.mentra.examples.ios",
                    action: mode == "Off" ? "off" : mode.lowercased(),
                    color: mode == "Off" ? nil : "#34C759",
                    ontime: mode == "Pulse" ? 600 : 1000,
                    offtime: mode == "Blink" ? 400 : 0,
                    count: mode == "Blink" ? 5 : 1
                )
            )
        }
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateGlassesStatus status: MentraGlassesStatusUpdate) {
        glassesValues.merge(status.values) { _, new in new }
        if isDisconnectedStatus(status.values) {
            applyDisconnectedState(status: "Disconnected")
        }
        append(tag: "STORE", text: summarize(status.values))
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateBluetoothStatus status: MentraBluetoothStatusUpdate) {
        bluetoothValues.merge(status.values) { _, new in new }
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
        if case let .raw(name, values) = event {
            handleRawEvent(name: name, values: values)
        } else {
            append(tag: "LIVE", text: event.description)
        }
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicPcm frame: Data) {
        pcmFrames += 1
        pcmBytes += frame.count
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicLc3 frame: Data) {
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

    private func applyDisconnectedState(status: String) {
        glassesValues = disconnectedGlassesValues()
        stopKeepAlive()
        activeStreamId = nil
        streamStartedAt = nil
        streamStatus = status
        micRecording = false
        hotspotEnabled = false
        if activePhotoRequestId != nil {
            activePhotoRequestId = nil
            pollGeneration += 1
            cameraStatus = "Disconnected before photo upload completed"
        }
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
            for attempt in 0..<45 {
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
                        values: [
                            "type": "keep_stream_alive",
                            "streamId": streamId,
                            "ackId": "ack-\(Int(Date().timeIntervalSince1970 * 1000))",
                        ]
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
    stringValue(values, "appVersion") ?? stringValue(values, "fwVersion") ?? stringValue(values, "mtkFwVersion") ?? stringValue(values, "besFwVersion") ?? "Unknown"
}

func rssiLabel(_ values: [String: Any]) -> String {
    intValue(values, "signalStrength").map { "\($0) dBm" } ?? "Unknown"
}

func bluetoothSearchLabel(_ values: [String: Any]) -> String {
    let count = (values["searchResults"] as? [[String: Any]])?.count ?? 0
    return "\(boolValue(values, "searching") == true ? "Scanning" : "Idle") · \(count) result\(count == 1 ? "" : "s")"
}

func wifiScanResults(_ values: [String: Any]) -> [[String: Any]] {
    values["wifiScanResults"] as? [[String: Any]] ?? []
}

func elapsedText(_ date: Date?) -> String {
    guard let date else { return "00:00:00" }
    let seconds = max(0, Int(Date().timeIntervalSince(date)))
    return String(format: "%02d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
}

func disconnectedGlassesValues() -> [String: Any] {
    [
        "connected": false,
        "connectionState": "DISCONNECTED",
        "fullyBooted": false,
        "batteryLevel": -1,
        "charging": false,
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
    return parts.count == 4 && parts[0] == 172 && (16...31).contains(parts[1])
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
       scheme == "rtmp" || scheme == "rtmps" {
        let pathSegments = components.path.split(separator: "/").filter { !$0.isEmpty }
        if pathSegments.count < 2 {
            return "RTMP URL must include an app and stream key, for example rtmp://<computer-ip>:1935/live/mentra-live."
        }
    }
    return nil
}
