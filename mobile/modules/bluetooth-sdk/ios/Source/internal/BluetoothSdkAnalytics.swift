import Foundation

public struct BluetoothSdkAnalyticsConfiguration {
    public static let disabled = BluetoothSdkAnalyticsConfiguration(enabled: false)

    public let enabled: Bool
    let surface: String

    public init(enabled: Bool = true) {
        self.enabled = enabled
        surface = "ios"
    }

    init(dictionary: [String: Any], surface: String) {
        enabled = dictionary["enabled"] as? Bool ?? true
        self.surface = surface
    }

    func applying(dictionary: [String: Any], surface: String) -> BluetoothSdkAnalyticsConfiguration {
        BluetoothSdkAnalyticsConfiguration(
            enabled: dictionary["enabled"] as? Bool ?? enabled,
            surface: surface
        )
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
    private var configuration: BluetoothSdkAnalyticsConfiguration
    private var startedCaptured = false
    private var lastConnected = false

    init(configuration: BluetoothSdkAnalyticsConfiguration) {
        self.configuration = configuration.resolvedForApp()
    }

    func configure(_ nextConfiguration: BluetoothSdkAnalyticsConfiguration) {
        stateQueue.sync {
            configuration = nextConfiguration.resolvedForApp()
            captureStartedLocked()
        }
    }

    func configure(dictionary: [String: Any], surface: String) {
        stateQueue.sync {
            configuration = configuration.applying(dictionary: dictionary, surface: surface).resolvedForApp()
            captureStartedLocked()
        }
    }

    func initializeGlassesStatus(_ status: GlassesStatus) {
        stateQueue.sync {
            lastConnected = status.analyticsConnected
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
            // Track the real connection state even while analytics is disabled so that
            // enabling it later cannot fabricate a connection event from stale or
            // pre-existing connected flags; only genuine not-connected -> connected
            // transitions observed while enabled are captured.
            let isConnected = status.analyticsConnected
            let wasConnected = lastConnected
            lastConnected = isConnected
            guard configuration.isReady else { return }
            if isConnected, !wasConnected {
                var properties: [String: Any] = [
                    "event_kind": "glasses_connected",
                    "fully_booted": status.fullyBooted,
                ]
                if !status.deviceModel.isEmpty {
                    properties["glasses_model"] = status.deviceModel
                }
                capture(event: "bluetooth_sdk_glasses_connected", properties: properties, configuration: configuration)
            }
        }
    }

    private func capture(
        event: String,
        properties: [String: Any],
        configuration activeConfiguration: BluetoothSdkAnalyticsConfiguration
    ) {
        guard activeConfiguration.isReady else { return }

        transportQueue.async {
            let payload: [String: Any] = [
                "api_key": Self.defaultPostHogApiKey,
                "event": event,
                "distinct_id": self.distinctId(),
                "properties": self.baseProperties(configuration: activeConfiguration).merging(properties) { _, new in new },
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
            "app_bundle_identifier": Bundle.main.bundleIdentifier ?? "",
            "os_platform": "ios",
            "os_version": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        if let sdkVersion = BluetoothSdkDefaults.sdkVersion {
            properties["sdk_version"] = sdkVersion
        }
        return properties
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

private extension BluetoothSdkAnalyticsConfiguration {
    func resolvedForApp() -> BluetoothSdkAnalyticsConfiguration {
        let disabledByApp = Bundle.main.object(forInfoDictionaryKey: "MentraBluetoothSdkAnalyticsDisabled") as? Bool == true

        return BluetoothSdkAnalyticsConfiguration(
            enabled: enabled && !disabledByApp,
            surface: surface
        )
    }
}
