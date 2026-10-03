import XCTest

@testable import FramePreviewCore

final class PreviewPercentileRingTests: XCTestCase {
  func testPercentilesAndMaxOverASmallSample() {
    let ring = PreviewPercentileRing(capacity: 8)
    for value in [1, 2, 3, 4, 5, 6, 7, 8] { ring.record(Int64(value) * 1_000_000) }
    XCTAssertEqual(ring.sampleCount, 8)
    XCTAssertEqual(ring.percentileMs(0.5), 5, accuracy: 0.001)
    XCTAssertEqual(ring.percentileMs(0.95), 8, accuracy: 0.001)
    XCTAssertEqual(ring.percentileMs(0.99), 8, accuracy: 0.001)
    XCTAssertEqual(ring.maxMs, 8, accuracy: 0.001)
  }

  /// The reason the ring exists: a soak must not grow memory. The reason `maxMs` is not windowed
  /// is here too — the worst frame of the run is the one that was visible, and a lapped ring
  /// would have forgotten it.
  func testTheRingLapsButTheMaximumSurvives() {
    let ring = PreviewPercentileRing(capacity: 4)
    ring.record(500_000_000)
    for _ in 0 ..< 8 { ring.record(1_000_000) }
    XCTAssertEqual(ring.sampleCount, 4)
    XCTAssertEqual(ring.percentileMs(0.95), 1, accuracy: 0.001)
    XCTAssertEqual(ring.maxMs, 500, accuracy: 0.001)
    ring.reset()
    XCTAssertEqual(ring.maxMs, 0)
    XCTAssertEqual(ring.percentileMs(0.5), 0)
  }

  func testAnEmptyRingReportsZeroRatherThanCrashing() {
    let ring = PreviewPercentileRing(capacity: 4)
    XCTAssertEqual(ring.percentileMs(0.5), 0)
    XCTAssertEqual(ring.maxMs, 0)
  }
}

final class PreviewStatsTests: XCTestCase {
  func testDeliveryGapsMeasureCadenceRatherThanRate() {
    let stats = PreviewStats()
    stats.onRunStart(nowNs: 0)
    // 30 ms, 100 ms, 30 ms: a mean fps that looks healthy over a lumpy cadence.
    stats.onDelivered(bytes: 10, nowNs: 0)
    stats.onDelivered(bytes: 10, nowNs: 30_000_000)
    stats.onDelivered(bytes: 10, nowNs: 130_000_000)
    stats.onDelivered(bytes: 10, nowNs: 160_000_000)
    XCTAssertEqual(stats.delivered, 4)
    // Three deliveries after the first, so three gaps: the first frame has nothing to compare to.
    XCTAssertEqual(stats.deliveryGap.sampleCount, 3)
    XCTAssertEqual(stats.deliveryGap.percentileMs(0.5), 30, accuracy: 0.001)
    XCTAssertEqual(stats.deliveryGap.maxMs, 100, accuracy: 0.001)
  }

  func testFirstFrameLatenciesAreMeasuredFromTheStartOfTheRun() {
    let stats = PreviewStats()
    stats.onRunStart(nowNs: 1_000_000_000)
    stats.onDelivered(bytes: 10, nowNs: 1_250_000_000)
    stats.onAckAccepted(roundTripNs: 5_000_000, nowNs: 1_300_000_000)
    XCTAssertEqual(stats.firstDeliveredLatencyMs, 250, accuracy: 0.001)
    XCTAssertEqual(stats.firstAckLatencyMs, 300, accuracy: 0.001)

    // Only the first of each counts; later frames must not overwrite the cold-start number.
    stats.onDelivered(bytes: 10, nowNs: 9_000_000_000)
    stats.onAckAccepted(roundTripNs: 5_000_000, nowNs: 9_000_000_000)
    XCTAssertEqual(stats.firstDeliveredLatencyMs, 250, accuracy: 0.001)
    XCTAssertEqual(stats.firstAckLatencyMs, 300, accuracy: 0.001)
  }

