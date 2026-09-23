import Foundation

/// Why a frame was not packed. Values are on the status wire and in NDJSON; do not rename.
public enum PackFailureReason: String, CaseIterable, Error, Sendable {
  case zeroSize = "zero_size"
  case strideTooSmall = "stride_too_small"
  case planeOutOfBounds = "plane_out_of_bounds"
  case payloadMismatch = "payload_mismatch"
  case slotTooSmall = "slot_too_small"
  case sinkError = "sink_error"
  case workerError = "worker_error"
}

public struct PreviewSize: Equatable, Hashable, Sendable {
  public let width: Int
  public let height: Int
  public init(width: Int, height: Int) {
    self.width = width
    self.height = height
  }
}

/// One source plane as the decoder lent it. `availableBytes` is how far past `base` may be read.
public struct PreviewPlane {
  public let base: UnsafeRawPointer
  public let stride: Int
  public let availableBytes: Int
  public init(base: UnsafeRawPointer, stride: Int, availableBytes: Int) {
    self.base = base
    self.stride = stride
    self.availableBytes = availableBytes
  }
}

/// A decoded 4:2:0 frame, described without CoreVideo so the pipeline can be tested anywhere.
/// I420 uses all three planes; NV12 uses `luma` and `chroma` (interleaved UV).
public struct PreviewSourceFrame {
  public let format: PreviewPixelFormat
  public let width: Int
  public let height: Int
  public let luma: PreviewPlane
  public let chroma: PreviewPlane
  public let chromaV: PreviewPlane?
  public let colorMatrix: PreviewColorMatrix
  public let colorRange: PreviewColorRange
  public let flags: PreviewFrameFlags
  public let timestampNs: Int64

  public init(
    format: PreviewPixelFormat, width: Int, height: Int,
    luma: PreviewPlane, chroma: PreviewPlane, chromaV: PreviewPlane?,
    colorMatrix: PreviewColorMatrix, colorRange: PreviewColorRange,
    flags: PreviewFrameFlags, timestampNs: Int64
  ) {
    self.format = format
    self.width = width
    self.height = height
    self.luma = luma
    self.chroma = chroma
    self.chromaV = chromaV
    self.colorMatrix = colorMatrix
    self.colorRange = colorRange
    self.flags = flags
    self.timestampNs = timestampNs
  }
}

/// Checks run before any byte is copied.
///
/// Swift cannot catch an out-of-bounds read: it is a trap or silent corruption. So a malformed
/// frame must be refused while it is still just numbers.
public enum PreviewGeometry {
  public static func validate(_ frame: PreviewSourceFrame, output: PreviewSize, payloadLength: Int) -> PackFailureReason? {
    guard frame.width > 0, frame.height > 0, output.width > 0, output.height > 0 else { return .zeroSize }
    // The header carries u16 dimensions and every reader rejects above this.
    guard output.width <= PreviewFrameParser.maxDimension, output.height <= PreviewFrameParser.maxDimension else {
      return .payloadMismatch
    }
    let chromaWidth = (frame.width + 1) / 2
    let chromaHeight = (frame.height + 1) / 2
    var planes: [(PreviewPlane, Int, Int)] = [(frame.luma, frame.width, frame.height)]
    switch frame.format {
    case .i420:
      guard let chromaV = frame.chromaV else { return .planeOutOfBounds }
      planes.append((frame.chroma, chromaWidth, chromaHeight))
      planes.append((chromaV, chromaWidth, chromaHeight))
    case .nv12:
      planes.append((frame.chroma, chromaWidth * 2, chromaHeight))
    }
    for (plane, rowBytes, _) in planes where plane.stride < rowBytes {
      return .strideTooSmall
    }
    for (plane, rowBytes, rows) in planes where plane.availableBytes < planeMinBytes(stride: plane.stride, rowBytes: rowBytes, rows: rows) {
      return .planeOutOfBounds
    }
    guard payloadLength == frame.format.packedSize(width: output.width, height: output.height) else {
      return .payloadMismatch
    }
    return nil
  }

  /// A slot must hold at least the frame; the send covers exactly `frameBytes`.
  public static func validateSlot(slotBytes: Int, frameBytes: Int) -> PackFailureReason? {
    slotBytes < frameBytes ? .slotTooSmall : nil
  }

  /// Bytes needed from a plane's start: every row but the last is a full stride.
  public static func planeMinBytes(stride: Int, rowBytes: Int, rows: Int) -> Int {
    guard rows > 0, rowBytes > 0 else { return 0 }
    return stride * (rows - 1) + rowBytes
  }
}

/// Output sizing: fit the source inside the host's box, keep its aspect, never upscale.
public enum PreviewScalePlan {
  /// The largest even-sized frame with the source's aspect ratio inside `box`. A source already
  /// inside the box is returned unchanged.
  public static func fit(source: PreviewSize, box: PreviewSize) -> PreviewSize {
    guard source.width > 0, source.height > 0, box.width > 0, box.height > 0 else { return source }
    if source.width <= box.width, source.height <= box.height { return source }
    let width: Int
    let height: Int
    // Integer cross-multiplication so the limiting side is chosen without float drift.
    if box.width * source.height <= box.height * source.width {
      width = box.width
      height = source.height * box.width / source.width
    } else {
      height = box.height
      width = source.width * box.height / source.height
    }
    return PreviewSize(width: even(width, source.width), height: even(height, source.height))
  }

  /// Shrink a box to at most `maxPixels`, keeping its shape. The host quantizes; this is a guard.
  public static func clampBox(_ box: PreviewSize, maxPixels: Int) -> PreviewSize {
    guard box.width > 0, box.height > 0 else { return box }
    let pixels = box.width * box.height
    guard pixels > maxPixels else { return box }
    let scale = (Double(maxPixels) / Double(pixels)).squareRoot()
    return PreviewSize(
      width: max(2, Int((Double(box.width) * scale).rounded(.down))),
      height: max(2, Int((Double(box.height) * scale).rounded(.down)))
    )
  }

  // Even sizes keep every chroma sample covering exactly two luma columns and rows.
  private static func even(_ value: Int, _ source: Int) -> Int {
    let rounded = value > 2 && value % 2 == 1 ? value - 1 : value
    return min(max(rounded, 2), source)
  }
}
