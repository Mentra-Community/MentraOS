package com.mentra.glassesmedia.source

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class FrameStallGateTest {
  private fun gate() = FrameStallGate(stallSamples = 3)

  private fun FrameStallGate.live(fps: Double) = sample(live = true, iceConnected = true, fps = fps)

  @Test
  fun advancingFramesNeverStall() {
    val gate = gate()
    repeat(10) { assertThat(gate.live(15.0)).isEqualTo(FrameStallGate.Verdict.Healthy) }
  }

  @Test
  fun aFrozenDecoderStallsOnlyAfterTheFullRun() {
    val gate = gate()
    assertThat(gate.live(0.0)).isEqualTo(FrameStallGate.Verdict.Suspected(1))
    assertThat(gate.live(0.0)).isEqualTo(FrameStallGate.Verdict.Suspected(2))
    assertThat(gate.live(0.0)).isEqualTo(FrameStallGate.Verdict.Stalled(3))
  }

  @Test
  fun stallIsReportedOnceSoTheSamplerDoesNotSpam() {
    val gate = gate()
    repeat(3) { gate.live(0.0) }
    repeat(5) { assertThat(gate.live(0.0)).isInstanceOf(FrameStallGate.Verdict.Suspected::class.java) }
  }

  @Test
  fun oneRecoveredSampleClearsTheRun() {
    val gate = gate()
    gate.live(0.0)
    gate.live(0.0)
    assertThat(gate.live(15.0)).isEqualTo(FrameStallGate.Verdict.Healthy)
    // The run restarts rather than resuming at 2, so a single dropped sample cannot fail a call.
    assertThat(gate.live(0.0)).isEqualTo(FrameStallGate.Verdict.Suspected(1))
  }

  // A rate needs two reads; the first sample has nothing to compare against and reports -1.
  @Test
  fun theFirstSampleOfASessionIsNotEvidence() {
    val gate = gate()
    repeat(5) { assertThat(gate.live(-1.0)).isEqualTo(FrameStallGate.Verdict.Healthy) }
  }

  // Before the first frame the first-frame gate owns the verdict, and a dead transport is its own
  // failure — neither should be reported as a stall.
  @Test
  fun aSourceThatHasNotPaintedYetIsNotStalled() {
    val gate = gate()
    repeat(5) {
      assertThat(gate.sample(live = false, iceConnected = true, fps = 0.0))
        .isEqualTo(FrameStallGate.Verdict.Healthy)
    }
  }

  @Test
  fun aDisconnectedTransportIsNotStalled() {
    val gate = gate()
    repeat(5) {
      assertThat(gate.sample(live = true, iceConnected = false, fps = 0.0))
        .isEqualTo(FrameStallGate.Verdict.Healthy)
    }
  }

  @Test
  fun armLetsASecondFreezeInTheSameCallBeReported() {
    val gate = gate()
    repeat(3) { gate.live(0.0) }
    gate.arm()
    assertThat(gate.live(0.0)).isEqualTo(FrameStallGate.Verdict.Suspected(1))
    gate.live(0.0)
    assertThat(gate.live(0.0)).isEqualTo(FrameStallGate.Verdict.Stalled(3))
  }

  @Test
  fun samplesExposeTheRunForTracing() {
    val gate = gate()
    assertThat(gate.samples).isZero()
    gate.live(0.0)
    gate.live(0.0)
    assertThat(gate.samples).isEqualTo(2)
  }
}
