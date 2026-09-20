import XCTest

@testable import FramePreviewCore

final class PixelPackTests: XCTestCase {
  /// Padded strides are the normal case out of a hardware decoder, and the symptom of getting
  /// them wrong is a sheared picture rather than a crash — so the padding is deliberately
  /// filled with a poison value that must never appear in the output.
  func testI420PackDropsRowPaddingAndKeepsPlaneOrder() {
    let width = 6, height = 4
    let strideY = 8, strideChroma = 5
    let chromaWidth = 3, chromaHeight = 2

    var y = [UInt8](repeating: 0xEE, count: strideY * height)
    var u = [UInt8](repeating: 0xEE, count: strideChroma * chromaHeight)
    var v = [UInt8](repeating: 0xEE, count: strideChroma * chromaHeight)
    for row in 0 ..< height {
      for column in 0 ..< width { y[row * strideY + column] = UInt8(row * 10 + column) }
    }
    for row in 0 ..< chromaHeight {
      for column in 0 ..< chromaWidth {
        u[row * strideChroma + column] = UInt8(100 + row * 10 + column)
        v[row * strideChroma + column] = UInt8(200 + row * 10 + column)
      }
    }

    var destination = [UInt8](repeating: 0, count: PreviewPixelFormat.i420.packedSize(width: width, height: height))
    destination.withUnsafeMutableBytes { output in
      y.withUnsafeBytes { yBytes in
        u.withUnsafeBytes { uBytes in
          v.withUnsafeBytes { vBytes in
            let written = PixelPack.packI420(
              y: yBytes.baseAddress!, strideY: strideY,
              u: uBytes.baseAddress!, strideU: strideChroma,
              v: vBytes.baseAddress!, strideV: strideChroma,
              width: width, height: height, into: output, at: 0
            )
            XCTAssertEqual(written, output.count)
          }
        }
      }
    }

    XCTAssertFalse(destination.contains(0xEE), "row padding leaked into the packed frame")
    XCTAssertEqual(Array(destination[0 ..< 6]), [0, 1, 2, 3, 4, 5])
    XCTAssertEqual(Array(destination[6 ..< 12]), [10, 11, 12, 13, 14, 15])
    XCTAssertEqual(Array(destination[24 ..< 27]), [100, 101, 102], "U follows Y")
    XCTAssertEqual(Array(destination[30 ..< 33]), [200, 201, 202], "V follows U")
  }

  func testNV12PackKeepsChromaInterleavedAndDropsPadding() {
    let width = 4, height = 2
    let strideY = 6, strideUV = 7
    var y = [UInt8](repeating: 0xEE, count: strideY * height)
    var uv = [UInt8](repeating: 0xEE, count: strideUV * 1)
    for row in 0 ..< height {
      for column in 0 ..< width { y[row * strideY + column] = UInt8(row * 10 + column) }
    }
    // One chroma row of two UV pairs.
    uv[0] = 90; uv[1] = 190; uv[2] = 91; uv[3] = 191

    var destination = [UInt8](repeating: 0, count: PreviewPixelFormat.nv12.packedSize(width: width, height: height))
    destination.withUnsafeMutableBytes { output in
      y.withUnsafeBytes { yBytes in
        uv.withUnsafeBytes { uvBytes in
          let written = PixelPack.packNV12(
            y: yBytes.baseAddress!, strideY: strideY,
            uv: uvBytes.baseAddress!, strideUV: strideUV,
            width: width, height: height, into: output, at: 0
          )
          XCTAssertEqual(written, output.count)
        }
      }
    }

    XCTAssertFalse(destination.contains(0xEE))
    XCTAssertEqual(Array(destination[0 ..< 4]), [0, 1, 2, 3])
    XCTAssertEqual(Array(destination[8 ..< 12]), [90, 190, 91, 191], "UV stays interleaved")
  }

  func testPackingLeavesAPrecedingHeaderUntouched() {
    // The Android path packs into a slice positioned after the header; this asserts the Swift
    // offset form has the same property, since both write into one send buffer.
    let width = 4, height = 2
    let payloadSize = PreviewPixelFormat.i420.packedSize(width: width, height: height)
    var buffer = [UInt8](repeating: 0, count: PreviewFrameHeader.byteCount + payloadSize)
    let header = PreviewFrameHeader(
      payloadLength: UInt32(payloadSize), sessionGeneration: 1, frameSequence: 1,
      width: UInt16(width), height: UInt16(height), pixelFormat: .i420
    )
    let plane = [UInt8](repeating: 0x7F, count: 64)
    buffer.withUnsafeMutableBytes { output in
      header.write(into: output)
      plane.withUnsafeBytes { source in
        PixelPack.packI420(
          y: source.baseAddress!, strideY: width,
          u: source.baseAddress!, strideU: (width + 1) / 2,
          v: source.baseAddress!, strideV: (width + 1) / 2,
          width: width, height: height, into: output, at: PreviewFrameHeader.byteCount
        )
      }
    }
    XCTAssertEqual(Array(buffer[0 ..< 4]), [0x4D, 0x46, 0x50, 0x56], "header survived the pack")
    XCTAssertEqual(buffer[PreviewFrameHeader.byteCount], 0x7F)
  }

  func testTestPatternCarriesADecodableFrameCounter() {
    let width = 1280, height = 720
    var frame = [UInt8](repeating: 0, count: PreviewPixelFormat.nv12.packedSize(width: width, height: height))
    for index in [0, 1, 42, 65535] {
      frame.withUnsafeMutableBytes {
        PreviewTestPattern.write(into: $0, width: width, height: height, frameIndex: index, format: .nv12)
      }
      let read = frame.withUnsafeBytes { PreviewTestPattern.readFrameMarker($0, width: width) }
      XCTAssertEqual(read, index & 0xFFFF, "marker must identify the exact frame on screen")
    }
  }
}
