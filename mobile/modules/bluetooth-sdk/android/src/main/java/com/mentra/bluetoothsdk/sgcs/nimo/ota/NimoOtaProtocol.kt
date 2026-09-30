package com.mentra.bluetoothsdk.sgcs.nimo.ota

import java.util.zip.CRC32

/** NIMO's OTA channel (7033/2001/2002), distinct from the normal 0xBF command channel. */
internal object NimoOtaProtocol {
  const val INFO = 0x02
  const val RESET = 0x03
  const val FILE_OFFSET = 0xE1
  const val CAN_UPDATE = 0xE2
  const val ENTER = 0xE3
  const val BLOCK = 0xE5
  const val VALIDATE = 0xE6
  const val SYNC = 0xE8
  private val header = byteArrayOf(0x70, 0x07, 0x6E)

  data class Response(val command: Int, val sequence: Int, val status: Int, val body: ByteArray)
  data class Slice(val offset: Long, val length: Int)
  data class EnterResult(val slice: Slice, val crc: Boolean)
  data class BlockResult(val slice: Slice, val delayMs: Int)

  fun request(command: Int, sequence: Int, params: ByteArray = byteArrayOf()): ByteArray {
    require(command in 0..255 && sequence in 0..255 && params.size <= 65534) { "Invalid OTA request" }
    val length = params.size + 1
    return header + byteArrayOf(0xC0.toByte(), command.toByte(), (length shr 8).toByte(), length.toByte(), sequence.toByte()) + params + 0x33.toByte()
  }

  /** Bounded incremental decoder. Any malformed frame invalidates this exchange, never resynchronizes silently. */
  class Decoder {
    private var buffer = byteArrayOf()
    fun reset() { buffer = byteArrayOf() }
    fun feed(bytes: ByteArray): List<Response> {
      val result = mutableListOf<Response>()
      try {
        // Append incrementally so a large/coalesced notification cannot grow the retained buffer without bound.
        for (byte in bytes) {
          buffer += byte
          if (buffer.size <= 3) require(buffer.last() == header[buffer.lastIndex]) { "Invalid OTA header" }
          if (buffer.size == 4) require(buffer[3] == 0.toByte()) { "Invalid OTA direction" }
          if (buffer.size >= 7) {
            val length = u16(buffer, 5)
            require(length in 2..4096) { "Invalid OTA response length" }
            if (buffer.size == length + 8) {
              require(buffer.last() == 0x33.toByte()) { "Invalid OTA footer" }
              result += Response(u8(buffer[4]), u8(buffer[8]), u8(buffer[7]), buffer.copyOfRange(9, buffer.size - 1))
              buffer = byteArrayOf()
            }
          }
        }
      } catch (error: IllegalArgumentException) {
        reset()
        throw error
      }
      return result
    }
  }

  fun deviceInfo(body: ByteArray): Map<Int, ByteArray> {
    val fields = mutableMapOf<Int, ByteArray>()
    var index = 0
    while (index < body.size) {
      val length = u8(body[index])
      require(length >= 1 && length <= body.size - index - 1) { "Truncated OTA device info" }
      val type = u8(body[index + 1])
      require(!fields.containsKey(type)) { "Duplicate OTA device info" }
      fields[type] = body.copyOfRange(index + 2, index + 1 + length)
      index += 1 + length
    }
    return fields
  }

  fun fileOffset(body: ByteArray): Slice {
    require(body.size == 6) { "Invalid OTA file offset" }
    return Slice(u32(body, 0), u16(body, 4))
  }

  fun enterResult(body: ByteArray): EnterResult {
    require(body.size == 8 && body[0] == 0.toByte() && u8(body[7]) in 0..1) { "OTA upgrade entry refused" }
    return EnterResult(Slice(u32(body, 1), u16(body, 5)), body[7] == 1.toByte())
  }

  fun blockResult(body: ByteArray): BlockResult {
    require(body.size == 9 && body[0] == 0.toByte()) { "OTA block refused" }
    val delay = u16(body, 7)
    require(delay <= 30000) { "Invalid OTA block delay" }
    return BlockResult(Slice(u32(body, 1), u16(body, 5)), delay)
  }

  fun firmwareSlice(firmware: ByteArray, slice: Slice): ByteArray {
    require(slice.offset >= 0 && slice.offset <= firmware.size.toLong() && slice.length > 0 &&
      slice.length.toLong() <= firmware.size.toLong() - slice.offset) { "OTA slice exceeds firmware" }
    return firmware.copyOfRange(slice.offset.toInt(), slice.offset.toInt() + slice.length)
  }

  /** Each chunk gets its own CRC and sequence; only the final chunk gets a block response. */
  fun blockParts(firmware: ByteArray, slice: Slice, crc: Boolean, writeCapacity: Int): List<ByteArray> {
    val data = firmwareSlice(firmware, slice)
    require(writeCapacity in 20..512) { "Unsupported OTA write capacity" }
    val chunkSize = minOf(496, writeCapacity - 16) - if (crc) 4 else 0
    require(chunkSize > 0) { "OTA write capacity too small for CRC" }
    return (data.indices step chunkSize).map { start ->
      val piece = data.copyOfRange(start, minOf(start + chunkSize, data.size))
      val checksum = if (crc) u32Bytes(CRC32().apply { update(piece) }.value) else byteArrayOf()
      u32Bytes(slice.offset + start) + piece + checksum
    }
  }

  private fun u8(value: Byte) = value.toInt() and 255
  private fun u16(bytes: ByteArray, offset: Int) = (u8(bytes[offset]) shl 8) or u8(bytes[offset + 1])
  private fun u32(bytes: ByteArray, offset: Int): Long = (0..3).fold(0L) { value, index -> (value shl 8) or u8(bytes[offset + index]).toLong() }
  private fun u32Bytes(value: Long) = byteArrayOf((value shr 24).toByte(), (value shr 16).toByte(), (value shr 8).toByte(), value.toByte())
}
