@testable import MentraBluetoothSDK
import XCTest

private final class NimoTestClock {
    private final class Job {
        let time: TimeInterval
        let task: () -> Void
        var cancelled = false
        init(_ time: TimeInterval, _ task: @escaping () -> Void) {
            self.time = time; self.task = task
        }
    }

    private var now: TimeInterval = 0
    private var jobs: [Job] = []
    lazy var schedule: NimoScheduler = { [unowned self] delay, task in
        let job = Job(self.now + delay, task)
        self.jobs.append(job)
        return { job.cancelled = true }
    }

    func advance(_ seconds: TimeInterval = 0) {
        let end = now + seconds
        while let job = jobs.filter({ !$0.cancelled && $0.time <= end }).min(by: { $0.time < $1.time }) {
            jobs.removeAll { $0 === job }
            now = job.time
            job.task()
        }
        now = end
    }
}

final class NimoCanvasTransportTests: XCTestCase {
    private let frame = Data([0, 0, 1])

    func testEarlyAckOnlyAdvancesAfterFinalWriteCompletes() {
        let clock = NimoTestClock()
        var chains: [[Data]] = [], starts: [() -> Void] = [], completes: [() -> Void] = []
        let canvas = NimoCanvasCoordinator(schedule: clock.schedule, writeCapacity: { 20 }, enqueue: { frames, start, complete in
            chains.append(frames); starts.append(start); completes.append(complete); return true
        }, reconnect: { XCTFail($0) }, rejected: { XCTFail("Unexpected rejection \($0)") })
        canvas.offer(frame, scope: "app")
        canvas.readiness(true)
        canvas.response(key: 1, payload: Data([0, 0xFD])) // Before final fragment: ignore.
        starts[0]()
        XCTAssertEqual(chains.count, 1)
        canvas.response(key: 1, payload: Data([0, 0xFD])) // Before GATT callback: buffer.
        XCTAssertEqual(chains.count, 1)
        completes[0]()
        XCTAssertEqual(chains.count, 2)
        XCTAssertEqual(chains[1][0][9], 4)
        starts[1](); completes[1]()
        canvas.response(key: 4, payload: Data([0, 0xFD, 0, 0, 0]))
        clock.advance(60)
    }

    func testTimeoutAndOldCompletionCannotAdvanceNewGeneration() {
        let clock = NimoTestClock()
        var completions: [() -> Void] = [], reasons: [String] = [], count = 0
        let canvas = NimoCanvasCoordinator(schedule: clock.schedule, writeCapacity: { 512 }, enqueue: { _, start, complete in
            count += 1; start(); completions.append(complete); return true
        }, reconnect: { reasons.append($0) }, rejected: { _ in })
        canvas.offer(frame, scope: "app"); canvas.readiness(true)
        clock.advance(45)
        XCTAssertEqual(reasons.count, 1)
        canvas.readiness(true)
        completions[0]()
        canvas.response(key: 1, payload: Data([0, 0xFD]))
        XCTAssertEqual(count, 2) // ACK buffered for the new flight until its own write completes.
        completions[1]()
        XCTAssertEqual(count, 3)
        canvas.disconnected()
    }

    func testQueueWatchdogRetiresRatherThanSkippingFragment() {
        let clock = NimoTestClock(), connection = NSObject(), characteristic = NSObject()
        var bytes: [Data] = [], failures: [String] = []
        let queue = NimoWriteQueue<NSObject>(schedule: clock.schedule, write: { _, data in bytes.append(data); return true }, failure: { failures.append($0) })
        queue.connected(connection)
        queue.enqueue(connection, characteristic: characteristic, frames: [Data([1]), Data([2])])
        clock.advance(3)
        XCTAssertEqual(bytes, [Data([1])]); XCTAssertEqual(failures, ["GATT write timed out"])
        queue.written(connection, characteristic: characteristic, success: true)
        clock.advance(1)
        XCTAssertEqual(bytes.count, 1)
    }

