package com.mentra.acsmeeting.video

import com.mentra.acsmeeting.source.AcsInvestigation
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class VideoProfileTest {
  @Test
  fun defaultRemainsHd720p15() {
    assertThat(VideoProfile.DEFAULT).isEqualTo(VideoProfile.HD)
    assertThat(VideoProfile.DEFAULT.width).isEqualTo(1280)
    assertThat(VideoProfile.DEFAULT.height).isEqualTo(720)
    assertThat(VideoProfile.DEFAULT.fps).isEqualTo(15)
  }

  @Test
  fun defaultProfileIsWithinAcsFormatBounds() {
    val spec = VideoProfile.DEFAULT.spec()
    assertThat(spec.withinAcsBounds()).isTrue()
    assertThat(spec.fps).isEqualTo(VideoProfile.DEFAULT.fps.toFloat())
  }

  @Test
  fun everyProfileIsWithinAcsFormatBounds() {
    for (profile in listOf(VideoProfile.HD, VideoProfile.SD, VideoProfile.P540, VideoProfile.P540_15)) {
      assertThat(profile.spec().withinAcsBounds()).isTrue()
    }
  }

  /**
   * The declared rate must equal the rate we actually emit. Advertising a rate
   * we do not sustain makes the ACS rate controller reserve budget for frames
   * that never arrive, which costs wire fps.
   */
  @Test
  fun declaredRateMatchesTheSyntheticEmitRate() {
    assertThat(VideoProfile.DEFAULT.fps).isEqualTo(AcsInvestigation.syntheticFps)
  }

  /**
   * Regression for the 1.4 fps collapse: 720p noise needed ~1.4 Mbit per frame
   * against a ~1.9 Mbps budget. Keep enough headroom per frame that ordinary
   * content never puts the rate controller in that position.
   */
  @Test
  fun eachProfileLeavesUsableBitsPerFrame() {
    for (profile in listOf(VideoProfile.HD, VideoProfile.SD, VideoProfile.P540_15)) {
      assertThat(profile.bitsPerFrame()).isGreaterThan(20_000)
    }
  }

  @Test
  fun parseAcceptsDocumentedVirtualCameraSizesAndRejectsPortraitAnd480p() {
    assertThat(VideoProfile.parse(1280, 720, 15, 2_500_000)).isEqualTo(VideoProfile.HD)
    assertThat(VideoProfile.parse(960, 540, 30, 1_500_000)).isEqualTo(VideoProfile.P540)
    assertThat(VideoProfile.parse(960, 540, 15, 1_500_000)).isEqualTo(VideoProfile.P540_15)
    assertThat(VideoProfile.parse(540, 960, 30, 1_500_000)).isNull()
    assertThat(VideoProfile.parse(854, 480, 15, 1_500_000)).isNull()
  }

  /** The fallback only earns its place if it is a real cut in encoder work. */
  @Test
  fun sdIsAQuarterOfTheHdPixelCount() {
    val hd = VideoProfile.HD.width * VideoProfile.HD.height
    val sd = VideoProfile.SD.width * VideoProfile.SD.height
    assertThat(sd).isEqualTo(hd / 4)
  }
}
