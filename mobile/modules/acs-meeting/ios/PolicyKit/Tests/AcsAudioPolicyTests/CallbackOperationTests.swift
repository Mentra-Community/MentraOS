@testable import AcsAudioPolicy
import Foundation
import XCTest

final class CallbackOperationTests: XCTestCase {
  private enum TestError: Error { case sdkFailure }

  private func onWorker(_ body: @escaping () throws -> Void) {
    let finished = expectation(description: "control queue operation")
    DispatchQueue.global().async {
      do { try body() }
      catch { XCTFail("Unexpected error: \(error)") }
      finished.fulfill()
    }
    wait(for: [finished], timeout: 2)
  }

  func testInlineAndDelayedSuccess() {
    onWorker {
      XCTAssertEqual(try CallbackOperation<Int>().wait { $0(7, nil) }, 7)
      let result = try CallbackOperation<Int>().wait { completion in
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.01) { completion(9, nil) }
      }
      XCTAssertEqual(result, 9)
    }
  }

  func testPropagatesSdkFailureAndRejectsMissingResult() {
    onWorker {
      XCTAssertThrowsError(try CallbackOperation<Int>().wait { $0(nil, TestError.sdkFailure) }) {
        XCTAssertTrue($0 is TestError)
      }
      XCTAssertThrowsError(try CallbackOperation<Int>().wait { $0(nil, nil) }) {
        guard case CallbackOperationError.missingResult = $0 else { return XCTFail("Wrong error: \($0)") }
      }
    }
  }

  func testTimeoutDisposesAResourceReturnedAfterTheWaitEnds() {
    let disposed = expectation(description: "late agent or call cleaned up")
    onWorker {
      var callback: ((Int?, Error?) -> Void)?
      XCTAssertThrowsError(try CallbackOperation<Int>().wait(timeout: 0.01, onLateSuccess: { value in
        XCTAssertEqual(value, 42)
        disposed.fulfill()
      }) { callback = $0 }) {
        guard case CallbackOperationError.timedOut = $0 else { return XCTFail("Wrong error: \($0)") }
      }
      callback?(42, nil)
    }
    wait(for: [disposed], timeout: 1)
  }
}
