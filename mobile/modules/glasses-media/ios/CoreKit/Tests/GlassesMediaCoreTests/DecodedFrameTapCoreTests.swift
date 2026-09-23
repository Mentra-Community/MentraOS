@testable import GlassesMediaCore
import XCTest

final class DecodedFrameTapCoreTests: XCTestCase {
    private struct Boom: Error {}

    func testNoSinkAndTelemetryOffCollectsNothing() {
        let tap = DecodedFrameTapCore<Int>()
        for frame in 0 ..< 5 { tap.offer(frame) }
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
            tap.offer(frame)
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
        let generation = tap.attach({ _ in throw Boom() }, onSinkError: { reported = $0 })
        tap.offer(1)
        tap.offer(2)
        let metrics = tap.drainMetrics()
        XCTAssertEqual(metrics.sinkExceptions, 2)
        XCTAssertEqual(metrics.framesWithSink, 2)
        XCTAssertTrue(reported is Boom)
        XCTAssertTrue(tap.detach(generation: generation))
    }

    func testALateDetachCannotRemoveANewerSink() {
        let tap = DecodedFrameTapCore<Int>()
        var newerFrames = 0
        let older = tap.attach { _ in }
        let newer = tap.attach { _ in newerFrames += 1 }
        XCTAssertFalse(tap.detach(generation: older))
        XCTAssertFalse(tap.isCurrent(generation: older))
        XCTAssertTrue(tap.isCurrent(generation: newer))
        tap.offer(1)
        XCTAssertEqual(newerFrames, 1)
        XCTAssertTrue(tap.detach(generation: newer))
        XCTAssertFalse(tap.hasSink)
    }
}
