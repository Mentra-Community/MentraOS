package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.*
import org.junit.Test

class NimoCanvasCodecTest {
  @Test fun imageSourcesAcceptRawAndMatchingDataUris() {
    // ImageIO/BitmapFactory validate the complete raster; this boundary validates file kind and size.
    val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 13, 10, 26, 10) + ByteArray(24)
    val bmp = byteArrayOf(0x42, 0x4D) + ByteArray(56)
    val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte()) + ByteArray(24)
    for ((mime, bytes) in listOf("png" to png, "bmp" to bmp, "jpeg" to jpeg)) {
      val raw = java.util.Base64.getEncoder().encodeToString(bytes)
      assertArrayEquals(bytes, NimoCanvasCodec.imageBytes(raw))
      assertArrayEquals(bytes, NimoCanvasCodec.imageBytes("data:image/$mime;base64,$raw"))
      val wrongMime = if (mime == "png") "bmp" else "png"
      assertThrows(IllegalArgumentException::class.java) {
        NimoCanvasCodec.imageBytes("data:image/$wrongMime;base64,$raw")
      }
    }
  }

  @Test fun unsupportedAndOversizedImageSourcesFailBeforeRasterDecoding() {
    val encoder = java.util.Base64.getEncoder()
    assertThrows(IllegalStateException::class.java) { NimoCanvasCodec.imageBytes("data:image/gif;base64,AAAA") }
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.imageBytes(encoder.encodeToString(ByteArray(54))) }
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.imageBytes("a".repeat(2_800_001)) }
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.imageBytes(encoder.encodeToString(ByteArray(2_000_001))) }
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.imageBytes("not valid base64!") }
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.imageBytes("Qk0") }
  }

  @Test fun guideGoldenPacket() {
    val frame = NimoCanvasCodec.replace(listOf(
      NimoCanvasCodec.rectangle(20, 20, 120, 50, 2, 8),
      NimoCanvasCodec.label("Hello Glass", 160, 30, 300, 40, font = 2)
    ))
    val actual = NimoCanvasCodec.frames(4, frame, 512).single()
    val expected = "BF003600F72D000007043200FD000000020001010C0014001400780032000208FF00031900A0001E002C012800000002FF0B0048656C6C6F20476C617373"
    assertEquals(expected, actual.joinToString("") { "%02X".format(it.toInt() and 255) })
  }

  @Test fun fourTonePolarityAndOddPadding() {
    assertArrayEquals(byteArrayOf(0xE4.toByte(), 0x3F),
      NimoCanvasCodec.pack2(byteArrayOf(0, 85, 170.toByte(), 255.toByte(), 255.toByte())))
  }

  @Test fun launchAndExitGoldenPackets() {
    fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02X".format(it.toInt() and 255) }
    assertEquals("BF000600F5E4000007010200FD00", hex(NimoCanvasCodec.frames(1, writeCapacity = 512).single()))
    assertEquals("BF00050086E4000007030100FD", hex(NimoCanvasCodec.frames(3, writeCapacity = 512).single()))
  }

  @Test fun primitivesValidateGeometryAndUseCompactCircle() {
    assertEquals(10, NimoCanvasCodec.line(0, 0, 499, 219).payload.size)
    assertEquals(12, NimoCanvasCodec.rectangle(0, 0, 500, 220).payload.size)
    assertEquals(9, NimoCanvasCodec.circle(10, 10, 10).payload.size)
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.line(0, 0, 500, 219) }
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.rectangle(Int.MAX_VALUE, 0, 10, 1) }
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.rectangle(0, 0, 501, 220) }
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.circle(0, 10, 10) }
  }

  @Test fun labelUtf8LengthAndErrors() {
    val label = NimoCanvasCodec.label("😀é", 0, 0, 100, 20)
    assertEquals(6, label.textBytes)
    assertEquals(6, label.payload[12].toInt())
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.label("a\u0000b", 0, 0, 100, 20) }
    assertThrows(java.nio.charset.CharacterCodingException::class.java) { NimoCanvasCodec.label("\uD800", 0, 0, 100, 20) }
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.label("é".repeat(1025), 0, 0, 100, 20) }
    assertEquals(2048, NimoCanvasCodec.label("é".repeat(1024), 0, 0, 100, 20).textBytes)
  }

  @Test fun totalBudgetsAndClear() {
    assertArrayEquals(byteArrayOf(0, 0, 1), NimoCanvasCodec.replace(emptyList()))
    val line = NimoCanvasCodec.line(0, 0, 1, 1)
    NimoCanvasCodec.replace(List(64) { line })
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.replace(List(65) { line }) }
    val text = NimoCanvasCodec.label("a".repeat(2048), 0, 0, 500, 220)
    NimoCanvasCodec.replace(List(4) { text })
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.replace(List(5) { text }) }
    val image = NimoCanvasCodec.bitmap(0, 0, 500, 220, ByteArray(110000))
    NimoCanvasCodec.replace(listOf(image))
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.replace(listOf(image, image)) }
    assertThrows(IllegalArgumentException::class.java) {
      NimoCanvasCodec.replace(listOf(NimoCanvasCodec.Object(4, ByteArray(12278))))
    }
  }

  @Test fun hostFrameReservationBoundsNativeEncoding() {
    val random = java.util.Random(42)
    for (size in listOf(1, 5, 80, 160, 200)) {
      val gray = ByteArray(size * size).also { random.nextBytes(it) }
      val image = NimoCanvasCodec.bitmap(0, 0, size, size, gray)
      val packed = (gray.size + 3) / 4
      val reserved = 32 + packed + (packed + 126) / 127
      assertTrue(3 + image.payload.size <= reserved)
    }
    // These are the retained prefixes of the host's over-budget regression scenes.
    val rows = NimoCanvasCodec.textRows(List(11) { "row" }.joinToString("\n"), 0, 0, 500, 220)
    assertTrue(NimoCanvasCodec.replace(List(5) { rows }.flatten()).size <= 12280)
    val images = listOf(200, 80).map { size ->
      NimoCanvasCodec.bitmap(0, 0, size, size, ByteArray(size * size).also { random.nextBytes(it) })
    }
    assertTrue(NimoCanvasCodec.replace(images).size <= 12280)
  }

  @Test fun explicitNewlinesRetainRowsWithoutRewrapping() {
    val rows = NimoCanvasCodec.textRows("first\n\nthird", 12, 15, 400, 100)
    assertEquals(2, rows.size)
    assertEquals(15, rows[0].payload[2].toInt())
    assertEquals(55, rows[1].payload[2].toInt())
    assertEquals(20, rows[1].payload[6].toInt())
    val single = NimoCanvasCodec.textRows("single", 12, 15, 400, 100).single()
    assertEquals(20, single.payload[6].toInt())
  }

  @Test fun rleBoundaryAndLiteralRoundtrip() {
    fun decode(data: ByteArray): ByteArray {
      val out = java.io.ByteArrayOutputStream(); var i = 0
      while (i < data.size) {
        val tag = data[i++].toInt() and 255
        val count = tag and 127
        assertTrue(count > 0)
        if (tag and 128 != 0) { out.write(data, i, count); i += count }
        else { repeat(count) { out.write(data[i].toInt() and 255) }; i++ }
      }
      return out.toByteArray()
    }
    for (size in listOf(1, 2, 3, 126, 127, 128, 254, 27500)) {
      for (input in listOf(ByteArray(size) { 33 }, ByteArray(size) { (it % 251).toByte() })) {
        assertArrayEquals(input, decode(NimoCanvasCodec.rle(input)))
      }
    }
    assertArrayEquals(byteArrayOf(3, 1, 0x82.toByte(), 2, 3), NimoCanvasCodec.rle(byteArrayOf(1, 1, 1, 2, 3)))
  }

  @Test fun bitmapIsCompleteCompressed2BppAndUsesExactOddSize() {
    val bitmap = NimoCanvasCodec.bitmap(0, 0, 5, 1, byteArrayOf(0, 85, 170.toByte(), 255.toByte(), 255.toByte()))
    assertEquals(1, bitmap.payload[10].toInt()) // total_chunks
    assertEquals(2, bitmap.payload[19].toInt()) // image bpp
    assertEquals(3, bitmap.payload[20].toInt()) // RLE is smallest here
    assertEquals(2, bitmap.payload[21].toInt()) // original_size ceil(5/4)
    assertArrayEquals(byteArrayOf(0x82.toByte(), 0xE4.toByte(), 0x3F), bitmap.payload.copyOfRange(29, bitmap.payload.size))
  }

  @Test fun fragmentationAtNegotiatedCapacityReassemblesWholeAppStream() {
    val content = NimoCanvasCodec.replace(listOf(NimoCanvasCodec.label("X".repeat(2048), 0, 0, 500, 220)))
    val baseline = NimoCanvasCodec.frames(4, content, 512).flatMap { it.drop(8) }.toByteArray()
    for (capacity in listOf(20, 64, 185, 244, 512)) {
      val frames = NimoCanvasCodec.frames(4, content, capacity)
      frames.forEachIndexed { index, packet ->
        assertTrue(packet.size <= capacity)
        assertEquals(0, packet[1].toInt())
        val expectedIndex = if (index == frames.lastIndex) 0 else index + 1
        assertEquals(expectedIndex, (packet[6].toInt() and 255) or ((packet[7].toInt() and 255) shl 8))
        assertEquals(NimoCanvasCodec.crc16(packet.copyOfRange(8, packet.size)),
          (packet[4].toInt() and 255) or ((packet[5].toInt() and 255) shl 8))
      }
      assertArrayEquals(baseline, frames.flatMap { it.drop(8) }.toByteArray())
    }
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.frames(4, content, 19) }
    assertThrows(IllegalArgumentException::class.java) { NimoCanvasCodec.frames(4, ByteArray(12281), 512) }
  }

  @Test fun strictResponseParserAcceptsStatusOnlyErrors() {
    fun packet(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    val good = packet("BF000900D87900000704050000FD000000")
    assertArrayEquals(byteArrayOf(0, 0xFD.toByte(), 0, 0, 0), NimoCanvasCodec.response(good)!!.second)
    assertNull(NimoCanvasCodec.response(good + 0))
    assertNull(NimoCanvasCodec.response(good.copyOf().also { it[10] = 4 }))
    assertNull(NimoCanvasCodec.response(good.copyOf().also { it[1] = 2 }))
    val body = byteArrayOf(7, 4, 1, 0, 7)
    val crc = NimoCanvasCodec.crc16(body)
    val statusOnly = byteArrayOf(0xBF.toByte(), 0, 5, 0, crc.toByte(), (crc shr 8).toByte(), 0, 0) + body
    assertArrayEquals(byteArrayOf(7), NimoCanvasCodec.response(statusOnly)!!.second)
  }

  @Test fun sceneCompilerKeepsGeometryOrderAndBorderBeforeText() {
    val text = NimoCanvasCodec.Element("text", 10, 20, 100, 40, "hello", border = 2, radius = 3)
    val rectangle = NimoCanvasCodec.Element("rect", 100, 100, 50, 20)
    val actual = NimoCanvasCodec.scene(listOf(text, rectangle)) { _, _, _ -> error("Not an image") }
    val expected = NimoCanvasCodec.replace(listOf(
      NimoCanvasCodec.rectangle(10, 20, 100, 40, 2, 3),
      NimoCanvasCodec.label("hello", 10, 20, 100, 20),
      NimoCanvasCodec.rectangle(100, 100, 50, 20, 1, 0)
    ))
    assertArrayEquals(expected, actual)
    assertFalse(actual.contentEquals(NimoCanvasCodec.scene(listOf(rectangle, text)) { _, _, _ -> error("Not an image") }))
    assertFalse(actual.contentEquals(NimoCanvasCodec.scene(listOf(text.copy(x = 11), rectangle)) { _, _, _ -> error("Not an image") }))
  }

  @Test fun scenePreflightsInvalidImageBudgetBeforeDecodingAnyPng() {
    val image = NimoCanvasCodec.Element("image", 0, 0, 500, 220, data = "unused")
    var decoded = 0
    assertThrows(IllegalArgumentException::class.java) {
      NimoCanvasCodec.scene(listOf(image, image)) { _, _, _ -> decoded++; ByteArray(110000) }
    }
    assertEquals(0, decoded)
    assertThrows(IllegalArgumentException::class.java) {
      NimoCanvasCodec.scene(listOf(image.copy(type = "html"))) { _, _, _ -> decoded++; ByteArray(110000) }
    }
    assertEquals(0, decoded)
  }

  @Test fun zlibCompressesDenseRepeatingImagesAndInflatesToPackedPixels() {
    val gray = ByteArray(32768) { (((it / 17) xor (it / 43)) % 4 * 85).toByte() }
    val bitmap = NimoCanvasCodec.bitmap(0, 0, 256, 128, gray)
    assertEquals(7, bitmap.payload[20].toInt())
    val inflater = java.util.zip.Inflater()
    try {
      inflater.setInput(bitmap.payload.copyOfRange(29, bitmap.payload.size))
      val output = ByteArray((gray.size + 3) / 4)
      assertEquals(output.size, inflater.inflate(output))
      assertTrue(inflater.finished())
      assertArrayEquals(NimoCanvasCodec.pack2(gray), output)
    } finally { inflater.end() }
    NimoCanvasCodec.replace(listOf(bitmap))
  }
}
