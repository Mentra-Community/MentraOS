@testable import AcsMeeting
import XCTest

final class AcsMeetingSessionTests: XCTestCase {
    func testMuteReplyIncludesTheAppliedStateAndCanRequestAnotherSnapshot() {
        let session = AcsMeetingSession(onState: { _ in }, onIncomingPcm: { _, _, _ in })
        let completed = expectation(description: "nested snapshot completes without queue deadlock")
        session.setMuted(true) { state in
            XCTAssertEqual(state["muted"] as? Bool, true)
            session.snapshot { next in
                XCTAssertEqual(next["muted"] as? Bool, true)
                session.leaveAndAwait(timeout: 5) { done in
                    XCTAssertTrue(done)
                    completed.fulfill()
                }
            }
        }
        wait(for: [completed], timeout: 10)
    }

    func testConcurrentSnapshotsMuteAndLeaveSerializeRosterTeardown() {
        // Exercise the actual native session and its roster.removeAll() teardown.
        // No Teams connection, media capture, or JavaScript mock is involved.
        let session = AcsMeetingSession(onState: { _ in }, onIncomingPcm: { _, _, _ in })
        let replies = expectation(description: "all session commands complete")
        replies.expectedFulfillmentCount = 800
        DispatchQueue.concurrentPerform(iterations: 200) { index in
            session.snapshot { state in
                XCTAssertNotNil(state["participants"] as? [[String: Any]])
                replies.fulfill()
            }
            session.setMuted(index.isMultiple(of: 2)) { state in
                XCTAssertEqual(state["muted"] as? Bool, index.isMultiple(of: 2))
                replies.fulfill()
            }
            session.setAudioSource("phone") { state in
                XCTAssertEqual(state["audioSource"] as? String, "glasses")
                replies.fulfill()
            }
            session.leaveAndAwait(timeout: 5) { done in
                XCTAssertTrue(done)
                replies.fulfill()
            }
        }
        wait(for: [replies], timeout: 30)
        let final = expectation(description: "final cleanup has an empty roster")
        session.leaveAndAwait(timeout: 5) { done in
            XCTAssertTrue(done)
            session.snapshot { state in
                XCTAssertEqual(state["state"] as? String, "idle")
                XCTAssertEqual(state["muted"] as? Bool, false)
                XCTAssertEqual((state["participants"] as? [[String: Any]])?.count, 0)
                final.fulfill()
            }
        }
        wait(for: [final], timeout: 10)
    }
}
