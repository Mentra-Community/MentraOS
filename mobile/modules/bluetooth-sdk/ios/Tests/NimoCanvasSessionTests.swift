@testable import MentraBluetoothSDK
import XCTest

final class NimoCanvasSessionTests: XCTestCase {
    private let a = Data([0, 0, 1])
    private let b = Data([1, 0, 1])
    private func ack(_ session: NimoCanvasSession, _ key: Int, status: UInt8 = 0) -> [NimoCanvasSession.Action] {
        session.response(key: key, payload: status == 0 ? (key == 4 ? Data([0, 0xFD, 0, 0, 0]) : Data([0, 0xFD])) : Data([status]))
    }

    private func sentKey(_ actions: [NimoCanvasSession.Action]) -> Int? {
        guard case let .send(key, _, _) = actions.first else { return nil }
        return key
    }

    private func connected(_ session: NimoCanvasSession) {
        XCTAssertTrue(session.offer(a, scope: "app:1").isEmpty)
        XCTAssertEqual(sentKey(session.readiness(true)), 1)
        XCTAssertEqual(sentKey(ack(session, 1)), 4)
        XCTAssertTrue(ack(session, 4).isEmpty)
    }

    func testReadinessLaunchAndLatestSceneWins() {
        let session = NimoCanvasSession()
        XCTAssertTrue(session.offer(a, scope: "app:1").isEmpty)
        XCTAssertEqual(sentKey(session.readiness(true)), 1)
        XCTAssertTrue(session.offer(b, scope: "app:1").isEmpty)
        guard case let .send(key, frame, _) = ack(session, 1).first else { return XCTFail("Missing update") }
        XCTAssertEqual(key, 4); XCTAssertEqual(frame, b)
        XCTAssertTrue(ack(session, 4).isEmpty)
        XCTAssertTrue(session.offer(b, scope: "app:1").isEmpty)
        XCTAssertEqual(sentKey(session.offer(b, scope: "app:2")), 4)
    }

    func testForcedReplayAndReconnectDiscardAcceptedState() {
        let session = NimoCanvasSession(); connected(session)
        XCTAssertEqual(sentKey(session.offer(a, scope: "app:1", force: true)), 4)
        _ = ack(session, 4)
        session.disconnected()
        XCTAssertEqual(sentKey(session.readiness(true)), 1)
        XCTAssertEqual(sentKey(ack(session, 1)), 4)
    }

    func testStatusSevenRequiresFreshReadinessAndBoundsRetries() {
        let session = NimoCanvasSession()
        _ = session.offer(a, scope: "app:1"); _ = session.readiness(true)
        for _ in 0 ..< 3 {
            XCTAssertEqual(ack(session, 1, status: 7), [.rejected(7)])
            XCTAssertTrue(session.readiness(true).isEmpty)
            XCTAssertEqual(sentKey(session.readiness(true, confirmed: true)), 1)
        }
        _ = ack(session, 1, status: 7)
        XCTAssertTrue(session.readiness(true, confirmed: true).isEmpty)
        XCTAssertTrue(session.readiness(false).isEmpty)
        XCTAssertEqual(sentKey(session.readiness(true)), 1)
    }

    func testWrongEchoAndWrongKeyDoNotAdvance() {
        let session = NimoCanvasSession()
        _ = session.offer(a, scope: "app:1"); _ = session.readiness(true)
        XCTAssertTrue(session.response(key: 1, payload: Data([0])).isEmpty)
        XCTAssertTrue(session.response(key: 1, payload: Data([0, 1])).isEmpty)
        XCTAssertTrue(ack(session, 4).isEmpty)
        XCTAssertEqual(sentKey(ack(session, 1)), 4)
    }

    func testLockedAndRejectedFramesDoNotSpin() {
        let session = NimoCanvasSession(); connected(session)
        _ = session.offer(b, scope: "app:1")
        XCTAssertEqual(ack(session, 4, status: 5), [.rejected(5)])
        XCTAssertTrue(session.offer(b, scope: "app:1", force: true).isEmpty)
        XCTAssertEqual(sentKey(session.offer(a, scope: "app:2")), 4)
        XCTAssertEqual(ack(session, 4, status: 8), [.rejected(8)])
        XCTAssertTrue(session.readiness(true, confirmed: true).isEmpty)
        XCTAssertTrue(session.offer(b, scope: "new").isEmpty)
    }

