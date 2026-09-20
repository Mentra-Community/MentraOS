import XCTest

@testable import FramePreviewCore

final class PreviewPacerTests: XCTestCase {
  private let period = PreviewPacer.period(forFps: 15)

  private func readyPacer() -> PreviewPacer {
    let pacer = PreviewPacer(targetFps: 15)
    pacer.beginGeneration()
    pacer.setConsumerReady(true)
    pacer.start(nowNs: 0)
    return pacer
  }

  func testNoCreditBeforeTheConsumerAuthenticates() {
    let pacer = PreviewPacer(targetFps: 15)
    pacer.beginGeneration()
    pacer.start(nowNs: 0)
    XCTAssertEqual(pacer.admit(nowNs: 0), .notRunning, "an unauthenticated page must never be sent pixels")
    pacer.setConsumerReady(true)
    XCTAssertEqual(pacer.admit(nowNs: 0), .admit(sequence: 1))
  }

  func testOnlyOneFrameIsEverInFlight() {
    let pacer = readyPacer()
    XCTAssertEqual(pacer.admit(nowNs: 0), .admit(sequence: 1))
    XCTAssertEqual(pacer.admit(nowNs: period * 5), .skipBusy, "still packing")
    pacer.onPacked(sequence: 1, sent: true, nowNs: period)
    XCTAssertEqual(pacer.outstandingFrames, 1)
    XCTAssertEqual(pacer.admit(nowNs: period * 5), .skipBusy, "sent but unacknowledged")
    XCTAssertEqual(pacer.onAck(generation: pacer.generation, sequence: 1, nowNs: period * 2), .accepted(roundTripNs: period))
    XCTAssertEqual(pacer.outstandingFrames, 0)
    XCTAssertEqual(pacer.admit(nowNs: period * 5), .admit(sequence: 2))
  }

  func testScheduleIsAbsoluteRatherThanAFixedDelayAfterEachFrame() {
    let pacer = readyPacer()
    guard case .admit = pacer.admit(nowNs: 0) else { return XCTFail("first frame") }
    pacer.onPacked(sequence: 1, sent: true, nowNs: 0)
    // The consumer took 40 ms; the next slot is still the one at 66.7 ms, not 40 + 66.7.
    _ = pacer.onAck(generation: pacer.generation, sequence: 1, nowNs: 40_000_000)
    XCTAssertEqual(pacer.admit(nowNs: 60_000_000), .skipPacing)
    XCTAssertEqual(pacer.admit(nowNs: period), .admit(sequence: 2))
  }

  func testALongStallResyncsInsteadOfBurstingToCatchUp() {
    let pacer = readyPacer()
    guard case .admit = pacer.admit(nowNs: 0) else { return XCTFail("first frame") }
    pacer.onPacked(sequence: 1, sent: false, nowNs: 0)
    // Ten periods of nothing (backgrounded, thermal dip). The next frame is admitted once, and
    // the one after it waits a full period rather than replaying the missed slots.
    let late = period * 10
    XCTAssertEqual(pacer.admit(nowNs: late), .admit(sequence: 2))
    pacer.onPacked(sequence: 2, sent: false, nowNs: late)
    XCTAssertEqual(pacer.admit(nowNs: late + 1), .skipPacing)
    XCTAssertEqual(pacer.admit(nowNs: late + period), .admit(sequence: 3))
  }

  func testAcksFromAPreviousGenerationOrFrameAreRejected() {
    let pacer = readyPacer()
    guard case .admit = pacer.admit(nowNs: 0) else { return XCTFail("first frame") }
    pacer.onPacked(sequence: 1, sent: true, nowNs: 0)
    XCTAssertEqual(pacer.onAck(generation: pacer.generation &- 1, sequence: 1, nowNs: period), .stale)
    XCTAssertEqual(pacer.onAck(generation: pacer.generation, sequence: 99, nowNs: period), .stale)
    XCTAssertEqual(pacer.outstandingFrames, 1, "a stale ack must not return credit")
    XCTAssertEqual(pacer.onAck(generation: pacer.generation, sequence: 1, nowNs: period), .accepted(roundTripNs: period))
    XCTAssertEqual(pacer.onAck(generation: pacer.generation, sequence: 1, nowNs: period), .stale, "acked twice")
  }

  func testAckTimeoutIsReportedAndANewDocumentRevokesCredit() {
    let pacer = readyPacer()
    guard case .admit = pacer.admit(nowNs: 0) else { return XCTFail("first frame") }
    pacer.onPacked(sequence: 1, sent: true, nowNs: 0)
    XCTAssertFalse(pacer.hasAckTimedOut(nowNs: 1_000_000_000))
    XCTAssertTrue(pacer.hasAckTimedOut(nowNs: 2_500_000_000))

    pacer.beginGeneration()
    XCTAssertFalse(pacer.consumerReady, "a new document must re-authenticate")
    XCTAssertEqual(pacer.admit(nowNs: 3_000_000_000), .notRunning)
  }

  func testStopKeepsTheConsumerAuthenticatedSoRestartNeedsNoHandshake() {
    let pacer = readyPacer()
    guard case .admit = pacer.admit(nowNs: 0) else { return XCTFail("first frame") }
    pacer.stop()
    XCTAssertEqual(pacer.admit(nowNs: period), .notRunning)
    pacer.start(nowNs: period)
    XCTAssertTrue(pacer.consumerReady)
    XCTAssertEqual(pacer.admit(nowNs: period), .admit(sequence: 2))
  }
}