  func testSkipReasonsAreCountedApartFromEachOther() {
    let stats = PreviewStats()
    stats.onSkippedPacing()
    stats.onSkippedBusy()
    stats.onPreDispatchDrop()
    stats.onSlotStarved()
    XCTAssertEqual(stats.skippedPacing, 1)
    XCTAssertEqual(stats.skippedBusy, 1)
    XCTAssertEqual(stats.preDispatchDrops, 1)
    XCTAssertEqual(stats.slotStarved, 1)
  }

  /// A stop/start must not average the new run's first second over however long the preview sat
  /// idle, which is what a window that only restarts on `takeWindow` would do.
  func testANewRunRestartsTheRateWindow() {
    let stats = PreviewStats()
    stats.onRunStart(nowNs: 0)
    _ = stats.takeWindow(nowNs: 1_000_000_000)

    // Ten seconds of nothing, then a fresh run that delivers one frame in its first second.
    stats.onRunStart(nowNs: 11_000_000_000)
    stats.onDelivered(bytes: 10, nowNs: 11_500_000_000)
    let window = stats.takeWindow(nowNs: 12_000_000_000)
    XCTAssertEqual(window.deliveredFps, 1, accuracy: 0.001)
  }

  func testResetClearsCountersRingsAndTheFirstFrameLatencies() {
    let stats = PreviewStats()
    stats.onRunStart(nowNs: 0)
    stats.onSourceFrame()
    stats.onDelivered(bytes: 100, nowNs: 10_000_000)
    stats.onDelivered(bytes: 100, nowNs: 40_000_000)
    stats.pack.record(5_000_000)

    stats.reset(nowNs: 0)
    XCTAssertEqual(stats.sourceFrames, 0)
    XCTAssertEqual(stats.delivered, 0)
    XCTAssertEqual(stats.payloadBytes, 0)
    XCTAssertEqual(stats.firstDeliveredLatencyMs, 0)
    XCTAssertEqual(stats.pack.maxMs, 0)
    XCTAssertEqual(stats.deliveryGap.sampleCount, 0)
  }

  func testTheRateWindowIsZeroUntilTimeHasPassedAndThenReportsPerSecond() {
    let stats = PreviewStats()
    stats.onRunStart(nowNs: 0)
    // No elapsed time to divide by, so the honest answer is zero rather than a division by zero.
    XCTAssertEqual(stats.takeWindow(nowNs: 0).deliveredFps, 0)

    stats.onSourceFrame()
    stats.onSourceFrame()
    stats.onDelivered(bytes: 1000, nowNs: 500_000_000)
    let window = stats.takeWindow(nowNs: 1_000_000_000)
    XCTAssertEqual(window.sourceFps, 2, accuracy: 0.001)
    XCTAssertEqual(window.deliveredFps, 1, accuracy: 0.001)
    XCTAssertEqual(window.bytesPerSecond, 1000, accuracy: 0.001)
  }
}

/// The pattern was rewritten from a per-pixel loop to two row builds plus a copy per row,
/// because at 175 ms a frame it was the only thing the experiment could measure. These pin the
/// output to the per-pixel definition so the speedup cannot have changed a single pixel.
final class PreviewTestPatternTests: XCTestCase {
  private static let bars: [(y: UInt8, u: UInt8, v: UInt8)] = [
    (235, 128, 128), (210, 16, 146), (170, 166, 16), (145, 54, 34),
    (106, 202, 222), (81, 90, 240), (41, 240, 110), (16, 128, 128),
  ]

