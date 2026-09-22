@testable import MentraBluetoothSDK
import XCTest

final class StreamSessionStateTests: XCTestCase {
    func testReadinessRequiresKnownProtocolAndProcessIdentity() {
        let state = StreamSessionState()
        state.ready(sessionId: "asg", controlVersion: nil)
        XCTAssertFalse(state.supported)
        state.ready(sessionId: "asg", controlVersion: 2)
        XCTAssertFalse(state.supported)
        state.ready(sessionId: "", controlVersion: 1)
        XCTAssertFalse(state.supported)
        state.ready(sessionId: "asg", controlVersion: 1)
        XCTAssertTrue(state.supported)
    }

    func testReconnectionReconcilesTerminalStateWithoutHeartbeatTimeouts() {
        let state = StreamSessionState()
        state.ready(sessionId: "asg", controlVersion: 1)
        XCTAssertTrue(state.accept(["sid": "asg", "revision": 1, "streamId": "stream", "terminal": false]))
        state.ready(sessionId: "asg", controlVersion: 1)
        XCTAssertEqual(state.currentStreamId, "stream")
        XCTAssertTrue(state.accept(["sid": "asg", "revision": 3, "streamId": "stream", "terminal": true]))
        XCTAssertNil(state.currentStreamId)
        XCTAssertFalse(state.accept(["sid": "asg", "revision": 2, "streamId": "stream", "terminal": false]))
        XCTAssertNil(state.currentStreamId)
    }

    func testProcessRestartRejectsOldStatusAndAcceptsNewStoppedSnapshot() {
        let state = StreamSessionState()
        state.ready(sessionId: "old", controlVersion: 1)
        XCTAssertTrue(state.accept(["sid": "old", "revision": 8, "streamId": "stream", "terminal": false]))
        state.ready(sessionId: "new", controlVersion: 1)
        XCTAssertFalse(state.accept(["sid": "old", "revision": 9, "streamId": "stream", "terminal": false]))
        XCTAssertTrue(state.accept(["sid": "new", "revision": 0, "terminal": true]))
        XCTAssertNil(state.currentStreamId)
    }
}
