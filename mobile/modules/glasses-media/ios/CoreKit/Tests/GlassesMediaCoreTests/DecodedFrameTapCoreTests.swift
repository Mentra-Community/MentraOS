@testable import GlassesMediaCore
import XCTest

final class DecodedFrameTapCoreTests: XCTestCase {
    private struct Boom: Error {}

    func testNoSinkAndTelemetryOffCollectsNothing() {
        let tap = DecodedFrameTapCore<Int>()
        for frame in 0 ..< 5 { tap.offer(frame, from: .acs) }
        tap.recordAcsSend()
        let metrics = tap.drainMetrics()
        XCTAssertEqual(metrics.framesOffered, 0)
        XCTAssertEqual(metrics.acsFramesSent, 0)
    }

    func testTelemetryCollectsCadenceAndSendsWithNoSink() {
        var now: Int64 = 1_000
        let tap = DecodedFrameTapCore<Int>(clock: { now })
        tap.setTelemetryEnabled(true)
        for frame in 0 ..< 5 {
            tap.offer(frame, from: .acs)
            tap.recordAcsSend()
            now += 33_000_000
        }
        let metrics = tap.drainMetrics()
        XCTAssertEqual(metrics.framesOffered, 5)
        XCTAssertEqual(metrics.framesWithSink, 0)
        XCTAssertEqual(metrics.cadenceSamples, 4)
        XCTAssertEqual(metrics.cadenceMaxMs, 33, accuracy: 0.001)
        XCTAssertEqual(metrics.acsFramesSent, 5)
    }

    func testAThrowingSinkNeverReachesTheCallerAndIsReported() {
        let tap = DecodedFrameTapCore<Int>()
        var reported: Error?
        let generation = tap.attach({ _ in throw Boom() }, producer: .acs, onSinkError: { reported = $0 })
        tap.offer(1, from: .acs)
        tap.offer(2, from: .acs)
        let metrics = tap.drainMetrics()
        XCTAssertEqual(metrics.sinkExceptions, 2)
        XCTAssertEqual(metrics.framesWithSink, 2)
        XCTAssertTrue(reported is Boom)
        XCTAssertTrue(tap.detach(generation: generation))
    }

    func testALateDetachCannotRemoveANewerSink() {
        let tap = DecodedFrameTapCore<Int>()
        var newerFrames = 0
        let older = tap.attach({ _ in }, producer: .acs)
        let newer = tap.attach({ _ in newerFrames += 1 }, producer: .acs)
        XCTAssertFalse(tap.detach(generation: older))
        XCTAssertFalse(tap.isCurrent(generation: older))
        XCTAssertTrue(tap.isCurrent(generation: newer))
        tap.offer(1, from: .acs)
        XCTAssertEqual(newerFrames, 1)
        XCTAssertTrue(tap.detach(generation: newer))
        XCTAssertFalse(tap.hasSink)
    }

    func testASinkOnlyReceivesFramesFromItsOwnProducer() {
        let tap = DecodedFrameTapCore<Int>()
        var acsFrames: [Int] = []
        let acs = tap.attach({ acsFrames.append($0) }, producer: .acs)
        tap.offer(1, from: .acs)
        tap.offer(2, from: .relay)
        tap.offer(3, from: .acs)
        XCTAssertEqual(acsFrames, [1, 3])
        XCTAssertTrue(tap.detach(generation: acs))

        var relayFrames: [Int] = []
        let relay = tap.attach({ relayFrames.append($0) }, producer: .relay)
        tap.offer(4, from: .acs)
        tap.offer(5, from: .relay)
        XCTAssertEqual(relayFrames, [5])
        XCTAssertEqual(acsFrames, [1, 3])
        XCTAssertTrue(tap.detach(generation: relay))
    }

    /// Teams with Direct link off runs both decoders at once. The relay's copy must not double the
    /// frame count or halve the cadence the ACS preview reports.
    func testFramesFromTheOtherProducerAreNotCounted() {
        var now: Int64 = 1_000
        let tap = DecodedFrameTapCore<Int>(clock: { now })
        let generation = tap.attach({ _ in }, producer: .acs)
        for frame in 0 ..< 4 {
            tap.offer(frame, from: .acs)
            now += 10_000_000
            tap.offer(frame, from: .relay)
            now += 23_000_000
        }
        let metrics = tap.drainMetrics()
        XCTAssertEqual(metrics.framesOffered, 4)
        XCTAssertEqual(metrics.framesWithSink, 4)
        XCTAssertEqual(metrics.cadenceSamples, 3)
        XCTAssertEqual(metrics.cadenceMaxMs, 33, accuracy: 0.001)
        XCTAssertTrue(tap.detach(generation: generation))
    }

