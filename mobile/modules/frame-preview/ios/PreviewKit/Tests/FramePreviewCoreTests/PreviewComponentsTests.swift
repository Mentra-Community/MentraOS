@testable import FramePreviewCore
import XCTest

final class PreviewGeometryTests: XCTestCase {
  private func validate(_ frame: PreviewSourceFrame, output: PreviewSize? = nil) -> PackFailureReason? {
    let size = output ?? PreviewSize(width: frame.width, height: frame.height)
    return PreviewGeometry.validate(frame, output: size, payloadLength: frame.format.packedSize(width: size.width, height: size.height))
  }

  func testWellFormedPaddedFramesPass() {
    for format in [PreviewPixelFormat.nv12, .i420] {
      XCTAssertNil(validate(TestFrame(format: format, width: 64, height: 36).frame()))
      XCTAssertNil(validate(TestFrame(format: format, width: 17, height: 9).frame()), "odd sizes")
      XCTAssertNil(validate(TestFrame(format: format, width: 1, height: 1).frame()))
    }
  }

  func testTheLastRowOnlyNeedsItsWidth() {
    let source = TestFrame(width: 64, height: 36, padding: 16)
    XCTAssertNil(validate(source.frame(lumaAvailable: 80 * 35 + 64)))
    XCTAssertEqual(validate(source.frame(lumaAvailable: 80 * 35 + 63)), .planeOutOfBounds)
  }

  func testZeroSizesAreRejected() {
    let frame = TestFrame(width: 64, height: 36).frame()
    XCTAssertEqual(PreviewGeometry.validate(frame, output: PreviewSize(width: 0, height: 36), payloadLength: 0), .zeroSize)
  }

  func testNarrowStridesAreRejected() {
    XCTAssertEqual(validate(TestFrame(width: 64, height: 36).frame(lumaStride: 63)), .strideTooSmall)
  }

  func testShortPlanesAreRejectedBeforeAnyCopy() {
    XCTAssertEqual(validate(TestFrame(width: 64, height: 36).frame(lumaAvailable: 100)), .planeOutOfBounds)
  }

  func testOversizeOutputsAreRejected() {
    let frame = TestFrame(width: 64, height: 36).frame()
    XCTAssertEqual(
      PreviewGeometry.validate(frame, output: PreviewSize(width: 5000, height: 2), payloadLength: PreviewPixelFormat.nv12.packedSize(width: 5000, height: 2)),
      .payloadMismatch
    )
  }

  func testMismatchedPayloadIsRejected() {
    let frame = TestFrame(width: 64, height: 36).frame()
    XCTAssertEqual(PreviewGeometry.validate(frame, output: PreviewSize(width: 64, height: 36), payloadLength: 1), .payloadMismatch)
  }

  func testI420WithoutAVPlaneIsRejected() {
    let source = TestFrame(format: .i420, width: 8, height: 8)
    let frame = PreviewSourceFrame(
      format: .i420, width: 8, height: 8, luma: source.plane(0), chroma: source.plane(1), chromaV: nil,
      colorMatrix: .bt601, colorRange: .limited, flags: [], timestampNs: 0
    )
    XCTAssertEqual(validate(frame), .planeOutOfBounds)
  }
}

final class PreviewScalePlanTests: XCTestCase {
  private func fit(_ w: Int, _ h: Int, _ bw: Int, _ bh: Int) -> PreviewSize {
    PreviewScalePlan.fit(source: PreviewSize(width: w, height: h), box: PreviewSize(width: bw, height: bh))
  }

  func testEachTierIsProducedExactlyFromASixteenByNineSource() {
    XCTAssertEqual(fit(1280, 720, 640, 360), PreviewSize(width: 640, height: 360))
    XCTAssertEqual(fit(1280, 720, 320, 180), PreviewSize(width: 320, height: 180))
    XCTAssertEqual(fit(1920, 1080, 640, 360), PreviewSize(width: 640, height: 360))
  }

  func testTheSourceAspectIsKept() {
    XCTAssertEqual(fit(800, 600, 640, 360), PreviewSize(width: 480, height: 360))
    XCTAssertEqual(fit(720, 1280, 640, 360), PreviewSize(width: 202, height: 360))
  }

  func testNeverUpscales() {
    XCTAssertEqual(fit(480, 270, 640, 360), PreviewSize(width: 480, height: 270))
    XCTAssertEqual(fit(17, 9, 640, 360), PreviewSize(width: 17, height: 9))
  }

  func testBoxesAreClampedToThePixelCeiling() {
    let clamped = PreviewScalePlan.clampBox(PreviewSize(width: 1280, height: 720), maxPixels: 640 * 360)
    XCTAssertEqual(clamped, PreviewSize(width: 640, height: 360))
  }
}

