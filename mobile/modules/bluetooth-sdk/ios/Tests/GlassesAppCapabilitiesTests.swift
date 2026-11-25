@testable import MentraBluetoothSDK
import XCTest

final class GlassesAppCapabilitiesTests: XCTestCase {
    func testTheChunkThatNamesTheAppSaysWhatItSupports() {
        let fields: [String: Any] = ["package_name": "com.mentra.asg_client", "deferred_photos": 1, "hotspot_ota_version": 2]
        XCTAssertEqual(GlassesAppCapabilities(fields: fields), GlassesAppCapabilities(deferredPhotos: 1, hotspotOta: 2))
    }

    func testAnAppRestartedOnOlderSoftwareHasNoneOfWhatItDoesNotName() {
        let fields: [String: Any] = ["package_name": "com.mentra.asg_client", "app_version": "3.3.0"]
        XCTAssertEqual(GlassesAppCapabilities(fields: fields), GlassesAppCapabilities(deferredPhotos: 0, hotspotOta: 0))
    }

    func testAFirmwareChunkDoesNotSpeakForTheApp() {
        XCTAssertNil(GlassesAppCapabilities(fields: ["bes_fw_version": "3.5.0.169"]))
    }
}
