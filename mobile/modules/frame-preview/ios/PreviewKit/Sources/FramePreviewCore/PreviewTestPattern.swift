import Foundation

/// Synthetic 720p content for the experiment.
///
/// A flat colour would hide every interesting failure: stride skew, a stale frame being redrawn,
/// planes swapped, chroma dropped. So the pattern carries four independent signals — colour bars
/// (chroma correctness and plane order), a bar that moves every frame (liveness), the frame
/// counter drawn as bits (which exact frame is on screen, readable by eye and assertable in a
/// test), and grain.
///
/// ## Why grain
///
/// Raw YUV is the same number of bytes whatever it contains, so noise cannot change the
/// bandwidth. It is here as a **control**. A frame of flat colour bars is enormously
/// compressible, so if anything in the path were quietly compressing — a WebSocket negotiating
/// `permessage-deflate`, say — the measurements would flatter us and nothing in the counters
/// would say so. Noise does not compress. If the send timings hold with grain on, nothing in
/// the path is compressing, and the throughput figure is real.
///
/// ## Why it is built from a cache
///
/// Generating a megapixel of fresh noise per frame would put the generator back on the critical
/// path, which is the exact problem this file already had once. Instead a small field of
/// pre-composited rows is built once, and each frame copies rows out of it at a rolling offset:
/// every pixel differs from its neighbours, the field drifts by a row per frame, and the
/// per-frame cost stays a memcpy.
public final class PreviewTestPattern {
  /// BT.601 limited-range colour bars: white, yellow, cyan, green, magenta, red, blue, black.
  private static let bars: [(y: UInt8, u: UInt8, v: UInt8)] = [
    (235, 128, 128), (210, 16, 146), (170, 166, 16), (145, 54, 34),
    (106, 202, 222), (81, 90, 240), (41, 240, 110), (16, 128, 128),
  ]

  private static let markerBits = 16
  private static let markerCell = 24
  private static let markerHeight = 32

  /// Enough rows that the grain does not visibly repeat down a 720-row frame, small enough that
  /// the field stays cheap to build and friendly to cache.
  private static let variantCount = 64

  /// ±40 around the bar value.
  ///
  /// Deliberately heavier than real sensor grain. A preview is drawn into a canvas a few hundred
  /// pixels wide, so four or more source pixels average into every screen pixel and halve the
  /// grain you can actually see — a realistic ±10 renders as an almost imperceptible shimmer.
  /// This is a diagnostic picture, and the grain has a job: it must be visibly present, and it
  /// must not compress. The bars stay readable because chroma separates them even when the luma
  /// ranges overlap, and the frame counter is stamped flat on top.
  public static let defaultNoiseAmplitude = 40

  private let width: Int
  private let height: Int
  private let format: PreviewPixelFormat
  private let chromaWidth: Int
  private let chromaHeight: Int
  private let sweepWidth: Int

  /// `variantCount` rows of colour bars plus one grain pattern each, flattened.
  private var lumaField: [UInt8] = []
  private var chromaFieldU: [UInt8] = []
  private var chromaFieldV: [UInt8] = []
  private var chromaFieldUV: [UInt8] = []

  public init(
    width: Int,
    height: Int,
    format: PreviewPixelFormat,
    noiseAmplitude: Int = PreviewTestPattern.defaultNoiseAmplitude
  ) {
    self.width = max(width, 0)
    self.height = max(height, 0)
    self.format = format
    chromaWidth = (self.width + 1) / 2
    chromaHeight = (self.height + 1) / 2
    sweepWidth = max(self.width / 40, 2)
    guard self.width > 0, self.height > 0 else { return }
    buildFields(noiseAmplitude: max(noiseAmplitude, 0))
  }

  /// Fill `destination` with one tightly packed frame. The buffer must hold
  /// `format.packedSize(width:height:)` bytes.
  public func write(into destination: UnsafeMutableRawBufferPointer, frameIndex: Int) {
    precondition(
      destination.count >= format.packedSize(width: width, height: height),
      "pattern buffer too small"
    )
    guard width > 0, height > 0 else { return }
    let luma = destination.baseAddress!.assumingMemoryBound(to: UInt8.self)

    lumaField.withUnsafeBufferPointer { field in
      let base = field.baseAddress!
      for row in 0 ..< height {
        let variant = (row &+ frameIndex) % Self.variantCount
        luma.advanced(by: row * width).update(from: base.advanced(by: variant * width), count: width)
      }
    }

    // The sweep and the counter move every frame, so they are stamped over the grain rather
    // than baked into it. Both are written flat: they are read by eye and by test, and grain
    // on top of them would only make that harder.
    let sweepX = (frameIndex * max(width / 60, 1)) % width
    let sweepEnd = min(sweepX + sweepWidth, width)
    if sweepEnd > sweepX {
      for row in 0 ..< height {
        luma.advanced(by: row * width + sweepX).update(repeating: 235, count: sweepEnd - sweepX)
      }
    }

    let markerRows = min(Self.markerHeight, height)
    let markerColumns = min(Self.markerBits * Self.markerCell, width)
    for bit in 0 ..< Self.markerBits {
      let start = bit * Self.markerCell
      if start >= markerColumns { break }
      let count = min(Self.markerCell, markerColumns - start)
      let value: UInt8 = (frameIndex >> bit) & 1 == 1 ? 235 : 16
      for row in 0 ..< markerRows {
        luma.advanced(by: row * width + start).update(repeating: value, count: count)
      }
    }

    let chromaOffset = width * height
    switch format {
    case .i420:
      let u = destination.baseAddress!.advanced(by: chromaOffset).assumingMemoryBound(to: UInt8.self)
      let v = u.advanced(by: chromaWidth * chromaHeight)
      copyChroma(into: u, from: chromaFieldU, rowBytes: chromaWidth, frameIndex: frameIndex)
      copyChroma(into: v, from: chromaFieldV, rowBytes: chromaWidth, frameIndex: frameIndex)
    case .nv12:
      let uv = destination.baseAddress!.advanced(by: chromaOffset).assumingMemoryBound(to: UInt8.self)
      copyChroma(into: uv, from: chromaFieldUV, rowBytes: chromaWidth * 2, frameIndex: frameIndex)
    }
  }

