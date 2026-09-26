import XCTest

@testable import FramePreviewCore

final class PreviewFrameHeaderTests: XCTestCase {
  /// Golden bytes. Kotlin writes the same 64 bytes and TypeScript parses them; if any of the
  /// three drifts, exactly one of these three tests fails and names the offset.
  func testHeaderGoldenBytes() {
    let header = PreviewFrameHeader(
      payloadLength: 1_382_400,
      sessionGeneration: 7,
      frameSequence: 258,
      width: 1280,
      height: 720,
      pixelFormat: .nv12,
      rotation: 1,
      colorMatrix: .bt709,
      colorRange: .full,
      flags: [.colorMetadataFallback],
      timestampNs: 0x0102_0304_0506_0708,
      sentAtNs: 0x1112_1314_1516_1718
    )
    let bytes = [UInt8](header.encoded())

    XCTAssertEqual(bytes.count, 64)
    XCTAssertEqual(Array(bytes[0 ..< 4]), [0x4D, 0x46, 0x50, 0x56], "magic MFPV")
    XCTAssertEqual(Array(bytes[4 ..< 6]), [0x01, 0x00], "version 1 little-endian")
    XCTAssertEqual(Array(bytes[6 ..< 8]), [0x40, 0x00], "headerLen 64")
    XCTAssertEqual(Array(bytes[8 ..< 12]), [0x00, 0x18, 0x15, 0x00], "payloadLen 1382400")
    XCTAssertEqual(Array(bytes[12 ..< 16]), [0x07, 0x00, 0x00, 0x00])
    XCTAssertEqual(Array(bytes[16 ..< 20]), [0x02, 0x01, 0x00, 0x00], "frameSeq 258")
    XCTAssertEqual(Array(bytes[20 ..< 22]), [0x00, 0x05], "width 1280")
    XCTAssertEqual(Array(bytes[22 ..< 24]), [0xD0, 0x02], "height 720")
    XCTAssertEqual(bytes[24], 2, "NV12")
    XCTAssertEqual(bytes[25], 1, "rotation")
    XCTAssertEqual(bytes[26], 2, "BT.709")
    XCTAssertEqual(bytes[27], 2, "full range")
    XCTAssertEqual(Array(bytes[28 ..< 30]), [0x01, 0x00], "fallback flag")
    XCTAssertEqual(Array(bytes[30 ..< 32]), [0x00, 0x00], "reserved")
    XCTAssertEqual(Array(bytes[32 ..< 40]), [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01])
    XCTAssertEqual(Array(bytes[40 ..< 48]), [0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11])
    XCTAssertEqual(Array(bytes[48 ..< 64]), [UInt8](repeating: 0, count: 16), "tail reserved zeroed")
  }

  func testPackedSizeMatchesTheDocumented720pPayload() {
    XCTAssertEqual(PreviewPixelFormat.i420.packedSize(width: 1280, height: 720), 1_382_400)
    XCTAssertEqual(PreviewPixelFormat.nv12.packedSize(width: 1280, height: 720), 1_382_400)
    // Odd dimensions round chroma up; a reader that rounds down would walk off the end.
    XCTAssertEqual(PreviewPixelFormat.i420.packedSize(width: 3, height: 3), 9 + 2 * 4)
  }
}