    func testAThrowingSinkIsNotCalledForTheOtherProducer() {
        let tap = DecodedFrameTapCore<Int>()
        var reported = 0
        let generation = tap.attach({ _ in throw Boom() }, producer: .relay, onSinkError: { _ in reported += 1 })
        tap.offer(1, from: .acs)
        XCTAssertEqual(reported, 0)
        XCTAssertEqual(tap.drainMetrics().sinkExceptions, 0)
        tap.offer(2, from: .relay)
        XCTAssertEqual(reported, 1)
        XCTAssertTrue(tap.detach(generation: generation))
    }

    func testTelemetryWithNoSinkMeasuresTheAcsCallOnly() {
        let tap = DecodedFrameTapCore<Int>()
        tap.setTelemetryEnabled(true)
        tap.offer(1, from: .relay)
        tap.offer(2, from: .acs)
        XCTAssertEqual(tap.drainMetrics().framesOffered, 1)

        // A relay sink that has gone leaves telemetry measuring the ACS call again.
        let generation = tap.attach({ _ in }, producer: .relay)
        XCTAssertTrue(tap.detach(generation: generation))
        tap.offer(3, from: .relay)
        tap.offer(4, from: .acs)
        XCTAssertEqual(tap.drainMetrics().framesOffered, 1)
    }

    func testReattachingForAnotherProducerSwitchesWhatIsDelivered() {
        let tap = DecodedFrameTapCore<Int>()
        var frames: [Int] = []
        let first = tap.attach({ frames.append($0) }, producer: .acs)
        let second = tap.attach({ frames.append($0 * 10) }, producer: .relay)
        tap.offer(1, from: .acs)
        tap.offer(2, from: .relay)
        XCTAssertEqual(frames, [20])
        XCTAssertFalse(tap.detach(generation: first))
        XCTAssertTrue(tap.detach(generation: second))
    }

    // MARK: - The relay's fan-out

    func testTheRelayPublishesEveryFrameBeforeThePreviewSeesIt() {
        let tap = DecodedFrameTapCore<Int>()
        var order: [String] = []
        let generation = tap.attach({ order.append("preview \($0)") }, producer: .relay)
        tap.relay(1) { order.append("publisher \($0)") }
        tap.relay(2) { order.append("publisher \($0)") }
        XCTAssertEqual(order, ["publisher 1", "preview 1", "publisher 2", "preview 2"])
        XCTAssertTrue(tap.detach(generation: generation))
    }

    func testTheRelayPublishesWithNoPreviewAttached() {
        let tap = DecodedFrameTapCore<Int>()
        var published: [Int] = []
        for frame in 0 ..< 3 { tap.relay(frame) { published.append($0) } }
        XCTAssertEqual(published, [0, 1, 2])
        XCTAssertEqual(tap.drainMetrics().framesOffered, 0)
    }

    func testAThrowingPreviewNeverInterruptsTheRelayPublisher() {
        let tap = DecodedFrameTapCore<Int>()
        var published: [Int] = []
        let generation = tap.attach({ _ in throw Boom() }, producer: .relay)
        for frame in 0 ..< 3 { tap.relay(frame) { published.append($0) } }
        XCTAssertEqual(published, [0, 1, 2])
        XCTAssertEqual(tap.drainMetrics().sinkExceptions, 3)
        XCTAssertTrue(tap.detach(generation: generation))
    }

    /// A Teams call's ACS preview must never be handed the relay's copy of the stream.
    func testAnAcsPreviewNeverReceivesRelayFrames() {
        let tap = DecodedFrameTapCore<Int>()
        var previewed = 0
        var published = 0
        let generation = tap.attach({ _ in previewed += 1 }, producer: .acs)
        for frame in 0 ..< 3 { tap.relay(frame) { _ in published += 1 } }
        XCTAssertEqual(published, 3)
        XCTAssertEqual(previewed, 0)
        XCTAssertTrue(tap.detach(generation: generation))
    }
}
