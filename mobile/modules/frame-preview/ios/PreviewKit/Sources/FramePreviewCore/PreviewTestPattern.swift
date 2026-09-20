import Foundation

/// Synthetic 720p content for the experiment.
///
/// A flat colour would hide every interesting failure: stride skew, a stale frame being redrawn,
/// planes swapped, chroma dropped. So the pattern carries three independent signals — colour bars
/// (chroma correctness and plane order), a bar that moves every frame (liveness), and the frame
/// counter drawn as bits (which exact frame is on screen, readable by eye and assertable in a
/// test).
public enum PreviewTestPattern {
  /// BT.601 limited-range colour bars: white, yellow, cyan, green, magenta, red, blue, black.
  private static let bars: [(y: UInt8, u: UInt8, v: UInt8)] = [
    (235, 128, 128), (210, 16, 146), (170, 166, 16), (145, 54, 34),
    (106, 202, 222), (81, 90, 240), (41, 240, 110), (16, 128, 128),
  ]

  private static let markerBits = 16
  private static let markerCell = 24
  private static let markerHeight = 32

  /// Fill `destination` with one tightly packed frame. The buffer must hold
  /// `format.packedSize(width:height:)` bytes.
  public static func write(
    into destination: UnsafeMutableRawBufferPointer,
    width: Int, height: Int, frameIndex: Int, format: PreviewPixelFormat
  ) {
    precondition(destination.count >= format.packedSize(width: width, height: height), "pattern buffer too small")
    let chromaWidth = (width + 1) / 2
    let chromaHeight = (height + 1) / 2
    let barWidth = max(width / bars.count, 1)
    // One full sweep every four seconds at 15 fps, so motion is obvious without strobing.
    let sweepX = (frameIndex * max(width / 60, 1)) % width
    let sweepWidth = max(width / 40, 2)

    let luma = destination.baseAddress!.assumingMemoryBound(to: UInt8.self)
    for row in 0 ..< height {
      let rowBase = luma.advanced(by: row * width)
      for column in 0 ..< width {
        let bar = bars[min(column / barWidth, bars.count - 1)]
        var value = bar.y
        if column >= sweepX, column < sweepX + sweepWidth { value = 235 }
        if let bit = markerValue(row: row, column: column, frameIndex: frameIndex) { value = bit }
        rowBase[column] = value
      }
    }

    let chromaOffset = width * height
    switch format {
    case .i420:
      let u = destination.baseAddress!.advanced(by: chromaOffset).assumingMemoryBound(to: UInt8.self)
      let v = u.advanced(by: chromaWidth * chromaHeight)
      for row in 0 ..< chromaHeight {
        for column in 0 ..< chromaWidth {
          let bar = bars[min((column * 2) / barWidth, bars.count - 1)]
          u[row * chromaWidth + column] = bar.u
          v[row * chromaWidth + column] = bar.v
        }
      }
    case .nv12:
      let uv = destination.baseAddress!.advanced(by: chromaOffset).assumingMemoryBound(to: UInt8.self)
      for row in 0 ..< chromaHeight {
        for column in 0 ..< chromaWidth {
          let bar = bars[min((column * 2) / barWidth, bars.count - 1)]
          uv[row * chromaWidth * 2 + column * 2] = bar.u
          uv[row * chromaWidth * 2 + column * 2 + 1] = bar.v
        }
      }
    }
  }

  /// Luma value for the frame-counter marker, or nil when this pixel is not part of it.
  private static func markerValue(row: Int, column: Int, frameIndex: Int) -> UInt8? {
    guard row < markerHeight, column < markerBits * markerCell else { return nil }
    let bit = column / markerCell
    return (frameIndex >> bit) & 1 == 1 ? 235 : 16
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
