import Foundation
import MentraBluetoothSDK

#if !MENTRA_SDK_HAS_WIFI_ADB
/// Shim for published MentraBluetoothSDK builds that predate OS-1627.
///
/// Default SPM dependency does not ship `setWifiAdbState` yet, so Enable/Disable
/// fail closed with a clear Console error. To exercise the real Mentra Live path:
/// 1. Point the example at MentraOS `mobile/modules/bluetooth-sdk` (see ios/README)
/// 2. Add `MENTRA_SDK_HAS_WIFI_ADB` to Swift Active Compilation Conditions
///
/// Once a published SDK includes the API, remove this shim (or keep the flag).
extension MentraBluetoothSDK {
    func setWifiAdbState(enabled: Bool) throws {
        throw NSError(
            domain: "MentraExample",
            code: 1627,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "MentraBluetoothSDK.setWifiAdbState is unavailable in this SDK build. Link MentraOS bluetooth-sdk (OS-1627) and define MENTRA_SDK_HAS_WIFI_ADB, or upgrade to a published SDK that includes the API.",
            ]
        )
    }
}
#endif
