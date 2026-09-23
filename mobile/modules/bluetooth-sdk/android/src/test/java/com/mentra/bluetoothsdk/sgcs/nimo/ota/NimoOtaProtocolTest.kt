package com.mentra.bluetoothsdk.sgcs.nimo.ota

import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NimoOtaProtocolTest {
  private val fixtures = JSONObject(File("../test-fixtures/nimo-ota.json").readText())
  private fun bytes(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

  @Test fun capturedRequestsAndResponsesMatchIncludingResetWithoutBusinessByte() {
    val requests = fixtures.getJSONArray("requests")
    for (index in 0 until requests.length()) {
      val item = requests.getJSONObject(index)
      assertArrayEquals(bytes(item.getString("frame")), NimoOtaProtocol.request(item.getInt("command"), item.getInt("sequence"), bytes(item.getString("params"))))
    }
    val responses = fixtures.getJSONArray("responses")
    var combined = byteArrayOf()
    for (index in 0 until responses.length()) {
      val item = responses.getJSONObject(index)
      val frame = bytes(item.getString("frame"))
      combined += frame
      // Every possible split must produce exactly one identical response.
      for (split in 0..frame.size) {
        val decoder = NimoOtaProtocol.Decoder()
        val actual = (decoder.feed(frame.copyOfRange(0, split)) + decoder.feed(frame.copyOfRange(split, frame.size))).single()
        assertEquals(item.getInt("command"), actual.command)
        assertEquals(item.getInt("sequence"), actual.sequence)
        assertEquals(item.getInt("status"), actual.status)
        assertArrayEquals(bytes(item.getString("body")), actual.body)
      }
    }
    assertEquals(responses.length(), NimoOtaProtocol.Decoder().feed(combined).size)
  }

  @Test fun smallPhoneWritesUsePerChunkCrcAndPreserveRequestedOffset() {
    val firmware = bytes(fixtures.getString("firmware"))
    val blocks = fixtures.getJSONArray("blocks")
    for (index in 0 until blocks.length()) {
      val item = blocks.getJSONObject(index)
      val parts = NimoOtaProtocol.blockParts(firmware, NimoOtaProtocol.Slice(item.getLong("offset"), item.getInt("length")), item.getBoolean("crc"), item.getInt("capacity"))
      val expected = item.getJSONArray("parts")
      assertEquals(expected.length(), parts.size)
      parts.forEachIndexed { i, part ->
        assertArrayEquals(bytes(expected.getString(i)), part)
        assertTrue(NimoOtaProtocol.request(0xE5, i, part).size <= item.getInt("capacity"))
      }
    }
  }

  @Test fun rejectsMalformedDeviceDataAndOutOfBoundsRequests() {
    for (hex in listOf("71", "70076ec0", "70076e00020001", "70076e00021001", "70076e0003000200fa00")) {
      assertThrows(IllegalArgumentException::class.java) { NimoOtaProtocol.Decoder().feed(bytes(hex)) }
    }
    for (hex in listOf("00", "0201", "01000100")) {
      assertThrows(IllegalArgumentException::class.java) { NimoOtaProtocol.deviceInfo(bytes(hex)) }
    }
    for (slice in listOf(NimoOtaProtocol.Slice(-1, 1), NimoOtaProtocol.Slice(100, 1), NimoOtaProtocol.Slice(0, 0), NimoOtaProtocol.Slice(Long.MAX_VALUE, 1))) {
      assertThrows(IllegalArgumentException::class.java) { NimoOtaProtocol.firmwareSlice(ByteArray(100), slice) }
    }
    assertThrows(IllegalArgumentException::class.java) { NimoOtaProtocol.blockParts(ByteArray(100), NimoOtaProtocol.Slice(0, 100), true, 20) }
    assertThrows(IllegalArgumentException::class.java) { NimoOtaProtocol.enterResult(bytes("0100000012100001")) }
    assertThrows(IllegalArgumentException::class.java) { NimoOtaProtocol.blockResult(bytes("000000000000007531")) }
  }

  @Test fun interpretsCapturedPreflightAndBlockRequests() {
    val info = NimoOtaProtocol.deviceInfo(bytes("0600000e000e0205010000020103026464020301020400020501"))
    assertArrayEquals(bytes("00000201"), info[1])
    assertArrayEquals(bytes("6464"), info[2])
    val entered = NimoOtaProtocol.enterResult(bytes("0000000012100001"))
    assertEquals(NimoOtaProtocol.Slice(18, 4096), entered.slice)
    assertTrue(entered.crc)
    assertEquals(NimoOtaProtocol.Slice(4114, 4096), NimoOtaProtocol.blockResult(bytes("000000101210000000")).slice)
    assertEquals(NimoOtaProtocol.Slice(0, 0), NimoOtaProtocol.blockResult(ByteArray(9)).slice)
  }
}
