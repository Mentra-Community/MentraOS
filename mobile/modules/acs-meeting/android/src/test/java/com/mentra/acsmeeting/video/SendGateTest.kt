package com.mentra.acsmeeting.video

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class SendGateTest {
  @Test
  fun burstyTenFpsAllSubmitWhenGateIsFree() {
    val intervals = burstyTenFps()
    assertThat(oldPacerDrops(intervals, minIntervalMs = 67)).isGreaterThan((intervals.size * 0.3).toInt())
    val gate = SendGate()
    assertThat(submitAll(intervals, gate)).isEqualTo(intervals.size)
    assertThat(gate.busyCount()).isEqualTo(0)
  }

  @Test
  fun decoderBatchingAtFifteenFpsAverageDropsNone() {
    val intervals = longArrayOf(20, 110, 25, 111, 20, 110, 25, 111)
    assertThat(oldPacerDrops(intervals, minIntervalMs = 33)).isGreaterThan(0)
    val gate = SendGate()
    assertThat(submitAll(intervals, gate)).isEqualTo(intervals.size)
    assertThat(gate.busyCount()).isEqualTo(0)
  }

  @Test
  fun threeFramesOneMsApartAllSubmitWhenFree() {
    val gate = SendGate()
    assertThat(submitAll(longArrayOf(1, 1, 1), gate)).isEqualTo(3)
    assertThat(gate.busyCount()).isEqualTo(0)
  }

  @Test
  fun heldGateIncrementsBusyAndDropsContendedFrames() {
    val gate = SendGate()
    assertThat(gate.tryAcquire()).isTrue()
    assertThat(gate.tryAcquire()).isFalse()
    assertThat(gate.tryAcquire()).isFalse()
    assertThat(gate.busyCount()).isEqualTo(2)
    gate.release()
    assertThat(gate.tryAcquire()).isTrue()
  }

  private fun submitAll(intervalsMs: LongArray, gate: SendGate): Int {
    var submitted = 0
    for (ignored in intervalsMs) {
      if (gate.tryAcquire()) {
        submitted += 1
        gate.release()
      }
    }
    return submitted
  }

  /** Observed WHEP pattern: unique ~10 fps delivered as 40 ms pairs then a 160 ms gap. */
  private fun burstyTenFps(): LongArray {
    val out = ArrayList<Long>(20)
    repeat(10) {
      out.add(40)
      out.add(160)
    }
    return out.toLongArray()
  }

  /** Old 1x / 2x min-interval gate, kept only so a reintroduced pacer fails these cases. */
  private fun oldPacerDrops(intervalsMs: LongArray, minIntervalMs: Long): Int {
    var last = Long.MIN_VALUE
    var t = 0L
    var drops = 0
    for (dt in intervalsMs) {
      t += dt
      if (last != Long.MIN_VALUE && t - last < minIntervalMs) {
        drops += 1
      } else {
        last = t
      }
    }
    return drops
  }
}
