import Foundation
import MentraBluetoothSDK

#if !MENTRA_SDK_HAS_WIFI_ADB
/// Shim for published MentraBluetoothSDK builds that predate OS-1627.
/// When linking a MentraOS checkout that already has `setWifiAdbState(enabled:)`,
/// add `MENTRA_SDK_HAS_WIFI_ADB` to Swift Active Compilation Conditions and remove
/// this shim (or leave it unused).
extension MentraBluetoothSDK {
    func setWifiAdbState(enabled: Bool) throws {
        throw NSError(
            domain: "MentraExample",
            code: 1627,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "MentraBluetoothSDK.setWifiAdbState is unavailable. Use a Mentra Bluetooth SDK build that includes OS-1627 (or define MENTRA_SDK_HAS_WIFI_ADB when linking MentraOS).",
            ]
        )
    }
}
#endif
