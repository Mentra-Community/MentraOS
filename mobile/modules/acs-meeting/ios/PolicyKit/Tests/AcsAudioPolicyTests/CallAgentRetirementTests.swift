@testable import AcsAudioPolicy
import Foundation
import XCTest

final class CallAgentRetirementTests: XCTestCase {
  func testMissingHangUpCallbackDisposesAgentBeforeUnblockingLeave() {
    let queue = DispatchQueue(label: "retirement.timeout")
    let group = DispatchGroup()
    var disposals = 0
    queue.sync {
      _ = CallAgentRetirement(group: group, queue: queue, timeout: 0.01) {
        XCTAssertEqual(group.wait(timeout: .now()), .timedOut)
        disposals += 1
      }
      XCTAssertEqual(group.wait(timeout: .now()), .timedOut)
    }
    XCTAssertEqual(group.wait(timeout: .now() + 1), .success)
    queue.sync { XCTAssertEqual(disposals, 1) }
  }

  func testLateCallbackCannotReleaseNextCallsCleanupBarrier() {
    let queue = DispatchQueue(label: "retirement.late")
    let group = DispatchGroup()
    var old: CallAgentRetirement!
    var disposals = 0
    queue.sync {
      old = CallAgentRetirement(group: group, queue: queue, timeout: 0.01) { disposals += 1 }
    }
    XCTAssertEqual(group.wait(timeout: .now() + 1), .success)
    queue.sync {
      let next = CallAgentRetirement(group: group, queue: queue) { disposals += 1 }
      old.finish()
      XCTAssertEqual(disposals, 1)
      XCTAssertEqual(group.wait(timeout: .now()), .timedOut)
      next.finish()
      XCTAssertEqual(disposals, 2)
      XCTAssertEqual(group.wait(timeout: .now()), .success)
    }
  }

  func testHangUpCompletionAndDeadlineDisposeExactlyOnce() {
    let queue = DispatchQueue(label: "retirement.completed")
    let group = DispatchGroup()
    let deadlinePassed = expectation(description: "deadline fired after callback")
    var disposals = 0
    queue.sync {
      let retirement = CallAgentRetirement(group: group, queue: queue, timeout: 0.01) { disposals += 1 }
      retirement.finish()
      retirement.finish()
      XCTAssertEqual(group.wait(timeout: .now()), .success)
      queue.asyncAfter(deadline: .now() + 0.03) {
        XCTAssertEqual(disposals, 1)
        deadlinePassed.fulfill()
      }
    }
    wait(for: [deadlinePassed], timeout: 1)
  }
}
