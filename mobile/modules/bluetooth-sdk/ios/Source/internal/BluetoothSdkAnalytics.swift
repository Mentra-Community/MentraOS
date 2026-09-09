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
    private var tracker = BluetoothSdkAnalyticsTracker(simulatedModel: DeviceTypes.SIMULATED)
    private var startedCaptured = false
    // Touched only on transportQueue, which serializes access.
    private var resolvedHostProperties: [String: Any]?
    private lazy var retryQueue: BluetoothSdkAnalyticsQueue? =
        BluetoothSdkAnalyticsQueue.defaultFileURL().map { BluetoothSdkAnalyticsQueue(fileURL: $0) }
    private let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    init(configuration: BluetoothSdkAnalyticsConfiguration) {
        self.configuration = configuration.resolvedForApp()
    }

    func initializeGlassesStatus(_ status: GlassesStatus) {
        stateQueue.sync {
            tracker.initialize(status.analyticsSnapshot, utcDay: BluetoothSdkAnalyticsTracker.utcDay())
        }
    }

    func captureStarted() {
        stateQueue.sync {
            guard !startedCaptured, configuration.isReady else { return }
            startedCaptured = true
            capture(event: "bluetooth_sdk_started", properties: ["event_kind": "sdk_started"], configuration: configuration)
            // A fresh runtime is the natural moment to retry what an earlier one could not deliver.
            transportQueue.async { self.drainRetryQueue(now: Date()) }
        }
    }

    func observeGlassesStatus(_ status: GlassesStatus) {
        stateQueue.sync {
            let events = tracker.observe(status.analyticsSnapshot, utcDay: BluetoothSdkAnalyticsTracker.utcDay())
            guard configuration.isReady else { return }
            for event in events {
                capture(event: event.name, properties: event.properties, configuration: configuration)
            }
        }
    }

    private func capture(
        event: String,
        properties: [String: Any],
        configuration activeConfiguration: BluetoothSdkAnalyticsConfiguration
    ) {
        guard activeConfiguration.isReady else { return }
        // Identity and time are fixed at capture, not at (re)send, so a retried
        // event neither double counts nor drifts into a later week.
        let uuid = UUID().uuidString.lowercased()
        let capturedAt = Date()

        transportQueue.async {
            // Host facts are resolved once, on the transport queue: Bundle lookups
            // must not run on the caller (often the Bluetooth status thread).
            let host = self.transportQueueHostProperties()
            let payload: [String: Any] = [
                "api_key": Self.defaultPostHogApiKey,
                "uuid": uuid,
                "event": event,
                "distinct_id": self.distinctId(),
                "timestamp": self.isoFormatter.string(from: capturedAt),
                "properties": self.baseProperties(configuration: activeConfiguration)
                    .merging(host) { _, new in new }
                    .merging(properties) { _, new in new },
            ]
            if self.send(payload) {
                self.drainRetryQueue(now: capturedAt)
            } else {
                self.retryQueue?.enqueue(payload, now: capturedAt)
            }
        }
    }

    /// Only ever called from `transportQueue`.
    private func drainRetryQueue(now: Date) {
        retryQueue?.drain(now: now) { payload in self.send(payload) }
    }

    /// Synchronous on purpose: it runs on the transport queue, and a serialized
    /// send keeps retry ordering trivial. Returns true only for a 2xx response.
    private func send(_ payload: [String: Any]) -> Bool {
        guard JSONSerialization.isValidJSONObject(payload),
              let body = try? JSONSerialization.data(withJSONObject: payload),
              let captureURL = captureURL()
        else { return false }
        var request = URLRequest(url: captureURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 4
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let semaphore = DispatchSemaphore(value: 0)
        var succeeded = false
        URLSession.shared.dataTask(with: request) { _, response, error in
            if error == nil, let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) {
                succeeded = true
            }
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 6)
        return succeeded
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

    /// Only ever called from `transportQueue`, which serializes access.
    private func transportQueueHostProperties() -> [String: Any] {
        if let resolvedHostProperties { return resolvedHostProperties }
        let resolved = BluetoothSdkAnalyticsHost.resolve().properties
        resolvedHostProperties = resolved
        return resolved
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
    var analyticsSnapshot: AnalyticsGlassesSnapshot {
        AnalyticsGlassesSnapshot(
            connected: connectionState.isConnected || connected || fullyBooted,
            fullyBooted: fullyBooted,
            model: deviceModel,
            serialNumber: serialNumber,
            firmwareVersion: firmwareVersion,
            besFirmwareVersion: besFirmwareVersion,
            mtkFirmwareVersion: mtkFirmwareVersion,
            androidVersion: androidVersion,
            appVersion: appVersion,
            buildNumber: buildNumber
        )
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
