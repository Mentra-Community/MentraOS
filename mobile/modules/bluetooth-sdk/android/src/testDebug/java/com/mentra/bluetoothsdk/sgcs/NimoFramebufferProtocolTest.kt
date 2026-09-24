package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.*
import org.junit.Test

class NimoFramebufferProtocolTest {
  @Test fun hexPreservesEveryByteAndEmptyEvidence() {
    val bytes = ByteArray(256) { it.toByte() }
    assertEquals(bytes.joinToString("") { "%02x".format(it.toInt() and 255) }, NimoFramebufferProtocol.hex(bytes))
    assertEquals("", NimoFramebufferProtocol.hex(byteArrayOf()))
  }
  private val pingRequest = NimoFramebufferProtocol.Request(0x01020304L, 0, 0, 0)
  // Fixed vectors produced independently by the existing Python FBP1 codec.
  private val ping = hex("bf0023008234000002151f0000464250310403020100000000000100000001000008003533376366317031")
  private val page = hex("bf000b0175e500000215070100464250310403020101013a010001000000010000f000") +
    ByteArray(240) { it.toByte() }

  @Test fun requestAndReplyMatchIndependentGoldenVectors() {
    assertArrayEquals(hex("bf001000227a000002150c00464250310403020100000000"),
      NimoFramebufferProtocol.requestFrame(pingRequest))
    val reply = NimoFramebufferProtocol.reply(ping, pingRequest)
    assertArrayEquals("537cf1p1".toByteArray(), reply.data)
    assertEquals(NimoFramebufferProtocol.State(0, 1, 0, 0), reply.before)
    val expectedPage = NimoFramebufferProtocol.Request(0x01020304L, 1, 1, 314)
    assertArrayEquals(ByteArray(240) { it.toByte() }, NimoFramebufferProtocol.reply(page, expectedPage).data)
  }

  @Test fun rejectsCrcLengthsDirectionIndexAndCommand() {
    for (offset in listOf(0, 1, 2, 4, 6, 8, 9, 10)) {
      val invalid = ping.copyOf().also { it[offset] = (it[offset].toInt() xor 1).toByte() }
      rejects { NimoFramebufferProtocol.reply(invalid, pingRequest) }
    }
    rejects { NimoFramebufferProtocol.reply(ping + 0, pingRequest) }
    rejects { NimoFramebufferProtocol.reply(ping.copyOf(ping.size - 1), pingRequest) }
  }

  @Test fun rejectsWrongTagMagicNonceOperationBankAndPage() {
    for (offset in listOf(13, 17, 21, 22, 23, 33, 35)) {
      val invalid = changeAndRecrc(ping, offset, ping[offset].toInt() xor 1)
      rejects { NimoFramebufferProtocol.reply(invalid, pingRequest) }
    }
    rejects { NimoFramebufferProtocol.reply(ping, pingRequest.copy(nonce = 9)) }
    rejects { NimoFramebufferProtocol.reply(ping, pingRequest.copy(op = 1)) }
  }

  @Test fun rejectsStatusErrorsEvenWithValidCorrelation() {
    for (status in listOf(1, 6, 7, 255)) {
      val payload = ping.copyOfRange(12, 35).also { it[0] = status.toByte(); it[21] = 0; it[22] = 0 }
      rejects { NimoFramebufferProtocol.reply(frame(0x15, payload), pingRequest) }
    }
    rejects { NimoFramebufferProtocol.reply(changeAndRecrc(ping, 12, 6), pingRequest) }
  }

  @Test fun rejectsMetadataChangedWithinAndAcrossPagesAndOutOfOrder() {
    val request = NimoFramebufferProtocol.Request(0x01020304L, 1, 1, 0)
    val first = NimoFramebufferProtocol.reply(pageAt(0), request)
    val read = NimoFramebufferProtocol.BankRead(request.nonce, request.bank)
    read.add(first)
    rejects { read.add(first) }
    rejects { NimoFramebufferProtocol.BankRead(request.nonce, request.bank).add(first.copy(page = 1)) }
    rejects { NimoFramebufferProtocol.reply(changeAndRecrc(pageAt(0), 29, 1), request) }
    val changed = first.copy(page = 1, before = first.before.copy(dirty = 1), after = first.after.copy(dirty = 1))
    val changedRead = NimoFramebufferProtocol.BankRead(request.nonce, request.bank)
    changedRead.add(first)
    rejects { changedRead.add(changed) }
  }

