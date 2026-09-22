@testable import MentraBluetoothSDK
import XCTest

final class OtaManifestTests: XCTestCase {
    private func manifest(_ full: [String: Any]? = nil, patches: [[String: String]] = []) throws -> OtaManifest {
        var json: [String: Any] = ["mtk_patches": patches, "versionCode": 38]
        if let full { json["mtk_full_ota"] = full }
        return try JSONDecoder().decode(OtaManifest.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private var full: [String: Any] {
        ["end_firmware": "MentraLive_20260908.10", "url": "https://cdn/full.zip",
         "sha256": String(repeating: "a", count: 64), "size": 640_341_205]
    }

    private func hasUpdate(_ manifest: OtaManifest, _ current: String) throws -> Bool {
        try OtaManifestChecker.hasUpdate(currentBuildNumber: "38", currentMtkVersion: current,
                                         currentBesVersion: "", manifest: manifest)
    }

    func testFullIsUpgradeOnlyWithNumericRevisionComparison() throws {
        let value = try manifest(full)
        XCTAssertTrue(OtaManifestChecker.hasMtkPatches(value))
        for current in ["20260709", "MentraLive_20260908.9", "20260907.20"] {
            XCTAssertTrue(try hasUpdate(value, current), current)
        }
        for current in ["", "unknown", "20260908.10", "20260908.11", "20260909"] {
            XCTAssertFalse(try hasUpdate(value, current), current)
        }
        var zero = full
        zero["end_firmware"] = "20260908.0"
        XCTAssertFalse(try hasUpdate(manifest(zero), "20260908"))
    }

    func testDeltaRemainsAvailableAndFullNeedsMetadata() throws {
        for start in [NSNull(), "20260709"] as [Any] {
            var invalid = full
            invalid["start_firmware"] = start
            XCTAssertFalse(try hasUpdate(manifest(invalid), "20260709"))
        }
        var numericTarget = full
        numericTarget["end_firmware"] = 20_260_908
        XCTAssertThrowsError(try manifest(numericTarget))
        XCTAssertTrue(try hasUpdate(manifest(patches: [["start_firmware": "20260709"]]), "MentraLive_20260709"))
        XCTAssertFalse(try hasUpdate(manifest(), "20260709"))
        for key in ["end_firmware", "url", "sha256", "size"] {
            var invalid = full
            invalid.removeValue(forKey: key)
            XCTAssertFalse(try hasUpdate(manifest(invalid), "20260709"), key)
        }
        var invalid = full
        invalid["size"] = 2_147_483_648 as Int64
        XCTAssertFalse(try hasUpdate(manifest(invalid), "20260709"))
    }
}
