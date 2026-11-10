import Foundation

enum OtaManifestDefaults {
    // ASG builds before 39 ignore ota_start.ota_version_url, so SDK checks must
    // use the same legacy production manifest those glasses will install from.
    static let legacyProdOtaVersionUrl = "https://ota.mentraglass.com/prod_live_version.json"

    static func defaultOtaVersionUrl() throws -> String {
        let manifestUrl = GeneratedReleaseMetadata.otaManifestUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !manifestUrl.isEmpty else {
            throw BluetoothSdkError(
                code: "ota_manifest_unconfigured",
                message: "This source-built Bluetooth SDK has no embedded OTA manifest. Configure one with the debug API."
            )
        }
        return manifestUrl
    }
}

struct OtaManifestApp: Decodable {
    let versionCode: Int?
}

struct MtkPatch: Decodable {
    let startFirmware: String
    let endFirmware: String?

    enum CodingKeys: String, CodingKey {
        case startFirmware = "start_firmware"
        case endFirmware = "end_firmware"
    }
}

struct BesFirmware: Decodable {
    let version: String?
}

struct MtkFullOta: Decodable {
    let endFirmware: String?
    let hasStartFirmware: Bool
    let url: String?
    let sha256: String?
    let size: Int64?

    enum CodingKeys: String, CodingKey {
        case endFirmware = "end_firmware"
        case startFirmware = "start_firmware"
        case url, sha256, size
    }

    init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        hasStartFirmware = fields.contains(.startFirmware)
        endFirmware = try fields.decodeIfPresent(String.self, forKey: .endFirmware)
        url = try fields.decodeIfPresent(String.self, forKey: .url)
        sha256 = try fields.decodeIfPresent(String.self, forKey: .sha256)
        size = try fields.decodeIfPresent(Int64.self, forKey: .size)
    }
}

struct OtaManifest: Decodable {
    let apps: [String: OtaManifestApp]?
    let mtkPatches: [MtkPatch]?
    let mtkFullOta: MtkFullOta?
    let besFirmware: BesFirmware?
    let versionCode: Int?

    enum CodingKeys: String, CodingKey {
        case apps
        case mtkPatches = "mtk_patches"
        case mtkFullOta = "mtk_full_ota"
        case besFirmware = "bes_firmware"
        case versionCode
    }
}

