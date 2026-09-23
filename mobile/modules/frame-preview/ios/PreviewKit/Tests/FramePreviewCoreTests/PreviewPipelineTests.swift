@testable import FramePreviewCore
import XCTest

/// The iOS frame path without CoreVideo or the socket: a fake transport, a controllable clock and
/// synchronous scheduling, so failure isolation and fault injection are deterministic.
final class PreviewPipelineTests: XCTestCase {
  private final class FakeTransport: PreviewFrameTransport {
    var sent: [[UInt8]] = []
    var dropped = 0
    var accept = true

    func send(_ slot: PreviewSlot, byteCount: Int, completion: @escaping (Bool) -> Void) -> Bool {
      guard accept else { return false }
      sent.append(Array(slot.buffer.prefix(byteCount)))
      completion(true)
      return true
    }

    func dropConsumer() { dropped += 1 }
  }

  private var now: Int64 = 1_000_000_000
  private var transport = FakeTransport()
  private var logs: [String] = []
  private var stops: [String] = []
  private var delayed: [(Int, () -> Void)] = []
  private var pipeline: PreviewPipeline!

  override func setUp() {
    super.setUp()
    transport = FakeTransport()
    logs = []
    stops = []
    delayed = []
    pipeline = PreviewPipeline(
      transport: transport,
      trace: PreviewTrace(sink: { [unowned self] _, line in logs.append(line) }, clockMs: { 0 }),
      scaler: BoxPlaneScaler(),
      clock: { [unowned self] in now },
      schedule: { [unowned self] delay, work in
        if delay == 0 { work() } else { delayed.append((delay, work)) }
      }
    )
    pipeline.onStopRequested = { [unowned self] reason in
      stops.append(reason)
      pipeline.stop()
    }
    pipeline.setDiagnosticsEnabled(true)
  }

  private func startRendering(box: PreviewSize = PreviewSize(width: 640, height: 360)) throws {
    _ = try pipeline.configure(PreviewConfig(mode: .render, targetWidth: box.width, targetHeight: box.height, maxFps: 15))
    pipeline.beginDocument()
    pipeline.consumerAuthenticated()
    pipeline.start()
  }

  /// One source frame through admission and processing, as the session does on its queue.
  @discardableResult
  private func offer(_ source: TestFrame, frame: PreviewSourceFrame? = nil) -> Bool {
    guard case let .admit(sequence) = pipeline.admit() else { return false }
    pipeline.process(frame ?? source.frame(), sequence: sequence, admittedAtNs: now)
    return true
  }

  private func ackLast() throws {
    guard case let .ok(frame) = PreviewFrameParser.parse(try XCTUnwrap(transport.sent.last)) else {
      return XCTFail("last frame does not parse")
    }
    pipeline.ackReceived(generation: frame.sessionGeneration, sequence: frame.frameSequence)
  }

  private func advance(ms: Int64) { now += ms * 1_000_000 }

  func testACallFrameIsDownscaledAndTheHeaderReportsTheProducedSize() throws {
    try startRendering()
    offer(TestFrame(format: .nv12, width: 1280, height: 720, fill: (0x30, 0x40, 0x50)))
    let bytes = try XCTUnwrap(transport.sent.first)
    guard case let .ok(frame) = PreviewFrameParser.parse(bytes) else { return XCTFail("does not parse") }
    XCTAssertEqual(frame.width, 640)
    XCTAssertEqual(frame.height, 360)
    XCTAssertEqual(bytes.count, PreviewFrameHeader.byteCount + frame.payloadLength)
    XCTAssertEqual(bytes[PreviewFrameHeader.byteCount], 0x30)
    let status = pipeline.status(tap: PreviewTapSnapshot(), tapSeconds: 1)
    XCTAssertEqual(status["outWidth"] as? Int, 640)
    XCTAssertEqual(status["srcWidth"] as? Int, 1280)
  }

