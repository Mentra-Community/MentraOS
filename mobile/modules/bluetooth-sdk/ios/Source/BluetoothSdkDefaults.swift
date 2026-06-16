import Foundation

/// Defaults for the public Bluetooth SDK surface.
enum BluetoothSdkDefaults {
    static var sdkVersion: String? {
        #if SWIFT_PACKAGE
            normalizedSdkVersion("__MENTRA_BLUETOOTH_SDK_VERSION__")
        #else
            packageVersion(from: sdkBundle)
        #endif
    }

    static let voiceActivityDetectionEnabled = false

    private static var sdkBundle: Bundle {
        #if SWIFT_PACKAGE
            Bundle.module
        #else
            Bundle(for: BluetoothSdkBundleToken.self)
        #endif
    }

    private static func packageVersion(from bundle: Bundle) -> String? {
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String

        for candidate in [version, build] {
            if let sdkVersion = normalizedSdkVersion(candidate) {
                return sdkVersion
            }
        }

        return nil
    }

    private static func normalizedSdkVersion(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed != "1.0",
              trimmed != "__MENTRA_BLUETOOTH_SDK_VERSION__"
        else {
            return nil
        }
        return trimmed
    }
}

private final class BluetoothSdkBundleToken {}
