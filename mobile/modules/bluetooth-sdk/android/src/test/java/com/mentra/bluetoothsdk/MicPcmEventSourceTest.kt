package com.mentra.bluetoothsdk

import com.mentra.bluetoothsdk.utils.MicTypes
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * The per-frame source tag, and the JS keys that read it.
 *
 * An ACS call pins the glasses microphone and then forwards every buffer to the far end. The pin is
 * what makes that safe, but a pin the SDK could not honour is exactly the case worth catching, so
 * each frame says which microphone produced it and the call verifies rather than assumes. That is
 * only true if the tag survives the bridge, so the key names here are a contract with
 * `AcsMeetingService`, not an implementation detail.
 */
class MicPcmEventSourceTest {
  private fun frame(source: String) = MicPcmEvent(
    pcm = ByteArray(320),
    sampleRate = MicPcmEvent.SAMPLE_RATE,
    bitsPerSample = MicPcmEvent.BITS_PER_SAMPLE,
    channels = MicPcmEvent.CHANNELS,
    encoding = MicPcmEvent.ENCODING,
    voiceActivityDetectionEnabled = false,
    source = source,
  )

  @Test
  fun theKeysTheCallReadsAreAllPresent() {
    val map = frame(MicTypes.GLASSES_CUSTOM).toMap()

    assertThat(map).containsKeys("pcm", "sampleRate", "source")
    assertThat(map["source"]).isEqualTo(MicTypes.GLASSES_CUSTOM)
    assertThat(map["sampleRate"]).isEqualTo(16_000)
    assertThat(map["encoding"]).isEqualTo("pcm_s16le")
  }

  @Test
  fun everySourceTheRankingCanPickRoundTrips() {
    for (source in MicTypes.ALL) {
      val restored = MicPcmEvent(frame(source).toMap())
      assertThat(restored.source).isEqualTo(source)
    }
  }

  /**
   * Absent must not decode as "glasses". A frame from a build that predates the tag is a frame
   * whose source is unknown, and the call has to drop it rather than forward the phone's room.
   */
  @Test
  fun anUntaggedFrameDecodesAsUnknownRatherThanGlasses() {
    val legacy = mapOf<String, Any>(
      "pcm" to ByteArray(320),
      "sampleRate" to 16_000,
      "bitsPerSample" to 16,
      "channels" to 1,
      "encoding" to "pcm_s16le",
      "voiceActivityDetectionEnabled" to false,
    )

    val decoded = MicPcmEvent(legacy)

    assertThat(decoded.source).isEmpty()
    assertThat(decoded.source).isNotEqualTo(MicTypes.GLASSES_CUSTOM)
  }

  /** 16 kHz mono PCM16, 10 ms per LC3 frame: the size the call's base64 round trip has to preserve. */
  @Test
  fun aDecodedLc3FrameIsOneHundredAndSixtySamples() {
    val map = frame(MicTypes.GLASSES_CUSTOM).toMap()
    val pcm = map["pcm"] as ByteArray

    assertThat(pcm).hasSize(320)
    assertThat(pcm.size / 2).isEqualTo(160)
  }
}
