@testable import MentraBluetoothSDK
import XCTest

final class OtaManifestDowngradeTests: XCTestCase {
    func testAnyLowerPinIsADowngrade() throws {
        for (target, expected) in [(36, true), (51_518_114, true), (100_000_095, false), (100_000_096, true)] {
            let manifest = OtaManifest(apps: ["com.mentra.asg_client": OtaManifestApp(versionCode: target)],
                                       mtkPatches: nil, mtkFullOta: nil, besFirmware: nil, versionCode: nil)
            XCTAssertEqual(try OtaManifestChecker.hasUpdate(currentBuildNumber: "100000095",
                                                            currentMtkVersion: "", currentBesVersion: "", manifest: manifest), expected)
        }
    }
}
