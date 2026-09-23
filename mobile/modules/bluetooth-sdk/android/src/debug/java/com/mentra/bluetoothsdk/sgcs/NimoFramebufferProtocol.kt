package com.mentra.bluetoothsdk.sgcs

/** Private FBP1 protocol for one pinned diagnostic build, never a general memory reader. */
internal object NimoFramebufferProtocol {
  const val EXPECTED_VERSION = "FW-VERSION-v0.1.1.1-20260827164351-537cf1-dirty-Debug"
  const val ARTIFACT_SHA256 = "4de441f887e85b1f8194881695b96c16e8018fbdc19d4edc9f5b5d4210e5aa83"
  const val WIDTH = 540
  const val HEIGHT = 280
  const val PAGE_BYTES = 240
  const val PAGE_COUNT = 315
  const val BANK_BYTES = PAGE_BYTES * PAGE_COUNT
  private val MAGIC = "FBP1".toByteArray(Charsets.US_ASCII)
  private val BUILD_TAG = "537cf1p1".toByteArray(Charsets.US_ASCII)

  data class Request(val nonce: Long, val op: Int, val bank: Int, val page: Int)
  data class State(val draw: Int, val prepared: Int, val dirty: Int, val pending: Int)
  data class Reply(val nonce: Long, val op: Int, val bank: Int, val page: Int,
    val before: State, val after: State, val data: ByteArray)

  fun hex(bytes: ByteArray): String {
    val digits = "0123456789abcdef"
    val chars = CharArray(bytes.size * 2)
    bytes.forEachIndexed { index, byte ->
      val value = byte.toInt() and 255
      chars[index * 2] = digits[value ushr 4]
      chars[index * 2 + 1] = digits[value and 15]
    }
    return chars.concatToString()
  }

  fun queryFrame(key: Int): ByteArray {
    require(key == 0x0B || key == 0x19) { "Only version and readiness queries are permitted" }
    return frame(key, byteArrayOf())
  }

  fun requestFrame(request: Request): ByteArray {
    validate(request)
    val nonce = ByteArray(4) { (request.nonce shr (8 * it)).toByte() }
    return frame(0x15, MAGIC + nonce + byteArrayOf(request.op.toByte(), request.bank.toByte(),
      request.page.toByte(), (request.page shr 8).toByte()))
  }

  fun version(packet: ByteArray): String {
    val payload = basicPayload(packet, 0x0B)
    require(payload.isNotEmpty() && payload[0] == 0.toByte()) { "Version query rejected" }
    val expected = EXPECTED_VERSION.toByteArray(Charsets.US_ASCII)
    require(payload.copyOfRange(1, payload.size).contentEquals(expected)) { "Unexpected firmware identity" }
    return EXPECTED_VERSION
  }

  /** Preserve status and all three readiness fields, including a not-ready result. */
  fun readiness(packet: ByteArray): List<Int> {
    val payload = basicPayload(packet, 0x19)
    require(payload.size == 4) { "Readiness response must contain status, ready, TWS, and peer GATT" }
    return payload.map { it.toInt() and 255 }
  }

  fun basicPayload(packet: ByteArray, key: Int): ByteArray {
    require(key == 0x0B || key == 0x19) { "Unexpected basic query" }
    return payload(packet, key, 128)
  }

  fun reply(packet: ByteArray, expected: Request): Reply {
    validate(expected)
    val body = payload(packet, 0x15, 23 + PAGE_BYTES)
    require(body.size >= 23) { "Short FBP1 response" }
    require(body.copyOfRange(1, 5).contentEquals(MAGIC)) { "FBP1 response magic mismatch" }
    require(word(body, 21) == body.size - 23) { "FBP1 data length mismatch" }
    val status = unsigned(body, 0)
    require(status in listOf(0, 6, 7)) { "Unknown FBP1 response status $status" }
    if (status != 0) {
      require(body.size == 23) { "Rejected FBP1 response contains data" }
      throw IllegalArgumentException("FBP1 request rejected with status $status")
    }
    val nonce = (0..3).fold(0L) { value, i -> value or (unsigned(body, 5 + i).toLong() shl (8 * i)) }
    val actual = Request(nonce, unsigned(body, 9), unsigned(body, 10), word(body, 11))
    require(actual == expected) { "FBP1 response correlation mismatch" }
    val before = state(body, 13)
    val after = state(body, 17)
    require(before == after) { "Framebuffer metadata changed during page copy" }
    val data = body.copyOfRange(23, body.size)
    if (actual.op == 0) require(data.contentEquals(BUILD_TAG)) { "Unexpected FBP1 build tag" }
    else require(data.size == PAGE_BYTES) { "Framebuffer page must contain $PAGE_BYTES bytes" }
    return Reply(nonce, actual.op, actual.bank, actual.page, before, after, data)
  }

