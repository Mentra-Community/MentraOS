package com.mentra.framepreview

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * The synthetic timer ticks at half the frame period so the pacer, not the timer, decides when a
 * frame is due. That only works if the tick divides the period exactly — and the obvious
 * millisecond arithmetic does not, which cost a measured 32/48 ms alternation at 30 fps behind a
 * perfectly healthy-looking 30.0 fps average.
 */
class PreviewPacerPeriodTest {
  /**
   * A nanosecond period is not always even — 1e9/30 is 33,333,333 — so two ticks can miss by a
   * nanosecond. What matters is the size of the miss: a nanosecond a frame is 30 ns of drift per
   * second and never crosses a slot boundary.
   */
  @Test
  fun `two ticks cover the frame period to within a microsecond`() {
    for (fps in listOf(5, 10, 15, 24, 30)) {
      val period = PreviewPacer.periodForFps(fps)
      assertThat(Math.abs((period / 2) * 2 - period)).isLessThan(1_000L)
    }
  }

  /**
   * The shape of the old bug, pinned so nobody reintroduces it: at 30 fps the truncated
   * millisecond tick is 16 ms, and two of those fall 1.33 ms short of the real period. The
   * pacer's absolute schedule then lands on the beat between ticks, and the delivered cadence
   * alternates 32/48 ms behind a perfectly healthy-looking 30.0 fps average.
   */
  @Test
  fun `millisecond truncation misses by three orders of magnitude more`() {
    val period = PreviewPacer.periodForFps(30)
    val truncated = Math.abs((1000L / 30 / 2) * 1_000_000 * 2 - period)
    val nanosecond = Math.abs((period / 2) * 2 - period)
    assertThat(truncated).isGreaterThan(1_000_000L)
    assertThat(nanosecond).isLessThan(1_000L)
  }
}

class PreviewPacerTest {
  private val period = PreviewPacer.periodForFps(15)

  private fun readyPacer(): PreviewPacer = PreviewPacer(15).apply {
    beginGeneration()
    setConsumerReady(true)
    start(0)
  }

  @Test
  fun `no credit before the consumer authenticates`() {
    val pacer = PreviewPacer(15)
    pacer.beginGeneration()
    pacer.start(0)
    assertThat(pacer.admit(0)).isEqualTo(PreviewAdmission.NotRunning)
    pacer.setConsumerReady(true)
    assertThat(pacer.admit(0)).isEqualTo(PreviewAdmission.Admit(1))
  }

  @Test
  fun `only one frame is ever in flight`() {
    val pacer = readyPacer()
    assertThat(pacer.admit(0)).isEqualTo(PreviewAdmission.Admit(1))
    assertThat(pacer.admit(period * 5)).isEqualTo(PreviewAdmission.SkipBusy)
    pacer.onPacked(1, sent = true, nowNs = period)
    assertThat(pacer.outstandingFrames).isEqualTo(1)
    assertThat(pacer.admit(period * 5)).isEqualTo(PreviewAdmission.SkipBusy)
    assertThat(pacer.onAck(pacer.generation, 1, period * 2))
      .isEqualTo(PreviewAckResult.Accepted(period))
    assertThat(pacer.outstandingFrames).isZero()
    assertThat(pacer.admit(period * 5)).isEqualTo(PreviewAdmission.Admit(2))
  }

  @Test
  fun `schedule is absolute rather than a fixed delay after each frame`() {
    val pacer = readyPacer()
    pacer.admit(0)
    pacer.onPacked(1, sent = true, nowNs = 0)
    // The consumer took 40 ms; the next slot is still the one at 66.7 ms, not 40 + 66.7.
    pacer.onAck(pacer.generation, 1, 40_000_000)
    assertThat(pacer.admit(60_000_000)).isEqualTo(PreviewAdmission.SkipPacing)
    assertThat(pacer.admit(period)).isEqualTo(PreviewAdmission.Admit(2))
  }

  @Test
  fun `a long stall resyncs instead of bursting to catch up`() {
    val pacer = readyPacer()
    pacer.admit(0)
    pacer.onPacked(1, sent = false, nowNs = 0)
    val late = period * 10
    assertThat(pacer.admit(late)).isEqualTo(PreviewAdmission.Admit(2))
    pacer.onPacked(2, sent = false, nowNs = late)
    assertThat(pacer.admit(late + 1)).isEqualTo(PreviewAdmission.SkipPacing)
    assertThat(pacer.admit(late + period)).isEqualTo(PreviewAdmission.Admit(3))
  }

  @Test
  fun `acks from a previous generation or frame are rejected`() {
    val pacer = readyPacer()
    pacer.admit(0)
    pacer.onPacked(1, sent = true, nowNs = 0)
    assertThat(pacer.onAck(pacer.generation - 1, 1, period)).isEqualTo(PreviewAckResult.Stale)
    assertThat(pacer.onAck(pacer.generation, 99, period)).isEqualTo(PreviewAckResult.Stale)
    assertThat(pacer.outstandingFrames).isEqualTo(1)
    assertThat(pacer.onAck(pacer.generation, 1, period)).isEqualTo(PreviewAckResult.Accepted(period))
    assertThat(pacer.onAck(pacer.generation, 1, period)).isEqualTo(PreviewAckResult.Stale)
  }

  @Test
  fun `ack timeout is reported and a new document revokes credit`() {
    val pacer = readyPacer()
    pacer.admit(0)
    pacer.onPacked(1, sent = true, nowNs = 0)
    assertThat(pacer.hasAckTimedOut(1_000_000_000)).isFalse()
    assertThat(pacer.hasAckTimedOut(2_500_000_000)).isTrue()

    pacer.beginGeneration()
    assertThat(pacer.consumerReady).isFalse()
    assertThat(pacer.admit(3_000_000_000)).isEqualTo(PreviewAdmission.NotRunning)
  }

  @Test
  fun `stop keeps the consumer authenticated so restart needs no handshake`() {
    val pacer = readyPacer()
    pacer.admit(0)
    pacer.stop()
    assertThat(pacer.admit(period)).isEqualTo(PreviewAdmission.NotRunning)
    pacer.start(period)
    assertThat(pacer.consumerReady).isTrue()
    assertThat(pacer.admit(period)).isEqualTo(PreviewAdmission.Admit(2))
  }
}
