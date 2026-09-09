import Foundation

/// Host-app facts attached to every analytics event so Mentra can separate
/// store installs from TestFlight, ad-hoc, development, and simulator builds.
struct BluetoothSdkAnalyticsHostProperties {
    let appVersion: String?
    let appBuild: String?
    let buildType: String
    let installSource: String
    let environment: String?

    var properties: [String: Any] {
        var values: [String: Any] = [
            "app_build_type": buildType,
            "app_install_source": installSource,
        ]
        if let appVersion { values["app_version"] = appVersion }
        if let appBuild { values["app_build"] = appBuild }
        if let environment { values["app_environment"] = environment }
        return values
    }
}

enum BluetoothSdkAnalyticsHost {
    /// Optional host-declared lane (`dev`, `staging`, `prod`, ...). Stamped by the
    /// Expo config plugin's `analytics.environment` option; native apps may set it directly.
    static let infoEnvironmentKey = "MentraBluetoothSdkAnalyticsEnvironment"

    /// An embedded provisioning profile only exists in development, ad-hoc, and
    /// enterprise builds, so it is checked before the receipt: TestFlight and App
    /// Store builds carry no profile, and TestFlight is the only one of those two
    /// whose receipt file is named `sandboxReceipt`.
    static func installSource(
        isSimulator: Bool,
        hasEmbeddedProvisioningProfile: Bool,
        receiptFileName: String?
    ) -> String {
        if isSimulator { return "simulator" }
        if hasEmbeddedProvisioningProfile { return "adhoc_or_dev" }
        if receiptFileName == "sandboxReceipt" { return "testflight" }
        return "app_store"
    }

    static func normalizedEnvironment(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !value.isEmpty, value.count <= 32 else { return nil }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789_-")
        guard value.unicodeScalars.allSatisfy({ allowed.contains($0) }),
              let first = value.unicodeScalars.first,
              first != "_", first != "-"
        else { return nil }
        return value
    }

    static func resolve(bundle: Bundle = .main) -> BluetoothSdkAnalyticsHostProperties {
        #if targetEnvironment(simulator)
            let isSimulator = true
        #else
            let isSimulator = false
        #endif
        #if DEBUG
            let buildType = "debug"
        #else
            let buildType = "release"
        #endif
        let info = bundle.infoDictionary ?? [:]
        return BluetoothSdkAnalyticsHostProperties(
            appVersion: nonBlank(info["CFBundleShortVersionString"] as? String),
            appBuild: nonBlank(info["CFBundleVersion"] as? String),
            buildType: buildType,
            installSource: installSource(
                isSimulator: isSimulator,
                hasEmbeddedProvisioningProfile: bundle.path(forResource: "embedded", ofType: "mobileprovision") != nil,
                receiptFileName: bundle.appStoreReceiptURL?.lastPathComponent
            ),
            environment: normalizedEnvironment(info[infoEnvironmentKey] as? String)
        )
    }

    private static func nonBlank(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
