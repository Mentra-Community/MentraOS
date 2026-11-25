@testable import MentraBluetoothSDK
import XCTest

final class HotspotLeaveCompletionTests: XCTestCase {
    func testConcurrentLeaveCallersShareOriginalOwnerUntilLeaveCompletes() {
        var owner: String? = "original"
        var released = 0
        var replied: [Int] = []
        let leave = HotspotLeaveCompletion { owner = nil; released += 1 }
        leave.append { _ in XCTAssertNil(owner); replied.append(1) }
        leave.append { _ in XCTAssertNil(owner); replied.append(2) }
        XCTAssertEqual(owner, "original")
        XCTAssertTrue(replied.isEmpty)
        leave.complete(.success(()))
        leave.complete(.success(()))
        XCTAssertEqual(released, 1)
        XCTAssertEqual(replied, [1, 2])
    }

    func testUnprovenAssociationCleanupRetainsOwnerForLaterLeave() {
        var released = false
        let leave = HotspotLeaveCompletion { released = true }
        var receivedFailure = false
        leave.append { if case .failure = $0 { receivedFailure = true } }
        leave.complete(.failure(HotspotError("Current association is unknown")))
        XCTAssertTrue(receivedFailure)
        XCTAssertFalse(released)
    }
}
