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
}
