package com.mentra.bluetoothsdk.sgcs

import java.io.ByteArrayOutputStream
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.util.Base64
import java.util.zip.Deflater

/** Pure encoder for the vendor Dynamic Layout V1 contract. No device or Android dependencies. */
internal object NimoCanvasCodec {
  const val WIDTH = 500
  const val HEIGHT = 220
  const val MAX_STREAM = 12288
  const val APP_ID = 0xFD
  const val LINE_HEIGHT = 20
  const val MAX_IMAGE_BASE64_CHARS = 2_800_000

  /** Bound and identify host images before handing them to a platform raster decoder. */
  fun imageBytes(input: String): ByteArray {
    require(input.length <= MAX_IMAGE_BASE64_CHARS) { "Encoded canvas image exceeds limit" }
    val mime = when {
      input.startsWith("data:image/png;base64,") -> "png"
      input.startsWith("data:image/bmp;base64,") -> "bmp"
      input.startsWith("data:image/jpeg;base64,") -> "jpeg"
      input.startsWith("data:") -> error("Unsupported canvas image data URI")
      else -> null
    }
    val encoded = if (mime != null) input.substringAfter(',') else input
    require(encoded.length % 4 == 0) { "Canvas image Base64 must be padded" }
    val data = Base64.getDecoder().decode(encoded)
    require(data.size in 24..2_000_000) { "Canvas image file size exceeds limit" }
    val png = data.take(8) == listOf(0x89.toByte(), 0x50.toByte(), 0x4E.toByte(), 0x47.toByte(), 13.toByte(), 10.toByte(), 26.toByte(), 10.toByte())
    val bmp = data.size >= 54 && data[0] == 0x42.toByte() && data[1] == 0x4D.toByte()
    val jpeg = data.take(3) == listOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte())
    val kind = when { png -> "png"; bmp -> "bmp"; jpeg -> "jpeg"; else -> null }
    require(kind != null && (mime == null || mime == kind)) { "Canvas image must be PNG, BMP or JPEG matching its MIME type" }
    return data
  }

  data class Object(val type: Int, val payload: ByteArray, val textBytes: Int = 0, val pixels: Int = 0)
  data class Element(val type: String, val x: Int, val y: Int, val width: Int, val height: Int,
                     val text: String? = null, val data: String? = null, val border: Int = 0, val radius: Int = 0)

  /** Pure whole-scene mapping; identity/change annotations intentionally do not enter this API. */
  fun scene(elements: List<Element>, decodeImage: (String, Int, Int) -> ByteArray): ByteArray {
    require(elements.size <= 64)
    var pixels = 0L
    for (element in elements) {
      region(element.x, element.y, element.width, element.height)
      require(element.type in listOf("text", "rect", "image"))
      require(element.border in 0..32 && element.radius in 0..255)
      if (element.type == "image") {
        requireNotNull(element.data)
        pixels += element.width.toLong() * element.height
        require(pixels <= 110000) { "Frame images exceed 110000 pixels before image decoding" }
      }
    }
    val objects = mutableListOf<Object>()
    for (element in elements) {
      with(element) {
        when (type) {
          "text" -> {
            if (border > 0) objects.add(rectangle(x, y, width, height, border, radius))
            objects.addAll(textRows(text ?: "", x, y, width, height))
          }
          "rect" -> objects.add(rectangle(x, y, width, height, maxOf(1, border), radius))
          "image" -> objects.add(bitmap(x, y, width, height, decodeImage(data!!, width, height)))
        }
      }
      require(objects.size <= 64)
    }
    return replace(objects)
  }

  fun region(x: Int, y: Int, width: Int, height: Int) {
    require(x in 0 until WIDTH && y in 0 until HEIGHT && width in 1..WIDTH && height in 1..HEIGHT)
    require(x + width <= WIDTH && y + height <= HEIGHT) { "Canvas region exceeds 500x220" }
  }

  fun line(x0: Int, y0: Int, x1: Int, y1: Int, stroke: Int = 1, intensity: Int = 255): Object {
    require(x0 in 0 until WIDTH && x1 in 0 until WIDTH && y0 in 0 until HEIGHT && y1 in 0 until HEIGHT)
    require(stroke in 1..32 && intensity in 0..255)
    return Object(0, words(x0, y0, x1, y1) + bytes(stroke, intensity))
  }

  fun rectangle(x: Int, y: Int, width: Int, height: Int, stroke: Int = 1, radius: Int = 0,
                intensity: Int = 255, filled: Boolean = false): Object {
    region(x, y, width, height)
    require(stroke in 0..32 && radius in 0..255 && intensity in 0..255)
    return Object(1, words(x, y, width, height) + bytes(stroke, radius, intensity, if (filled) 1 else 0))
  }

  fun circle(x: Int, y: Int, radius: Int, stroke: Int = 1, intensity: Int = 255, filled: Boolean = false): Object {
    require(radius in 1..110 && x - radius >= 0 && y - radius >= 0 && x + radius < WIDTH && y + radius < HEIGHT)
    require(stroke in 0..32 && intensity in 0..255)
    return Object(2, words(x, y, radius) + bytes(stroke, intensity, if (filled) 1 else 0))
  }

  fun label(text: String, x: Int, y: Int, width: Int, height: Int, font: Int = 0,
            language: Int = 0, intensity: Int = 255): Object {
    region(x, y, width, height)
    require(font in 0..3 && language in 0..20 && intensity in 0..255)
    require(text.length <= 2048 && '\u0000' !in text)
    val encoder = Charsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
    val encoded = encoder.encode(CharBuffer.wrap(text))
    val utf8 = ByteArray(encoded.remaining()).also { encoded.get(it) }
    require(utf8.size in 1..2048) { "Label exceeds 2048 UTF-8 bytes" }
    return Object(3, words(x, y, width, height, language) + bytes(font, intensity) + words(utf8.size) + utf8,
      textBytes = utf8.size)
  }

  /** Host-prewrapped rows retain their y positions, including empty rows. */
  fun textRows(text: String, x: Int, y: Int, width: Int, height: Int): List<Object> {
    region(x, y, width, height)
    require(text.length <= 8192 && '\u0000' !in text)
    if (!text.contains('\n')) return if (text.isEmpty()) emptyList()
      else listOf(label(text, x, y, width, minOf(LINE_HEIGHT, height)))
    val rows = text.split('\n')
    require(rows.size <= 64)
    return rows.mapIndexedNotNull { index, row ->
      val offset = index * LINE_HEIGHT
      if (offset >= height || row.isEmpty()) null
      else label(row, x, y + offset, width, minOf(LINE_HEIGHT, height - offset))
    }
  }

  /** 00=white, 11=black. Padding is black and packing continues across row boundaries. */
  fun pack2(gray: ByteArray): ByteArray {
    require(gray.size in 1..110000)
    val out = ByteArray((gray.size + 3) / 4) { 0xFF.toByte() }
    for (i in gray.indices) {
      val shift = 6 - 2 * (i % 4)
      val code = ((255 - (gray[i].toInt() and 255) + 42) / 85).coerceIn(0, 3)
      out[i / 4] = ((out[i / 4].toInt() and (3 shl shift).inv()) or (code shl shift)).toByte()
    }
    return out
  }

  fun rle(data: ByteArray): ByteArray {
    require(data.size <= 110000)
    val out = ByteArrayOutputStream()
    var i = 0
    fun run(start: Int): Int {
      var n = 1
      while (start + n < data.size && n < 127 && data[start + n] == data[start]) n++
      return n
    }
    while (i < data.size) {
      val count = run(i)
      if (count >= 3) {
        out.write(count); out.write(data[i].toInt() and 255); i += count
      } else {
        val start = i
        i += count
        while (i < data.size && i - start < 127) {
          val next = run(i)
          if (next >= 3) break
          i += minOf(next, 127 - (i - start))
        }
        out.write(0x80 or (i - start)); out.write(data, start, i - start)
      }
    }
    return out.toByteArray()
  }

  fun bitmap(x: Int, y: Int, width: Int, height: Int, gray: ByteArray): Object {
    region(x, y, width, height)
    require(gray.size == width * height)
    val packed = pack2(gray)
    val rle = rle(packed)
    val zlib = zlib(packed)
    val compression = if (rle.size <= zlib.size) 3 else 7
    val body = if (compression == 3) rle else zlib
    val packet = bytes(0) + words(width, height) + bytes(2, compression) + dword(packed.size) + dword(body.size) + body
    require(packet.size <= 65535)
    return Object(4, words(x, y, width, height, 0, 1, packet.size) + packet, pixels = gray.size)
  }

  fun replace(objects: List<Object>): ByteArray {
    require(objects.size <= 64) { "More than 64 canvas objects" }
    require(objects.sumOf { it.textBytes.toLong() } <= 8192) { "Frame text exceeds 8192 bytes" }
    require(objects.sumOf { it.pixels.toLong() } <= 110000) { "Frame images exceed 110000 pixels" }
    val size = 3L + objects.sumOf { 3L + it.payload.size }
    require(size <= MAX_STREAM - 8) { "Canvas frame exceeds Companion reassembly budget" }
    val out = ByteArrayOutputStream(size.toInt())
    out.write(words(objects.size)); out.write(1)
    objects.forEach { require(it.type in 0..4); out.write(it.type); out.write(words(it.payload.size)); out.write(it.payload) }
    return out.toByteArray()
  }

  /** [content] is a V1 frame for Update, absent for Launch and Exit. */
  fun frames(key: Int, content: ByteArray = ByteArray(0), writeCapacity: Int): List<ByteArray> {
    require(writeCapacity in 20..512)
    val payload = when (key) {
      1 -> bytes(APP_ID, 0)
      3 -> bytes(APP_ID)
      4 -> bytes(APP_ID, 0, 0, 0) + content
      else -> error("Unsupported canvas command")
    }
    val stream = bytes(7, key) + words(payload.size) + payload
    require(stream.size <= MAX_STREAM)
    val chunkSize = writeCapacity - 8
    val chunks = (stream.size + chunkSize - 1) / chunkSize
    return (0 until chunks).map { index ->
      val data = stream.copyOfRange(index * chunkSize, minOf(stream.size, (index + 1) * chunkSize))
      bytes(0xBF, 0) + words(data.size, crc16(data), if (index == chunks - 1) 0 else index + 1) + data
    }
  }

  /** Canvas ACKs are unfragmented and use the normal payload length INCLUDING status. */
  fun response(packet: ByteArray): Pair<Int, ByteArray>? {
    if (packet.size < 13 || packet[0].toInt() and 255 != 0xBF || packet[1].toInt() != 0) return null
    fun word(i: Int) = (packet[i].toInt() and 255) or ((packet[i + 1].toInt() and 255) shl 8)
    if (word(2) != packet.size - 8 || word(6) != 0 || packet[8].toInt() != 7) return null
    if (word(4) != crc16(packet.copyOfRange(8, packet.size)) || word(10) != packet.size - 12) return null
    val key = packet[9].toInt() and 255
    if (key !in listOf(1, 3, 4)) return null
    return key to packet.copyOfRange(12, packet.size)
  }

  fun crc16(data: ByteArray): Int {
    var crc = 0xFFFF
    for (byte in data) {
      crc = crc xor ((byte.toInt() and 255) shl 8)
      repeat(8) { crc = (if (crc and 0x8000 != 0) (crc shl 1) xor 0x1021 else crc shl 1) and 0xFFFF }
    }
    return crc
  }

  private fun zlib(data: ByteArray): ByteArray {
    val deflater = Deflater(6)
    return try {
      deflater.setInput(data); deflater.finish()
      val out = ByteArrayOutputStream(); val chunk = ByteArray(4096)
      while (!deflater.finished()) { val n = deflater.deflate(chunk); check(n > 0); out.write(chunk, 0, n) }
      out.toByteArray()
    } finally { deflater.end() }
  }
  private fun bytes(vararg values: Int) = values.map { it.toByte() }.toByteArray()
  private fun words(vararg values: Int): ByteArray = values.flatMap {
    require(it in 0..65535); listOf(it.toByte(), (it shr 8).toByte())
  }.toByteArray()
  private fun dword(value: Int) = bytes(value, value shr 8, value shr 16, value shr 24)
}
