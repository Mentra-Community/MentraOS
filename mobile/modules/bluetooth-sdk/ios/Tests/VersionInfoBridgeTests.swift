@testable import MentraBluetoothSDK
import XCTest

final class VersionInfoBridgeTests: XCTestCase {
    func testWireMetadataSurvivesBridgeNormalization() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")
        let delivered = expectation(description: "Both version chunks")
        delivered.expectedFulfillmentCount = 2
        var outcomes: [VersionInfoAccumulatorOutcome] = []
        let sink = Bridge.addEventSink { type, body in
            guard type == "version_info" else { return }
            outcomes.append(accumulator.accept(body))
            delivered.fulfill()
        }
        defer { Bridge.removeEventSink(sink) }
        Bridge.sendVersionInfo([
            "request_id": "request-1", "sid": "asg-1", "chunkCount": 2,
            "chunkIndex": 1, "final": false, "build_number": "42",
        ], responseChunk: "version_info_1")
        Bridge.sendVersionInfo([
            "request_id": "request-1", "sid": "asg-1", "chunkCount": 2,
            "chunkIndex": 2, "final": true, "bes_fw_version": "new",
        ], responseChunk: "version_info_3")
        wait(for: [delivered], timeout: 2)
        guard case .waiting = outcomes[0], case let .complete(result) = outcomes[1] else {
            return XCTFail("Expected an explicitly complete combined response")
        }
        XCTAssertEqual(result.buildNumber, "42")
        XCTAssertEqual(result.besFirmwareVersion, "new")
        XCTAssertFalse(result.dictionary.keys.contains { $0.hasPrefix("_response") })
    }
}
