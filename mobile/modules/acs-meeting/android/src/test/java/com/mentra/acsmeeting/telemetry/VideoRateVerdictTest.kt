package com.mentra.acsmeeting.telemetry

import com.mentra.acsmeeting.telemetry.VideoRateVerdict.Bound
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class VideoRateVerdictTest {
  /** 540p15 against the 1.5 Mbps budget Mentra Call grants it. */
  private fun verdict(
    advertisedFps: Double = 15.0,
    sinkFps: Double = 15.0,
    admittedFps: Double = 15.0,
    wireFps: Double? = 15.0,
    wireBitrateBps: Long? = 1_400_000,
    budgetBps: Int = 1_500_000,
    cpuPercent: Double? = 55.0,
  ) = VideoRateVerdict.of(
    advertisedFps = advertisedFps,
    sinkFps = sinkFps,
    admittedFps = admittedFps,
    wireFps = wireFps,
    wireBitrateBps = wireBitrateBps,
    budgetBps = budgetBps,
    cpuPercent = cpuPercent,
  )

  @Test
  fun aWireHoldingTheAdvertisedRateIsOk() {
    assertThat(verdict()).isEqualTo(Bound.OK)
  }

  /**
   * The exact shape of the greedy-gate bug: the glasses supplied 14.6 fps, the
   * pacer admitted 7.3 against an advertised 8, and every counter downstream
   * looked like an encoder problem. It was ours.
   */
  @Test
  fun aGateThatDropsFramesTheSourceSuppliedIsBlamedOnThePacer() {
    assertThat(verdict(advertisedFps = 8.0, sinkFps = 14.6, admittedFps = 7.3, wireFps = 7.0))
      .isEqualTo(Bound.PACER_SHORT)
  }

  @Test
  fun aShortSourceIsNotBlamedOnAnythingDownstream() {
    assertThat(verdict(sinkFps = 6.0, admittedFps = 6.0, wireFps = 6.0))
      .isEqualTo(Bound.SOURCE_SHORT)
  }

  /**
   * A source a little under the advertise is not the pacer's fault. Scoring the
   * gate against the advertise alone would read every slightly slow glasses leg
   * as our own bug and send the next fix to the wrong place.
   */
  @Test
  fun thePacerIsNotBlamedForFramesTheSourceNeverSent() {
    assertThat(verdict(sinkFps = 13.0, admittedFps = 13.0, wireFps = 13.0))
      .isEqualTo(Bound.OK)
  }

  /**
   * The two verdicts that matter, because they want opposite fixes. Same short
   * wire rate, same delivered rate; only CPU and the bitrate headroom differ.
   */
  @Test
  fun aBusyCpuMeansTheEncoderIsTheCeiling() {
    assertThat(verdict(wireFps = 8.0, cpuPercent = 92.0)).isEqualTo(Bound.ENCODER_SHORT)
  }

  @Test
  fun sparecpuAndACollapsedBitrateMeansTheRateControllerIsThrottling() {
    assertThat(verdict(wireFps = 8.0, wireBitrateBps = 496_000, cpuPercent = 50.0))
      .isEqualTo(Bound.BITRATE_STARVED)
  }

  /** Spare CPU but the budget is being spent: the encoder really is the limit. */
  @Test
  fun sparecpuWithTheBudgetSpentIsStillTheEncoder() {
    assertThat(verdict(wireFps = 8.0, wireBitrateBps = 1_450_000, cpuPercent = 50.0))
      .isEqualTo(Bound.ENCODER_SHORT)
  }

  @Test
  fun aMissingWireReportIsNotAVerdict() {
    assertThat(verdict(wireFps = null)).isEqualTo(Bound.UNKNOWN)
    assertThat(verdict(advertisedFps = 0.0)).isEqualTo(Bound.UNKNOWN)
  }

  /** Every bound carries an action, or the line makes the reader open this file. */
  @Test
  fun everyBoundHasANonEmptyHint() {
    for (bound in Bound.entries) {
      assertThat(VideoRateVerdict.hint(bound)).isNotBlank()
    }
  }

  @Test
  fun theLinePrintsTheInputsBesideTheVerdict() {
    val line = VideoRateVerdict.line(
      advertisedFps = 15.0,
      sinkFps = 14.6,
      admittedFps = 7.3,
      wireFps = 7.0,
      wireBitrateBps = 496_000,
      budgetBps = 1_500_000,
      cpuPercent = 61.3,
      codecName = "h264 sw",
    )
    assertThat(line).startsWith("P7 rate bound=PACER_SHORT")
    assertThat(line).contains("advertised=15.0")
    assertThat(line).contains("sink=14.6")
    assertThat(line).contains("admitted=7.3")
    assertThat(line).contains("wire=7.0")
    assertThat(line).contains("kbps=496")
    assertThat(line).contains("budgetKbps=1500")
    assertThat(line).contains("cpu=61.3")
    assertThat(line).contains("codec=h264_sw")
    assertThat(line).contains(VideoRateVerdict.hint(Bound.PACER_SHORT))
  }
}