  /// The original definition, kept here as the specification the fast path must satisfy.
  private static func reference(
    width: Int, height: Int, frameIndex: Int, format: PreviewPixelFormat
  ) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: format.packedSize(width: width, height: height))
    let chromaWidth = (width + 1) / 2
    let chromaHeight = (height + 1) / 2
    let barWidth = max(width / bars.count, 1)
    let sweepX = (frameIndex * max(width / 60, 1)) % width
    let sweepWidth = max(width / 40, 2)
    let markerBits = 16, markerCell = 24, markerHeight = 32

    for row in 0 ..< height {
      for column in 0 ..< width {
        let bar = bars[min(column / barWidth, bars.count - 1)]
        var value = bar.y
        if column >= sweepX, column < sweepX + sweepWidth { value = 235 }
        if row < markerHeight, column < markerBits * markerCell {
          value = (frameIndex >> (column / markerCell)) & 1 == 1 ? 235 : 16
        }
        out[row * width + column] = value
      }
    }

    let chromaOffset = width * height
    for row in 0 ..< chromaHeight {
      for column in 0 ..< chromaWidth {
        let bar = bars[min((column * 2) / barWidth, bars.count - 1)]
        switch format {
        case .i420:
          out[chromaOffset + row * chromaWidth + column] = bar.u
          out[chromaOffset + chromaWidth * chromaHeight + row * chromaWidth + column] = bar.v
        case .nv12:
          out[chromaOffset + row * chromaWidth * 2 + column * 2] = bar.u
          out[chromaOffset + row * chromaWidth * 2 + column * 2 + 1] = bar.v
        }
      }
    }
    return out
  }

  /// Renders one frame. Grain defaults off so the structural comparison stays exact; the tests
  /// below that care about grain ask for it explicitly.
  private static func render(
    width: Int, height: Int, frameIndex: Int, format: PreviewPixelFormat, noise: Int = 0
  ) -> [UInt8] {
    let pattern = PreviewTestPattern(width: width, height: height, format: format, noiseAmplitude: noise)
    var out = [UInt8](repeating: 0, count: format.packedSize(width: width, height: height))
    out.withUnsafeMutableBytes { pattern.write(into: $0, frameIndex: frameIndex) }
    return out
  }

  private func assertMatchesReference(
    width: Int, height: Int, frameIndex: Int, format: PreviewPixelFormat,
    line: UInt = #line
  ) {
    let actual = Self.render(width: width, height: height, frameIndex: frameIndex, format: format)
    let expected = Self.reference(width: width, height: height, frameIndex: frameIndex, format: format)
    XCTAssertEqual(actual, expected, "pattern drifted from the per-pixel definition", line: line)
  }

  func testRowWisePatternMatchesThePerPixelDefinition() {
    for index in [0, 1, 7, 42, 65_535] {
      assertMatchesReference(width: 1280, height: 720, frameIndex: index, format: .nv12)
      assertMatchesReference(width: 1280, height: 720, frameIndex: index, format: .i420)
    }
  }

  /// Odd sizes round the chroma plane up, and a frame shorter than the counter band has no rows
  /// outside it — both are edges the row-wise version could plausibly have broken.
  func testOddAndSmallSizesMatchToo() {
    assertMatchesReference(width: 321, height: 181, frameIndex: 9, format: .i420)
    assertMatchesReference(width: 321, height: 181, frameIndex: 9, format: .nv12)
    assertMatchesReference(width: 640, height: 16, frameIndex: 3, format: .nv12)
    assertMatchesReference(width: 2, height: 2, frameIndex: 1, format: .i420)
  }

  func testTheCounterStillRoundTripsAtTheSyntheticSourceSize() {
    for index in [0, 1, 42, 65_535] {
      let frame = Self.render(width: 1280, height: 720, frameIndex: index, format: .nv12)
      let read = frame.withUnsafeBytes { PreviewTestPattern.readFrameMarker($0, width: 1280) }
      XCTAssertEqual(read, index)
    }
  }

  // MARK: - Grain

  /// Grain exists as a control against silent compression somewhere in the path, so the thing
  /// that actually matters about it is that the bytes are genuinely varied rather than a
  /// compressible expanse of flat colour.
  func testGrainVariesWithinAFlatColourBar() {
    let noisy = Self.render(width: 1280, height: 720, frameIndex: 5, format: .nv12, noise: 10)
    let flat = Self.render(width: 1280, height: 720, frameIndex: 5, format: .nv12, noise: 0)

    // Sample a row below the counter band and away from the moving sweep, inside one bar.
    let row = 400
    let columns = 700 ..< 760
    let flatValues = Set(columns.map { flat[row * 1280 + $0] })
    let noisyValues = Set(columns.map { noisy[row * 1280 + $0] })
    XCTAssertEqual(flatValues.count, 1, "without grain a bar should be one flat value")
    XCTAssertGreaterThan(noisyValues.count, 5, "grain should spread a bar over many values")
  }

  func testGrainStaysCloseEnoughToKeepTheBarsRecognisable() {
    let noisy = Self.render(width: 1280, height: 720, frameIndex: 5, format: .nv12, noise: 10)
    let flat = Self.render(width: 1280, height: 720, frameIndex: 5, format: .nv12, noise: 0)
    let row = 400
    for column in 700 ..< 760 {
      let delta = abs(Int(noisy[row * 1280 + column]) - Int(flat[row * 1280 + column]))
      XCTAssertLessThanOrEqual(delta, 10, "grain exceeded its amplitude at column \(column)")
    }
  }

  /// A still grain field would be a fixed pattern the first frame pays for and every later one
  /// reuses. The field has to move, or consecutive frames differ only where the sweep is.
  func testGrainMovesBetweenFrames() {
    let first = Self.render(width: 1280, height: 720, frameIndex: 100, format: .nv12, noise: 10)
    let second = Self.render(width: 1280, height: 720, frameIndex: 101, format: .nv12, noise: 10)
    let row = 400
    let changed = (0 ..< 1280).filter { first[row * 1280 + $0] != second[row * 1280 + $0] }
    XCTAssertGreaterThan(changed.count, 600, "grain should differ across most of a row")
  }

  func testTheCounterStillReadsThroughGrain() {
    for index in [0, 1, 42, 65_535] {
      let frame = Self.render(width: 1280, height: 720, frameIndex: index, format: .nv12, noise: 10)
      let read = frame.withUnsafeBytes { PreviewTestPattern.readFrameMarker($0, width: 1280) }
      XCTAssertEqual(read, index, "grain must not corrupt the frame counter")
    }
  }

  func testGrainDoesNotChangeTheFrameSize() {
    // The point of the control: identical bytes on the wire, very different entropy.
    let noisy = Self.render(width: 1280, height: 720, frameIndex: 7, format: .nv12, noise: 10)
    let flat = Self.render(width: 1280, height: 720, frameIndex: 7, format: .nv12, noise: 0)
    XCTAssertEqual(noisy.count, flat.count)
    XCTAssertEqual(noisy.count, PreviewPixelFormat.nv12.packedSize(width: 1280, height: 720))
  }
}

