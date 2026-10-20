@testable import MentraBluetoothSDK
import XCTest

@MainActor
final class MentraLiveCommandQueueTests: XCTestCase {
    func testStaleGenerationRunIsDiscardedInOnePassAheadOfTheCurrentWrite() {
        let queue = MentraLive.CommandQueue()
        for (id, generation) in [("1", 1), ("2", 1), ("3", 2), ("4", 3), ("5", 3)] {
            _ = queue.enqueue(write(id, generation: generation))
        }

        let next = queue.dequeue(currentGeneration: 3)
        XCTAssertEqual(next.command?.id, "4")
        XCTAssertEqual(next.staleIds, ["1", "2", "3"])

        let following = queue.dequeue(currentGeneration: 3)
        XCTAssertEqual(following.command?.id, "5")
        XCTAssertEqual(following.staleIds, [])
    }

    func testQueueOfOnlyStaleWritesDrainsToEmpty() {
        let queue = MentraLive.CommandQueue()
        _ = queue.enqueue(write("1", generation: 1))
        _ = queue.enqueue(write("2", generation: 2))

        let next = queue.dequeue(currentGeneration: 3)
        XCTAssertNil(next.command)
        XCTAssertEqual(next.staleIds, ["1", "2"])
        XCTAssertNil(queue.dequeue())
    }

    private func write(_ id: String, generation: Int) -> MentraLive.PendingMessage {
        MentraLive.PendingMessage(data: Data([1]), id: id, retries: 0, generation: generation)
    }
}
