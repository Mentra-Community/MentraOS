import Combine
import Foundation
import MentraBluetoothSDK

@MainActor
final class BluetoothViewModel: NSObject, ObservableObject, MentraBluetoothSDKDelegate {
    @Published var statusSummary = "Not connected"
    @Published private(set) var logText = "SDK ready. Start a scan to find Mentra Live glasses."

    private let sdk = MentraBluetoothSDK()
    private var latestDevice: MentraDiscoveredDevice?

    override init() {
        super.init()
        sdk.delegate = self
    }

    deinit {
        sdk.invalidate()
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

    private func append(_ message: String) {
        logText += "\n\(message)"
    }
}
