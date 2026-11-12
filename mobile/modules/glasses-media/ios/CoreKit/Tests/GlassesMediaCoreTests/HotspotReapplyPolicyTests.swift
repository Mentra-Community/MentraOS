@testable import GlassesMediaCore
import XCTest

final class HotspotReapplyPolicyTests: XCTestCase {
    func testAMissedRequestIsMadeAgainAfterEightSeconds() {
        let policy = HotspotReapplyPolicy()
        XCTAssertFalse(policy.shouldReapply(applies: 1, pollsSinceApply: 15))
        XCTAssertTrue(policy.shouldReapply(applies: 1, pollsSinceApply: 16))
        XCTAssertTrue(policy.shouldReapply(applies: 2, pollsSinceApply: 16))
    }

    func testRequestsStopAtTheLimit() {
        let policy = HotspotReapplyPolicy()
        XCTAssertFalse(policy.shouldReapply(applies: 3, pollsSinceApply: 16))
        XCTAssertFalse(policy.shouldReapply(applies: 3, pollsSinceApply: 1_000))
        XCTAssertFalse(HotspotReapplyPolicy(maxApplies: 1).shouldReapply(applies: 1, pollsSinceApply: 16))
    }
}
