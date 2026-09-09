package com.mentra.acsmeeting.source

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class FirstFrameGateTest {
  @Test
  fun answerAloneDoesNotPromote() {
    val gate = FirstFrameGate()
    gate.arm(1)
    // The answer is armed, not live: nothing has reached the sink yet.
    assertThat(gate.expired(1)).isTrue()
  }

  @Test
  fun firstFrameForTheArmedGenerationPromotesExactlyOnce() {
    val gate = FirstFrameGate()
    gate.arm(7)
    assertThat(gate.onFrame(7)).isTrue()
    assertThat(gate.onFrame(7)).isFalse()
    assertThat(gate.expired(7)).isFalse()
  }

  @Test
  fun framesFromAPeerBeingTornDownNeverPromote() {
    val gate = FirstFrameGate()
    gate.arm(2)
    assertThat(gate.onFrame(1)).isFalse()
    assertThat(gate.expired(2)).isTrue()
  }

  @Test
  fun deadlineForASupersededGenerationDoesNotFailTheNewPeer() {
    val gate = FirstFrameGate()
    gate.arm(3)
    gate.arm(4)
    assertThat(gate.expired(3)).isFalse()
    assertThat(gate.expired(4)).isTrue()
  }

  @Test
  fun iceRecoveryRearmsSoTheNextFramePromotesAgain() {
    val gate = FirstFrameGate()
    gate.arm(5)
    assertThat(gate.onFrame(5)).isTrue()
    // ICE bounced and came back on the same peer: LIVE has to be re-earned.
    gate.arm(5)
    assertThat(gate.expired(5)).isTrue()
    assertThat(gate.onFrame(5)).isTrue()
  }

  @Test
  fun resetClearsTheArmSoAStoppedSourceCannotBeFailedLater() {
    val gate = FirstFrameGate()
    gate.arm(6)
    gate.reset()
    assertThat(gate.expired(6)).isFalse()
    assertThat(gate.onFrame(6)).isFalse()
  }
}
