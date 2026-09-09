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
