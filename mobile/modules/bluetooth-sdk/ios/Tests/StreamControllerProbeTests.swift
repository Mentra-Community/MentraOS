@testable import MentraBluetoothSDK
import XCTest

final class StreamControllerProbeTests: XCTestCase {
    private func probe() -> [String: Any] {
        ["protocolVersion": 1, "controllerId": StreamControllerProbe.controllerId,
         "streamId": "stream", "probeId": "nonce"]
    }

    func testAnswersCurrentProcessChallengeWithoutJsOrTimer() {
        let response = StreamControllerProbe.response(probe())
        XCTAssertEqual(response?["type"] as? String, "stream_controller_response")
        XCTAssertEqual(response?["probeId"] as? String, "nonce")
        XCTAssertEqual(response?["streamId"] as? String, "stream")
    }

    func testRejectsPreviousProcessAndMalformedChallenges() {
        for (key, value) in [("controllerId", "previous-process" as Any),
                             ("protocolVersion", 2), ("protocolVersion", true),
                             ("probeId", ""), ("streamId", "")]
        {
            var input = probe()
            input[key] = value
            XCTAssertNil(StreamControllerProbe.response(input))
        }
    }
}
