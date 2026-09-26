package com.mentra.framepreview

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Reader for the MFPV wire format, with the same checks, in the same order, and the same reason
 * codes as the TypeScript parser. Native code only writes frames in production; this exists so
 * Kotlin asserts the shared golden fixtures exactly as the page does.
 */
object PreviewFrameParser {
  /** Parser reason codes. Values are shared with Swift and TypeScript; do not rename. */
  enum class Reason(val wire: String) {
    SHORT_BUFFER("short-buffer"),
    BAD_MAGIC("bad-magic"),
    UNSUPPORTED_VERSION("unsupported-version"),
    BAD_HEADER_LENGTH("bad-header-length"),
    BAD_DIMENSIONS("bad-dimensions"),
    UNKNOWN_PIXEL_FORMAT("unknown-pixel-format"),
    PAYLOAD_SIZE_MISMATCH("payload-size-mismatch"),
    TRUNCATED_PAYLOAD("truncated-payload"),
  }

  /** Raw header fields. Colour codes stay raw so "unknown" is visible to the caller. */
  data class Frame(
    val payloadLength: Int,
    val sessionGeneration: Long,
    val frameSequence: Long,
    val width: Int,
    val height: Int,
    val pixelFormat: PreviewPixelFormat,
    val rotation: Int,
    val colorMatrixCode: Int,
    val colorRangeCode: Int,
    val flags: Int,
    val timestampNs: Long,
    val sentAtNs: Long,
    /** Offset of the first payload byte in the parsed array. */
    val payloadOffset: Int,
  )

  sealed interface Result {
    data class Ok(val frame: Frame) : Result

    data class Rejected(val reason: Reason) : Result
  }

  /** Neither the glasses nor a phone camera reaches this; anything above is a corrupt header. */
  const val MAX_DIMENSION = 4096

  fun parse(bytes: ByteArray, length: Int = bytes.size): Result {
    val header = PreviewFrameHeader.BYTE_COUNT
    if (length < header) return Result.Rejected(Reason.SHORT_BUFFER)
    for (index in PreviewFrameHeader.MAGIC.indices) {
      if (bytes[index] != PreviewFrameHeader.MAGIC[index]) return Result.Rejected(Reason.BAD_MAGIC)
    }
    val view = ByteBuffer.wrap(bytes, 0, header).order(ByteOrder.LITTLE_ENDIAN)
    val version = view.getShort(4).toInt() and 0xFFFF
    if (version != PreviewFrameHeader.VERSION) return Result.Rejected(Reason.UNSUPPORTED_VERSION)
    val headerLength = view.getShort(6).toInt() and 0xFFFF
    if (headerLength != header) return Result.Rejected(Reason.BAD_HEADER_LENGTH)
    val payloadLength = view.getInt(8).toLong() and 0xFFFFFFFFL
    val width = view.getShort(20).toInt() and 0xFFFF
    val height = view.getShort(22).toInt() and 0xFFFF
    if (width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
      return Result.Rejected(Reason.BAD_DIMENSIONS)
    }
    val format = PreviewPixelFormat.entries.firstOrNull { it.code == (bytes[24].toInt() and 0xFF) }
      ?: return Result.Rejected(Reason.UNKNOWN_PIXEL_FORMAT)
    if (payloadLength != format.packedSize(width, height).toLong()) {
      return Result.Rejected(Reason.PAYLOAD_SIZE_MISMATCH)
    }
    if (length.toLong() < header + payloadLength) return Result.Rejected(Reason.TRUNCATED_PAYLOAD)
    return Result.Ok(
      Frame(
        payloadLength = payloadLength.toInt(),
        sessionGeneration = view.getInt(12).toLong() and 0xFFFFFFFFL,
        frameSequence = view.getInt(16).toLong() and 0xFFFFFFFFL,
        width = width,
        height = height,
        pixelFormat = format,
        rotation = bytes[25].toInt() and 0xFF,
        colorMatrixCode = bytes[26].toInt() and 0xFF,
        colorRangeCode = bytes[27].toInt() and 0xFF,
        flags = view.getShort(28).toInt() and 0xFFFF,
        timestampNs = view.getLong(32),
        sentAtNs = view.getLong(40),
        payloadOffset = header,
      ),
    )
  }
}
