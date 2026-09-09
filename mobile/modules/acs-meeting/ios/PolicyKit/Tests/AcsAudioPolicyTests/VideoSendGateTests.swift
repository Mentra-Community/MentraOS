@testable import AcsAudioPolicy
import Foundation
import XCTest

final class VideoSendGateTests: XCTestCase {
  func testDelayedCompletionBoundsOutstandingFrames() throws {
    let gate = VideoSendGate()
    let token = try XCTUnwrap(gate.acquire())
    for _ in 0 ..< 1000 {
      XCTAssertNil(gate.acquire())
    }
    gate.release(token)
    XCTAssertNotNil(gate.acquire())
  }

  func testOldCompletionDoesNotReleaseNewStreamFrame() throws {
    let gate = VideoSendGate()
    let old = try XCTUnwrap(gate.acquire())
    gate.reset()
    let current = try XCTUnwrap(gate.acquire())
    gate.release(old)
    XCTAssertNil(gate.acquire())
    gate.release(current)
    XCTAssertNotNil(gate.acquire())
  }

  func testConcurrentFramesAdmitExactlyOneSubmission() {
    let gate = VideoSendGate()
    let lock = NSLock()
    var admitted = 0
    DispatchQueue.concurrentPerform(iterations: 100) { _ in
      if gate.acquire() != nil {
        lock.lock()
        admitted += 1
        lock.unlock()
      }
    }
    XCTAssertEqual(admitted, 1)
  }
}
