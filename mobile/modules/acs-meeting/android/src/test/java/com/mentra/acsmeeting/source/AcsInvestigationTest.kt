package com.mentra.acsmeeting.source

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class AcsInvestigationTest {
  @Test
  fun videoArmDefaultsToWhep() {
    assertThat(AcsInvestigation.videoArm).isEqualTo(VideoSourceArm.WHEP)
  }

  @Test
  fun decoderModeDefaultsToTexture() {
    assertThat(AcsInvestigation.decoderMode).isEqualTo(DecoderMode.TEXTURE)
  }

  @Test
  fun zeroCopyDefaultsToOff() {
    assertThat(AcsInvestigation.zeroCopy).isFalse()
  }

  @Test
  fun pixelFormatDefaultsToI420() {
    assertThat(AcsInvestigation.pixelFormat).isEqualTo(PixelFormatArm.I420)
  }
}
