@testable import MentraBluetoothSDK
import XCTest

final class BluetoothSdkAnalyticsQueueTests: XCTestCase {
    private var fileURL: URL!

    override func setUpWithError() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        fileURL = directory.appendingPathComponent("queue.jsonl")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
    }

    private func payload(_ id: String) -> [String: Any] {
        ["uuid": id, "event": "bluetooth_sdk_started"]
    }

    func testDrainsOldestFirstAndKeepsFailuresInOrder() {
        let queue = BluetoothSdkAnalyticsQueue(fileURL: fileURL)
        queue.enqueue(payload("a"), now: Date(timeIntervalSince1970: 1))
        queue.enqueue(payload("b"), now: Date(timeIntervalSince1970: 2))
        queue.enqueue(payload("c"), now: Date(timeIntervalSince1970: 3))

        var sent: [String] = []
        queue.drain(now: Date(timeIntervalSince1970: 4)) { p in
            let id = p["uuid"] as? String ?? ""
            if id == "b" { return .retry }
            sent.append(id)
            return .delivered
        }
        XCTAssertEqual(sent, ["a"])
        XCTAssertEqual(queue.count, 2)

        var second: [String] = []
        queue.drain(now: Date(timeIntervalSince1970: 5)) { p in
            second.append(p["uuid"] as? String ?? "")
            return .delivered
        }
        XCTAssertEqual(second, ["b", "c"])
        XCTAssertEqual(queue.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
    }

    func testDropsPastCapAndExpiredEntries() {
        let queue = BluetoothSdkAnalyticsQueue(fileURL: fileURL, maxEntries: 2, maxAge: 10)
        queue.enqueue(payload("old"), now: Date(timeIntervalSince1970: 0))
        queue.enqueue(payload("mid"), now: Date(timeIntervalSince1970: 5))
        queue.enqueue(payload("new"), now: Date(timeIntervalSince1970: 6))
        XCTAssertEqual(queue.count, 2)

        var sent: [String] = []
        queue.drain(now: Date(timeIntervalSince1970: 16)) { p in
            sent.append(p["uuid"] as? String ?? "")
            return .delivered
        }
        XCTAssertEqual(sent, ["new"])
    }

    func testSurvivesACorruptLine() throws {
        let queue = BluetoothSdkAnalyticsQueue(fileURL: fileURL)
        queue.enqueue(payload("a"), now: Date(timeIntervalSince1970: 1))
        let handle = try FileHandle(forWritingTo: fileURL)
        handle.seekToEndOfFile()
        try handle.write(XCTUnwrap("not json\n".data(using: .utf8)))
        try handle.close()
        queue.enqueue(payload("b"), now: Date(timeIntervalSince1970: 2))
        XCTAssertEqual(queue.count, 2)
    }

    func testPermanentlyRejectedPayloadIsDroppedWithoutBlockingTheRest() {
        let queue = BluetoothSdkAnalyticsQueue(fileURL: fileURL)
        queue.enqueue(payload("bad"), now: Date(timeIntervalSince1970: 1))
        queue.enqueue(payload("good"), now: Date(timeIntervalSince1970: 2))

        var sent: [String] = []
        queue.drain(now: Date(timeIntervalSince1970: 3)) { p in
            let id = p["uuid"] as? String ?? ""
            if id == "bad" { return .discard }
            sent.append(id)
            return .delivered
        }
        XCTAssertEqual(sent, ["good"])
        XCTAssertEqual(queue.count, 0)
    }

    func testHttpStatusMapsToOutcome() {
        XCTAssertEqual(SendOutcome.fromHTTPStatus(200), .delivered)
        XCTAssertEqual(SendOutcome.fromHTTPStatus(400), .discard)
        XCTAssertEqual(SendOutcome.fromHTTPStatus(401), .discard)
        XCTAssertEqual(SendOutcome.fromHTTPStatus(408), .retry)
        XCTAssertEqual(SendOutcome.fromHTTPStatus(429), .retry)
        XCTAssertEqual(SendOutcome.fromHTTPStatus(503), .retry)
    }
}
