package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class StreamRequestCaptureAudioTest {
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