final class PreviewSlotPoolTests: XCTestCase {
  func testNeverHandsOutAHeldSlot() throws {
    let pool = PreviewSlotPool(slotCount: 2)
    let first = try XCTUnwrap(pool.acquire(byteCount: 100, sequence: 1))
    let second = try XCTUnwrap(pool.acquire(byteCount: 100, sequence: 2))
    XCTAssertFalse(first === second)
    XCTAssertNil(pool.acquire(byteCount: 100, sequence: 3))
    pool.release(first)
    XCTAssertTrue(pool.acquire(byteCount: 100, sequence: 4) === first)
  }

  func testReallocatesOnlyWhenTheProducedSizeChanges() throws {
    let pool = PreviewSlotPool()
    for sequence in 0 ..< 10 { pool.release(try XCTUnwrap(pool.acquire(byteCount: 100, sequence: UInt32(sequence)))) }
    XCTAssertEqual(pool.reallocations, 1)
    pool.release(try XCTUnwrap(pool.acquire(byteCount: 200, sequence: 11)))
    XCTAssertEqual(pool.reallocations, 2)
    pool.prepare(byteCount: 200)
    XCTAssertEqual(pool.reallocations, 2)
  }

  func testAReshapeRetiresHeldSlotsAndKeepsTheirMemoryAlive() throws {
    let pool = PreviewSlotPool(slotCount: 1)
    let held = try XCTUnwrap(pool.acquire(byteCount: 100, sequence: 1))
    held.buffer[0] = 7
    let next = try XCTUnwrap(pool.acquire(byteCount: 200, sequence: 2))
    XCTAssertFalse(next === held)
    XCTAssertEqual(held.buffer[0], 7)
    pool.release(held)
    XCTAssertEqual(pool.heldCount, 1)
    XCTAssertNil(pool.acquire(byteCount: 200, sequence: 3))
  }
}

final class PreviewScalerTests: XCTestCase {
  func testBoxScalerAveragesTwoByTwo() throws {
    let values: [UInt8] = [0, 20, 40, 60, 100, 120, 140, 160]
    var out = [UInt8](repeating: 0, count: 2)
    try values.withUnsafeBytes { source in
      try out.withUnsafeMutableBytes { destination in
        guard let src = source.baseAddress, let dst = destination.baseAddress else { return XCTFail("empty") }
        try BoxPlaneScaler().scalePlanar8(source: src, sourceStride: 4, sourceWidth: 4, sourceHeight: 2, destination: dst, width: 2, height: 1)
      }
    }
    XCTAssertEqual(out, [60, 100])
  }

  func testBoxScalerKeepsInterleavedChannelsApart() throws {
    let values: [UInt8] = [10, 200, 30, 220, 10, 200, 30, 220]
    var out = [UInt8](repeating: 0, count: 2)
    try values.withUnsafeBytes { source in
      try out.withUnsafeMutableBytes { destination in
        guard let src = source.baseAddress, let dst = destination.baseAddress else { return XCTFail("empty") }
        try BoxPlaneScaler().scaleInterleaved16(source: src, sourceStride: 4, sourceWidth: 2, sourceHeight: 2, destination: dst, width: 1, height: 1)
      }
    }
    XCTAssertEqual(out, [20, 210])
  }

  func testTheDefaultScalerKeepsFlatPlanesFlat() throws {
    let scaler = PreviewScalers.makeDefault()
    let source = TestFrame(format: .nv12, width: 128, height: 72, fill: (0x50, 0x60, 0x70))
    var y = [UInt8](repeating: 0, count: 64 * 36)
    var uv = [UInt8](repeating: 0, count: 32 * 18 * 2)
    try y.withUnsafeMutableBytes { dst in
      guard let base = dst.baseAddress else { return XCTFail("empty") }
      try scaler.scalePlanar8(source: source.plane(0).base, sourceStride: source.strides[0], sourceWidth: 128, sourceHeight: 72, destination: base, width: 64, height: 36)
    }
    try uv.withUnsafeMutableBytes { dst in
      guard let base = dst.baseAddress else { return XCTFail("empty") }
      try scaler.scaleInterleaved16(source: source.plane(1).base, sourceStride: source.strides[1], sourceWidth: 64, sourceHeight: 36, destination: base, width: 32, height: 18)
    }
    // vImage's Lanczos kernel may round a flat plane by one level; the box fallback is exact.
    func near(_ values: [UInt8], _ expected: UInt8) -> Bool { values.allSatisfy { abs(Int($0) - Int(expected)) <= 1 } }
    XCTAssertTrue(near(y, 0x50))
    XCTAssertTrue(near(stride(from: 0, to: uv.count, by: 2).map { uv[$0] }, 0x60))
    XCTAssertTrue(near(stride(from: 1, to: uv.count, by: 2).map { uv[$0] }, 0x70))
  }
}

