package com.mentra.acsmeeting.source

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class AcsInvestigationTest {
  @Test
  fun videoArmDefaultsToWhep() {
    assertThat(AcsInvestigation.videoArm).isEqualTo(VideoSourceArm.WHEP)
  }
}
