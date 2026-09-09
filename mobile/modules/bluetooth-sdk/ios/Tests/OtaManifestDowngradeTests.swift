@testable import MentraBluetoothSDK
import XCTest

final class OtaManifestDowngradeTests: XCTestCase {
    func testShippedFloorAllowsMentra30ButRejectsOlderTargets() throws {
        for (target, expected) in [(51_518_113, false), (51_518_114, true), (51_518_115, true), (100_000_095, false)] {
            let manifest = OtaManifest(apps: ["com.mentra.asg_client": OtaManifestApp(versionCode: target)],
                                       mtkPatches: nil, besFirmware: nil, versionCode: nil)
            XCTAssertEqual(try OtaManifestChecker.hasUpdate(currentBuildNumber: "100000095",
                                                            currentMtkVersion: "", currentBesVersion: "", manifest: manifest), expected)
        }
    }

    func testExplicitDisabledFloorStillRejectsDowngrades() throws {
        let manifest = OtaManifest(apps: ["com.mentra.asg_client": OtaManifestApp(versionCode: 51_518_114)],
                                   mtkPatches: nil, besFirmware: nil, versionCode: nil)
        XCTAssertFalse(try OtaManifestChecker.hasUpdate(currentBuildNumber: "100000095",
                                                        currentMtkVersion: "", currentBesVersion: "", manifest: manifest, downgradeFloorVersionCode: 0))
    }
}
