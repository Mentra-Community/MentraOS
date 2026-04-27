import Combine
import Foundation
import MentraBluetoothSDK

@MainActor
final class BluetoothViewModel: NSObject, ObservableObject, MentraBluetoothSDKDelegate {
    @Published var statusSummary = "Not connected"
    @Published var webhookUrl = ""
    @Published private(set) var cameraStatus = "Camera: enter the local webhook /upload URL"
    @Published private(set) var photoPreviewUrl: URL?
    @Published private(set) var logText = "SDK ready. Start a scan to find Mentra Live glasses."

    private let sdk = MentraBluetoothSDK()
    private var latestDevice: MentraDiscoveredDevice?
    private var activePhotoPollRequestId: String?
    private var photoPollTask: Task<Void, Never>?

    override init() {
        super.init()
        sdk.delegate = self
        if let launchWebhookUrl = ProcessInfo.processInfo.environment["MENTRA_PHOTO_WEBHOOK_URL"] {
            webhookUrl = launchWebhookUrl
            append("Loaded webhook URL from MENTRA_PHOTO_WEBHOOK_URL.")
        }
    }

    deinit {
        Task { @MainActor [sdk] in
            sdk.invalidate()
        }
    }

    func scan() {
        latestDevice = nil
        sdk.startScan(model: .mentraLive)
        append("Scanning for Mentra Live glasses...")
    }

    func connect() {
        if let latestDevice {
            sdk.connect(to: latestDevice)
            append("Connecting to \(latestDevice.name)...")
        } else {
            sdk.connectDefault()
            append("No scan result yet. Trying default device...")
        }
    }

    func displayHello() {
        Task {
            do {
                try await sdk.displayText(
                    MentraDisplayTextRequest(
                        text: "Hello from bare iOS",
                        x: 0,
                        y: 0,
                        size: 24
                    )
                )
                append("Sent display text.")
            } catch {
                append("Display failed: \(error)")
            }
        }
    }

    func applyDisplaySettings() {
        Task {
            do {
                try await sdk.setBrightness(60)
                try await sdk.setDashboardPosition(
                    MentraDashboardPositionRequest(height: 4, depth: 6)
                )
                append("Applied brightness and dashboard position.")
            } catch {
                append("Settings failed: \(error)")
            }
        }
    }

    func clearDisplay() {
        Task {
            do {
                try await sdk.clearDisplay()
                append("Cleared display.")
            } catch {
                append("Clear display failed: \(error)")
            }
        }
    }

    func requestWebhookPhoto() {
        let uploadUrlText = webhookUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let uploadUrl = URL(string: uploadUrlText),
              let scheme = uploadUrl.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else {
            cameraStatus = "Camera: enter a webhook URL like http://<computer-ip>:8787/upload"
            append("Webhook photo skipped because the upload URL is missing or invalid.")
            return
        }

        let requestId = nextRequestId(prefix: "photo")
        activePhotoPollRequestId = requestId
        photoPreviewUrl = nil
        cameraStatus = "Camera: webhook upload requested (\(requestId))"

        append("Photo request id: \(requestId)")
        append("Current glasses status: \(sdk.glassesStatus)")
        append("Current Bluetooth status: \(sdk.bluetoothStatus)")

        sdk.requestPhoto(
            MentraPhotoRequest(
                requestId: requestId,
                appId: "com.mentra.examples.ios",
                size: "medium",
                webhookUrl: uploadUrlText,
                authToken: "",
                compress: "medium",
                flash: false,
                sound: true
            )
        )

        append("Requested webhook photo upload: \(requestId) -> \(uploadUrlText).")
        pollPhotoPreview(requestId: requestId, uploadUrl: uploadUrl)
    }

    func disconnect() {
        sdk.disconnect()
        append("Disconnect requested.")
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlassesStatus status: MentraGlassesStatusUpdate) {
        statusSummary = "Glasses: \(status)"
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateBluetoothStatus status: MentraBluetoothStatusUpdate) {
        append("Bluetooth status: \(status)")
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: MentraDiscoveredDevice) {
        latestDevice = device
        append("Discovered \(device.name)")
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didStopScan reason: MentraScanStopReason) {
        append("Scan stopped: \(reason)")
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceive event: MentraBluetoothEvent) {
        if case let .raw(name, values) = event, name == "photo_response" {
            handlePhotoResponse(values)
            return
        }

        append("Event: \(event)")
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicPcm frame: Data) {
        append("PCM frame: \(frame.count) bytes")
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicLc3 frame: Data) {
        append("LC3 frame: \(frame.count) bytes")
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didChangeDefaultDevice device: MentraPairedDevice?) {
        append("Default device: \(String(describing: device))")
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didLog message: String) {
        append(message)
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didFail error: MentraBluetoothError) {
        append("Error: \(error)")
    }