  @Test fun bankRequiresEveryPageAndIndependentEqualSecondPass() {
    val first = completeBank(10)
    val second = completeBank(11)
    NimoFramebufferProtocol.verifyPair(first, second)
    assertEquals(75600, first.bytes().size)
    rejects { NimoFramebufferProtocol.verifyPair(first, first) }
    rejects { NimoFramebufferProtocol.verifyPair(first, completeBank(12, changedLastPixel = true)) }
    rejects { NimoFramebufferProtocol.BankRead(20, 1).bytes() }
  }

  @Test fun requestLimitsPreventArbitraryCommandsOrAddresses() {
    for (request in listOf(pingRequest.copy(nonce = -1), pingRequest.copy(nonce = 0x100000000L),
      pingRequest.copy(op = 2), pingRequest.copy(bank = 2), pingRequest.copy(page = 1),
      pingRequest.copy(op = 1, page = 315))) {
      rejects { NimoFramebufferProtocol.requestFrame(request) }
    }
    rejects { NimoFramebufferProtocol.queryFrame(0x0A) }
  }

  @Test fun basicResponsesRequireExactVersionAndReadinessShape() {
    val version = byteArrayOf(0) + NimoFramebufferProtocol.EXPECTED_VERSION.toByteArray()
    assertEquals(NimoFramebufferProtocol.EXPECTED_VERSION,
      NimoFramebufferProtocol.version(frame(0x0B, version)))
    rejects { NimoFramebufferProtocol.version(frame(0x0B, version + 0)) }
    rejects { NimoFramebufferProtocol.version(frame(0x0B, version.copyOf().also { it[0] = 7 })) }
    assertEquals(listOf(0, 0, 1, 0), NimoFramebufferProtocol.readiness(frame(0x19, byteArrayOf(0, 0, 1, 0))))
    rejects { NimoFramebufferProtocol.readiness(frame(0x19, byteArrayOf(0, 1, 1))) }
  }

  private fun completeBank(nonce: Long, changedLastPixel: Boolean = false): NimoFramebufferProtocol.BankRead {
    val read = NimoFramebufferProtocol.BankRead(nonce, 1)
    repeat(315) { index ->
      val original = NimoFramebufferProtocol.reply(pageAt(index),
        NimoFramebufferProtocol.Request(0x01020304L, 1, 1, index))
      val data = original.data.copyOf()
      if (changedLastPixel && index == 314) data[239] = 0
      read.add(original.copy(nonce = nonce, data = data))
    }
    return read
  }

  private fun pageAt(index: Int): ByteArray {
    val result = page.copyOf()
    result[23] = index.toByte(); result[24] = (index shr 8).toByte()
    return recrc(result)
  }
  private fun changeAndRecrc(value: ByteArray, index: Int, byte: Int) =
    recrc(value.copyOf().also { it[index] = byte.toByte() })
  private fun recrc(value: ByteArray): ByteArray {
    val crc = NimoCanvasCodec.crc16(value.copyOfRange(8, value.size))
    value[4] = crc.toByte(); value[5] = (crc shr 8).toByte()
    return value
  }
  private fun frame(key: Int, payload: ByteArray): ByteArray {
    val body = byteArrayOf(2, key.toByte(), payload.size.toByte(), (payload.size shr 8).toByte()) + payload
    return recrc(byteArrayOf(0xBF.toByte(), 0, body.size.toByte(), (body.size shr 8).toByte(), 0, 0, 0, 0) + body)
  }
  private fun rejects(block: () -> Unit) { assertThrows(IllegalArgumentException::class.java, block) }
  private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
