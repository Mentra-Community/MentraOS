package com.mentra.acsmeeting.telemetry

import com.mentra.acsmeeting.telemetry.VideoQuality.Band
import com.mentra.acsmeeting.video.VideoProfile
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.within
import org.junit.Test

class VideoQualityTest {
  @Test
  fun bitsPerPixelIsBitrateOverPixelsPerSecond() {
    // 960x540 at 15 fps on 1.5 Mbps: 1_500_000 / (960*540*15).
    val bpp = VideoQuality.bitsPerPixel(1_500_000, 960, 540, 15.0)!!
    assertThat(bpp).isCloseTo(0.193, within(0.001))
  }

  @Test
  fun missingOrZeroInputsGiveNoNumberRatherThanZero() {
    assertThat(VideoQuality.bitsPerPixel(null, 960, 540, 15.0)).isNull()
    assertThat(VideoQuality.bitsPerPixel(1_500_000, 960, 540, null)).isNull()
    assertThat(VideoQuality.bitsPerPixel(1_500_000, 0, 540, 15.0)).isNull()
    assertThat(VideoQuality.bitsPerPixel(1_500_000, 960, 540, 0.0)).isNull()
    assertThat(VideoQuality.band(null)).isEqualTo(Band.UNKNOWN)
  }

  @Test
  fun bandsFollowTheKushGaugeMotionMultiples() {
    assertThat(VideoQuality.band(0.03)).isEqualTo(Band.BLOCKY)
    assertThat(VideoQuality.band(0.10)).isEqualTo(Band.SOFT)
    assertThat(VideoQuality.band(0.20)).isEqualTo(Band.OK)
    assertThat(VideoQuality.band(0.30)).isEqualTo(Band.GOOD)
  }

  @Test
  fun bandBoundariesAreTheConstantsThemselves() {
    assertThat(VideoQuality.band(VideoQuality.STATIC_BPP)).isEqualTo(Band.SOFT)
    assertThat(VideoQuality.band(VideoQuality.MODERATE_BPP)).isEqualTo(Band.OK)
    assertThat(VideoQuality.band(VideoQuality.HIGH_MOTION_BPP)).isEqualTo(Band.GOOD)
  }

  /**
   * The measured device state: `wire=960x540@14.4 kbps=1276`. Every rate counter
   * read healthy and the picture was reported pixelated, which is the whole
   * reason this file exists.
   */
  @Test
  fun theMeasuredDeviceStateLandsShortOfHighMotion() {
    val bpp = VideoQuality.bitsPerPixel(1_276_000, 960, 540, 14.4)!!
    assertThat(bpp).isCloseTo(0.171, within(0.001))
    assertThat(VideoQuality.band(bpp)).isEqualTo(Band.OK)
    assertThat(bpp).isLessThan(VideoQuality.HIGH_MOTION_BPP)
  }

  /**
   * The old 1.5 Mbps grant could not reach high motion at 540p15 no matter what the
   * encoder did, which is why the ceiling was raised. This pins the new one to the
   * requirement rather than to a round number, so shrinking it back below what the
   * geometry needs fails here instead of on someone's screen.
   */
  @Test
  fun theShipped540pBudgetCanNowReachHighMotion() {
    val p540 = VideoProfile.P540_15
    val needed = VideoQuality.neededBps(p540.width, p540.height, p540.fps.toDouble(), VideoQuality.HIGH_MOTION_BPP)
    assertThat(needed).isCloseTo(2_177_280L, within(1_000L))
    assertThat(p540.maxBitrateBps.toLong()).isGreaterThanOrEqualTo(needed)
    assertThat(
      VideoQuality.budgetCapsQuality(p540.width, p540.height, p540.fps.toDouble(), p540.maxBitrateBps),
    ).isFalse()
    // The grant it replaced, kept as the regression it was.
    assertThat(VideoQuality.budgetCapsQuality(p540.width, p540.height, p540.fps.toDouble(), 1_500_000)).isTrue()
  }

  /** 360p15 fits inside its 1 Mbps grant, so the smaller profile is not budget-capped. */
  @Test
  fun theSdProfileIsNotBudgetCapped() {
    val sd = VideoProfile.SD
    assertThat(
      VideoQuality.budgetCapsQuality(sd.width, sd.height, sd.fps.toDouble(), sd.maxBitrateBps),
    ).isFalse()
  }

