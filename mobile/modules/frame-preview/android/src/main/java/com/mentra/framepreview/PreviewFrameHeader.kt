package com.mentra.framepreview

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Pixel layout of the packed payload. Values are on the wire; do not renumber. */
enum class PreviewPixelFormat(val code: Int) {
  I420(1),
  NV12(2),
  ;

  /** Bytes a tightly packed frame of this format occupies. */
  fun packedSize(width: Int, height: Int): Int {
    val chromaWidth = (width + 1) / 2
    val chromaHeight = (height + 1) / 2
    // I420 keeps U and V as separate planes, NV12 interleaves them; the total is the same.
    return width * height + 2 * chromaWidth * chromaHeight
  }
}

enum class PreviewColorMatrix(val code: Int) { UNKNOWN(0), BT601(1), BT709(2) }

enum class PreviewColorRange(val code: Int) { UNKNOWN(0), LIMITED(1), FULL(2) }

/**
 * Wire format for one preview frame: a fixed 64-byte little-endian header followed by tightly
 * packed 8-bit YUV.
 *
 * Swift writes the same 64 bytes and TypeScript parses them, so the layout is spelled out once
 * and asserted against golden bytes in all three languages. A reader validates version, lengths
 * and dimensions before touching a pixel, because both transports can hand over a truncated or
 * stale buffer.
 */
data class PreviewFrameHeader(
  val payloadLength: Int,
  val sessionGeneration: Int,
  val frameSequence: Int,
  val width: Int,
  val height: Int,
  val pixelFormat: PreviewPixelFormat,
  /** Quarter turns clockwise the consumer must apply, 0-3. */
  val rotation: Int = 0,
  val colorMatrix: PreviewColorMatrix = PreviewColorMatrix.UNKNOWN,
  val colorRange: PreviewColorRange = PreviewColorRange.UNKNOWN,
  val flags: Int = 0,
  /** Source decode time on the platform's monotonic clock, or 0 when the source gave none. */
  val timestampNs: Long = 0,
  /** Monotonic clock reading taken immediately before the transport send call. */
  val sentAtNs: Long = 0,
) {
  /**
   * Write into the first [BYTE_COUNT] bytes of [target]'s backing array.
   *
   * Takes the array rather than a positioned buffer on purpose: the payload is packed through a
   * slice of the same allocation, and `I420Packer.pack` calls `clear()` on whatever buffer it is
   * given. Writing the header through its own little-endian view keeps the two from colliding.
   */
  fun writeInto(target: ByteArray, offset: Int = 0) {
    require(target.size - offset >= BYTE_COUNT) { "header buffer too small" }
    val buffer = ByteBuffer.wrap(target, offset, BYTE_COUNT).order(ByteOrder.LITTLE_ENDIAN)
    buffer.put(MAGIC)
    buffer.putShort(VERSION.toShort())
    buffer.putShort(BYTE_COUNT.toShort())
    buffer.putInt(payloadLength)
    buffer.putInt(sessionGeneration)
    buffer.putInt(frameSequence)
    buffer.putShort(width.toShort())
    buffer.putShort(height.toShort())
    buffer.put(pixelFormat.code.toByte())
    buffer.put(rotation.toByte())
    buffer.put(colorMatrix.code.toByte())
    buffer.put(colorRange.code.toByte())
    buffer.putShort(flags.toShort())
    buffer.putShort(0.toShort())
    buffer.putLong(timestampNs)
    buffer.putLong(sentAtNs)
    while (buffer.position() < offset + BYTE_COUNT) buffer.put(0.toByte())
  }

  companion object {
    const val BYTE_COUNT = 64
    const val VERSION = 1

    /** "MFPV" at offset 0. */
    val MAGIC = byteArrayOf(0x4D, 0x46, 0x50, 0x56)

    /** Colour metadata was missing at the source and the documented fallback was used. */
    const val FLAG_COLOR_METADATA_FALLBACK = 1 shl 0
  }
}
