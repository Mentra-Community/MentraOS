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

  /**
   * Outgoing audio's shape: `RawOutgoingAudioStream` in 2.16.0 exposes no stream clock, so the
   * capture time is always the source and `streamTicks` is always 0.
   *
   * The audio and the video come from different places — one over BLE, one over the SoftAP peer —
   * so a shared `System.nanoTime()` base is the only thing that lets a receiver relate them at all.
   * These assertions are the precondition for the A/V question, not the answer to it: whether ACS
   * honours the ticks for raw audio is a receiver measurement.
   */
  @Test
  fun audioFramesStampedFromCaptureTimeShareTheVideoTickBase() {
    val captureNs = 1_234_500_000L
    val audio = AcsTimestamp.resolve(streamTicks = 0, captureNs = captureNs, lastTicks = 0)
    val videoFromTheSameInstant = AcsTimestamp.resolve(streamTicks = 0, captureNs = captureNs, lastTicks = 0)

    assertThat(audio).isEqualTo(videoFromTheSameInstant)
    assertThat(audio).isEqualTo(captureNs / AcsTimestamp.NS_PER_TICK)
  }

  @Test
  fun aStreamOfAudioFramesIsStrictlyIncreasingAndNeverZero() {
    // 20 ms periods on a clock coarse enough that two frames could collide.
    var last = 0L
    val ticks = (0 until 50).map { period ->
      val resolved = AcsTimestamp.resolve(streamTicks = 0, captureNs = period * 20_000_000L, lastTicks = last)
      last = resolved
      resolved
    }

    assertThat(ticks).doesNotContain(0L)
    assertThat(ticks).isSorted()
    assertThat(ticks.toSet()).hasSameSizeAs(ticks)
  }
}
