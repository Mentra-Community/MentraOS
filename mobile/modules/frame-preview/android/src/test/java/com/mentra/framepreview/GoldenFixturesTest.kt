package com.mentra.framepreview

import java.io.File
import org.assertj.core.api.Assertions.assertThat
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test

/**
 * The shared MFPV fixtures under `mobile/modules/frame-preview/fixtures/`, asserted exactly as the
 * Swift and TypeScript suites assert them. A drift in any language fails the same named file.
 */
class GoldenFixturesTest {
  private val dir = File(
    System.getProperty("framePreview.fixturesDir")
      ?: error("framePreview.fixturesDir is not set; run through Gradle"),
  )

  private val manifest: List<JSONObject> by lazy {
    val array = JSONArray(File(dir, "manifest.json").readText())
    (0 until array.length()).map { array.getJSONObject(it) }
  }

  @Test
  fun `manifest covers every parser reason and both pixel formats`() {
    val expects = manifest.map { it.getString("expect") }.toSet()
    assertThat(expects).containsAll(PreviewFrameParser.Reason.entries.map { it.wire } + "ok")
    val valid = manifest.filter { it.getString("expect") == "ok" }
    assertThat(valid.map { it.getString("format") }.toSet()).containsExactlyInAnyOrder("i420", "nv12")
    assertThat(valid.map { it.getInt("rotation") }.toSet()).containsExactlyInAnyOrder(0, 1, 2, 3)
    assertThat(valid.map { it.getString("matrix") }.toSet()).containsExactlyInAnyOrder("unknown", "bt601", "bt709")
    assertThat(valid.map { it.getString("range") }.toSet()).containsExactlyInAnyOrder("unknown", "limited", "full")
  }

  @Test
  fun `every fixture parses to its manifest expectation`() {
    for (entry in manifest) {
      val name = entry.getString("file")
      val bytes = File(dir, name).readBytes()
      when (val result = PreviewFrameParser.parse(bytes)) {
        is PreviewFrameParser.Result.Rejected ->
          assertThat(result.reason.wire).describedAs(name).isEqualTo(entry.getString("expect"))
        is PreviewFrameParser.Result.Ok -> {
          assertThat("ok").describedAs(name).isEqualTo(entry.getString("expect"))
          assertFields(name, entry, result.frame, bytes)
        }
      }
    }
  }

  @Test
  fun `the Kotlin writer produces each valid fixture's header byte for byte`() {
    for (entry in manifest.filter { it.getString("expect") == "ok" }) {
      val name = entry.getString("file")
      val expected = File(dir, name).readBytes().copyOf(PreviewFrameHeader.BYTE_COUNT)
      val written = ByteArray(PreviewFrameHeader.BYTE_COUNT)
      PreviewFrameHeader(
        payloadLength = entry.getInt("payloadLength"),
        sessionGeneration = entry.getLong("generation").toInt(),
        frameSequence = entry.getLong("sequence").toInt(),
        width = entry.getInt("width"),
        height = entry.getInt("height"),
        pixelFormat = if (entry.getString("format") == "nv12") PreviewPixelFormat.NV12 else PreviewPixelFormat.I420,
        rotation = entry.getInt("rotation"),
        colorMatrix = PreviewColorMatrix.entries.first { it.code == matrixCode(entry.getString("matrix")) },
        colorRange = PreviewColorRange.entries.first { it.code == rangeCode(entry.getString("range")) },
        flags = entry.getInt("flags"),
        timestampNs = entry.getString("timestampNs").toLong(),
        sentAtNs = entry.getString("sentAtNs").toLong(),
      ).writeInto(written)
      assertThat(written).describedAs(name).isEqualTo(expected)
    }
  }

  private fun assertFields(name: String, entry: JSONObject, frame: PreviewFrameParser.Frame, bytes: ByteArray) {
    assertThat(frame.width).describedAs("$name width").isEqualTo(entry.getInt("width"))
    assertThat(frame.height).describedAs("$name height").isEqualTo(entry.getInt("height"))
    assertThat(frame.pixelFormat.name.lowercase()).describedAs("$name format").isEqualTo(entry.getString("format"))
    assertThat(frame.rotation).describedAs("$name rotation").isEqualTo(entry.getInt("rotation"))
    assertThat(frame.colorMatrixCode).describedAs("$name matrix").isEqualTo(matrixCode(entry.getString("matrix")))
    assertThat(frame.colorRangeCode).describedAs("$name range").isEqualTo(rangeCode(entry.getString("range")))
    assertThat(frame.flags).describedAs("$name flags").isEqualTo(entry.getInt("flags"))
    assertThat(frame.sessionGeneration).describedAs("$name generation").isEqualTo(entry.getLong("generation"))
    assertThat(frame.frameSequence).describedAs("$name sequence").isEqualTo(entry.getLong("sequence"))
    assertThat(frame.payloadLength).describedAs("$name payloadLength").isEqualTo(entry.getInt("payloadLength"))
    assertThat(frame.timestampNs).describedAs("$name timestampNs").isEqualTo(entry.getString("timestampNs").toLong())
    assertThat(frame.sentAtNs).describedAs("$name sentAtNs").isEqualTo(entry.getString("sentAtNs").toLong())

    val fill = entry.getJSONObject("fill")
    val luma = frame.width * frame.height
    val chroma = ((frame.width + 1) / 2) * ((frame.height + 1) / 2)
    val payload = bytes.copyOfRange(frame.payloadOffset, frame.payloadOffset + frame.payloadLength).map { it.toInt() and 0xFF }
    assertThat(payload.subList(0, luma).toSet()).describedAs("$name Y").containsExactly(fill.getInt("y"))
    if (frame.pixelFormat == PreviewPixelFormat.NV12) {
      val uv = payload.subList(luma, luma + 2 * chroma)
      assertThat(uv.filterIndexed { i, _ -> i % 2 == 0 }.toSet()).describedAs("$name U").containsExactly(fill.getInt("u"))
      assertThat(uv.filterIndexed { i, _ -> i % 2 == 1 }.toSet()).describedAs("$name V").containsExactly(fill.getInt("v"))
    } else {
      assertThat(payload.subList(luma, luma + chroma).toSet()).describedAs("$name U").containsExactly(fill.getInt("u"))
      assertThat(payload.subList(luma + chroma, luma + 2 * chroma).toSet()).describedAs("$name V").containsExactly(fill.getInt("v"))
    }
  }

  private fun matrixCode(name: String) = when (name) {
    "bt601" -> 1
    "bt709" -> 2
    else -> 0
  }

  private fun rangeCode(name: String) = when (name) {
    "limited" -> 1
    "full" -> 2
    else -> 0
  }
}
