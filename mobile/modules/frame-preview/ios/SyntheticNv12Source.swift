import CoreVideo
import Foundation

/// Synthetic 720p NV12 frames, produced as real `CVPixelBuffer`s.
///
/// Going through a pixel buffer rather than straight to packed bytes is the point: the synthetic
/// path then exercises exactly the same lock / stride / pack / release code as a live call, so a
/// number measured with synthetic frames means something for real ones.
///
/// The pool is capped at two buffers rather than left to grow. That cap is the ownership rule:
/// if the packing worker still holds the previous frame, the generator cannot get a buffer and
/// the tick is skipped. Without it the generator would overwrite pixels a worker was reading.
final class SyntheticNv12Source {
  private let width: Int
  private let height: Int
  private var pool: CVPixelBufferPool?
  private let auxiliaryAttributes: CFDictionary

  init(width: Int, height: Int) {
    self.width = width
    self.height = height
    auxiliaryAttributes = [
      kCVPixelBufferPoolAllocationThresholdKey as String: 2,
    ] as CFDictionary
    let poolAttributes = [kCVPixelBufferPoolMinimumBufferCountKey as String: 2] as CFDictionary
    let bufferAttributes = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:] as CFDictionary,
    ] as CFDictionary
    var created: CVPixelBufferPool?
    CVPixelBufferPoolCreate(kCFAllocatorDefault, poolAttributes, bufferAttributes, &created)
    pool = created
  }

  /// Nil when both leases are still out — the caller counts that as a skip, not an error.
  func makeFrame(index: Int) -> CVPixelBuffer? {
    guard let pool else { return nil }
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(
      kCFAllocatorDefault, pool, auxiliaryAttributes, &buffer
    )
    guard status == kCVReturnSuccess, let buffer else { return nil }

    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let luma = CVPixelBufferGetBaseAddressOfPlane(buffer, 0),
          let chroma = CVPixelBufferGetBaseAddressOfPlane(buffer, 1)
    else { return nil }

    // The pattern writer works on tight rows, so it is applied row by row into the pool buffer's
    // padded strides rather than assuming the pool handed back a tight allocation.
    let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
    let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
    var tight = [UInt8](repeating: 0, count: PreviewPixelFormat.nv12.packedSize(width: width, height: height))
    tight.withUnsafeMutableBytes {
      PreviewTestPattern.write(into: $0, width: width, height: height, frameIndex: index, format: .nv12)
    }
    tight.withUnsafeBytes { source in
      let base = source.baseAddress!
      for row in 0 ..< height {
        luma.advanced(by: row * lumaStride).copyMemory(from: base.advanced(by: row * width), byteCount: width)
      }
      let chromaHeight = (height + 1) / 2
      let chromaWidth = ((width + 1) / 2) * 2
      let chromaSource = base.advanced(by: width * height)
      for row in 0 ..< chromaHeight {
        chroma.advanced(by: row * chromaStride)
          .copyMemory(from: chromaSource.advanced(by: row * chromaWidth), byteCount: chromaWidth)
      }
    }
    return buffer
  }
}