    func testQueueRejectsOldPeripheralAndCharacteristicAndPacesWrites() {
        let clock = NimoTestClock(), old = NSObject(), current = NSObject(), characteristic = NSObject()
        var count = 0, completed = 0
        let queue = NimoWriteQueue<NSObject>(schedule: clock.schedule, write: { _, _ in count += 1; return true }, failure: { XCTFail($0) })
        queue.connected(old)
        queue.enqueue(old, characteristic: characteristic, frames: [Data([0])])
        queue.connected(current)
        queue.enqueue(current, characteristic: characteristic, frames: [Data([1]), Data([2])], completed: { completed += 1 })
        queue.written(old, characteristic: characteristic, success: true)
        queue.written(current, characteristic: NSObject(), success: true)
        clock.advance(0.01)
        XCTAssertEqual(count, 2)
        queue.written(current, characteristic: characteristic, success: true)
        clock.advance(0.004)
        XCTAssertEqual(count, 2)
        clock.advance(0.001)
        XCTAssertEqual(count, 3)
        queue.written(current, characteristic: characteristic, success: true)
        clock.advance(0.005)
        XCTAssertEqual(completed, 1)
        clock.advance(10)
    }

    func testGattErrorAbortsRemainingChain() {
        let clock = NimoTestClock(), connection = NSObject(), characteristic = NSObject()
        var count = 0, failures = 0
        let queue = NimoWriteQueue<NSObject>(schedule: clock.schedule, write: { _, _ in count += 1; return true }, failure: { _ in failures += 1 })
        queue.connected(connection)
        queue.enqueue(connection, characteristic: characteristic, frames: [Data([1]), Data([2])])
        queue.written(connection, characteristic: characteristic, success: false)
        clock.advance(4)
        XCTAssertEqual(count, 1); XCTAssertEqual(failures, 1)
    }

    func testLatestOnlyEncoderAndExitFenceRunningResults() {
        let main = NimoTestClock(), worker = NimoTestClock()
        var delivered: [Data] = [], encoded = 0
        let encoder = NimoCanvasEncoder(main: main.schedule, worker: worker.schedule, failure: { XCTFail("\($0)") })
        encoder.submit(encode: { encoded += 1; return Data([1]) }, deliver: { delivered.append($0) })
        encoder.submit(encode: { encoded += 1; return Data([2]) }, deliver: { delivered.append($0) })
        worker.advance()
        XCTAssertEqual(encoded, 1)
        encoder.invalidate() // Exit/disconnect while the finished encode awaits Main.
        main.advance()
        XCTAssertTrue(delivered.isEmpty)
        encoder.submit(encode: { Data([3]) }, deliver: { delivered.append($0) })
        worker.advance(); main.advance()
        XCTAssertEqual(delivered, [Data([3])])
    }

    func testCompleteSceneThroughWriteQueueAndBusinessAcks() throws {
        let clock = NimoTestClock(), connection = NSObject(), characteristic = NSObject()
        var written: [Data] = []
        let queue = NimoWriteQueue<NSObject>(schedule: clock.schedule, write: { _, data in written.append(data); return true }, failure: { XCTFail($0) })
        queue.connected(connection)
        let canvas = NimoCanvasCoordinator(schedule: clock.schedule, writeCapacity: { 20 }, enqueue: { frames, started, completed in
            queue.enqueue(connection, characteristic: characteristic, frames: frames, finalStarted: started, completed: completed)
        }, reconnect: { XCTFail($0) }, rejected: { XCTFail("Rejected \($0)") })
        let content = try NimoCanvasCodec.replace([NimoCanvasCodec.label("Captions", 0, 0, 500, 20)])
        canvas.offer(content, scope: "captions:1"); canvas.readiness(true)
        queue.written(connection, characteristic: characteristic, success: true); clock.advance(0.005)
        let launchAck = Data([0, 0xFD])
        canvas.response(key: 1, payload: launchAck)
        let expected = try NimoCanvasCodec.frames(key: 4, content: content, writeCapacity: 20)
        for _ in expected {
            queue.written(connection, characteristic: characteristic, success: true); clock.advance(0.005)
        }
        XCTAssertEqual(Array(written.dropFirst()), expected)
        canvas.response(key: 4, payload: Data([0, 0xFD, 0, 0, 0]))
        canvas.offer(content, scope: "captions:1")
        XCTAssertEqual(written.count, expected.count + 1)
        canvas.disconnected(); queue.reset()
    }
}
