package com.mentra.framepreview

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

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