    private func handlePhotoResponse(_ values: [String: Any]) {
        let requestId = stringValue(values, keys: ["requestId", "request_id"])
        if let activePhotoPollRequestId,
           let requestId,
           requestId != activePhotoPollRequestId
        {
            append(
                "Ignoring stale photo response for \(requestId); active request is \(activePhotoPollRequestId). \(summarize(values))"
            )
            return
        }

        let success = values["success"] as? Bool

        if success == false {
            if requestId == activePhotoPollRequestId {
                photoPollTask?.cancel()
                activePhotoPollRequestId = nil
            }

            let errorCode = stringValue(values, keys: ["errorCode", "error_code"]) ?? "unknown_error"
            let errorMessage = stringValue(values, keys: ["errorMessage", "error_message", "error"]) ?? "no details"
            cameraStatus = "Camera: photo failed \(errorCode) - \(errorMessage)"
        } else if requestId == activePhotoPollRequestId {
            cameraStatus = "Camera: photo acknowledged; waiting for local server upload"
        } else {
            cameraStatus = "Camera: photo response received"
        }

        append("Photo response: \(summarize(values))")
    }

    private func pollPhotoPreview(requestId: String, uploadUrl: URL) {
        guard let statusUrl = photoStatusUrl(uploadUrl: uploadUrl, requestId: requestId) else {
            cameraStatus = "Camera: invalid webhook URL"
            return
        }

        photoPollTask?.cancel()
        photoPollTask = Task { @MainActor [weak self] in
            for attempt in 0..<45 {
                guard let self, !Task.isCancelled, self.activePhotoPollRequestId == requestId else {
                    return
                }

                do {
                    let (data, response) = try await URLSession.shared.data(from: statusUrl)
                    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

                    if statusCode == 200,
                       let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let photoUrlText = stringValue(json, keys: ["photoUrl", "photo_url", "url"]),
                       let photoUrl = URL(string: photoUrlText)
                    {
                        self.photoPreviewUrl = photoUrl
                        self.cameraStatus = "Camera: loaded photo preview"
                        self.activePhotoPollRequestId = nil
                        self.append("Local webhook photo ready: \(photoUrlText)")
                        return
                    } else if attempt == 0 || attempt % 10 == 9 {
                        self.append("Waiting for upload \(requestId): local server returned \(statusCode).")
                    }
                } catch {
                    if attempt == 0 || attempt % 10 == 9 {
                        self.append("Waiting for local photo server: \(error.localizedDescription)")
                    }
                }

                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }

            if self?.activePhotoPollRequestId == requestId {
                self?.cameraStatus = "Camera: timed out waiting for local server upload"
                self?.append("Timed out polling local photo server for \(requestId).")
            }
        }
    }

    private func photoStatusUrl(uploadUrl: URL, requestId: String) -> URL? {
        var components = URLComponents()
        components.scheme = uploadUrl.scheme
        components.host = uploadUrl.host
        components.port = uploadUrl.port
        components.path = "/uploads/\(requestId).json"
        return components.url
    }

    private func nextRequestId(prefix: String) -> String {
        "\(prefix)-\(Int(Date().timeIntervalSince1970 * 1000))"
    }

    private func stringValue(_ values: [String: Any], keys: [String]) -> String? {
        for key in keys {
            if let value = values[key] as? String, !value.isEmpty {
                return value
            }
        }

        return nil
    }

    private func summarize(_ values: [String: Any]) -> String {
        values
            .filter { key, _ in !["type", "timestamp", "password", "authToken"].contains(key) }
            .prefix(6)
            .map { key, value in "\(key)=\(value)" }
            .joined(separator: ", ")
    }

    private func append(_ message: String) {
        print(message)
        logText += "\n\(message)"
    }
}
