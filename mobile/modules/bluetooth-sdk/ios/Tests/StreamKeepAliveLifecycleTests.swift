@testable import MentraBluetoothSDK
import XCTest

@MainActor
final class StreamKeepAliveLifecycleTests: XCTestCase {
    func testRetryableErrorPreservesMonitorThroughTransientStoppedStatus() {
        let tracker = makeArmedTracker()

        XCTAssertEqual(tracker.handle(event(status: "error", willRetry: true)), .preserve)
        XCTAssertFalse(tracker.armed)
        XCTAssertTrue(tracker.retryPending)
        XCTAssertNil(tracker.pendingAckId)
        XCTAssertEqual(tracker.missedAckCount, 0)

        XCTAssertEqual(tracker.handle(event(status: "stopped")), .preserve)
        XCTAssertFalse(tracker.armed)
        XCTAssertTrue(tracker.retryPending)
    }

    func testReconnectLifecycleRearmsExistingMonitorWithoutAnotherStart() {
        let tracker = makeArmedTracker()

        XCTAssertEqual(tracker.handle(event(status: "error", willRetry: true)), .preserve)
        XCTAssertEqual(tracker.handle(event(status: "reconnecting")), .preserve)
        XCTAssertFalse(tracker.armed)

        XCTAssertEqual(tracker.handle(event(status: "reconnected")), .preserve)
        XCTAssertTrue(tracker.armed)
        XCTAssertFalse(tracker.retryPending)

        tracker.pendingAckId = "ack-new"
        tracker.missedAckCount = 1
        XCTAssertEqual(tracker.handle(event(status: "streaming")), .preserve)
        XCTAssertEqual(tracker.pendingAckId, "ack-new")
        XCTAssertEqual(tracker.missedAckCount, 1)
    }

    func testStreamingStatusCanRearmDirectlyAfterRetryableError() {
        let tracker = makeArmedTracker()

        XCTAssertEqual(tracker.handle(event(status: "error", willRetry: true)), .preserve)
        XCTAssertEqual(tracker.handle(event(status: "streaming")), .preserve)
        XCTAssertTrue(tracker.armed)
        XCTAssertFalse(tracker.retryPending)
    }

    func testTerminalStatusesStopMonitor() {
        for status in ["stopping", "stopped", "error", "reconnect_failed"] {
            let tracker = makeArmedTracker()
            XCTAssertEqual(tracker.handle(event(status: status)), .stop, status)
        }
    }

    private func makeArmedTracker() -> ActiveStreamKeepAlive {
        let tracker = ActiveStreamKeepAlive(streamId: "stream-1", intervalSeconds: 5)
        tracker.armed = true
        tracker.pendingAckId = "ack-old"
        tracker.missedAckCount = 2
        return tracker
    }

    private func event(status: String, willRetry: Bool? = nil) -> StreamStatusEvent {
        var values: [String: Any] = [
            "type": "stream_status",
            "status": status,
            "streamId": "stream-1",
        ]
        if let willRetry {
            values["willRetry"] = willRetry
        }
        return StreamStatusEvent(values: values)
    }
}
