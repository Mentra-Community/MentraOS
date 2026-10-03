@testable import GlassesMediaCore
import XCTest

final class WhipOfferGateTests: XCTestCase {
    func testStalledStunGatherPostsAtDeadlineWithoutWaitingForComplete() {
        var gate = WhipOfferGate()
        XCTAssertFalse(gate.observe(.localDescriptionSet))
        XCTAssertTrue(gate.observe(.deadline))
        XCTAssertFalse(gate.observe(.gatheringComplete))
        XCTAssertFalse(gate.observe(.serverReflexiveCandidate))
    }

    func testUsableCandidateCanArriveBeforeLocalDescriptionCallback() {
        var gate = WhipOfferGate()
        XCTAssertFalse(gate.observe(.serverReflexiveCandidate))
        XCTAssertTrue(gate.observe(.localDescriptionSet))
        XCTAssertFalse(gate.observe(.deadline))
    }

    func testFastGatherPostsWithoutWaitingForDeadline() {
        var gate = WhipOfferGate()
        XCTAssertFalse(gate.observe(.localDescriptionSet))
        XCTAssertTrue(gate.observe(.gatheringComplete))
        XCTAssertFalse(gate.observe(.deadline))
    }

    func testStoppedAttemptCannotPostFromLateCallbacks() {
        var gate = WhipOfferGate()
        XCTAssertFalse(gate.observe(.localDescriptionSet))
        XCTAssertFalse(gate.observe(.stop))
        XCTAssertFalse(gate.observe(.deadline))
        XCTAssertFalse(gate.observe(.serverReflexiveCandidate))
        XCTAssertFalse(gate.observe(.gatheringComplete))
    }
}
