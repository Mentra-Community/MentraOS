package com.mentra.acsmeeting.video

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class AcsTimestampTest {
  @Test
  fun streamClockWinsWhenItIsAdvancing() {
    val ticks = AcsTimestamp.resolve(streamTicks = 5_000, captureNs = 1_000_000, lastTicks = 100)
    assertThat(ticks).isEqualTo(5_000)
  }

  @Test
  fun captureNsConvertsToHundredNanosecondTicks() {
    val ticks = AcsTimestamp.resolve(streamTicks = 0, captureNs = 66_700_000, lastTicks = 0)
    assertThat(ticks).isEqualTo(667_000)
  }

  /**
   * A run of timestamp-0 frames is what Teams renders as a freeze: the jitter
   * buffer holds the last picture because presentation time never moves.
   */
  @Test
  fun zeroInputsStillAdvance() {
    val first = AcsTimestamp.resolve(streamTicks = 0, captureNs = 0, lastTicks = 0)
    val second = AcsTimestamp.resolve(streamTicks = 0, captureNs = 0, lastTicks = first)
    assertThat(first).isEqualTo(1)
    assertThat(second).isGreaterThan(first)
  }

  @Test
  fun neverReusesTheLastTick() {
    val stuckStream = 40L
    val ticks = AcsTimestamp.resolve(streamTicks = stuckStream, captureNs = 1_000, lastTicks = 40)
    assertThat(ticks).isEqualTo(41)
  }

  @Test
  fun captureBehindLastTickStillAdvances() {
    val ticks = AcsTimestamp.resolve(streamTicks = 0, captureNs = 100, lastTicks = 9_000)
    assertThat(ticks).isEqualTo(9_001)
  }
}
