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
}
