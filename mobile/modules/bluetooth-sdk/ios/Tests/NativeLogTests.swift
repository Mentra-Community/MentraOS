@testable import MentraBluetoothSDK
import XCTest

final class NativeLogTests: XCTestCase {
    func testTracingAnEventDoesNotRecursivelyTraceTheLog() {
        let delivered = expectation(description: "Trace and original event")
        delivered.expectedFulfillmentCount = 2
        delivered.assertForOverFulfill = true
        var events: [String] = []
        let sink = Bridge.addEventSink { event, _ in
            events.append(event)
            delivered.fulfill()
        }
        defer { Bridge.removeEventSink(sink) }
        Bridge.sendTypedMessage("head_up", body: ["up": true])
        wait(for: [delivered], timeout: 2)
        XCTAssertEqual(events, ["log", "head_up"])
    }

    func testNativeDiagnosticsReachTheLogEventOnce() {
        let delivered = expectation(description: "Native log event")
        delivered.assertForOverFulfill = true
        let sink = Bridge.addEventSink { event, body in
            guard event == "log" else { return }
            XCTAssertEqual(body["message"] as? String, "MessageChunker: diagnostic")
            delivered.fulfill()
        }
        defer { Bridge.removeEventSink(sink) }
        DispatchQueue.global().async {
            Bridge.log("MessageChunker: diagnostic")
        }
        wait(for: [delivered], timeout: 2)
    }
}