  func testI420IsScaledPlaneByPlane() throws {
    try startRendering(box: PreviewSize(width: 320, height: 180))
    offer(TestFrame(format: .i420, width: 640, height: 360, fill: (0x10, 0x20, 0x30)))
    let bytes = try XCTUnwrap(transport.sent.first)
    let luma = 320 * 180
    let chroma = 160 * 90
    let base = PreviewFrameHeader.byteCount
    XCTAssertEqual(Set(bytes[base ..< base + luma]), [0x10])
    XCTAssertEqual(Set(bytes[base + luma ..< base + luma + chroma]), [0x20])
    XCTAssertEqual(Set(bytes[base + luma + chroma ..< base + luma + 2 * chroma]), [0x30])
  }

  func testASourceInsideTheBoxIsSentAtItsOwnSize() throws {
    try startRendering()
    offer(TestFrame(width: 480, height: 270))
    guard case let .ok(frame) = PreviewFrameParser.parse(try XCTUnwrap(transport.sent.first)) else { return XCTFail() }
    XCTAssertEqual(frame.width, 480)
    XCTAssertEqual(frame.height, 270)
  }

  func testOneCreditUntilTheAckArrives() throws {
    try startRendering()
    let source = TestFrame(width: 320, height: 180)
    offer(source)
    for _ in 0 ..< 10 {
      advance(ms: 100)
      XCTAssertFalse(offer(source))
    }
    XCTAssertEqual(transport.sent.count, 1)
    try ackLast()
    advance(ms: 100)
    XCTAssertTrue(offer(source))
    XCTAssertEqual(transport.sent.count, 2)
  }

  func testAThrowInThePackPathIsCaughtCountedAndStops() throws {
    try startRendering()
    try pipeline.armFault(.packThrow, ms: 0)
    offer(TestFrame(width: 320, height: 180))
    XCTAssertEqual(stops, ["pack_failed"])
    XCTAssertTrue(transport.sent.isEmpty)
    XCTAssertEqual(pipeline.stats.packFailuresByReason, ["worker_error": 1])
    XCTAssertTrue(logs.contains { $0.contains("phase=pack_failed") && $0.contains("reason=worker_error") })
  }

  func testASinkErrorIsCountedAndStops() throws {
    try startRendering()
    pipeline.sinkFailed(InjectedPreviewFault(kind: .sinkThrow))
    XCTAssertEqual(stops, ["pack_failed"])
    var tap = PreviewTapSnapshot()
    tap.sinkExceptions = 1
    let status = pipeline.status(tap: tap, tapSeconds: 1)
    XCTAssertEqual(status["tapSinkExceptions"] as? Int, 1)
    XCTAssertEqual(status["packFailures"] as? [String: Int], ["sink_error": 1])
  }

  func testMalformedGeometryIsRejectedBeforeAnyCopy() throws {
    try startRendering()
    let source = TestFrame(width: 320, height: 180)
    offer(source, frame: source.frame(lumaAvailable: 100))
    XCTAssertEqual(stops, ["pack_failed"])
    XCTAssertTrue(transport.sent.isEmpty)
    XCTAssertEqual(pipeline.stats.packFailuresByReason, ["plane_out_of_bounds": 1])
  }

  func testDroppedAcksEndInAckTimeoutRatherThanANewCredit() throws {
    try startRendering()
    try pipeline.armFault(.ackDrop, ms: 0)
    let source = TestFrame(width: 320, height: 180)
    offer(source)
    try ackLast()
    advance(ms: 2500)
    XCTAssertFalse(offer(source))
    XCTAssertEqual(stops, ["ack_timeout"])
    XCTAssertEqual(transport.sent.count, 1)
    XCTAssertEqual(pipeline.stats.ackTimeouts, 1)
  }

  func testAckDelayHoldsTheAckUntilItsTimerFires() throws {
    try startRendering()
    try pipeline.armFault(.ackDelay, ms: 300)
    let source = TestFrame(width: 320, height: 180)
    offer(source)
    try ackLast()
    XCTAssertEqual(delayed.map(\.0), [300])
    advance(ms: 100)
    XCTAssertFalse(offer(source))
    delayed.removeFirst().1()
    advance(ms: 100)
    XCTAssertTrue(offer(source))
  }