enum OtaManifestChecker {
    /// Package the stock Mentra glasses client installs as, and the key every apps-shaped
    /// manifest is pinned under. A client reporting any other package is a sideloaded build that
    /// this manifest cannot describe.
    static let asgClientPackage = "com.mentra.asg_client"

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
                message: "OTA manifest request failed with HTTP \(httpResponse.statusCode) for \(otaVersionUrl)."
            )
        }
        return try JSONDecoder().decode(OtaManifest.self, from: data)
    }

    static func hasUpdate(
        currentBuildNumber: String,
        currentMtkVersion: String,
        currentBesVersion: String,
        manifest: OtaManifest,
        // Mentra 3.0 is the oldest downgrade-safe target, matching Engine, ASG, and recovery.
        // Coordinated releases guarantee higher supported ASG builds can downgrade; no source gate is needed.
        // The shipped floor may increase, never decrease, and must stay aligned across all checkers.
        // See asg_client/docs/mentra-live-spec.md#ota-and-updates.
        // An explicit non-positive override still disables downgrades.
        downgradeFloorVersionCode: Int = 51518114
    ) throws -> Bool {
        try hasApkUpdate(
            currentBuildNumber: currentBuildNumber,
            manifest: manifest,
            downgradeFloorVersionCode: downgradeFloorVersionCode
        ) ||
            hasMtkUpdate(patches: manifest.mtkPatches, full: manifest.mtkFullOta, currentVersion: currentMtkVersion) ||
            hasBesUpdate(besFirmware: manifest.besFirmware, currentVersion: currentBesVersion)
    }

    static func hasMtkPatches(_ manifest: OtaManifest) -> Bool {
        !(manifest.mtkPatches?.isEmpty ?? true) || manifest.mtkFullOta != nil
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

    private static func hasApkUpdate(
        currentBuildNumber: String,
        manifest: OtaManifest,
        downgradeFloorVersionCode: Int
    ) throws -> Bool {
        guard let currentVersion = Int(currentBuildNumber) else {
            throw BluetoothSdkError(
                code: "invalid_glasses_version",
                message: "Cannot check OTA update because glasses build number is invalid."
            )
        }
        guard let serverVersion = try latestAppInfo(manifest).versionCode else {
            throw BluetoothSdkError(code: "invalid_ota_manifest", message: "OTA manifest is missing ASG app versionCode.")
        }
        // Only apps-shaped manifests are exact pins. A legacy top-level manifest (versionCode at
        // the root, no apps entry) is NOT a pin and stays strictly upgrade-only, matching the
        // engine TS checker and Kotlin.
        let isExactPin = manifest.apps?[asgClientPackage]?.versionCode != nil
        if !isExactPin {
            return serverVersion > currentVersion
        }
        // Exact pin: any mismatch is an update in either direction (downgrades take the
        // uninstall-then-reinstall detour on the glasses). A non-positive pin is only legitimate
        // in the frozen legacy rescue manifests that pre-39 glasses are checked against; for
        // modern glasses it means the manifest cannot verify anything, and that must surface as
        // an error — never as "no update". Mirrors the Kotlin OtaManifestChecker.
        if serverVersion <= 0 {
            if currentVersion >= 39 {
                throw BluetoothSdkError(
                    code: "invalid_ota_manifest",
                    message: "OTA manifest ASG pin is missing or zero; cannot verify update state."
                )
            }
            return false
        }
        if serverVersion > currentVersion {
            return true
        }
        // Exact match: already on the pin, no update.
        if serverVersion == currentVersion {
            return false
        }
        // Downgrade: only actionable at/above the enabled floor; a non-positive floor disables
        // downgrades (fail closed, matching ASG and the engine).
        return downgradeFloorVersionCode > 0 && serverVersion >= downgradeFloorVersionCode
    }

    /// Mentra 3.0's MTK. No downgrade goes below it: downgrades keep userdata (photos and videos),
    /// which holds only between builds with the same Android version, security patch level and AVB
    /// rollback indexes. The glasses (MtkOtaSelector), the engine and Android keep the same floor.
    static let mtkDowngradeFloor = "MentraLive_20260709"
    /// Each published downgrade's record, by its two versions.
    static let mtkDowngradeRecordBaseUrl = "https://mtkfirmware.mentraglass.com/"

    private static func normalizeMtk(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "_").last ?? ""
    }

    /// Date, then revision (a date-only version is revision 0); false when either is unknown.
    static func isNewerMtk(_ target: String, _ current: String) -> Bool {
        let pattern = "^[0-9]{8}(\\.[0-9]{1,9})?$"
        let t = normalizeMtk(target), c = normalizeMtk(current)
        guard t.range(of: pattern, options: .regularExpression) != nil,
              c.range(of: pattern, options: .regularExpression) != nil
        else { return false }
        let targetParts = t.split(separator: ".").compactMap { Int64($0) }
        let currentParts = c.split(separator: ".").compactMap { Int64($0) }
        let targetRevision = targetParts.count == 2 ? targetParts[1] : 0
        let currentRevision = currentParts.count == 2 ? currentParts[1] : 0
        return targetParts[0] > currentParts[0] ||
            (targetParts[0] == currentParts[0] && targetRevision > currentRevision)
    }

    /// The older MTK this manifest pins, from Mentra 3.0's up: its full OTA's version, or else the
    /// one version its patches all end at.
    static func mtkDowngradeTarget(_ manifest: OtaManifest, currentVersion: String) -> String? {
        var target: String?
        if let full = manifest.mtkFullOta {
            target = full.endFirmware.map(normalizeMtk)
        } else {
            for patch in manifest.mtkPatches ?? [] {
                let end = normalizeMtk(patch.endFirmware ?? "")
                if let target, target != end { return nil }
                target = end
            }
        }
        guard let target, isNewerMtk(currentVersion, target), !isNewerMtk(mtkDowngradeFloor, target) else { return nil }
        return target
    }

    /// Whether the glasses would downgrade their MTK to the older one this manifest pins: its
    /// release predates the newer MTK, so the downgrade's published record decides.
    static func hasMtkDowngrade(
        manifest: OtaManifest,
        currentVersion: String,
        fetchRecord: (String) async -> [String: Any]? = fetchDowngradeRecord
    ) async -> Bool {
        guard let target = mtkDowngradeTarget(manifest, currentVersion: currentVersion) else { return false }
        let url = "\(mtkDowngradeRecordBaseUrl)mtk_ota_downgrade_\(normalizeMtk(currentVersion))_\(target).json"
        guard let record = await fetchRecord(url),
              let start = record["start_firmware"] as? String, normalizeMtk(start) == normalizeMtk(currentVersion),
              let end = record["end_firmware"] as? String, normalizeMtk(end) == target,
              let link = record["url"] as? String, link.range(of: "^https?://[^/\\s]+/.*$", options: .regularExpression) != nil,
              let hash = record["sha256"] as? String, hash.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil,
              let size = record["size"] as? Int64 ?? (record["size"] as? Int).map(Int64.init),
              size > 0, size <= 1024 * 1024 * 1024
        else { return false }
        return true
    }

    static func fetchDowngradeRecord(_ url: String) async -> [String: Any]? {
        guard let url = URL(string: url),
              let (data, response) = try? await URLSession.shared.data(from: url),
              (response as? HTTPURLResponse).map({ (200 ... 299).contains($0.statusCode) }) == true
        else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func hasMtkUpdate(patches: [MtkPatch]?, full: MtkFullOta?, currentVersion: String) -> Bool {
        let current = normalizeMtk(currentVersion)
        guard !current.isEmpty else { return false }
        // An upgrade only: a reverse patch listed here could be a userdata-wiping one.
        if (patches ?? []).contains(where: {
            normalizeMtk($0.startFirmware) == current && isNewerMtk($0.endFirmware ?? "", current)
        }) { return true }
        guard let full, let endFirmware = full.endFirmware,
              !full.hasStartFirmware,
              let url = full.url, url.range(of: "^https?://[^/\\s]+/.*$", options: .regularExpression) != nil,
              let hash = full.sha256, hash.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil,
              let size = full.size, size > 0, size <= 1024 * 1024 * 1024
        else { return false }
        return isNewerMtk(endFirmware, current)
    }

    private static func hasBesUpdate(besFirmware: BesFirmware?, currentVersion: String) throws -> Bool {
        guard let besFirmware else { return false }
        guard let serverVersion = besFirmware.version, !serverVersion.isEmpty else {
            throw BluetoothSdkError(code: "invalid_ota_manifest", message: "OTA manifest bes_firmware.version is missing.")
        }
        if currentVersion.isEmpty {
            return true
        }
        return serverVersion != currentVersion
    }
}
