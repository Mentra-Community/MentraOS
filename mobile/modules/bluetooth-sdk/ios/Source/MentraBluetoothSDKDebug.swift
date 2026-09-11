import Foundation

@MainActor
public enum MentraBluetoothSDKDebug {
    public static func setOtaVersionUrl(_ otaVersionUrl: String, on sdk: MentraBluetoothSDK) throws {
        try sdk.setOtaVersionUrl(otaVersionUrl)
    }

    public static func getOtaVersionUrl(on sdk: MentraBluetoothSDK) throws -> String {
        try sdk.getOtaVersionUrl()
    }
}