  private func copyChroma(
    into plane: UnsafeMutablePointer<UInt8>, from field: [UInt8], rowBytes: Int, frameIndex: Int
  ) {
    field.withUnsafeBufferPointer { source in
      let base = source.baseAddress!
      for row in 0 ..< chromaHeight {
        let variant = (row &+ frameIndex) % Self.variantCount
        plane.advanced(by: row * rowBytes)
          .update(from: base.advanced(by: variant * rowBytes), count: rowBytes)
      }
    }
  }

  private func buildFields(noiseAmplitude: Int) {
    let barWidth = max(width / Self.bars.count, 1)
    var rng = Xorshift(state: 0x9E37_79B9)

    lumaField = [UInt8](repeating: 0, count: Self.variantCount * width)
    for variant in 0 ..< Self.variantCount {
      for column in 0 ..< width {
        let bar = Self.bars[min(column / barWidth, Self.bars.count - 1)]
        lumaField[variant * width + column] = rng.jitter(bar.y, by: noiseAmplitude)
      }
    }

    switch format {
    case .i420:
      chromaFieldU = [UInt8](repeating: 0, count: Self.variantCount * chromaWidth)
      chromaFieldV = [UInt8](repeating: 0, count: Self.variantCount * chromaWidth)
      for variant in 0 ..< Self.variantCount {
        for column in 0 ..< chromaWidth {
          let bar = Self.bars[min((column * 2) / barWidth, Self.bars.count - 1)]
          chromaFieldU[variant * chromaWidth + column] = rng.jitter(bar.u, by: noiseAmplitude)
          chromaFieldV[variant * chromaWidth + column] = rng.jitter(bar.v, by: noiseAmplitude)
        }
      }
    case .nv12:
      chromaFieldUV = [UInt8](repeating: 0, count: Self.variantCount * chromaWidth * 2)
      for variant in 0 ..< Self.variantCount {
        for column in 0 ..< chromaWidth {
          let bar = Self.bars[min((column * 2) / barWidth, Self.bars.count - 1)]
          let base = variant * chromaWidth * 2 + column * 2
          chromaFieldUV[base] = rng.jitter(bar.u, by: noiseAmplitude)
          chromaFieldUV[base + 1] = rng.jitter(bar.v, by: noiseAmplitude)
        }
      }
    }
  }

  /// Read the frame counter back out of a packed frame. Used by tests to prove a buffer was not
  /// overwritten while a worker still held it.
  public static func readFrameMarker(_ source: UnsafeRawBufferPointer, width: Int) -> Int {
    let luma = source.baseAddress!.assumingMemoryBound(to: UInt8.self)
    var value = 0
    for bit in 0 ..< markerBits {
      let column = bit * markerCell + markerCell / 2
      guard column < width else { break }
      // Sample the middle of the cell so a one-pixel rounding difference cannot flip a bit.
      if luma.advanced(by: (markerHeight / 2) * width + column).pointee > 128 { value |= 1 << bit }
    }
    return value
  }
}

/// Deterministic so a run can be reproduced and a test can assert on the result.
private struct Xorshift {
  var state: UInt32

  mutating func next() -> UInt32 {
    state ^= state << 13
    state ^= state >> 17
    state ^= state << 5
    return state
  }

  /// `value` displaced by up to ±`amplitude`, clamped into range. Amplitude 0 returns `value`
  /// untouched and consumes no randomness, which is what keeps the noise-free path exact.
  mutating func jitter(_ value: UInt8, by amplitude: Int) -> UInt8 {
    guard amplitude > 0 else { return value }
    let span = UInt32(amplitude * 2 + 1)
    let offset = Int(next() % span) - amplitude
    return UInt8(clamping: Int(value) + offset)
  }
}
