import Foundation

enum OtaManifestDefaults {
    private static let sdkOtaReleaseBaseUrl = "https://github.com/Mentra-Community/MentraOS/releases/download/bluetooth-sdk-ota"
    // ASG builds before 39 ignore ota_start.ota_version_url, so SDK checks must
    // use the same legacy production manifest those glasses will install from.
    static let legacyProdOtaVersionUrl = "https://ota.mentraglass.com/prod_live_version.json"

    static func defaultOtaVersionUrl() throws -> String {
        guard let sdkVersion = BluetoothSdkDefaults.sdkVersion,
              !sdkVersion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw BluetoothSdkError(
                code: "missing_sdk_version",
                message: "Cannot determine Bluetooth SDK version for the default OTA manifest URL."
            )
        }
        return "\(sdkOtaReleaseBaseUrl)/bluetooth-sdk-\(sdkVersion)-version.json"
    }
}

struct OtaManifestApp: Decodable {
    let versionCode: Int?
}

struct MtkPatch: Decodable {
    let startFirmware: String

    enum CodingKeys: String, CodingKey {
        case startFirmware = "start_firmware"
    }
}

struct BesFirmware: Decodable {
    let version: String?
}

struct OtaManifest: Decodable {
    let apps: [String: OtaManifestApp]?
    let mtkPatches: [MtkPatch]?
    let besFirmware: BesFirmware?
    let versionCode: Int?

    enum CodingKeys: String, CodingKey {
        case apps
        case mtkPatches = "mtk_patches"
        case besFirmware = "bes_firmware"
        case versionCode
    }
}

enum OtaManifestChecker {
    private static let asgClientPackage = "com.mentra.asg_client"

    static func normalizeHttpUrl(_ value: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw BluetoothSdkError(code: "invalid_ota_url", message: "OTA version URL must be a non-empty http(s) URL.")
        }
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              (scheme == "http" || scheme == "https"),
              url.host?.isEmpty == false
        else {
            throw BluetoothSdkError(code: "invalid_ota_url", message: "OTA version URL must be a valid http(s) URL.")
        }
        return url.absoluteString
    }

    static func fetch(_ otaVersionUrl: String) async throws -> OtaManifest {
        guard let url = URL(string: otaVersionUrl) else {
            throw BluetoothSdkError(code: "invalid_ota_url", message: "OTA version URL must be a valid http(s) URL.")
        }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw BluetoothSdkError(code: "ota_manifest_request_failed", message: "OTA manifest request failed.")
        }
        guard (200 ... 299).contains(httpResponse.statusCode) else {
            throw BluetoothSdkError(
                code: "ota_manifest_request_failed",
                message: "OTA manifest request failed with HTTP \(httpResponse.statusCode)."
            )
        }
        return try JSONDecoder().decode(OtaManifest.self, from: data)
    }

    static func hasUpdate(
        currentBuildNumber: String,
        currentMtkVersion: String,
        currentBesVersion: String,
        manifest: OtaManifest
    ) throws -> Bool {
        try hasApkUpdate(currentBuildNumber: currentBuildNumber, manifest: manifest) ||
            hasMtkUpdate(patches: manifest.mtkPatches, currentVersion: currentMtkVersion) ||
            hasBesUpdate(besFirmware: manifest.besFirmware, currentVersion: currentBesVersion)
    }

    static func hasMtkPatches(_ manifest: OtaManifest) -> Bool {
        !(manifest.mtkPatches?.isEmpty ?? true)
    }

    static func hasBesFirmware(_ manifest: OtaManifest) -> Bool {
        manifest.besFirmware != nil
    }

    private static func latestAppInfo(_ manifest: OtaManifest) throws -> OtaManifestApp {
        if let app = manifest.apps?[asgClientPackage], app.versionCode != nil {
            return app
        }
        if let versionCode = manifest.versionCode {
            return OtaManifestApp(versionCode: versionCode)
        }
        throw BluetoothSdkError(code: "invalid_ota_manifest", message: "OTA manifest is missing ASG app versionCode.")
    }

    private static func hasApkUpdate(currentBuildNumber: String, manifest: OtaManifest) throws -> Bool {
        guard let currentVersion = Int(currentBuildNumber) else {
            throw BluetoothSdkError(
                code: "invalid_glasses_version",
                message: "Cannot check OTA update because glasses build number is invalid."
            )
        }
        guard let serverVersion = try latestAppInfo(manifest).versionCode else {
            throw BluetoothSdkError(code: "invalid_ota_manifest", message: "OTA manifest is missing ASG app versionCode.")
        }
        return serverVersion > currentVersion
    }

    private static func hasMtkUpdate(patches: [MtkPatch]?, currentVersion: String) throws -> Bool {
        guard let patches, !patches.isEmpty else { return false }
        guard !currentVersion.isEmpty else { return false }

        return patches.contains { patch in
            if patch.startFirmware == currentVersion {
                return true
            }
            let serverDate = patch.startFirmware.contains("_")
                ? String(patch.startFirmware.split(separator: "_").last ?? "")
                : patch.startFirmware
            return serverDate == currentVersion
        }
    }

    private static func hasBesUpdate(besFirmware: BesFirmware?, currentVersion: String) throws -> Bool {
        guard let besFirmware else { return false }
        guard let serverVersion = besFirmware.version, !serverVersion.isEmpty else {
            throw BluetoothSdkError(code: "invalid_ota_manifest", message: "OTA manifest bes_firmware.version is missing.")
        }
        if currentVersion.isEmpty {
            return true
        }
        return compareVersions(serverVersion, currentVersion) > 0
    }

    private static func compareVersions(_ version1: String, _ version2: String) -> Int {
        if version1.contains("."), version2.contains(".") {
            let parts1 = version1.split(separator: ".").map { Int($0) ?? 0 }
            let parts2 = version2.split(separator: ".").map { Int($0) ?? 0 }
            for index in 0 ..< max(parts1.count, parts2.count) {
                let value1 = index < parts1.count ? parts1[index] : 0
                let value2 = index < parts2.count ? parts2[index] : 0
                if value1 != value2 {
                    return value1 - value2
                }
            }
            return 0
        }
        return version1.compare(version2).rawValue
    }
}