  @Test
  fun aBudgetOfZeroIsNotTreatedAsACap() {
    assertThat(VideoQuality.budgetCapsQuality(960, 540, 15.0, 0)).isFalse()
  }

  @Test
  fun everyBandHasANonEmptyHint() {
    for (band in Band.entries) {
      for (capped in listOf(true, false)) {
        for (spending in listOf(true, false)) {
          for (busy in listOf(true, false)) {
            assertThat(VideoQuality.hint(band, capped, spending, busy)).isNotBlank()
          }
        }
      }
    }
  }

  /**
   * Underspending with a nearly full core and underspending with an idle one look
   * the same on screen and want opposite fixes, so they must not share a hint.
   */
  @Test
  fun underspendSplitsOnCpuRatherThanCollapsingToOneRemedy() {
    val busy = VideoQuality.hint(Band.OK, budgetCapped = true, spendingBudget = false, encoderBusy = true)
    val idle = VideoQuality.hint(Band.OK, budgetCapped = true, spendingBudget = false, encoderBusy = false)
    assertThat(busy).contains("cut pixels")
    assertThat(idle).contains("congestion control")
    assertThat(idle).doesNotContain("cut pixels")
  }

  @Test
  fun spendingIsMeasuredAgainstTheGrantedCeiling() {
    assertThat(VideoQuality.spendingBudget(1_275_000, 1_500_000)).isTrue()
    assertThat(VideoQuality.spendingBudget(1_200_000, 1_500_000)).isFalse()
    assertThat(VideoQuality.spendingBudget(null, 1_500_000)).isFalse()
    assertThat(VideoQuality.spendingBudget(1_200_000, 0)).isFalse()
  }

  /**
   * Measured on device during the bitrate slide: `kbps=1210 budgetKbps=1500` with
   * process CPU at 69–88% of one core on an 8-core phone. The encoder had headroom
   * and the rate still fell, so this must not be reported as an encoder problem.
   */
  @Test
  fun theMeasuredSlideIsBlamedOnCongestionNotTheEncoder() {
    val line = VideoQuality.line(960, 540, 14.2, 1_210_000, 1_500_000, 140.0, 77.8, "GOOD")
    assertThat(line).contains("used=81%")
    assertThat(line).contains("cpu=77.8")
    assertThat(line).contains("sendQuality=GOOD")
    assertThat(line).contains("congestion control")
    assertThat(line).doesNotContain("cut pixels")
  }

  /** A picture that is already sharp is never told to cut anything. */
  @Test
  fun aGoodPictureIsNotGivenARemedy() {
    val hint = VideoQuality.hint(
      Band.GOOD,
      budgetCapped = true,
      spendingBudget = false,
      encoderBusy = true,
    )
    assertThat(hint).isEqualTo("enough for high motion")
  }

  @Test
  fun theLinePrintsTheShortfallAndNotJustTheNumber() {
    val line = VideoQuality.line(
      wireWidth = 960,
      wireHeight = 540,
      wireFps = 14.4,
      wireBitrateBps = 1_276_000,
      budgetBps = 1_500_000,
      packetsPerSecond = 143.0,
      cpuPercent = 74.4,
      sendQuality = "GOOD",
    )
    assertThat(line).startsWith("P9 quality band=OK")
    assertThat(line).contains("bpp=0.171")
    assertThat(line).contains("size=960x540@14.4")
    assertThat(line).contains("kbps=1276")
    assertThat(line).contains("budgetKbps=1500")
    assertThat(line).contains("used=85%")
    // What it would take to look sharp on a head-mounted camera, scored against the
    // rate actually on the wire (960*540*14.4*0.28), not the rate we asked for.
    assertThat(line).contains("goodNeedsKbps=2090")
    assertThat(line).contains("budgetCapped=true")
    assertThat(line).contains("pps=143.0")
  }

  @Test
  fun theLineSurvivesAMissingWireReport() {
    val line = VideoQuality.line(null, null, null, null, 1_500_000, null, null, "")
    assertThat(line).contains("band=UNKNOWN")
    assertThat(line).contains("bpp=na")
    assertThat(line).contains("pps=na")
    assertThat(line).contains("cpu=na")
    assertThat(line).contains("sendQuality=na")
  }
}
