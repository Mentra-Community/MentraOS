@testable import MentraBluetoothSDK
import XCTest

@MainActor
final class StreamKeepAliveLifecycleTests: XCTestCase {
    func testRetryableErrorPreservesMonitorThroughTransientStoppedStatus() {
        let tracker = makeArmedTracker()

        XCTAssertEqual(tracker.handle(event(status: "error", willRetry: true)), .restartRecoveryDeadline)
        XCTAssertFalse(tracker.armed)
        XCTAssertTrue(tracker.retryPending)
        XCTAssertNil(tracker.pendingAckId)
        XCTAssertEqual(tracker.missedAckCount, 0)

        XCTAssertEqual(tracker.handle(event(status: "stopped")), .restartRecoveryDeadline)
        XCTAssertFalse(tracker.armed)
        XCTAssertTrue(tracker.retryPending)
    }

    func testReconnectLifecycleRearmsExistingMonitorWithoutAnotherStart() {
        let tracker = makeArmedTracker()

        XCTAssertEqual(tracker.handle(event(status: "error", willRetry: true)), .restartRecoveryDeadline)
        XCTAssertEqual(tracker.handle(event(status: "reconnecting")), .restartRecoveryDeadline)
        XCTAssertFalse(tracker.armed)

        XCTAssertEqual(tracker.handle(event(status: "reconnected")), .cancelRecoveryDeadline)
        XCTAssertTrue(tracker.armed)
        XCTAssertFalse(tracker.retryPending)

        tracker.pendingAckId = "ack-new"
        tracker.missedAckCount = 1
        XCTAssertEqual(tracker.handle(event(status: "streaming")), .cancelRecoveryDeadline)
        XCTAssertEqual(tracker.pendingAckId, "ack-new")
        XCTAssertEqual(tracker.missedAckCount, 1)
    }

    func testStreamingStatusCanRearmDirectlyAfterRetryableError() {
        let tracker = makeArmedTracker()

        XCTAssertEqual(tracker.handle(event(status: "error", willRetry: true)), .restartRecoveryDeadline)
        XCTAssertEqual(tracker.handle(event(status: "streaming")), .cancelRecoveryDeadline)
        XCTAssertTrue(tracker.armed)
        XCTAssertFalse(tracker.retryPending)
    }

    func testTerminalStatusesStopMonitor() {
        for status in ["stopping", "stopped", "error", "reconnect_failed"] {
            let tracker = makeArmedTracker()
            XCTAssertEqual(tracker.handle(event(status: status)), .stop, status)
        }
    }

    func testRetryableErrorAfterTransientStoppedRestartsRecoveryDeadline() {
        let tracker = makeArmedTracker()

        XCTAssertEqual(tracker.handle(event(status: "error", willRetry: true)), .restartRecoveryDeadline)
        XCTAssertEqual(tracker.handle(event(status: "stopped")), .restartRecoveryDeadline)
        XCTAssertEqual(tracker.handle(event(status: "error", willRetry: true)), .restartRecoveryDeadline)
        XCTAssertTrue(tracker.retryPending)
        XCTAssertFalse(tracker.armed)
    }

    func testRetryProgressRestartsDeadlineUntilStreamIsLive() {
        let tracker = makeArmedTracker()

        XCTAssertEqual(tracker.handle(event(status: "error", willRetry: true)), .restartRecoveryDeadline)
        XCTAssertEqual(tracker.handle(event(status: "stopped")), .restartRecoveryDeadline)
        XCTAssertEqual(tracker.handle(event(status: "reconnecting")), .restartRecoveryDeadline)
        XCTAssertEqual(tracker.handle(event(status: "initializing")), .restartRecoveryDeadline)
        XCTAssertTrue(tracker.retryPending)
        XCTAssertFalse(tracker.armed)

        XCTAssertEqual(tracker.handle(event(status: "reconnected")), .cancelRecoveryDeadline)
        XCTAssertFalse(tracker.retryPending)
        XCTAssertTrue(tracker.armed)
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
