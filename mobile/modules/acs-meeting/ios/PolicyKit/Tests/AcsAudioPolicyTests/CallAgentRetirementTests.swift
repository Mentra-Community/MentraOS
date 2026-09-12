@testable import AcsAudioPolicy
import Foundation
import XCTest

final class CallAgentRetirementTests: XCTestCase {
  func testCancelledJoinWithNoCallbackStillRetiresAtDeadline() {
    let queue = DispatchQueue(label: "retirement.missing-join")
    let group = DispatchGroup()
    var disposals = 0
    queue.sync {
      let join = CallJoinRetirement<Int>(group: group, queue: queue, timeout: 0.01, dispose: { disposals += 1 }) { _, _ in
        XCTFail("No call was returned to hang up")
      }
      join.cancel()
      XCTAssertEqual(group.wait(timeout: .now()), .timedOut)
    }
    XCTAssertEqual(group.wait(timeout: .now() + 1), .success)
    queue.sync { XCTAssertEqual(disposals, 1) }
  }

  func testSuccessfulJoinTransfersOwnershipWithoutDisposal() {
    let queue = DispatchQueue(label: "retirement.successful-join")
    let group = DispatchGroup()
    queue.sync {
      let join = CallJoinRetirement<Int>(group: group, queue: queue, dispose: { XCTFail("Session owns this agent") }) { _, _ in
        XCTFail("Session owns this call")
      }
      XCTAssertTrue(join.receive(42))
      join.cancel()
      XCTAssertEqual(group.wait(timeout: .now()), .success)
    }
  }

  func testCancelledJoinRetainsAgentUntilLateCallFinishesHangingUp() {
    let queue = DispatchQueue(label: "retirement.cancelled-join")
    let group = DispatchGroup()
    let joinReturned = expectation(description: "cancelled join returned a call")
    var disposals = 0
    var hangUpCompleted: (() -> Void)?
    queue.sync {
      let join = CallJoinRetirement<Int>(group: group, queue: queue, dispose: { disposals += 1 }) { call, finished in
        XCTAssertEqual(call, 42)
        XCTAssertEqual(disposals, 0)
        hangUpCompleted = finished
        joinReturned.fulfill()
      }
      join.cancel()
      join.cancel()
      XCTAssertFalse(join.receive(42))
    }
    wait(for: [joinReturned], timeout: 1)
    queue.sync {
      XCTAssertEqual(group.wait(timeout: .now()), .timedOut)
      XCTAssertEqual(disposals, 0)
      hangUpCompleted?()
    }
    XCTAssertEqual(group.wait(timeout: .now() + 1), .success)
    queue.sync { XCTAssertEqual(disposals, 1) }
  }

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
