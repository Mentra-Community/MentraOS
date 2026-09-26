import Foundation

/// Reader for the MFPV wire format, with the same checks, in the same order, and the same reason
/// codes as the TypeScript parser. Native code only writes frames in production; this exists so
/// Swift asserts the shared golden fixtures exactly as the page does.
public enum PreviewFrameParser {
  /// Parser reason codes. Values are shared with Kotlin and TypeScript; do not rename.
  public enum Reason: String, CaseIterable, Sendable {
    case shortBuffer = "short-buffer"
    case badMagic = "bad-magic"
    case unsupportedVersion = "unsupported-version"
    case badHeaderLength = "bad-header-length"
    case badDimensions = "bad-dimensions"
    case unknownPixelFormat = "unknown-pixel-format"
    case payloadSizeMismatch = "payload-size-mismatch"
    case truncatedPayload = "truncated-payload"
  }

  /// Raw header fields. Colour codes stay raw so "unknown" is visible to the caller.
  public struct Frame: Equatable, Sendable {
    public let payloadLength: Int
    public let sessionGeneration: UInt32
    public let frameSequence: UInt32
    public let width: Int
    public let height: Int
    public let pixelFormat: PreviewPixelFormat
    public let rotation: UInt8
    public let colorMatrixCode: UInt8
    public let colorRangeCode: UInt8
    public let flags: UInt16
    public let timestampNs: Int64
    public let sentAtNs: Int64
    public let payloadOffset: Int
  }

  public enum Result: Equatable, Sendable {
    case ok(Frame)
    case rejected(Reason)
  }

  /// Neither the glasses nor a phone camera reaches this; anything above is a corrupt header.
  public static let maxDimension = 4096

  public static func parse(_ bytes: [UInt8]) -> Result {
    let header = PreviewFrameHeader.byteCount
    guard bytes.count >= header else { return .rejected(.shortBuffer) }
    for (index, byte) in PreviewFrameHeader.magic.enumerated() where bytes[index] != byte {
      return .rejected(.badMagic)
    }
    guard u16(bytes, 4) == PreviewFrameHeader.version else { return .rejected(.unsupportedVersion) }
    guard Int(u16(bytes, 6)) == header else { return .rejected(.badHeaderLength) }
    let payloadLength = Int(u32(bytes, 8))
    let width = Int(u16(bytes, 20))
    let height = Int(u16(bytes, 22))
    guard width > 0, height > 0, width <= maxDimension, height <= maxDimension else {
      return .rejected(.badDimensions)
    }
    guard let format = PreviewPixelFormat(rawValue: bytes[24]) else { return .rejected(.unknownPixelFormat) }
    guard payloadLength == format.packedSize(width: width, height: height) else {
      return .rejected(.payloadSizeMismatch)
    }
    guard bytes.count >= header + payloadLength else { return .rejected(.truncatedPayload) }
    return .ok(Frame(
      payloadLength: payloadLength,
      sessionGeneration: u32(bytes, 12),
      frameSequence: u32(bytes, 16),
      width: width,
      height: height,
      pixelFormat: format,
      rotation: bytes[25],
      colorMatrixCode: bytes[26],
      colorRangeCode: bytes[27],
      flags: u16(bytes, 28),
      timestampNs: Int64(bitPattern: u64(bytes, 32)),
      sentAtNs: Int64(bitPattern: u64(bytes, 40)),
      payloadOffset: header
    ))
  }

  private static func u16(_ bytes: [UInt8], _ offset: Int) -> UInt16 {
    UInt16(bytes[offset]) | UInt16(bytes[offset + 1]) << 8
  }

  private static func u32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
    (0 ..< 4).reduce(UInt32(0)) { $0 | UInt32(bytes[offset + $1]) << (8 * UInt32($1)) }
  }

  private static func u64(_ bytes: [UInt8], _ offset: Int) -> UInt64 {
    (0 ..< 8).reduce(UInt64(0)) { $0 | UInt64(bytes[offset + $1]) << (8 * UInt64($1)) }
  }
}
