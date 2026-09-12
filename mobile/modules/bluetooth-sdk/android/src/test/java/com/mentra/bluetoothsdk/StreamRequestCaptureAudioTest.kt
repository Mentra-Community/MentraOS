package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class StreamRequestCaptureAudioTest {
  @Test
  fun videoBitrateOptionsSurviveBridgeAndWireSerialization() {
    val video = StreamVideoConfig.fromMap(mapOf(
      "minBitrateBps" to 300_000,
      "initialBitrateBps" to 400_000,
      "bitrate" to 500_000,
    ))!!
    assertThat(video.toMap()).containsEntry("minBitrateBps", 300_000)
      .containsEntry("initialBitrateBps", 400_000).containsEntry("bitrate", 500_000)
    assertThat(StreamVideoConfig().toMap()).doesNotContainKeys("minBitrateBps", "initialBitrateBps")
  }

  @Test
  fun toMapOmitsCaptureAudioWhenTrue() {
    val map = StreamRequest(streamUrl = "https://example.com/whip", captureAudio = true).toMap()
    assertThat(map).doesNotContainKey("captureAudio")
  }

  @Test
  fun toMapIncludesCaptureAudioWhenFalse() {
    val map = StreamRequest(streamUrl = "https://example.com/whip", captureAudio = false).toMap()
    assertThat(map["captureAudio"]).isEqualTo(false)
  }

  @Test
  fun fromMapDefaultsTrueAndHonorsCompactFalse() {
    val defaults = StreamRequest.fromMap(mapOf("streamUrl" to "https://example.com/whip"))
    assertThat(defaults.captureAudio).isTrue()

    val compact = StreamRequest.fromMap(mapOf("streamUrl" to "https://example.com/whip", "ca" to false))
    assertThat(compact.captureAudio).isFalse()

    val full = StreamRequest.fromMap(mapOf("streamUrl" to "https://example.com/whip", "captureAudio" to false))
    assertThat(full.captureAudio).isFalse()
  }

  @Test
  fun hostOnlyIceSurvivesBridgeAndWireSerialization() {
    val request = StreamRequest.fromMap(mapOf(
      "streamUrl" to "http://192.168.43.79:8080/whip",
      "ice" to mapOf("stun" to ""),
    ))
    assertThat(request.ice?.stun).isEqualTo("")

    // The empty string is the host-only request. Dropping it as "blank" is what silently left the
    // glasses gathering against the default Cloudflare STUN server on an internet-less hotspot.
    @Suppress("UNCHECKED_CAST")
    val ice = request.toMap()["ice"] as Map<String, Any>
    assertThat(ice).containsEntry("stun", "")
  }

  @Test
  fun absentIceStaysAbsentSoGlassesKeepTheirDefault() {
    val request = StreamRequest.fromMap(mapOf("streamUrl" to "https://example.com/whip"))
    assertThat(request.ice).isNull()
    assertThat(request.toMap()).doesNotContainKey("ice")
  }

  @Test
  fun compactIceKeysParse() {
    val request = StreamRequest.fromMap(mapOf(
      "streamUrl" to "http://192.168.43.79:8080/whip",
      "i" to mapOf("s" to "stun:stun.example.com:3478"),
    ))
    assertThat(request.ice?.stun).isEqualTo("stun:stun.example.com:3478")
  }

  @Test
  fun traceIdSurvivesBridgeAndWireSerialization() {
    val request = StreamRequest.fromMap(mapOf(
      "streamUrl" to "http://192.168.43.79:8080/whip",
      "traceId" to "d34eeb11",
    ))
    assertThat(request.traceId).isEqualTo("d34eeb11")
    assertThat(request.toMap()).containsEntry("traceId", "d34eeb11")

    assertThat(StreamRequest(streamUrl = "https://example.com/whip").toMap())
      .doesNotContainKey("traceId")
  }
}
