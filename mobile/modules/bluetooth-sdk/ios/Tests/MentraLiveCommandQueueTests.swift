@testable import MentraBluetoothSDK
import XCTest

@MainActor
final class MentraLiveCommandQueueTests: XCTestCase {
    func testHandshakesFromEarlierEpochsAreDiscardedInOnePass() {
        let queue = MentraLive.CommandQueue()
        for (id, epoch) in [("1", 1), ("2", 1), ("3", 2), ("4", 3), ("5", 3)] {
            _ = queue.enqueue(write(id, wireEpoch: epoch))
        }

        let next = queue.dequeue(currentEpoch: 3)
        XCTAssertEqual(next.command?.id, "4")
        XCTAssertEqual(next.staleIds, ["1", "2", "3"])

        let following = queue.dequeue(currentEpoch: 3)
        XCTAssertEqual(following.command?.id, "5")
        XCTAssertEqual(following.staleIds, [])
    }

    func testQueueOfOnlyStaleHandshakesDrainsToEmpty() {
        let queue = MentraLive.CommandQueue()
        _ = queue.enqueue(write("1", wireEpoch: 1))
        _ = queue.enqueue(write("2", wireEpoch: 2))

        let next = queue.dequeue(currentEpoch: 3)
        XCTAssertNil(next.command)
        XCTAssertEqual(next.staleIds, ["1", "2"])
        XCTAssertNil(queue.dequeue())
    }

    /// A version request queued between an ASG restart and its glasses_ready must still be
    /// sent after that reset: dropping it left the app's update check waiting for an answer.
    func testCommandsQueuedBeforeAWireEpochResetAreStillSentInOrder() {
        let queue = MentraLive.CommandQueue()
        _ = queue.enqueue(write("17", wireEpoch: nil))
        _ = queue.enqueue(write("handshake", wireEpoch: 1))
        _ = queue.enqueue(write("18", wireEpoch: nil))

        let first = queue.dequeue(currentEpoch: 2)
        XCTAssertEqual(first.command?.id, "17")
        XCTAssertEqual(first.staleIds, ["handshake"])
        XCTAssertEqual(queue.dequeue(currentEpoch: 2).command?.id, "18")
    }

    private func write(_ id: String, wireEpoch: Int?) -> MentraLive.PendingMessage {
        MentraLive.PendingMessage(data: Data([1]), id: id, retries: 0, wireEpoch: wireEpoch)
    }
}
