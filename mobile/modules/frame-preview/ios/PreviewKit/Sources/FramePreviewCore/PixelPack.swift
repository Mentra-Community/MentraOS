import Foundation

/// Stride-aware copies from decoder planes into a tightly packed payload.
///
/// Decoders hand back rows padded to an alignment the GPU liked; the wire format is tight. Every
/// bug in this area looks the same from the outside (a skewed, diagonally sheared picture), so
/// the row loops live here once and are covered by tests that deliberately use padded strides.
public enum PixelPack {
  /// Three planes in, `Y | U | V` out. Returns the number of bytes written.
  @discardableResult
  public static func packI420(
    y: UnsafeRawPointer, strideY: Int,
    u: UnsafeRawPointer, strideU: Int,
    v: UnsafeRawPointer, strideV: Int,
    width: Int, height: Int,
    into destination: UnsafeMutableRawBufferPointer, at offset: Int
  ) -> Int {
    let chromaWidth = (width + 1) / 2
    let chromaHeight = (height + 1) / 2
    var written = offset
    written += copyPlane(y, stride: strideY, width: width, height: height, into: destination, at: written)
    written += copyPlane(u, stride: strideU, width: chromaWidth, height: chromaHeight, into: destination, at: written)
    written += copyPlane(v, stride: strideV, width: chromaWidth, height: chromaHeight, into: destination, at: written)
    return written - offset
  }

  /// Bi-planar in, `Y | UVUV…` out. The interleaved plane keeps its layout; only the padding goes.
  @discardableResult
  public static func packNV12(
    y: UnsafeRawPointer, strideY: Int,
    uv: UnsafeRawPointer, strideUV: Int,
    width: Int, height: Int,
    into destination: UnsafeMutableRawBufferPointer, at offset: Int
  ) -> Int {
    let chromaHeight = (height + 1) / 2
    // Two bytes per chroma sample pair, so the tight interleaved row is twice the chroma width.
    let interleavedWidth = ((width + 1) / 2) * 2
    var written = offset
    written += copyPlane(y, stride: strideY, width: width, height: height, into: destination, at: written)
    written += copyPlane(uv, stride: strideUV, width: interleavedWidth, height: chromaHeight, into: destination, at: written)
    return written - offset
  }

  private static func copyPlane(
    _ source: UnsafeRawPointer, stride: Int, width: Int, height: Int,
    into destination: UnsafeMutableRawBufferPointer, at offset: Int
  ) -> Int {
    guard width > 0, height > 0, stride >= width else { return 0 }
    let base = destination.baseAddress!.advanced(by: offset)
    if stride == width {
      base.copyMemory(from: source, byteCount: width * height)
      return width * height
    }
    for row in 0 ..< height {
      base.advanced(by: row * width)
        .copyMemory(from: source.advanced(by: row * stride), byteCount: width)
    }
    return width * height
  }
}
