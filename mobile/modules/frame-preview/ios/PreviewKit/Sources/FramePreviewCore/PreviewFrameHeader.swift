import Foundation

/// Wire format for one preview frame: a fixed 64-byte little-endian header followed by tightly
/// packed 8-bit YUV.
///
/// The same bytes are produced by Kotlin and parsed by TypeScript, so the layout is spelled out
/// here once and asserted against golden bytes in all three languages. Nothing about the payload
/// is inferred from the transport: a reader validates version, lengths and dimensions before it
/// touches a single pixel, because both transports can hand over a truncated or stale buffer.
public enum PreviewPixelFormat: UInt8, Sendable {
  case i420 = 1
  case nv12 = 2

  /// Bytes a tightly packed frame of this format occupies.
  public func packedSize(width: Int, height: Int) -> Int {
    let chromaW = (width + 1) / 2
    let chromaH = (height + 1) / 2
    // I420 keeps U and V as separate planes, NV12 interleaves them; the total is the same.
    return width * height + 2 * chromaW * chromaH
  }
}

public enum PreviewColorMatrix: UInt8, Sendable {
  case unknown = 0
  case bt601 = 1
  case bt709 = 2
}

public enum PreviewColorRange: UInt8, Sendable {
  case unknown = 0
  case limited = 1
  case full = 2
}

public struct PreviewFrameFlags: OptionSet, Sendable {
  public let rawValue: UInt16
  public init(rawValue: UInt16) { self.rawValue = rawValue }
  /// Colour metadata was missing at the source and the documented fallback was used.
  public static let colorMetadataFallback = PreviewFrameFlags(rawValue: 1 << 0)
}

public struct PreviewFrameHeader: Equatable, Sendable {
  public static let byteCount = 64
  public static let version: UInt16 = 1
  /// "MFPV" as four ASCII bytes at offset 0.
  public static let magic: [UInt8] = [0x4D, 0x46, 0x50, 0x56]

  public var payloadLength: UInt32
  public var sessionGeneration: UInt32
  public var frameSequence: UInt32
  public var width: UInt16
  public var height: UInt16
  public var pixelFormat: PreviewPixelFormat
  /// Quarter turns clockwise the consumer must apply, 0-3.
  public var rotation: UInt8
  public var colorMatrix: PreviewColorMatrix
  public var colorRange: PreviewColorRange
  public var flags: PreviewFrameFlags
  /// Source decode time on the platform's monotonic clock, or 0 when the source did not supply one.
  public var timestampNs: Int64
  /// Monotonic clock reading taken immediately before the transport send call.
  public var sentAtNs: Int64

  public init(
    payloadLength: UInt32,
    sessionGeneration: UInt32,
    frameSequence: UInt32,
    width: UInt16,
    height: UInt16,
    pixelFormat: PreviewPixelFormat,
    rotation: UInt8 = 0,
    colorMatrix: PreviewColorMatrix = .unknown,
    colorRange: PreviewColorRange = .unknown,
    flags: PreviewFrameFlags = [],
    timestampNs: Int64 = 0,
    sentAtNs: Int64 = 0
  ) {
    self.payloadLength = payloadLength
    self.sessionGeneration = sessionGeneration
    self.frameSequence = frameSequence
    self.width = width
    self.height = height
    self.pixelFormat = pixelFormat
    self.rotation = rotation
    self.colorMatrix = colorMatrix
    self.colorRange = colorRange
    self.flags = flags
    self.timestampNs = timestampNs
    self.sentAtNs = sentAtNs
  }

  /// Write the header into the first 64 bytes of `buffer`, which must be at least that long.
  public func write(into buffer: UnsafeMutableRawBufferPointer) {
    precondition(buffer.count >= Self.byteCount, "header buffer too small")
    for (index, byte) in Self.magic.enumerated() { buffer[index] = byte }
    putU16(buffer, 4, Self.version)
    putU16(buffer, 6, UInt16(Self.byteCount))
    putU32(buffer, 8, payloadLength)
    putU32(buffer, 12, sessionGeneration)
    putU32(buffer, 16, frameSequence)
    putU16(buffer, 20, width)
    putU16(buffer, 22, height)
    buffer[24] = pixelFormat.rawValue
    buffer[25] = rotation
    buffer[26] = colorMatrix.rawValue
    buffer[27] = colorRange.rawValue
    putU16(buffer, 28, flags.rawValue)
    putU16(buffer, 30, 0)
    putU64(buffer, 32, UInt64(bitPattern: timestampNs))
    putU64(buffer, 40, UInt64(bitPattern: sentAtNs))
    for offset in 48 ..< Self.byteCount { buffer[offset] = 0 }
  }

  public func encoded() -> Data {
    var data = Data(count: Self.byteCount)
    data.withUnsafeMutableBytes { write(into: $0) }
    return data
  }

  private func putU16(_ buffer: UnsafeMutableRawBufferPointer, _ offset: Int, _ value: UInt16) {
    buffer[offset] = UInt8(value & 0xFF)
    buffer[offset + 1] = UInt8((value >> 8) & 0xFF)
  }

  private func putU32(_ buffer: UnsafeMutableRawBufferPointer, _ offset: Int, _ value: UInt32) {
    for shift in 0 ..< 4 { buffer[offset + shift] = UInt8((value >> (8 * UInt32(shift))) & 0xFF) }
  }

  private func putU64(_ buffer: UnsafeMutableRawBufferPointer, _ offset: Int, _ value: UInt64) {
    for shift in 0 ..< 8 { buffer[offset + shift] = UInt8((value >> (8 * UInt64(shift))) & 0xFF) }
  }
}
