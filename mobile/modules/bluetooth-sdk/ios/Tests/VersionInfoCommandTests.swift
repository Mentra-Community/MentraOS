@testable import MentraBluetoothSDK
import XCTest

@MainActor
private final class VersionInfoCommandTransport: MentraLive {
    var requestId: String?

    override func sendJson(_ jsonOriginal: [String: Any], wakeUp: Bool, requireAck: Bool) {
        XCTAssertEqual(jsonOriginal["type"] as? String, "request_version")
        XCTAssertTrue(wakeUp, "An idle ASG must wake to finish its version response")
        XCTAssertTrue(requireAck)
        do {
            let bytes = try JSONSerialization.data(withJSONObject: jsonOriginal)
            let command = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            let id = try XCTUnwrap(command["request_id"] as? String)
            requestId = id
            let common: [String: Any] = ["request_id": id, "sid": "asg-1", "chunkCount": 2]
            for chunk: [String: Any] in [
                ["type": "version_info_1", "chunkIndex": 1, "final": false,
                 "build_number": "303000008", "app_version": "3.3.0"],
                ["type": "version_info_3", "chunkIndex": 2, "final": true,
                 "bes_fw_version": "26.9.23.0", "mtk_fw_version": "MentraLive_20260921.0"],
            ] {
                let response = common.merging(chunk) { _, value in value }
                try processReceivedData(JSONSerialization.data(withJSONObject: response))
            }
        } catch {
            XCTFail("Could not replay version request: \(error)")
        }
    }
}

@MainActor
final class VersionInfoCommandTests: XCTestCase {
    func testPublicVersionRequestWakesGlassesAndCombinesBothResponseChunks() async throws {
        let previous = DeviceManager.shared.sgc
        let transport = VersionInfoCommandTransport()
        DeviceManager.shared.sgc = transport
        let sdk = MentraBluetoothSDK()
        defer {
            sdk.invalidate()
            DeviceManager.shared.sgc = previous
        }

        let result = try await sdk.requestVersionInfo()

        XCTAssertNotNil(transport.requestId)
        XCTAssertEqual(result.buildNumber, "303000008")
        XCTAssertEqual(result.appVersion, "3.3.0")
        XCTAssertEqual(result.besFirmwareVersion, "26.9.23.0")
        XCTAssertEqual(result.mtkFirmwareVersion, "MentraLive_20260921.0")
    }
}
