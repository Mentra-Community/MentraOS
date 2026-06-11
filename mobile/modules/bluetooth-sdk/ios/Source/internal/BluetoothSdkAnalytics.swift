import Foundation

public struct BluetoothSdkAnalyticsConfiguration {
    public static let disabled = BluetoothSdkAnalyticsConfiguration(enabled: false)
    public static let defaultPostHogApiKey = "phc_FCweXVAxVgU7wZK4Fk3okOx4RmyNqVHJf62YpZSfJt5"
    public static let defaultPostHogHost = "https://us.i.posthog.com"

    public let enabled: Bool
    public let postHogApiKey: String?
    public let postHogHost: String
    let surface: String

    public init(
        enabled: Bool = true,
        postHogApiKey: String? = BluetoothSdkAnalyticsConfiguration.defaultPostHogApiKey,
        postHogHost: String = BluetoothSdkAnalyticsConfiguration.defaultPostHogHost
    ) {
        self.enabled = enabled
        self.postHogApiKey = postHogApiKey
        self.postHogHost = postHogHost
        surface = "ios"
    }

    init(dictionary: [String: Any], surface: String) {
        enabled = dictionary["enabled"] as? Bool ?? true
        postHogApiKey = (dictionary["postHogApiKey"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? BluetoothSdkAnalyticsConfiguration.defaultPostHogApiKey
        postHogHost = (dictionary["postHogHost"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? BluetoothSdkAnalyticsConfiguration.defaultPostHogHost
        self.surface = surface
    }

    var isReady: Bool {
        enabled && !(postHogApiKey?.isEmpty ?? true)
    }

    func withSurface(_ surface: String) -> BluetoothSdkAnalyticsConfiguration {
        BluetoothSdkAnalyticsConfiguration(
            enabled: enabled,
            postHogApiKey: postHogApiKey,
            postHogHost: postHogHost,
            surface: surface
        )
    }

    private init(
        enabled: Bool,
        postHogApiKey: String?,
        postHogHost: String,
        surface: String
    ) {
        self.enabled = enabled
        self.postHogApiKey = postHogApiKey
        self.postHogHost = postHogHost
        self.surface = surface
    }
}

final class BluetoothSdkAnalytics {
    private let queue = DispatchQueue(label: "com.mentra.bluetoothsdk.analytics")
    private var configuration: BluetoothSdkAnalyticsConfiguration
    private var startedCaptured = false
    private var lastConnected = false

    init(configuration: BluetoothSdkAnalyticsConfiguration) {
        self.configuration = configuration.resolvedForApp()
    }

    func configure(_ nextConfiguration: BluetoothSdkAnalyticsConfiguration) {
        configuration = nextConfiguration.resolvedForApp()
        captureStarted()
    }

    func captureStarted() {
        guard !startedCaptured, configuration.isReady else { return }
        startedCaptured = true
        capture(event: "bluetooth_sdk_started", properties: ["event_kind": "sdk_started"])
    }

    func observeGlassesStatus(_ status: GlassesStatus) {
        let isConnected = status.connectionState.isConnected || status.connected || status.fullyBooted
        if isConnected && !lastConnected {
            var properties: [String: Any] = [
                "event_kind": "glasses_connected",
                "fully_booted": status.fullyBooted,
            ]
            if !status.deviceModel.isEmpty {
                properties["glasses_model"] = status.deviceModel
            }
            capture(event: "bluetooth_sdk_glasses_connected", properties: properties)
        }
        lastConnected = isConnected
    }

    private func capture(event: String, properties: [String: Any]) {
        let activeConfiguration = configuration
        guard activeConfiguration.isReady, let apiKey = activeConfiguration.postHogApiKey else { return }

        let payload: [String: Any] = [
            "api_key": apiKey,
            "event": event,
            "distinct_id": distinctId(),
            "properties": baseProperties(configuration: activeConfiguration).merging(properties) { _, new in new },
        ]

        queue.async {
            guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
            guard let captureURL = self.captureURL(host: activeConfiguration.postHogHost) else { return }
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

    private func captureURL(host: String) -> URL? {
        let normalized = host.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: "\(normalized)/i/v0/e/")
    }
}

private extension BluetoothSdkAnalyticsConfiguration {
    func resolvedForApp() -> BluetoothSdkAnalyticsConfiguration {
        let disabledByApp = Bundle.main.object(forInfoDictionaryKey: "MentraBluetoothSdkAnalyticsDisabled") as? Bool == true
        let infoApiKey = (Bundle.main.object(forInfoDictionaryKey: "MentraBluetoothSdkPostHogApiKey") as? String)
            .flatMap { $0.isEmpty ? nil : $0 }
        let infoHost = (Bundle.main.object(forInfoDictionaryKey: "MentraBluetoothSdkPostHogHost") as? String)
            .flatMap { $0.isEmpty ? nil : $0 }

        return BluetoothSdkAnalyticsConfiguration(
            enabled: enabled && !disabledByApp,
            postHogApiKey: resolvedPostHogApiKey(infoApiKey: infoApiKey),
            postHogHost: infoHost ?? postHogHost,
            surface: surface
        )
    }

    private func resolvedPostHogApiKey(infoApiKey: String?) -> String? {
        let configuredApiKey = postHogApiKey.flatMap { $0.isEmpty ? nil : $0 }
        if configuredApiKey == nil {
            return infoApiKey ?? BluetoothSdkAnalyticsConfiguration.defaultPostHogApiKey
        }
        if configuredApiKey == BluetoothSdkAnalyticsConfiguration.defaultPostHogApiKey {
            return infoApiKey ?? configuredApiKey
        }
        return configuredApiKey
    }
}
