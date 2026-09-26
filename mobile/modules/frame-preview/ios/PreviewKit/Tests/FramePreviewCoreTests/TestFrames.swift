@testable import FramePreviewCore
import Foundation

/// Owns padded source planes for tests and describes them as a `PreviewSourceFrame`.
final class TestFrame {
  let format: PreviewPixelFormat
  let width: Int
  let height: Int
  let padding: Int
  private(set) var planes: [UnsafeMutableRawBufferPointer] = []
  private(set) var strides: [Int] = []

  init(format: PreviewPixelFormat = .nv12, width: Int, height: Int, fill: (y: UInt8, u: UInt8, v: UInt8) = (0x80, 0x40, 0xC0), padding: Int = 16) {
    self.format = format
    self.width = width
    self.height = height
    self.padding = padding
    let chromaWidth = (width + 1) / 2
    let chromaHeight = (height + 1) / 2
    addPlane(stride: width + padding, rows: height) { _ in fill.y }
    switch format {
    case .i420:
      addPlane(stride: chromaWidth + padding, rows: chromaHeight) { _ in fill.u }
      addPlane(stride: chromaWidth + padding, rows: chromaHeight) { _ in fill.v }
    case .nv12:
      addPlane(stride: chromaWidth * 2 + padding, rows: chromaHeight) { $0 % 2 == 0 ? fill.u : fill.v }
    }
  }

  private func addPlane(stride: Int, rows: Int, value: (Int) -> UInt8) {
    let buffer = UnsafeMutableRawBufferPointer.allocate(byteCount: stride * rows, alignment: 16)
    for row in 0 ..< rows {
      for column in 0 ..< stride { buffer[row * stride + column] = value(column) }
    }
    planes.append(buffer)
    strides.append(stride)
  }

  deinit { planes.forEach { $0.deallocate() } }

  func plane(_ index: Int, available: Int? = nil, stride: Int? = nil) -> PreviewPlane {
    let buffer = planes[index]
    // Test-only: the buffers are allocated just above and never empty.
    return PreviewPlane(
      base: UnsafeRawPointer(buffer.baseAddress ?? UnsafeMutableRawPointer(bitPattern: 16)!),
      stride: stride ?? strides[index],
      availableBytes: available ?? buffer.count
    )
  }

  func frame(lumaAvailable: Int? = nil, lumaStride: Int? = nil) -> PreviewSourceFrame {
    PreviewSourceFrame(
      format: format, width: width, height: height,
      luma: plane(0, available: lumaAvailable, stride: lumaStride),
      chroma: plane(1),
      chromaV: format == .i420 ? plane(2) : nil,
      colorMatrix: .bt709, colorRange: .limited, flags: [], timestampNs: 42
    )
  }
}
