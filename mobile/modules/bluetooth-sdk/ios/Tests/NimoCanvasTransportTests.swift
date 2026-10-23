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

    func testNotReadyProbesAreTimedBoundedAndCancelled() {
        for stop in ["budget", "disconnect", "exit", "notReady"] {
            let clock = NimoTestClock()
            var keys: [Int] = []
            let canvas = NimoCanvasCoordinator(schedule: clock.schedule, writeCapacity: { 512 }, enqueue: { frames, start, complete in
                keys.append(Int(frames[0][9])); start(); complete(); return true
            }, reconnect: { XCTFail($0) }, rejected: { _ in })
            canvas.activate(); canvas.readiness(true)
            for attempt in 0 ..< 4 {
                canvas.response(key: 1, payload: Data([7]))
                if stop == "disconnect" { canvas.disconnected() }
                if stop == "exit" { canvas.exit() }
                if stop == "notReady" { canvas.readiness(false) }
                let before = keys.count
                clock.advance(0.999)
                XCTAssertEqual(keys.count, before)
                clock.advance(0.001)
                XCTAssertEqual(keys.count, before + (stop == "budget" && attempt < 3 ? 1 : 0))
                if stop != "budget" { break }
            }
            clock.advance(60)
            XCTAssertEqual(keys.count, stop == "budget" ? 4 : 1)
        }
    }

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

    func testEncoderInvalidationRetainsRunningWorkerAndPendingDelivery() {
        let main = NimoTestClock(), worker = NimoTestClock()
        var delivered = false
        var encoder: NimoCanvasEncoder!
        encoder = NimoCanvasEncoder(main: main.schedule, worker: worker.schedule, failure: { XCTFail("\($0)") })
        encoder.submit(encode: {
            XCTAssertEqual(encoder.workerCount, 1)
            encoder.invalidate()
            XCTAssertEqual(encoder.workerCount, 1) // Running encode is not cancelled by dropping its result.
            return Data([1])
        }, deliver: { _ in delivered = true })
        worker.advance()
        XCTAssertEqual(encoder.workerCount, 0)
        XCTAssertEqual(encoder.deliveryCount, 1)
        main.advance()
        XCTAssertEqual(encoder.deliveryCount, 0)
        XCTAssertFalse(delivered)
    }

    func testWriterResetCannotEraseRealInFlightOrPostedCompletion() {
        let clock = NimoTestClock(), original = NSObject(), replacement = NSObject(), characteristic = NSObject()
        let queue = NimoWriteQueue<NSObject>(schedule: clock.schedule, write: { _, _ in true }, failure: { XCTFail($0) })
        queue.connected(original)
        queue.enqueue(original, characteristic: characteristic, frames: [Data([1])])
        XCTAssertEqual(queue.activeCount, 1)
        queue.reset()
        XCTAssertEqual(queue.activeCount, 1)
        queue.written(replacement, characteristic: characteristic, success: true)
        XCTAssertEqual(queue.activeCount, 1)
        queue.connectionClosed(replacement)
        XCTAssertEqual(queue.activeCount, 1)
        queue.connectionClosed(original)
        XCTAssertEqual(queue.activeCount, 0)
        queue.connected(original)
        queue.enqueue(original, characteristic: characteristic, frames: [Data([1])])
        queue.written(original, characteristic: characteristic, success: true)
        queue.reset()
        XCTAssertEqual(queue.activeCount, 1) // Real scheduled completion still must run its fence.
        clock.advance(0.005)
        XCTAssertEqual(queue.activeCount, 0)
    }

    func testCanvasExitEvidenceWaitsForWriteCompletionAndExactBusinessAck() {
        let clock = NimoTestClock()
        var started: (() -> Void)?, completed: (() -> Void)?, results: [Int] = []
        var observed: [UInt64?] = []
        let canvas = NimoCanvasCoordinator(schedule: clock.schedule, writeCapacity: { 512 }, enqueue: { _, start, complete in
            started = start; completed = complete; return true
        }, reconnect: { XCTFail($0) }, rejected: { _ in }, result: { key, status in
            if key == 3 { results.append(status) }
        }, observedResult: { key, _, received in
            if key == 3 { observed.append(received) }
        }, continuousNow: { 120 })
        canvas.activate(); canvas.readiness(true)
        started?(); completed?(); canvas.response(key: 1, payload: Data([0, 0xFD]))
        started?(); completed?(); canvas.response(key: 4, payload: Data([0, 0xFD, 0, 0, 0]))
        XCTAssertTrue(canvas.mayHaveEntered)
        canvas.exit(); started?()
        canvas.response(key: 3, payload: Data([0, 0xFD]), receivedElapsedMs: 119)
        XCTAssertTrue(results.isEmpty) // Queued prewrite ACK cannot settle Exit.
        canvas.response(key: 3, payload: Data([0, 0xFD]), receivedElapsedMs: 123)
        XCTAssertTrue(results.isEmpty)
        completed?()
        XCTAssertEqual(results, [0])
        XCTAssertEqual(observed, [123]) // Never retimestamp buffered ACK at write completion.
        XCTAssertFalse(canvas.mayHaveEntered)
    }


    func testCancelledQueuedEncoderRemainsInRosterUntilBothRealFencesExecute() {
        let main = NimoTestClock(), worker = NimoTestClock()
        var encoded = false
        let encoder = NimoCanvasEncoder(main: main.schedule, worker: worker.schedule, failure: { XCTFail("\($0)") })
        encoder.submit(encode: { encoded = true; return Data([1]) }, deliver: { _ in XCTFail("Cancelled delivery") })
        encoder.invalidate()
        XCTAssertEqual(encoder.workerCount, 1)
        worker.advance()
        XCTAssertFalse(encoded)
        XCTAssertEqual(encoder.workerCount, 0)
        XCTAssertEqual(encoder.deliveryCount, 1)
        main.advance()
        XCTAssertEqual(encoder.deliveryCount, 0)
    }

    func testReleaseDrainsOriginalLaunchAndUpdateBeforeExit() {
        for releaseKey in [1, 4] {
            let clock = NimoTestClock()
            var now: UInt64 = 100
            var started: (() -> Void)?, completed: (() -> Void)?
            var keys: [Int] = [], observed: [(Int, UInt64?)] = []
            let canvas = NimoCanvasCoordinator(schedule: clock.schedule, writeCapacity: { 512 }, enqueue: { frames, start, complete in
                keys.append(Int(frames[0][9])); started = start; completed = complete; return true
            }, reconnect: { XCTFail($0) }, rejected: { _ in }, observedResult: { key, _, received in observed.append((key, received)) }, continuousNow: { now })
            canvas.activate(); canvas.readiness(true)
            if releaseKey == 4 {
                started?(); completed?(); canvas.response(key: 1, payload: Data([0, 0xFD]), receivedElapsedMs: 100)
                now = 110
            }
            started?(); let originalCompletion = completed
            canvas.drainForRelease()
            canvas.offer(Data([9]), scope: "new", force: true)
            canvas.activate(); canvas.readiness(true); canvas.nativeApp(99, entered: true)
            let payload = releaseKey == 4 ? Data([0, 0xFD, 0, 0, 0]) : Data([0, 0xFD])
            func deliver(_ key: Int, _ data: Data, _ received: UInt64) {
                if canvas.acceptsReleaseResponse(key: key, payload: data) { canvas.response(key: key, payload: data, receivedElapsedMs: received) }
            }
            XCTAssertFalse(canvas.acceptsReleaseResponse(key: 3, payload: Data([0, 0xFD])))
            XCTAssertFalse(canvas.acceptsReleaseResponse(key: releaseKey, payload: Data([0, 1])))
            XCTAssertTrue(canvas.acceptsReleaseResponse(key: releaseKey, payload: payload))
            deliver(releaseKey, payload, now - 1) // Callback received before actual final write.
            XCTAssertEqual(keys.last, releaseKey)
            deliver(releaseKey, payload, now + 2) // Early ACK buffered until real didWrite.
            XCTAssertEqual(keys.last, releaseKey)
            originalCompletion?()
            XCTAssertEqual(keys.last, 3)
            XCTAssertEqual(observed.last?.0, releaseKey); XCTAssertEqual(observed.last?.1, now + 2)
            now += 10; started?(); completed?()
            deliver(releaseKey, payload, now)
            XCTAssertEqual(canvas.pendingCount, 1)
            deliver(3, Data([0, 0xFD]), now + 1)
            XCTAssertEqual(canvas.pendingCount, 0); XCTAssertFalse(canvas.mayHaveEntered)
            XCTAssertEqual(keys, releaseKey == 1 ? [1, 3] : [1, 4, 3])
            canvas.offer(Data([8]), scope: "replacement"); clock.advance(2)
            XCTAssertEqual(keys.last, 3)
        }
    }

    func testReleaseMissingOrRejectedOriginalAckCannotInventExitOrRetry() {
        for status: UInt8? in [nil, 7, 8, 2] {
            let clock = NimoTestClock()
            var keys: [Int] = [], reconnects: [String] = [], results: [Int] = []
            let canvas = NimoCanvasCoordinator(schedule: clock.schedule, writeCapacity: { 512 }, enqueue: { frames, start, complete in
                keys.append(Int(frames[0][9])); start(); complete(); return true
            }, reconnect: { reconnects.append($0) }, rejected: { _ in }, result: { key, _ in results.append(key) })
            canvas.activate(); canvas.readiness(true); canvas.drainForRelease()
            if let status {
                let payload = Data([status])
                XCTAssertTrue(canvas.acceptsReleaseResponse(key: 1, payload: payload))
                canvas.response(key: 1, payload: payload)
            }
            clock.advance(46)
            XCTAssertEqual(keys, [1]); XCTAssertFalse(results.contains(3))
            if status == nil || status == 2 { XCTAssertEqual(reconnects.count, 1) }
        }
    }

}
