@testable import FramePreviewCore
import Foundation
import XCTest

/// The shared MFPV fixtures under `mobile/modules/frame-preview/fixtures/`, asserted exactly as
/// the Kotlin and TypeScript suites assert them. A drift in any language fails the same file.
final class GoldenFixturesTests: XCTestCase {
  private struct Entry: Decodable {
    let file: String
    let expect: String
    let width: Int
    let height: Int
    let format: String
    let rotation: Int
    let matrix: String
    let range: String
    let flags: Int
    let generation: UInt32
    let sequence: UInt32
    let payloadLength: Int
    let timestampNs: String
    let sentAtNs: String
    let fill: [String: Int]
  }

  private static let directory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // FramePreviewCoreTests
    .deletingLastPathComponent() // Tests
    .deletingLastPathComponent() // PreviewKit
    .deletingLastPathComponent() // ios
    .deletingLastPathComponent() // frame-preview
    .appendingPathComponent("fixtures")

  private func manifest() throws -> [Entry] {
    let data = try Data(contentsOf: Self.directory.appendingPathComponent("manifest.json"))
    return try JSONDecoder().decode([Entry].self, from: data)
  }

  private func bytes(_ name: String) throws -> [UInt8] {
    [UInt8](try Data(contentsOf: Self.directory.appendingPathComponent(name)))
  }

  func testManifestCoversEveryParserReasonAndBothFormats() throws {
    let entries = try manifest()
    let expects = Set(entries.map(\.expect))
    XCTAssertTrue(expects.isSuperset(of: PreviewFrameParser.Reason.allCases.map(\.rawValue) + ["ok"]))
    let valid = entries.filter { $0.expect == "ok" }
    XCTAssertEqual(Set(valid.map(\.format)), ["i420", "nv12"])
    XCTAssertEqual(Set(valid.map(\.rotation)), [0, 1, 2, 3])
    XCTAssertEqual(Set(valid.map(\.matrix)), ["unknown", "bt601", "bt709"])
    XCTAssertEqual(Set(valid.map(\.range)), ["unknown", "limited", "full"])
  }

  func testEveryFixtureParsesToItsManifestExpectation() throws {
    for entry in try manifest() {
      let data = try bytes(entry.file)
      switch PreviewFrameParser.parse(data) {
      case let .rejected(reason):
        XCTAssertEqual(reason.rawValue, entry.expect, entry.file)
      case let .ok(frame):
        XCTAssertEqual("ok", entry.expect, entry.file)
        assertFields(entry, frame, data)
      }
    }
  }

  func testTheSwiftWriterProducesEachValidFixtureHeaderByteForByte() throws {
    for entry in try manifest() where entry.expect == "ok" {
      let expected = Array(try bytes(entry.file).prefix(PreviewFrameHeader.byteCount))
      let header = PreviewFrameHeader(
        payloadLength: UInt32(entry.payloadLength),
        sessionGeneration: entry.generation,
        frameSequence: entry.sequence,
        width: UInt16(entry.width),
        height: UInt16(entry.height),
        pixelFormat: entry.format == "nv12" ? .nv12 : .i420,
        rotation: UInt8(entry.rotation),
        colorMatrix: PreviewColorMatrix(rawValue: Self.matrixCode(entry.matrix)) ?? .unknown,
        colorRange: PreviewColorRange(rawValue: Self.rangeCode(entry.range)) ?? .unknown,
        flags: PreviewFrameFlags(rawValue: UInt16(entry.flags)),
        timestampNs: Int64(entry.timestampNs) ?? -1,
        sentAtNs: Int64(entry.sentAtNs) ?? -1
      )
      XCTAssertEqual([UInt8](header.encoded()), expected, entry.file)
    }
  }

  private func assertFields(_ entry: Entry, _ frame: PreviewFrameParser.Frame, _ data: [UInt8]) {
    let name = entry.file
    XCTAssertEqual(frame.width, entry.width, name)
    XCTAssertEqual(frame.height, entry.height, name)
    XCTAssertEqual(frame.pixelFormat == .nv12 ? "nv12" : "i420", entry.format, name)
    XCTAssertEqual(Int(frame.rotation), entry.rotation, name)
    XCTAssertEqual(frame.colorMatrixCode, Self.matrixCode(entry.matrix), name)
    XCTAssertEqual(frame.colorRangeCode, Self.rangeCode(entry.range), name)
    XCTAssertEqual(Int(frame.flags), entry.flags, name)
    XCTAssertEqual(frame.sessionGeneration, entry.generation, name)
    XCTAssertEqual(frame.frameSequence, entry.sequence, name)
    XCTAssertEqual(frame.payloadLength, entry.payloadLength, name)
    XCTAssertEqual(frame.timestampNs, Int64(entry.timestampNs), name)
    XCTAssertEqual(frame.sentAtNs, Int64(entry.sentAtNs), name)

    let luma = frame.width * frame.height
    let chroma = ((frame.width + 1) / 2) * ((frame.height + 1) / 2)
    let payload = Array(data[frame.payloadOffset ..< frame.payloadOffset + frame.payloadLength])
    XCTAssertEqual(Set(payload[0 ..< luma]), [UInt8(entry.fill["y"] ?? 0)], "\(name) Y")
    if frame.pixelFormat == .nv12 {
      let uv = Array(payload[luma ..< luma + 2 * chroma])
      XCTAssertEqual(Set(stride(from: 0, to: uv.count, by: 2).map { uv[$0] }), [UInt8(entry.fill["u"] ?? 0)], "\(name) U")
      XCTAssertEqual(Set(stride(from: 1, to: uv.count, by: 2).map { uv[$0] }), [UInt8(entry.fill["v"] ?? 0)], "\(name) V")
    } else {
      XCTAssertEqual(Set(payload[luma ..< luma + chroma]), [UInt8(entry.fill["u"] ?? 0)], "\(name) U")
      XCTAssertEqual(Set(payload[luma + chroma ..< luma + 2 * chroma]), [UInt8(entry.fill["v"] ?? 0)], "\(name) V")
    }
  }

  private static func matrixCode(_ name: String) -> UInt8 {
    switch name {
    case "bt601": return 1
    case "bt709": return 2
    default: return 0
    }
  }

  private static func rangeCode(_ name: String) -> UInt8 {
    switch name {
    case "limited": return 1
    case "full": return 2
    default: return 0
    }
  }
}
