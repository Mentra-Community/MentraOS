import Foundation

/// Defaults for the public Bluetooth SDK surface.
enum BluetoothSdkDefaults {
    static var sdkVersion: String? {
        // Release exports replace the source placeholder; Expo builds stamp the host Info.plist.
        normalizedSdkVersion(swiftPackageSdkVersion)
            ?? normalizedSdkVersion(Bundle.main.object(forInfoDictionaryKey: infoSdkVersionKey) as? String)
    }

    static let voiceActivityDetectionEnabled = false
    static let loudnessGateEnabled = false

    /// Must stay true. The firmware defaults auto power-off on, and we re-push
    /// every Bluetooth setting on connect, so a false default here would
    /// silently disable it on every pair the app touches.
    static let autoPowerOffEnabled = true
    private static let infoSdkVersionKey = "MentraBluetoothSdkVersion"
    private static let swiftPackageSdkVersion = "__MENTRA_BLUETOOTH_SDK_VERSION__"
    private static let swiftPackageSdkVersionPlaceholder = "__MENTRA" + "_BLUETOOTH_SDK_VERSION__"

    private static func normalizedSdkVersion(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed != swiftPackageSdkVersionPlaceholder
        else {
            return nil
        }
        return trimmed
    }
}