final class PreviewRunLogTests: XCTestCase {
  /// A rate over a zero-length window is `inf`, and `JSONSerialization` refuses the whole object
  /// for one bad key. Losing twenty good counters to one bad one is the failure worth preventing.
  func testNonFiniteNumbersDoNotCostTheRestOfTheLine() throws {
    let encoded = try XCTUnwrap(PreviewRunLog.encode([
      "deliveredFps": Double.infinity,
      "packMsP95": Double.nan,
      "delivered": 42,
      "mode": "render",
    ]))
    let text = try XCTUnwrap(String(data: encoded, encoding: .utf8))
    XCTAssertTrue(text.hasSuffix("\n"), "NDJSON needs one record per line")

    let parsed = try XCTUnwrap(
      JSONSerialization.jsonObject(with: encoded) as? [String: Any]
    )
    XCTAssertEqual(parsed["delivered"] as? Int, 42)
    XCTAssertEqual(parsed["mode"] as? String, "render")
    XCTAssertEqual(parsed["deliveredFps"] as? Double, 0)
    XCTAssertEqual(parsed["packMsP95"] as? Double, 0)
  }

  func testEachRecordIsExactlyOneLine() throws {
    let encoded = try XCTUnwrap(PreviewRunLog.encode(["a": 1, "b": "two"]))
    let text = try XCTUnwrap(String(data: encoded, encoding: .utf8))
    XCTAssertEqual(text.filter { $0 == "\n" }.count, 1)
  }
}