    func testTimeoutRequiresNewConnectionAndStaleTicketCannotResetIt() {
        let session = NimoCanvasSession()
        _ = session.offer(a, scope: "app")
        guard case let .send(_, _, ticket) = session.readiness(true).first else { return XCTFail() }
        XCTAssertEqual(session.timeout(ticket), [.reconnect("Canvas ACK timeout; reconnect before reusing a command key")])
        XCTAssertTrue(ack(session, 1).isEmpty)
        session.disconnected()
        XCTAssertEqual(sentKey(session.readiness(true)), 1)
        XCTAssertTrue(session.timeout(ticket).isEmpty)
    }

    func testReadinessLossDuringFlightRetiresTransport() {
        let session = NimoCanvasSession(); connected(session)
        _ = session.offer(b, scope: "app")
        XCTAssertEqual(session.readiness(false), [.reconnect("Readiness lost during canvas command")])
    }

    func testExitReportPreservesNewHostScene() {
        let session = NimoCanvasSession(); connected(session)
        XCTAssertEqual(sentKey(session.exit()), 3)
        _ = session.offer(b, scope: "new")
        XCTAssertTrue(session.nativeApp(0xFD, entered: false).isEmpty)
        XCTAssertEqual(sentKey(ack(session, 3)), 1)
        guard case let .send(_, frame, _) = ack(session, 1).first else { return XCTFail() }
        XCTAssertEqual(frame, b)
    }

    func testNativeTakeoverReplaysWithoutNewHostFrame() {
        let session = NimoCanvasSession(); connected(session)
        XCTAssertEqual(sentKey(session.nativeApp(0, entered: true)), 1)
        XCTAssertTrue(session.nativeApp(0, entered: true).isEmpty)
        guard case let .send(_, frame, _) = ack(session, 1).first else { return XCTFail() }
        XCTAssertEqual(frame, a)
        XCTAssertTrue(session.nativeApp(0xFD, entered: false).isEmpty)
        XCTAssertEqual(sentKey(ack(session, 4)), 1)
    }

    func testStartupStockUiPreservesReconnectScene() {
        let session = NimoCanvasSession(); connected(session)
        session.disconnected()
        XCTAssertTrue(session.nativeApp(0, entered: true).isEmpty)
        XCTAssertTrue(session.activate().isEmpty)
        XCTAssertEqual(sentKey(session.readiness(true)), 1)
        guard case let .send(_, frame, _) = ack(session, 1).first else { return XCTFail() }
        XCTAssertEqual(frame, a)
    }

    func testActivationEntersBlankCanvasBeforeAnyMiniapp() {
        let session = NimoCanvasSession()
        XCTAssertTrue(session.activate().isEmpty)
        XCTAssertEqual(sentKey(session.readiness(true)), 1)
        guard case let .send(_, frame, _) = ack(session, 1).first else { return XCTFail() }
        XCTAssertEqual(frame, Data([0, 0, 1]))
    }

    func testExplicitExitStopsRestorationUntilAnotherConnection() {
        let session = NimoCanvasSession(); connected(session)
        XCTAssertEqual(sentKey(session.exit()), 3)
        XCTAssertTrue(session.nativeApp(0, entered: true).isEmpty)
        XCTAssertTrue(ack(session, 3).isEmpty)
        XCTAssertTrue(session.nativeApp(0xFD, entered: false).isEmpty)
        session.disconnected()
        _ = session.activate()
        XCTAssertEqual(sentKey(session.readiness(true)), 1)
    }

    func testProbesAreBoundedAndHeartbeatCanStillRecover() {
        let session = NimoCanvasSession()
        _ = session.activate(); _ = session.readiness(true)
        for _ in 0 ..< 3 {
            _ = ack(session, 1, status: 7)
            XCTAssertEqual(sentKey(session.retryNotReady()), 1)
        }
        _ = ack(session, 1, status: 7)
        XCTAssertTrue(session.retryNotReady().isEmpty)
        XCTAssertEqual(sentKey(session.readiness(true, confirmed: true)), 1)
    }
}
