@testable import MentraBluetoothSDK
import XCTest

@MainActor
final class PendingResponseTimeoutTests: XCTestCase {
    /// Glasses asked again shortly before the deadline get the whole timeout to answer.
    func testRestartedTimeoutLetsALateAnswerThrough() async throws {
        let pending = PendingResponse<String>(operation: "version info request")
        let waiter = Task { try await pending.wait(timeoutMs: 300) }
        try await Task.sleep(nanoseconds: 200_000_000)
        pending.restartTimeout()
        try await Task.sleep(nanoseconds: 200_000_000)
        pending.resolve("answer")
        let answer = try await waiter.value
        XCTAssertEqual(answer, "answer")
    }

    func testTimeoutStillFiresWithoutARestart() async throws {
        let pending = PendingResponse<String>(operation: "version info request")
        do {
            _ = try await pending.wait(timeoutMs: 100)
            XCTFail("expected a timeout")
        } catch let error as BluetoothSdkError {
            XCTAssertEqual(error.code, "request_timeout")
        }
    }
}
