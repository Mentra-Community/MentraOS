import Foundation

public struct BluetoothSdkAnalyticsConfiguration {
    public static let disabled = BluetoothSdkAnalyticsConfiguration(enabled: false)

    public let enabled: Bool
    let surface: String

    public init(enabled: Bool = true) {
        self.enabled = enabled
        surface = "ios"
    }

    var isReady: Bool {
        enabled
    }

    func withSurface(_ surface: String) -> BluetoothSdkAnalyticsConfiguration {
        BluetoothSdkAnalyticsConfiguration(
            enabled: enabled,
            surface: surface
        )
    }

    private init(
        enabled: Bool,
        surface: String
    ) {
        self.enabled = enabled
        self.surface = surface
    }
}

final class BluetoothSdkAnalytics {
    private static let defaultPostHogApiKey = "phc_FCweXVAxVgU7wZK4Fk3okOx4RmyNqVHJf62YpZSfJt5"
    private static let defaultPostHogHost = "https://us.i.posthog.com"
    private let stateQueue = DispatchQueue(label: "com.mentra.bluetoothsdk.analytics.state")
    private let transportQueue = DispatchQueue(label: "com.mentra.bluetoothsdk.analytics.transport")
    private let configuration: BluetoothSdkAnalyticsConfiguration
    private var startedCaptured = false
    private var lastConnected = false
    private var identifiedCapturedForConnection = false

    init(configuration: BluetoothSdkAnalyticsConfiguration) {
        self.configuration = configuration.resolvedForApp()
    }

    func initializeGlassesStatus(_ status: GlassesStatus) {
        stateQueue.sync {
            lastConnected = status.analyticsConnected
            // Only treat identification as already captured when a valid serial is
            // present at init. If the glasses are connected but the serial has not
            // arrived yet (Mentra Live fills it via version_info after connect), leave
            // this false so the identify event still fires once the serial arrives.
            identifiedCapturedForConnection =
                status.analyticsConnected && status.serialNumber.validManufacturingSerial != nil
        }
    }

    func captureStarted() {
        stateQueue.sync {
            captureStartedLocked()
        }
    }

    private func captureStartedLocked() {
        guard !startedCaptured, configuration.isReady else { return }
        startedCaptured = true
        capture(
            event: "bluetooth_sdk_started",
            properties: ["event_kind": "sdk_started"],
            configuration: configuration
        )
    }

    func observeGlassesStatus(_ status: GlassesStatus) {
        stateQueue.sync {
            let isConnected = status.analyticsConnected
            let wasConnected = lastConnected
            lastConnected = isConnected
            guard configuration.isReady else { return }
            guard isConnected else {
                identifiedCapturedForConnection = false
                return
            }
            if isConnected, !wasConnected {
                identifiedCapturedForConnection = false
                var properties: [String: Any] = [
                    "event_kind": "glasses_connected",
                    "fully_booted": status.fullyBooted,
                ]
                if !status.deviceModel.isEmpty {
                    properties["glasses_model"] = status.deviceModel
                }
                properties["glasses_is_simulated"] = status.deviceModel == DeviceTypes.SIMULATED
                capture(event: "bluetooth_sdk_glasses_connected", properties: properties, configuration: configuration)
                // Fall through: a serial already present at connect time (G1/Ar99
                // report it in the advertisement) should be identified now rather than
                // waiting for some later, unrelated glasses-store update to run.
            }

            guard !identifiedCapturedForConnection,
                  let serialNumber = status.serialNumber.validManufacturingSerial
            else { return }
            identifiedCapturedForConnection = true
            var properties: [String: Any] = [
                "event_kind": "glasses_identified",
                "fully_booted": status.fullyBooted,
                "glasses_device_id": serialNumber,
                "glasses_device_id_type": "manufacturing_serial",
            ]
            if !status.deviceModel.isEmpty {
                properties["glasses_model"] = status.deviceModel
            }
            properties["glasses_is_simulated"] = status.deviceModel == DeviceTypes.SIMULATED
            properties.merge(glassesSoftwareProperties(status)) { _, new in new }
            capture(event: "bluetooth_sdk_glasses_identified", properties: properties, configuration: configuration)
        }
    }

