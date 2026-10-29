import Foundation

/// One random id per app install, shared by usage analytics (as the PostHog
/// `distinct_id`) and the startup update check, so both describe the same install.
/// It is created on first use whether or not analytics is enabled.
enum BluetoothSdkInstallId {
    /// The key analytics has always stored its distinct id under; existing installs keep their id.
    static let defaultsKey = "mentra_bluetooth_sdk_analytics_distinct_id"
    private static let lock = NSLock()

    static func get(defaults: UserDefaults = .standard) -> String {
        lock.lock()
        defer { lock.unlock() }
        if let existing = defaults.string(forKey: defaultsKey), !existing.isEmpty {
            return existing
        }
        let generated = "mentra-bt-sdk-\(UUID().uuidString)"
        defaults.set(generated, forKey: defaultsKey)
        return generated
    }
}