  /** Sequential, single-pass assembler. Any rejected input permanently invalidates the read. */
  class BankRead(val nonce: Long, val bank: Int) {
    var pageCount = 0
      private set
    var metadata: State? = null
      private set
    private var failed = false
    private val data = ByteArray(BANK_BYTES)

    init { validate(Request(nonce, 1, bank, 0)) }

    fun add(reply: Reply) {
      require(!failed) { "Bank read was invalidated" }
      try {
        require(pageCount < PAGE_COUNT && reply.page == pageCount) { "Duplicate or out-of-order framebuffer page" }
        require(reply.nonce == nonce && reply.bank == bank && reply.op == 1) { "Bank read correlation mismatch" }
        require(reply.data.size == PAGE_BYTES) { "Invalid framebuffer page length" }
        require(reply.before == reply.after) { "Metadata changed during page copy" }
        require(metadata == null || metadata == reply.before) { "Metadata changed between pages" }
        metadata = reply.before
        reply.data.copyInto(data, pageCount * PAGE_BYTES)
        pageCount += 1
      } catch (error: IllegalArgumentException) {
        failed = true
        throw error
      }
    }

    fun bytes(): ByteArray {
      require(!failed && pageCount == PAGE_COUNT) { "Framebuffer bank is incomplete or invalidated" }
      return data.copyOf()
    }
  }

  fun verifyPair(first: BankRead, second: BankRead) {
    require(first.nonce != second.nonce) { "Static verification requires independent nonces" }
    require(first.bank == second.bank && first.metadata == second.metadata) { "Static pair metadata mismatch" }
    require(first.bytes().contentEquals(second.bytes())) { "Framebuffer pixels changed between passes" }
  }

  private fun validate(request: Request) {
    require(request.nonce in 0..0xFFFFFFFFL && request.op in 0..1 && request.bank in 0..1 &&
      request.page in 0 until PAGE_COUNT && (request.op != 0 || request.page == 0)) { "Invalid FBP1 request" }
  }

  private fun state(body: ByteArray, offset: Int): State {
    val state = State(unsigned(body, offset), unsigned(body, offset + 1), unsigned(body, offset + 2), unsigned(body, offset + 3))
    require(state.draw in 0..1 && state.prepared in 0..1) { "Invalid framebuffer selectors" }
    return state
  }

  private fun payload(packet: ByteArray, key: Int, maximum: Int): ByteArray {
    require(packet.size in 12..(12 + maximum)) { "Invalid frame size" }
    require(unsigned(packet, 0) == 0xBF && packet[1] == 0.toByte()) { "Expected BF00 frame" }
    require(word(packet, 6) == 0) { "Fragmented framebuffer responses are not supported" }
    require(word(packet, 2) == packet.size - 8 && word(packet, 10) == packet.size - 12) { "Frame length mismatch" }
    require(unsigned(packet, 8) == 2 && unsigned(packet, 9) == key) { "Frame command mismatch" }
    require(word(packet, 4) == NimoCanvasCodec.crc16(packet.copyOfRange(8, packet.size))) { "Frame CRC mismatch" }
    return packet.copyOfRange(12, packet.size)
  }

  private fun frame(key: Int, payload: ByteArray): ByteArray {
    val body = byteArrayOf(2, key.toByte(), payload.size.toByte(), (payload.size shr 8).toByte()) + payload
    val crc = NimoCanvasCodec.crc16(body)
    return byteArrayOf(0xBF.toByte(), 0, body.size.toByte(), (body.size shr 8).toByte(),
      crc.toByte(), (crc shr 8).toByte(), 0, 0) + body
  }
  private fun unsigned(bytes: ByteArray, index: Int) = bytes[index].toInt() and 255
  private fun word(bytes: ByteArray, index: Int) = unsigned(bytes, index) or (unsigned(bytes, index + 1) shl 8)
}
