import Foundation

public struct BluetoothSdkAnalyticsConfiguration {
    public static let disabled = BluetoothSdkAnalyticsConfiguration(enabled: false)

    public let enabled: Bool
    let surface: String

    public init(enabled: Bool = true) {
        self.enabled = enabled
        #if os(macOS)
        surface = "macos"
        #else
        surface = "ios"
        #endif
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
    // Delivery is process-wide (see BluetoothSdkAnalyticsTransport); this instance only tracks its connection.
    private let transportQueue = BluetoothSdkAnalyticsTransport.queue
    private let configuration: BluetoothSdkAnalyticsConfiguration
    // Tracker state is touched from the MainActor facade and store listeners;
    // stateQueue serializes every read and write of it.
    private var tracker = BluetoothSdkAnalyticsTracker(simulatedModel: DeviceTypes.SIMULATED)
    private var usage = BluetoothSdkUsageTracker()
    private var startedCaptured = false
    private var lastGlasses: AnalyticsGlassesSnapshot?
    /// Set by an SDK disconnect/forget/cancel call and consumed by the next
    /// connected -> disconnected transition, so that transition can say why.
    private var pendingDisconnectReason: String?
    // Touched only on transportQueue, which serializes access.
    private var resolvedHostProperties: [String: Any]?
    private var retryQueue: BluetoothSdkAnalyticsQueue? {
        BluetoothSdkAnalyticsTransport.retryQueue
    }

    private let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    init(configuration: BluetoothSdkAnalyticsConfiguration) {
        self.configuration = configuration.resolvedForApp()
    }

    /// False when the host disabled analytics; callers skip building usage facts entirely.
    var isEnabled: Bool {
        configuration.isReady
    }

    func initializeGlassesStatus(_ status: GlassesStatus) {
        stateQueue.sync {
            let snapshot = status.analyticsSnapshot
            lastGlasses = snapshot
            tracker.initialize(snapshot, reportingDay: BluetoothSdkAnalyticsTracker.reportingDay())
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

    func observeGlassesStatus(_ status: GlassesStatus, phoneBluetoothOff: () -> Bool) {
        stateQueue.sync {
            let snapshot = status.analyticsSnapshot
            lastGlasses = snapshot
            let now = Date()
            let events = tracker.observe(
                snapshot,
                reportingDay: BluetoothSdkAnalyticsTracker.reportingDay(date: now),
                nowMs: Self.epochMillis(now)
            ) {
                pendingDisconnectReason
                    ?? (phoneBluetoothOff()
                        ? BluetoothSdkAnalyticsTracker.disconnectBluetoothOff
                        : BluetoothSdkAnalyticsTracker.disconnectLinkLost)
            }
            if !snapshot.connected || events.contains(where: { $0.name == "bluetooth_sdk_glasses_connected" }) {
                pendingDisconnectReason = nil
            }
            guard configuration.isReady else { return }
            for event in events {
                capture(event: event.name, properties: event.properties, configuration: configuration)
            }
        }
    }

    func noteDisconnectRequested(_ reason: String) {
        stateQueue.sync {
            if lastGlasses?.connected == true { pendingDisconnectReason = reason }
        }
    }

    func recordUsage(_ build: (inout BluetoothSdkUsageTracker) -> AnalyticsEvent?) {
        stateQueue.sync {
            guard configuration.isReady, let event = build(&usage) else { return }
            capture(
                event: event.name,
                properties: glassesContext().merging(event.properties) { _, new in new },
                configuration: configuration
            )
        }
    }

    /// Usage-tracker state changes that emit nothing themselves (e.g. a stop request).
    func updateUsage(_ update: (inout BluetoothSdkUsageTracker) -> Void) {
        stateQueue.sync {
            guard configuration.isReady else { return }
            update(&usage)
        }
    }

    static func epochMillis(_ date: Date = Date()) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
    }

    /// Only ever called on `stateQueue`.
    private func glassesContext() -> [String: Any] {
        guard let glasses = lastGlasses, glasses.connected else { return [:] }
        var context: [String: Any] = [:]
        if !glasses.model.isBlank { context["glasses_model"] = glasses.model }
        if let serial = glasses.serialNumber.validManufacturingSerial { context["glasses_device_id"] = serial }
        if !glasses.buildNumber.isBlank { context["glasses_build_number"] = glasses.buildNumber }
        return context
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
                "distinct_id": BluetoothSdkInstallId.get(),
                "timestamp": self.isoFormatter.string(from: capturedAt),
                "properties": self.baseProperties(configuration: activeConfiguration)
                    .merging(host) { _, new in new }
                    .merging(properties) { _, new in new },
            ]
            switch self.send(payload) {
            case .delivered: self.drainRetryQueue(now: capturedAt)
            case .retry: self.retryQueue?.enqueue(payload, now: capturedAt)
            case .discard: break
            }
        }
    }

