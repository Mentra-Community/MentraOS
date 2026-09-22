package com.mentra.acsmeeting.video

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.within
import org.junit.Test

class FramePacerTest {
  @Test
  fun firstFrameAlwaysAdmits() {
    val pacer = FramePacer()
    assertThat(pacer.tryAdmit(FramePacer.intervalNs(8f), nowNs = 1_000L)).isTrue()
  }

  @Test
  fun dropsAFrameThatArrivesInsideTheAdvertisedInterval() {
    val pacer = FramePacer()
    val interval = FramePacer.intervalNs(8f)
    assertThat(pacer.tryAdmit(interval, nowNs = 0L)).isTrue()
    assertThat(pacer.tryAdmit(interval, nowNs = interval - 1)).isFalse()
  }

  @Test
  fun admitsOnceTheAdvertisedIntervalHasElapsed() {
    val pacer = FramePacer()
    val interval = FramePacer.intervalNs(8f)
    assertThat(pacer.tryAdmit(interval, nowNs = 0L)).isTrue()
    assertThat(pacer.tryAdmit(interval, nowNs = interval)).isTrue()
  }

  /**
   * Fifteen frames a second against an 8 fps advertise is the production SoftAP
   * case, and the only assertion that catches the failure is the sustained rate.
   *
   * Counting admits inside one 15-frame window cannot: 8 of 15 is also what a
   * 7.5 fps stream looks like, because both land on i=0,2,4..14. That is how a
   * greedy "interval elapsed since the last admit" gate passed this file while
   * the device ran `sub=7.0 wire=960x540@7.0` against an advertised 8.
   */
  @Test
  fun sustainsTheAdvertisedRateFromAnyFasterSource() {
    // 14.49 and 14.6 are arrival rates measured on device (gapP50 68-69ms), not
    // round numbers. The greedy gate delivered 7.25 and 7.30 for them.
    for (sourceFps in listOf(14.49f, 14.6f, 15f, 30f)) {
      assertThat(sustainedFps(advertisedFps = 8f, sourceFps = sourceFps))
        .`as`("source %s fps", sourceFps)
        .isCloseTo(8.0, within(0.05))
    }
  }

  /** A source slower than the advertise passes through untouched, not padded. */
  @Test
  fun neverInventsFramesTheSourceDidNotSend() {
    assertThat(sustainedFps(advertisedFps = 8f, sourceFps = 5f)).isCloseTo(5.0, within(0.05))
  }

  /**
   * Catch-up is bounded. A source that goes away must not buy its debt back as a
   * burst of back-to-back admits: that is over-delivery against the same
   * advertised rate, which is the way the ungated path starved the encoder.
   */
  @Test
  fun aStallDoesNotEarnABurstOfCatchUpAdmits() {
    val pacer = FramePacer()
    val interval = FramePacer.intervalNs(8f)
    assertThat(pacer.tryAdmit(interval, nowNs = 0L)).isTrue()
    val afterStall = 10 * interval
    assertThat(pacer.tryAdmit(interval, nowNs = afterStall)).isTrue()
    // The resync admit starts a fresh interval; nothing is due until it elapses.
    assertThat(pacer.tryAdmit(interval, nowNs = afterStall + 1)).isFalse()
    assertThat(pacer.tryAdmit(interval, nowNs = afterStall + interval)).isTrue()
  }

  private fun sustainedFps(advertisedFps: Float, sourceFps: Float, frames: Int = 3000): Double {
    val pacer = FramePacer()
    val interval = FramePacer.intervalNs(advertisedFps)
    val arrival = FramePacer.intervalNs(sourceFps)
    var admitted = 0
    for (i in 0 until frames) {
      if (pacer.tryAdmit(interval, nowNs = i * arrival)) admitted += 1
    }
    return admitted / ((frames - 1).toDouble() * arrival / 1_000_000_000.0)
  }

  @Test
  fun resetForgetsTheLastAdmit() {
    val pacer = FramePacer()
    val interval = FramePacer.intervalNs(8f)
    assertThat(pacer.tryAdmit(interval, nowNs = 0L)).isTrue()
    pacer.reset()
    assertThat(pacer.tryAdmit(interval, nowNs = 1L)).isTrue()
  }

  @Test
  fun zeroIntervalNeverPaces() {
    val pacer = FramePacer()
    assertThat(FramePacer.intervalNs(0f)).isEqualTo(0L)
    assertThat(pacer.tryAdmit(0L, nowNs = 0L)).isTrue()
    assertThat(pacer.tryAdmit(0L, nowNs = 1L)).isTrue()
  }

  @Test
  fun eightFpsIntervalIsOneHundredTwentyFiveMilliseconds() {
    assertThat(FramePacer.intervalNs(8f)).isEqualTo(125_000_000L)
  }
}
