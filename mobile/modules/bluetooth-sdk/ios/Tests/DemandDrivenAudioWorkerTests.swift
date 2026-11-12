import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class DemandDrivenAudioWorkerTests: XCTestCase {
    private final class Processor {
        let onRelease: () -> Void
        init(onRelease: @escaping () -> Void = {}) {
            self.onRelease = onRelease
        }

        deinit { onRelease() }
    }

    func testNoDemandAndEmptyActiveQueueScheduleNoRecurringWork() {
        let queue = DispatchQueue(label: "test.speech")
        var creations = 0
        var processed = [Data]()
        let worker = DemandDrivenAudioWorker(queue: queue, makeProcessor: {
            creations += 1
            return Processor()
        }, process: { _, data, _ in processed.append(data) })
        worker.accept(Data([1]))
        queue.sync {}
        XCTAssertEqual(creations, 0)
        worker.setActive(true)
        worker.setActive(true)
        queue.sync {}
        XCTAssertEqual(creations, 1)
        XCTAssertTrue(worker.snapshot().initialized)
        XCTAssertFalse(worker.snapshot().processing)
        // A serial barrier completes with an empty queue; no sleeping consumer holds it.
        queue.sync {}
        XCTAssertTrue(processed.isEmpty)
        worker.setActive(false)
        queue.sync {}
        XCTAssertFalse(worker.snapshot().initialized)
    }

    func testFirstAudioIsRetainedDuringAsynchronousInitializationAndBounded() {
        let queue = DispatchQueue(label: "test.speech")
        let loading = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        var processed = [Data]()
        let worker = DemandDrivenAudioWorker(capacity: 3, queue: queue, makeProcessor: {
            XCTAssertFalse(Thread.isMainThread)
            loading.signal()
            release.wait()
            return Processor()
        }, process: { _, data, _ in processed.append(data) })
        worker.setActive(true)
        XCTAssertEqual(loading.wait(timeout: .now() + 2), .success)
        worker.accept(Data([1]))
        worker.accept(Data([2]))
        XCTAssertEqual(worker.snapshot().queuedBuffers, 2)
        release.signal()
        queue.sync {}
        XCTAssertEqual(processed, [Data([1]), Data([2])])
        worker.setActive(false)
        queue.sync {}
    }

    func testStopDuringLoadingDropsOldAudioAndCannotResurrectProcessor() {
        let queue = DispatchQueue(label: "test.speech")
        let loading = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        var released = 0
        var processed = 0
        let worker = DemandDrivenAudioWorker(capacity: 2, queue: queue, makeProcessor: {
            loading.signal()
            release.wait()
            return Processor { released += 1 }
        }, process: { _, _, _ in processed += 1 })
        worker.setActive(true)
        XCTAssertEqual(loading.wait(timeout: .now() + 2), .success)
        for byte: UInt8 in 1 ... 10 {
            worker.accept(Data([byte]))
        }
        XCTAssertEqual(worker.snapshot().queuedBuffers, 2)
        XCTAssertEqual(worker.snapshot().droppedBuffers, 8)
        worker.setActive(false)
        XCTAssertEqual(worker.snapshot().queuedBuffers, 0)
        release.signal()
        queue.sync {}
        XCTAssertEqual(processed, 0)
        XCTAssertEqual(released, 1)
        XCTAssertFalse(worker.snapshot().initialized)
    }

    func testRestartAndRapidDemandChangesSerializeOldAndNewProcessors() {
        let queue = DispatchQueue(label: "test.speech")
        let processing = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        var creations = 0
        var destructions = 0
        var tokens = [UInt64]()
        var dataSeen = [Data]()
        let worker = DemandDrivenAudioWorker(queue: queue, makeProcessor: {
            XCTAssertEqual(creations, destructions)
            creations += 1
            return Processor { destructions += 1 }
        }, process: { _, data, token in
            dataSeen.append(data)
            tokens.append(token)
            if data == Data([1]) {
                processing.signal()
                release.wait()
            }
        })
        worker.setActive(true)
        worker.accept(Data([1]))
        XCTAssertEqual(processing.wait(timeout: .now() + 2), .success)
        worker.accept(Data([2]))
        worker.restart()
        worker.setActive(false)
        worker.setActive(true)
        worker.accept(Data([3]))
        release.signal()
        queue.sync {}
        XCTAssertEqual(dataSeen, [Data([1]), Data([3])])
        XCTAssertFalse(worker.isCurrent(tokens[0]))
        XCTAssertTrue(worker.isCurrent(tokens[1]))
        XCTAssertEqual(creations, 2)
        worker.setActive(false)
        queue.sync {}
        XCTAssertEqual(destructions, 2)
        XCTAssertFalse(worker.isCurrent(tokens[1]))
    }

    func testMissingModelDoesNotRetryEveryFrameAndRestartWithoutDemandDoesNotLoad() {
        let queue = DispatchQueue(label: "test.speech")
        var attempts = 0
        let worker = DemandDrivenAudioWorker<Processor>(queue: queue, makeProcessor: {
            attempts += 1
            return nil
        }, process: { _, _, _ in XCTFail("Missing processor") })
        worker.restart()
        queue.sync {}
        XCTAssertEqual(attempts, 0)
        worker.setActive(true)
        for _ in 0 ..< 5 {
            worker.accept(Data([1]))
            queue.sync {}
        }
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(worker.snapshot().queuedBuffers, 0)
        worker.restart()
        queue.sync {}
        XCTAssertEqual(attempts, 2)
        worker.setActive(false)
        worker.setActive(true)
        queue.sync {}
        XCTAssertEqual(attempts, 3)
        worker.setActive(false)
        queue.sync {}
    }

    func testControlOperationDoesNotEnableMicrophoneDemand() async {
        let worker = DemandDrivenAudioWorker<Processor>(makeProcessor: { Processor() }, process: { _, _, _ in })
        let prepared = await worker.perform { true }
        XCTAssertTrue(prepared)
        XCTAssertFalse(worker.snapshot().active)
        XCTAssertEqual(worker.snapshot().processedBuffers, 0)
        let ran = await worker.withCurrentProcessor { _, _ in true }
        XCTAssertNil(ran)
        XCTAssertFalse(worker.snapshot().initialized)
    }

    func testCurrentProcessorOperationRunsAfterQueuedAudio() async {
        var events = [String]()
        let worker = DemandDrivenAudioWorker<Processor>(makeProcessor: { Processor() }, process: { _, _, _ in
            events.append("audio")
        })
        worker.setActive(true)
        worker.accept(Data([1, 0]))
        let finished = await worker.withCurrentProcessor { _, token -> Bool in
            events.append("flush")
            return worker.isCurrent(token)
        }
        XCTAssertEqual(finished, true)
        XCTAssertEqual(events, ["audio", "flush"])
        worker.setActive(false)
    }

    func testDemandEndReleasesProcessorAndNextDemandLoadsAgain() async {
        var creations = 0
        var releases = 0
        let worker = DemandDrivenAudioWorker<Processor>(makeProcessor: {
            creations += 1
            return Processor { releases += 1 }
        }, process: { _, _, _ in })
        let idle = await worker.awaitLoad()
        XCTAssertEqual(idle, .noDemand)
        XCTAssertEqual(creations, 0)

        worker.setActive(true)
        let loaded = await worker.awaitLoad()
        XCTAssertEqual(loaded, .loaded)
        XCTAssertTrue(worker.snapshot().initialized)
        XCTAssertEqual(creations, 1)

        worker.setActive(false)
        // Release is serialized on the worker queue, after which no processor is reachable.
        let afterRelease = await worker.withCurrentProcessor { _, _ in true }
        XCTAssertNil(afterRelease)
        XCTAssertEqual(releases, 1)
        XCTAssertFalse(worker.snapshot().initialized)
        let ended = await worker.awaitLoad()
        XCTAssertEqual(ended, .noDemand)

        worker.setActive(true)
        let reloaded = await worker.awaitLoad()
        XCTAssertEqual(reloaded, .loaded)
        XCTAssertEqual(creations, 2)
        worker.setActive(false)
        _ = await worker.perform { true }
        XCTAssertEqual(releases, 2)
    }

    func testRestartAndAwaitLoadReportsFailureAndSkipsLoadingWithoutDemand() async {
        var attempts = 0
        var succeed = true
        let worker = DemandDrivenAudioWorker<Processor>(makeProcessor: {
            attempts += 1
            return succeed ? Processor() : nil
        }, process: { _, _, _ in })
        let withoutDemand = await worker.restartAndAwaitLoad()
        XCTAssertEqual(withoutDemand, .noDemand)
        _ = await worker.perform { true }
        XCTAssertEqual(attempts, 0)

        worker.setActive(true)
        let first = await worker.awaitLoad()
        XCTAssertEqual(first, .loaded)
        succeed = false
        let failed = await worker.restartAndAwaitLoad()
        XCTAssertEqual(failed, .failed)
        XCTAssertFalse(worker.snapshot().initialized)
        succeed = true
        let recovered = await worker.restartAndAwaitLoad()
        XCTAssertEqual(recovered, .loaded)
        XCTAssertEqual(attempts, 3)
        worker.setActive(false)
    }

    func testControlOperationRunsWhileAudioArrivesFasterThanInference() async {
        let queue = DispatchQueue(label: "test.speech.slow")
        let worker = DemandDrivenAudioWorker<Processor>(queue: queue, makeProcessor: { Processor() }, process: { _, _, _ in
            Thread.sleep(forTimeInterval: 0.004)
        })
        let loaded = await worker.activateAndAwaitLoad()
        XCTAssertEqual(loaded, .loaded)

        let feeding = ManagedAtomicFlag()
        let feeder = Thread {
            // One buffer per millisecond against 4 ms of inference each: the queue never empties.
            while !feeding.isSet {
                worker.accept(Data([1]))
                Thread.sleep(forTimeInterval: 0.001)
            }
        }
        feeder.start()
        let started = Date()
        let ran = await worker.perform { true }
        let waited = Date().timeIntervalSince(started)
        feeding.set()
        XCTAssertTrue(ran)
        XCTAssertLessThan(waited, 1.0)
        worker.setActive(false)
    }

    func testEnablingAgainRetriesAFailedLoadButNotAWorkingOne() async {
        var attempts = 0
        var succeed = false
        let worker = DemandDrivenAudioWorker<Processor>(makeProcessor: {
            attempts += 1
            return succeed ? Processor() : nil
        }, process: { _, _, _ in })
        let failed = await worker.activateAndAwaitLoad()
        XCTAssertEqual(failed, .failed)
        XCTAssertEqual(attempts, 1)

        succeed = true
        let recovered = await worker.activateAndAwaitLoad()
        XCTAssertEqual(recovered, .loaded)
        XCTAssertEqual(attempts, 2)

        let again = await worker.activateAndAwaitLoad()
        XCTAssertEqual(again, .loaded)
        XCTAssertEqual(attempts, 2)
        worker.setActive(false)
    }

    func testAwaitLoadWaitsForASlowLoad() async {
        let loading = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let worker = DemandDrivenAudioWorker<Processor>(makeProcessor: {
            loading.signal()
            release.wait()
            return Processor()
        }, process: { _, _, _ in })
        worker.setActive(true)
        XCTAssertEqual(loading.wait(timeout: .now() + 2), .success)
        XCTAssertFalse(worker.snapshot().initialized)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { release.signal() }
        let state = await worker.awaitLoad()
        XCTAssertEqual(state, .loaded)
        XCTAssertTrue(worker.snapshot().initialized)
        worker.setActive(false)
    }
}

/// A tiny thread-safe stop flag for the feeder thread.
private final class ManagedAtomicFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set() {
        lock.lock()
        value = true
        lock.unlock()
    }
}