    /// Only ever called from `transportQueue`.
    private func drainRetryQueue(now: Date) {
        retryQueue?.drain(now: now) { payload in self.send(payload) }
    }

    /// Synchronous on purpose: it runs on the transport queue, and one request in
    /// flight at a time keeps retry ordering trivial. The completion handler owns the
    /// outcome; if it has not fired by the deadline the task is cancelled and the
    /// payload is treated as retryable (its uuid makes a late duplicate harmless).
    private func send(_ payload: [String: Any]) -> SendOutcome {
        guard JSONSerialization.isValidJSONObject(payload),
              let body = try? JSONSerialization.data(withJSONObject: payload),
              let captureURL = captureURL()
        else { return .discard }
        var request = URLRequest(url: captureURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 4
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let result = SendResult()
        let task = URLSession.shared.dataTask(with: request) { _, response, error in
            let outcome: SendOutcome
            if error != nil {
                outcome = .retry
            } else if let http = response as? HTTPURLResponse {
                outcome = SendOutcome.fromHTTPStatus(http.statusCode)
            } else {
                outcome = .retry
            }
            result.complete(outcome)
        }
        task.resume()
        if result.wait(timeout: .now() + 6) == .timedOut {
            task.cancel()
        }
        return result.outcome
    }

    private func baseProperties(configuration: BluetoothSdkAnalyticsConfiguration) -> [String: Any] {
        #if os(macOS)
        let platform = "macos"
        #else
        let platform = "ios"
        #endif
        var properties: [String: Any] = [
            "$process_person_profile": false,
            "event_source": "mentra_bluetooth_sdk",
            "sdk_platform": platform,
            "sdk_surface": configuration.surface,
            "app_identifier": Bundle.main.bundleIdentifier ?? "",
            "app_bundle_identifier": Bundle.main.bundleIdentifier ?? "",
            "os_platform": platform,
            "os_version": ProcessInfo.processInfo.operatingSystemVersionString,
            "phone_manufacturer": "Apple",
            "locale": Locale.current.identifier.replacingOccurrences(of: "_", with: "-"),
            "timezone": TimeZone.current.identifier,
        ]
        if let phoneModel = Self.phoneModel { properties["phone_model"] = phoneModel }
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

    /// The hardware identifier (e.g. `iPhone15,2`), not the user-assigned device name.
    private static let phoneModel: String? = {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machine = withUnsafeBytes(of: &systemInfo.machine) { buffer in
            String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
        }
        return machine.isEmpty ? nil : machine
    }()

    private func captureURL() -> URL? {
        let normalized = Self.defaultPostHogHost.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: "\(normalized)/i/v0/e/")
    }
}

/// Completion-owned send result: the outcome is written once, under a lock, and
/// read only after the semaphore says it is settled (or after a timeout, in which
/// case it stays `.retry`).
private final class SendResult {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var settled: SendOutcome = .retry

    var outcome: SendOutcome {
        lock.lock()
        defer { lock.unlock() }
        return settled
    }

    func complete(_ outcome: SendOutcome) {
        lock.lock()
        settled = outcome
        lock.unlock()
        semaphore.signal()
    }

    func wait(timeout: DispatchTime) -> DispatchTimeoutResult {
        semaphore.wait(timeout: timeout)
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
            buildNumber: buildNumber,
            batteryLevel: batteryLevel,
            charging: charging
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
