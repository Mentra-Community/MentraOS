package com.mentra.acsmeeting.audio

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class CapturePolicyTest {
  @Test
  fun glassesCapturesMicAndPhoneDoesNot() {
    assertThat(CapturePolicy.captureGlassesMic(AudioSourceKind.GLASSES)).isTrue()
    assertThat(CapturePolicy.captureGlassesMic(AudioSourceKind.PHONE)).isFalse()
  }
}

class GlassesPcmRoutingTest {
  /**
   * The double-audio case. Both sources carry the same room; enabling both is heard as an echo at
   * the far end that no participant can mute, because neither copy is anyone's microphone.
   */
  @Test
  fun exactlyOneSourceOfTheWearersVoiceIsEverOn() {
    for (softap in listOf(true, false)) {
      for (enabled in listOf(true, false)) {
        val routing = GlassesPcmRouting.decide(softap, enabled)
        assertThat(routing.relayPcm && routing.externalPcm).isFalse()
      }
    }
  }

  @Test
  fun aSoftApCallTakesTheWearerFromTheRelayTrackUntilLc3HasAnalogVoice() {
    assertThat(GlassesPcmRouting.decide(softap = true, enabled = true))
      .isEqualTo(GlassesPcmRouting(relayPcm = true, externalPcm = false))
  }

  @Test
  fun aWhepCallKeepsTakingTheWearerFromTheRelayTrack() {
    assertThat(GlassesPcmRouting.decide(softap = false, enabled = true))
      .isEqualTo(GlassesPcmRouting(relayPcm = true, externalPcm = false))
  }

  /**
   * Disabling has to close *both* gates whichever transport this call uses. A push that survives a
   * mute or a source switch is the wearer heard when they asked not to be.
   */
  @Test
  fun disablingClosesBothGatesOnEitherTransport() {
    assertThat(GlassesPcmRouting.decide(softap = true, enabled = false))
      .isEqualTo(GlassesPcmRouting(relayPcm = false, externalPcm = false))
    assertThat(GlassesPcmRouting.decide(softap = false, enabled = false))
      .isEqualTo(GlassesPcmRouting(relayPcm = false, externalPcm = false))
  }
}
