import Foundation

/// Whether the host app lets iOS keep the glasses link working while the app is suspended.
///
/// The SDK keeps a pending reconnection open after the glasses drop the link (for example while
/// their Bluetooth chip restarts during a software update). iOS completes it, and delivers BLE
/// events, only to apps that declare the `bluetooth-central` background mode. A Swift package
/// cannot declare it for the app, so the SDK checks it and warns instead.
enum BluetoothBackgroundMode {
    static let requiredMode = "bluetooth-central"

    /// Platform-independent plist check, so tests exercise it on every host.
    static func declaresBluetoothCentral(_ infoDictionary: [String: Any]?) -> Bool {
        guard let modes = infoDictionary?["UIBackgroundModes"] as? [String] else { return false }
        return modes.contains(requiredMode)
    }

    static func isDeclared(in infoDictionary: [String: Any]?) -> Bool {
        #if os(iOS)
            return declaresBluetoothCentral(infoDictionary)
        #else
            // macOS apps are not suspended the same way and have no background modes.
            return true
        #endif
    }

    static let missingWarning =
        "MentraBluetoothSDK: WARNING Info.plist is missing UIBackgroundModes `bluetooth-central`. "
            + "While the phone is locked or the app is in the background, iOS will not reconnect to "
            + "the glasses after a link drop (for example during a software update) until the app "
            + "is opened. See https://docs.mentraglass.com/bluetooth-sdk/ios#background-operation"
}