    private func capture(
        event: String,
        properties: [String: Any],
        configuration activeConfiguration: BluetoothSdkAnalyticsConfiguration
    ) {
        guard activeConfiguration.isReady else { return }

        transportQueue.async {
            // Host facts are resolved once, on the transport queue: Bundle lookups
            // must not run on the caller (often the Bluetooth status thread).
            let host = self.transportQueueHostProperties()
            let payload: [String: Any] = [
                "api_key": Self.defaultPostHogApiKey,
                "event": event,
                "distinct_id": self.distinctId(),
                "properties": self.baseProperties(configuration: activeConfiguration)
                    .merging(host) { _, new in new }
                    .merging(properties) { _, new in new },
            ]
            guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
            guard let captureURL = self.captureURL() else { return }
            var request = URLRequest(url: captureURL)
            request.httpMethod = "POST"
            request.timeoutInterval = 4
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
            URLSession.shared.dataTask(with: request).resume()
        }
    }

    private func baseProperties(configuration: BluetoothSdkAnalyticsConfiguration) -> [String: Any] {
        var properties: [String: Any] = [
            "$process_person_profile": false,
            "event_source": "mentra_bluetooth_sdk",
            "sdk_platform": "ios",
            "sdk_surface": configuration.surface,
            "app_identifier": Bundle.main.bundleIdentifier ?? "",
            "app_bundle_identifier": Bundle.main.bundleIdentifier ?? "",
            "os_platform": "ios",
            "os_version": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        // Always present so version cohorts never collapse into a null bucket. The
        // placeholder shows up only for unstamped source builds (plain SwiftPM checkout).
        properties["sdk_version"] = BluetoothSdkDefaults.sdkVersion ?? "unknown"
        return properties
    }

    private var resolvedHostProperties: [String: Any]?

    /// Only ever called from `transportQueue`, which serializes access.
    private func transportQueueHostProperties() -> [String: Any] {
        if let resolvedHostProperties { return resolvedHostProperties }
        let resolved = BluetoothSdkAnalyticsHost.resolve().properties
        resolvedHostProperties = resolved
        return resolved
    }

    /// Glasses-side software versions, attached to identification only, so identified
    /// glasses can be grouped by firmware. Glasses that never report a serial produce
    /// no identification event; that coverage gap is measured elsewhere.
    private func glassesSoftwareProperties(_ status: GlassesStatus) -> [String: Any] {
        var values: [String: Any] = [:]
        let fields: [(String, String)] = [
            ("glasses_firmware_version", status.firmwareVersion),
            ("glasses_bes_firmware_version", status.besFirmwareVersion),
            ("glasses_mtk_firmware_version", status.mtkFirmwareVersion),
            ("glasses_android_version", status.androidVersion),
            ("glasses_app_version", status.appVersion),
            ("glasses_build_number", status.buildNumber),
        ]
        for (key, value) in fields where !value.trimmingCharacters(in: .whitespaces).isEmpty {
            values[key] = value
        }
        return values
    }

    private func distinctId() -> String {
        let key = "mentra_bluetooth_sdk_analytics_distinct_id"
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
            return existing
        }
        let generated = "mentra-bt-sdk-\(UUID().uuidString)"
        UserDefaults.standard.set(generated, forKey: key)
        return generated
    }

    private func captureURL() -> URL? {
        let normalized = Self.defaultPostHogHost.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: "\(normalized)/i/v0/e/")
    }
}

private extension GlassesStatus {
    var analyticsConnected: Bool {
        connectionState.isConnected || connected || fullyBooted
    }
}

private extension String {
    var validManufacturingSerial: String? {
        let normalized = trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized.contains(where: { $0 != "0" }) else { return nil }
        return normalized
    }
}

private extension BluetoothSdkAnalyticsConfiguration {
    func resolvedForApp() -> BluetoothSdkAnalyticsConfiguration {
        let disabledByApp = Bundle.main.object(forInfoDictionaryKey: "MentraBluetoothSdkAnalyticsDisabled") as? Bool == true

        return BluetoothSdkAnalyticsConfiguration(
            enabled: enabled && !disabledByApp,
            surface: surface
        )
    }
}
