import AVFoundation
import CoreBluetooth
import CoreLocation
import Foundation

/// A new manager's getter can precede Core Location's initial authorization callback.
/// Keep the manager and delegate alive until that callback, without requesting consent or location updates.
@MainActor
private final class PassiveLocationAuthorization: NSObject, @preconcurrency CLLocationManagerDelegate {
    private var manager: CLLocationManager?
    private var completed: ((CLAuthorizationStatus) -> Void)?

    func start(_ completed: @escaping (CLAuthorizationStatus) -> Void) {
        self.completed = completed
        let manager = CLLocationManager()
        self.manager = manager
        manager.delegate = self
    }

    func stop() {
        manager?.delegate = nil
        manager = nil
        completed = nil
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager === self.manager else { return }
        completed?(manager.authorizationStatus)
    }
}

/// One finite initial callback. Missing initialization stays unknown, including when the task is canceled.
@MainActor
final class InitialLocationAuthorization {
    private var continuation: CheckedContinuation<CLAuthorizationStatus?, Never>?
    private var timeout: Task<Void, Never>?
    private var stop: (() -> Void)?

    func observe(timeoutMs: UInt64 = 5000,
                 start: (@escaping (CLAuthorizationStatus) -> Void) -> Void,
                 stop: @escaping () -> Void) async -> CLAuthorizationStatus? {
        self.stop = stop
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                self.continuation = continuation
                if Task.isCancelled { finish(nil); return }
                timeout = Task { @MainActor in
                    do { try await Task.sleep(nanoseconds: timeoutMs * 1_000_000) }
                    catch { return }
                    self.finish(nil)
                }
                start { self.finish($0) }
            }
        } onCancel: {
            Task { @MainActor in self.finish(nil) }
        }
    }

    private func finish(_ status: CLAuthorizationStatus?) {
        guard let continuation else { return }
        self.continuation = nil
        timeout?.cancel()
        timeout = nil
        stop?()
        stop = nil
        continuation.resume(returning: status)
    }
}

/// Passive app-owned observations. None of these getters requests consent,
/// starts capture, creates a Bluetooth central, or joins a network.
enum PermissionStatusReceipt {
    static let relativePath = "MentraDiagnostics/permission-status.json"

    static func state(_ rawStatus: String, _ status: String) -> [String: String] {
        ["rawStatus": rawStatus, "status": status]
    }

    static func location(_ value: CLAuthorizationStatus) -> [String: String] {
        switch value {
        case .notDetermined: return state("notDetermined", "denied")
        case .denied: return state("denied", "blocked")
        case .restricted: return state("restricted", "unavailable")
        case .authorizedAlways: return state("authorizedAlways", "granted")
        case .authorizedWhenInUse: return state("authorizedWhenInUse", "granted")
        @unknown default: return state("unknown", "unknown")
        }
    }

    static func capture(_ value: AVAuthorizationStatus) -> [String: String] {
        switch value {
        case .notDetermined: return state("notDetermined", "denied")
        case .denied: return state("denied", "blocked")
        case .restricted: return state("restricted", "unavailable")
        case .authorized: return state("authorized", "granted")
        @unknown default: return state("unknown", "unknown")
        }
    }

    static func bluetooth(_ value: CBManagerAuthorization) -> [String: String] {
        switch value {
        case .notDetermined: return state("notDetermined", "denied")
        case .denied: return state("denied", "blocked")
        case .restricted: return state("restricted", "unavailable")
        case .allowedAlways: return state("allowedAlways", "granted")
        @unknown default: return state("unknown", "unknown")
        }
    }

    @MainActor
    private static func initializedLocationStatus() async -> CLAuthorizationStatus? {
        let source = PassiveLocationAuthorization()
        return await InitialLocationAuthorization().observe(start: source.start, stop: source.stop)
    }

    static func current() async -> [String: Any] {
        // The global service getter may block; only the manager's authorization
        // observation belongs to the main actor, which owns Core Location objects.
        let servicesEnabled = CLLocationManager.locationServicesEnabled()
        let locationStatus = await initializedLocationStatus()
        return await MainActor.run {
            let bundle = Bundle.main
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return [
                "schemaVersion": 1,
                "observedAt": formatter.string(from: Date()),
                "identity": [
                    "pid": ProcessInfo.processInfo.processIdentifier,
                    "uid": getuid(),
                    "bundleId": bundle.bundleIdentifier ?? "",
                    "bundlePath": bundle.bundleURL.path,
                    "executablePath": bundle.executableURL?.path ?? "",
                    "version": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                    "build": bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
                ] as [String: Any],
                "locationServicesEnabled": servicesEnabled,
                "permissions": [
                    "location": locationStatus.map(location) ?? state("initializationUnconfirmed", "unknown"),
                    "camera": capture(AVCaptureDevice.authorizationStatus(for: .video)),
                    "microphone": capture(AVCaptureDevice.authorizationStatus(for: .audio)),
                    "bluetooth": bluetooth(CBManager.authorization),
                    // iOS has no public passive Local Network authorization getter.
                    "localNetwork": ["rawStatus": NSNull(), "status": "unknown"],
                ] as [String: Any],
            ]
        }
    }

    static func correlate(_ observation: [String: Any], requestId: String) throws -> [String: Any] {
        guard requestId.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}\\z", options: .regularExpression) != nil else {
            throw NSError(domain: "MentraPermissionStatus", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "One bounded permission request ID is required"])
        }
        return observation.merging(["requestId": requestId]) { _, fresh in fresh }
    }

    static func write(_ receipt: [String: Any], to path: URL) throws {
        let files = FileManager.default
        try files.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true,
                                  attributes: [.posixPermissions: 0o700])
        try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]).write(to: path, options: .atomic)
        try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }

    static func publish(requestId: String) async throws -> [String: Any] {
        // Validate before observing; the request never controls a filesystem path.
        _ = try correlate([:], requestId: requestId)
        let observation = await current()
        let receipt = try correlate(observation, requestId: requestId)
        let cache = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask,
                                                appropriateFor: nil, create: true)
        try write(receipt, to: cache.appendingPathComponent(relativePath))
        return receipt
    }
}
