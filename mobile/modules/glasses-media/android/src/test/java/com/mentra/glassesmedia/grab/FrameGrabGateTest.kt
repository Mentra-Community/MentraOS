package com.mentra.glassesmedia.grab

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class FrameGrabGateTest {
  private var now = 10_000L
  private val gate = FrameGrabGate<String> { now }

  private class Outcome {
    val frames = mutableListOf<String>()
    val failures = mutableListOf<String>()
    val request = FrameGrabGate.Request<String>({ frames += it }, { failures += it })
  }

  @Test
  fun `a phone that never decoded a frame is not live`() {
    assertThat(gate.frameAgeMs()).isEqualTo(-1)
    assertThat(gate.isLive(1_000)).isFalse()
  }

  @Test
  fun `a stream is live only while frames keep arriving`() {
    gate.noteFrame()
    now += 400
    assertThat(gate.frameAgeMs()).isEqualTo(400)
    assertThat(gate.isLive(1_000)).isTrue()
    now += 700
    assertThat(gate.isLive(1_000)).isFalse()
  }

  @Test
  fun `a frame with nothing waiting claims nothing`() {
    assertThat(gate.claim()).isNull()
  }

  @Test
  fun `the next frame goes to the waiting request and only that frame`() {
    val outcome = Outcome()
    assertThat(gate.arm(outcome.request)).isTrue()
    assertThat(gate.claim()!!.deliver("first")).isTrue()
    assertThat(gate.claim()).isNull()
    assertThat(outcome.frames).containsExactly("first")
    assertThat(outcome.failures).isEmpty()
  }

  @Test
  fun `a second request while one waits is refused and the first keeps its place`() {
    val first = Outcome()
    val second = Outcome()
    assertThat(gate.arm(first.request)).isTrue()
    assertThat(gate.arm(second.request)).isFalse()
    gate.claim()!!.deliver("frame")
    assertThat(first.frames).containsExactly("frame")
    assertThat(second.frames).isEmpty()
  }

  @Test
  fun `a request that timed out is not handed a later frame`() {
    val outcome = Outcome()
    gate.arm(outcome.request)
    assertThat(gate.expire(outcome.request)).isTrue()
    outcome.request.fail("no_frame")
    assertThat(gate.claim()).isNull()
    assertThat(outcome.failures).containsExactly("no_frame")
  }

  @Test
  fun `a timeout that loses the race to a frame changes nothing`() {
    val outcome = Outcome()
    gate.arm(outcome.request)
    val claimed = gate.claim()!!
    assertThat(gate.expire(outcome.request)).isFalse()
    claimed.deliver("frame")
    outcome.request.fail("no_frame")
    assertThat(outcome.frames).containsExactly("frame")
    assertThat(outcome.failures).isEmpty()
  }

  @Test
  fun `a frame offered to a settled request stays with the caller`() {
    val outcome = Outcome()
    outcome.request.fail("frame_unreadable")
    assertThat(outcome.request.deliver("late")).isFalse()
    assertThat(outcome.frames).isEmpty()
    assertThat(outcome.failures).containsExactly("frame_unreadable")
  }

  @Test
  fun `the gate is free again after a request expires`() {
    val first = Outcome()
    gate.arm(first.request)
    gate.expire(first.request)
    assertThat(gate.arm(Outcome().request)).isTrue()
  }
}