final class PreviewDiagnosticsTests: XCTestCase {
  func testReleaseAllowsOnlyTheCallSourceRendering() {
    XCTAssertNil(PreviewDiagnosticsPolicy.check(PreviewConfig(mode: .render), diagnosticsEnabled: false))
    XCTAssertNil(PreviewDiagnosticsPolicy.check(PreviewConfig(mode: .off), diagnosticsEnabled: false))
  }

  func testReleaseRejectsSyntheticSourcesDiagnosticModesAndKnobs() {
    let rejected = [
      PreviewConfig(source: .synthetic, mode: .render),
      PreviewConfig(mode: .generateOnly),
      PreviewConfig(mode: .packOnly),
      PreviewConfig(mode: .receiveDiscard),
      PreviewConfig(mode: .render, noiseAmplitude: 10),
      PreviewConfig(mode: .render, consumerDelayMs: 50),
    ]
    for config in rejected {
      XCTAssertEqual(PreviewDiagnosticsPolicy.check(config, diagnosticsEnabled: false), "diagnostics_disabled", "\(config)")
      XCTAssertNil(PreviewDiagnosticsPolicy.check(config, diagnosticsEnabled: true), "\(config)")
    }
  }

  func testConfigureOptionsParsePerTheContract() throws {
    let config = try PreviewConfig.parse([
      "source": "synthetic", "mode": "pack_only", "targetWidth": 320, "targetHeight": 180.0, "maxFps": 15,
      "diagnostics": ["noiseAmplitude": 12, "consumerDelayMs": 40],
    ])
    XCTAssertEqual(config, PreviewConfig(source: .synthetic, mode: .packOnly, targetWidth: 320, targetHeight: 180, maxFps: 15, noiseAmplitude: 12, consumerDelayMs: 40))
    XCTAssertThrowsError(try PreviewConfig.parse(["mode": "turbo"]))
    XCTAssertThrowsError(try PreviewConfig.parse(["source": "glasses"]))
  }

  func testOneShotFaultsDisarmWhenTaken() {
    let faults = PreviewFaults()
    faults.arm(.packThrow)
    XCTAssertTrue(faults.takePackThrow())
    XCTAssertFalse(faults.takePackThrow())
    faults.arm(.ackDelay, ms: 250)
    faults.arm(.ackDrop)
    XCTAssertTrue(faults.anyArmed)
    faults.arm(.clear)
    XCTAssertFalse(faults.anyArmed)
  }
}

final class PreviewTraceTests: XCTestCase {
  func testLinesCarryTheMarkerIdsPhaseAndTime() {
    var lines: [String] = []
    let trace = PreviewTrace(sink: { _, line in lines.append(line) }, clockMs: { 42 })
    trace.traceId = "abc123"
    trace.docGen = 3
    trace.tapGeneration = 9
    trace.info("source_attach", ["reason": "host stop"])
    XCTAssertEqual(lines, ["[PREVIEW_TRACE] previewTraceId=abc123 phase=source_attach t=42 docGen=3 gen=9 reason=\"host stop\""])
  }

  func testTokensAndMeetingUrlsAreRedacted() {
    let line = PreviewTrace.format(traceId: "", phase: "transport_bind", tMs: 1, fields: [
      ("token", "secret-token"),
      ("meetingUrl", "https://teams.example/join/1"),
      ("url", "ws://127.0.0.1:5000/preview?token=abc"),
    ])
    XCTAssertFalse(line.contains("secret-token"))
    XCTAssertFalse(line.contains("teams.example"))
    XCTAssertFalse(line.contains("abc"))
    XCTAssertTrue(line.contains("token=<redacted>"))
    XCTAssertTrue(line.contains("url=ws://127.0.0.1:5000/preview?<redacted>"))
  }

  func testRepeatedWarningsLogOnceThenACountPerWindow() {
    var now: Int64 = 0
    var lines: [String] = []
    let trace = PreviewTrace(sink: { _, line in lines.append(line) }, clockMs: { now })
    for _ in 0 ..< 5 { trace.warnLimited("stale", "stale_ack") }
    XCTAssertEqual(lines.count, 1)
    now = 10000
    trace.warnLimited("stale", "stale_ack")
    XCTAssertEqual(lines.count, 2)
    XCTAssertTrue(lines.last?.contains("suppressed=4") ?? false)
    trace.warnLimited("stale", "stale_ack")
    now = 20001
    trace.flushLimited()
    XCTAssertTrue(lines.last?.contains("phase=repeated_warning") ?? false)
    XCTAssertTrue(lines.last?.contains("suppressed=1") ?? false)
  }
}