  func testAClosedTransportStopsWithTransportFailed() throws {
    try startRendering()
    try pipeline.armFault(.transportClose, ms: 0)
    offer(TestFrame(width: 320, height: 180))
    XCTAssertEqual(stops, ["transport_failed"])
    XCTAssertEqual(transport.dropped, 1)
  }

  func testAWrongTokenNeverRevokesTheCurrentConsumer() throws {
    try startRendering()
    pipeline.transportFailed(reason: "auth_failed", detail: "token_mismatch")
    XCTAssertTrue(stops.isEmpty)
    XCTAssertTrue(offer(TestFrame(width: 320, height: 180)))
  }

  func testStaleAcksAreCountedAndIgnored() throws {
    try startRendering()
    offer(TestFrame(width: 320, height: 180))
    pipeline.ackReceived(generation: 99, sequence: 1)
    XCTAssertEqual(pipeline.stats.staleAcks, 1)
    XCTAssertEqual(pipeline.pacer.outstandingFrames, 1)
  }

  func testATierChangeSwapsTheOutputWithoutRestartingProduction() throws {
    try startRendering()
    let source = TestFrame(width: 1280, height: 720)
    offer(source)
    let outcome = try pipeline.configure(PreviewConfig(mode: .render, targetWidth: 320, targetHeight: 180, maxFps: 15))
    XCTAssertEqual(outcome, PreviewPipeline.ConfigureOutcome(restartProduction: false, tierChanged: true))
    try ackLast()
    advance(ms: 100)
    offer(source)
    guard case let .ok(frame) = PreviewFrameParser.parse(try XCTUnwrap(transport.sent.last)) else { return XCTFail() }
    XCTAssertEqual(frame.width, 320)
    XCTAssertEqual(pipeline.stats.tierChanges, 1)
  }

  func testReleaseRejectsDiagnosticsAndClampsToTheProductCeiling() throws {
    pipeline.setDiagnosticsEnabled(false)
    XCTAssertThrowsError(try pipeline.configure(PreviewConfig(source: .synthetic, mode: .render))) { error in
      XCTAssertEqual((error as? PreviewRejection)?.code, "diagnostics_disabled")
    }
    XCTAssertThrowsError(try pipeline.configure(PreviewConfig(mode: .packOnly)))
    XCTAssertThrowsError(try pipeline.armFault(.packThrow, ms: 0))
    _ = try pipeline.configure(PreviewConfig(mode: .render, targetWidth: 1280, targetHeight: 720, maxFps: 30))
    XCTAssertEqual(pipeline.box, PreviewSize(width: 640, height: 360))
    XCTAssertEqual(pipeline.fps, 15)
  }

  func testTurningDiagnosticsOffFlagsADiagnosticsOnlyRun() throws {
    _ = try pipeline.configure(PreviewConfig(source: .synthetic, mode: .packOnly))
    XCTAssertTrue(pipeline.setDiagnosticsEnabled(false))
    XCTAssertEqual(pipeline.config.mode, .off)
  }

  func testStatusCarriesEveryContractCounterAndTheAcsSendRate() throws {
    try startRendering()
    var tap = PreviewTapSnapshot()
    tap.framesOffered = 30
    tap.acsFramesSent = 15
    let status = pipeline.status(tap: tap, tapSeconds: 1)
    for key in PreviewPipeline.contractCounters + ["acsSendFps", "tapFramesOffered"] {
      XCTAssertNotNil(status[key], key)
    }
    XCTAssertEqual(status["acsSendFps"] as? Double, 15)
    XCTAssertEqual(status["tapFramesOffered"] as? Int, 30)
  }

  func testNoLineLogsAToken() throws {
    try startRendering()
    offer(TestFrame(width: 320, height: 180))
    pipeline.transportFailed(reason: "auth_failed", detail: "token_mismatch")
    XCTAssertFalse(logs.isEmpty)
    XCTAssertTrue(logs.allSatisfy { $0.hasPrefix("[PREVIEW_TRACE]") })
  }
}
