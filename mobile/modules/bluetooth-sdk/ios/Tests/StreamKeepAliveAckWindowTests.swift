@testable import MentraBluetoothSDK
import XCTest

final class StreamKeepAliveAckWindowTests: XCTestCase {
    func testStartedStreamWindowMonitorsFirstRequest() {
        let window = StreamKeepAliveAckWindow.forStartedStream(maxTrackedAckIds: 3, maxMissedAcks: 3)
        window.recordSent(ackId: "ack-1")

        XCTAssertTrue(window.armed)
        XCTAssertNil(window.recordTick())
        XCTAssertNil(window.recordTick())
        XCTAssertEqual(window.recordTick(), 3)
    }

    func testLateAckWithinWindowResetsMissCount() {
        let window = StreamKeepAliveAckWindow(maxTrackedAckIds: 3, maxMissedAcks: 3)
        window.arm()
        window.recordSent(ackId: "ack-1")

        XCTAssertNil(window.recordTick())
        window.recordSent(ackId: "ack-2")

        XCTAssertTrue(window.acknowledge(ackId: "ack-1"))
        XCTAssertEqual(window.missedAckCount, 0)
        XCTAssertTrue(window.acknowledge(ackId: "ack-2"))
    }

    func testOneIntervalLateAcksNeverReachTimeout() {
        let window = StreamKeepAliveAckWindow(maxTrackedAckIds: 3, maxMissedAcks: 3)
        window.arm()
        window.recordSent(ackId: "ack-1")

        for sequence in 2 ... 6 {
            XCTAssertNil(window.recordTick())
            window.recordSent(ackId: "ack-\(sequence)")
            XCTAssertTrue(window.acknowledge(ackId: "ack-\(sequence - 1)"))
            XCTAssertEqual(window.missedAckCount, 0)
        }
    }

    func testNewerAckDiscardsOlderOutstandingRequests() {
        let window = StreamKeepAliveAckWindow(maxTrackedAckIds: 3, maxMissedAcks: 3)
        window.arm()
        window.recordSent(ackId: "ack-1")
        window.recordSent(ackId: "ack-2")

        XCTAssertTrue(window.acknowledge(ackId: "ack-2"))
        XCTAssertFalse(window.acknowledge(ackId: "ack-1"))
        XCTAssertNil(window.recordTick())
    }

    func testTimeoutReportsOnceButKeepsAcceptingAcks() {
        let window = StreamKeepAliveAckWindow(maxTrackedAckIds: 3, maxMissedAcks: 3)
        window.arm()

        window.recordSent(ackId: "ack-1")
        XCTAssertNil(window.recordTick())
        window.recordSent(ackId: "ack-2")
        XCTAssertNil(window.recordTick())
        window.recordSent(ackId: "ack-3")
        XCTAssertEqual(window.recordTick(), 3)
        window.recordSent(ackId: "ack-4")

        XCTAssertNil(window.recordTick())
        XCTAssertTrue(window.acknowledge(ackId: "ack-2"))
        XCTAssertEqual(window.missedAckCount, 0)
    }

    func testRequestsOutsideBoundedWindowAreRejected() {
        let window = StreamKeepAliveAckWindow(maxTrackedAckIds: 2, maxMissedAcks: 3)
        window.arm()
        window.recordSent(ackId: "ack-1")
        window.recordSent(ackId: "ack-2")
        window.recordSent(ackId: "ack-3")

        XCTAssertFalse(window.acknowledge(ackId: "ack-1"))
        XCTAssertTrue(window.acknowledge(ackId: "ack-2"))
    }
}
