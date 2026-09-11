@testable import MentraBluetoothSDK
import XCTest

final class BluetoothSdkAnalyticsTransportTests: XCTestCase {
    func testDrainStartedByAnOldInstanceCannotOverwriteAnEventANewInstancePersists() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let queue = BluetoothSdkAnalyticsQueue(fileURL: dir.appendingPathComponent("queue.jsonl"))
        queue.enqueue(["uuid": "old"], now: Date(timeIntervalSince1970: 1))
        let drainStarted = DispatchSemaphore(value: 0)
        let newInstanceReady = DispatchSemaphore(value: 0)

        // "Old instance": a slow drain that snapshots the file, then rewrites it.
        BluetoothSdkAnalyticsTransport.queue.async {
            queue.drain(now: Date(timeIntervalSince1970: 2)) { _ in
                drainStarted.signal()
                _ = newInstanceReady.wait(timeout: .now() + 2)
                return .delivered
            }
        }
        // "New instance": persists a failed event while that drain is in progress.
        // Through the shared serial queue it runs after the drain instead of racing its rewrite.
        XCTAssertEqual(drainStarted.wait(timeout: .now() + 2), .success)
        BluetoothSdkAnalyticsTransport.queue.async { queue.enqueue(["uuid": "new"], now: Date(timeIntervalSince1970: 3)) }
        newInstanceReady.signal()
        BluetoothSdkAnalyticsTransport.queue.sync {}

        var remaining: [String] = []
        queue.drain(now: Date(timeIntervalSince1970: 4)) { p in
            remaining.append(p["uuid"] as? String ?? "")
            return .retry
        }
        XCTAssertEqual(remaining, ["new"])
        try? FileManager.default.removeItem(at: dir)
    }
}
