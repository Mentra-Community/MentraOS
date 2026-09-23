import Foundation
#if canImport(Accelerate)
  import Accelerate
#endif

/// Downscales one plane into tight rows at `destination`. Implementations never read outside
/// `stride * (sourceHeight - 1) + rowBytes` of the source; callers validate that first.
public protocol PreviewPlaneScaler: AnyObject {
  /// One byte per sample (Y, or a separate U/V plane).
  func scalePlanar8(
    source: UnsafeRawPointer, sourceStride: Int, sourceWidth: Int, sourceHeight: Int,
    destination: UnsafeMutableRawPointer, width: Int, height: Int
  ) throws

  /// Interleaved two-byte samples (NV12's UV plane). Widths are in sample pairs.
  func scaleInterleaved16(
    source: UnsafeRawPointer, sourceStride: Int, sourceWidth: Int, sourceHeight: Int,
    destination: UnsafeMutableRawPointer, width: Int, height: Int
  ) throws
}

public enum PreviewScalers {
  /// vImage where Accelerate exists, the area-average fallback elsewhere.
  public static func makeDefault() -> PreviewPlaneScaler {
    #if canImport(Accelerate)
      return VImagePlaneScaler()
    #else
      return BoxPlaneScaler()
    #endif
  }
}

/// Area-average downscale in plain Swift: each output sample averages the source rectangle it
/// covers, so a 2:1 reduction is an exact 2x2 box. The reference and the non-Apple fallback.
public final class BoxPlaneScaler: PreviewPlaneScaler {
  public init() {}

  public func scalePlanar8(
    source: UnsafeRawPointer, sourceStride: Int, sourceWidth: Int, sourceHeight: Int,
    destination: UnsafeMutableRawPointer, width: Int, height: Int
  ) throws {
    scale(source, sourceStride, sourceWidth, sourceHeight, destination, width, height, channels: 1)
  }

  public func scaleInterleaved16(
    source: UnsafeRawPointer, sourceStride: Int, sourceWidth: Int, sourceHeight: Int,
    destination: UnsafeMutableRawPointer, width: Int, height: Int
  ) throws {
    scale(source, sourceStride, sourceWidth, sourceHeight, destination, width, height, channels: 2)
  }

  private func scale(
    _ source: UnsafeRawPointer, _ stride: Int, _ srcW: Int, _ srcH: Int,
    _ destination: UnsafeMutableRawPointer, _ outW: Int, _ outH: Int, channels: Int
  ) {
    guard srcW > 0, srcH > 0, outW > 0, outH > 0 else { return }
    let src = source.assumingMemoryBound(to: UInt8.self)
    let dst = destination.assumingMemoryBound(to: UInt8.self)
    var out = 0
    for oy in 0 ..< outH {
      let y0 = oy * srcH / outH
      let y1 = max(y0 + 1, (oy + 1) * srcH / outH)
      for ox in 0 ..< outW {
        let x0 = ox * srcW / outW
        let x1 = max(x0 + 1, (ox + 1) * srcW / outW)
        let count = (y1 - y0) * (x1 - x0)
        for channel in 0 ..< channels {
          var sum = 0
          for sy in y0 ..< y1 {
            let row = sy * stride
            for sx in x0 ..< x1 { sum += Int(src[row + sx * channels + channel]) }
          }
          dst[out] = UInt8((sum + count / 2) / count)
          out += 1
        }
      }
    }
  }
}

#if canImport(Accelerate)
  /// vImage Lanczos downscale. The temporary buffer vImage needs is allocated once per output
  /// shape, never per frame.
  public final class VImagePlaneScaler: PreviewPlaneScaler {
    public struct ScaleError: Error { public let code: Int }

    private var temp: UnsafeMutableRawPointer?
    private var tempBytes = 0

    public init() {}

    deinit { temp?.deallocate() }

    public func scalePlanar8(
      source: UnsafeRawPointer, sourceStride: Int, sourceWidth: Int, sourceHeight: Int,
      destination: UnsafeMutableRawPointer, width: Int, height: Int
    ) throws {
      var src = vImage_Buffer(
        data: UnsafeMutableRawPointer(mutating: source), height: vImagePixelCount(sourceHeight),
        width: vImagePixelCount(sourceWidth), rowBytes: sourceStride
      )
      var dst = vImage_Buffer(
        data: destination, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: width
      )
      let needed = vImageScale_Planar8(&src, &dst, nil, vImage_Flags(kvImageGetTempBufferSize))
      let scratch = try scratchBuffer(bytes: needed)
      let error = vImageScale_Planar8(&src, &dst, scratch, vImage_Flags(kvImageNoFlags))
      guard error == kvImageNoError else { throw ScaleError(code: error) }
    }

    public func scaleInterleaved16(
      source: UnsafeRawPointer, sourceStride: Int, sourceWidth: Int, sourceHeight: Int,
      destination: UnsafeMutableRawPointer, width: Int, height: Int
    ) throws {
      var src = vImage_Buffer(
        data: UnsafeMutableRawPointer(mutating: source), height: vImagePixelCount(sourceHeight),
        width: vImagePixelCount(sourceWidth), rowBytes: sourceStride
      )
      var dst = vImage_Buffer(
        data: destination, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: width * 2
      )
      let needed = vImageScale_CbCr8(&src, &dst, nil, vImage_Flags(kvImageGetTempBufferSize))
      let scratch = try scratchBuffer(bytes: needed)
      let error = vImageScale_CbCr8(&src, &dst, scratch, vImage_Flags(kvImageNoFlags))
      guard error == kvImageNoError else { throw ScaleError(code: error) }
    }

    private func scratchBuffer(bytes: vImage_Error) throws -> UnsafeMutableRawPointer? {
      guard bytes >= 0 else { throw ScaleError(code: bytes) }
      guard bytes > 0 else { return nil }
      if bytes > tempBytes {
        temp?.deallocate()
        temp = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: 16)
        tempBytes = bytes
      }
      return temp
    }
  }
#endif
