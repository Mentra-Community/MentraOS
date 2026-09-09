package com.mentra.acsmeeting.audio

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class UplinkPacerTest {
  private val frameBytes = UplinkPacer.FRAME_BYTES
  private val tickNanos = UplinkPacer.FRAME_MS * 1_000_000L

  /** Non-zero PCM so a manufactured silence frame is distinguishable. */
  private fun tone(ms: Int): ByteArray = ByteArray(ms * UplinkPacer.BYTES_PER_MS) { 0x20 }

  @Test
  fun prerollGateHoldsUntilTargetDepth() {
    val pacer = UplinkPacer()
    var now = 0L
    pacer.push(tone(40))
    repeat(3) {
      assertThat(pacer.tick(now).silence).isTrue()
      now += tickNanos
    }
    assertThat(pacer.state()).isEqualTo(UplinkPacer.State.PREROLLING)
    assertThat(pacer.depthMs()).isEqualTo(40)

    pacer.push(tone(20))
    assertThat(pacer.tick(now).silence).isFalse()
    assertThat(pacer.state()).isEqualTo(UplinkPacer.State.RUNNING)
  }

  @Test
  fun steadyStateSendsFiftyFramesPerSecondAtTargetDepth() {
    val pacer = UplinkPacer()
    var now = 0L
    pacer.push(tone(UplinkPacer.TARGET_MS))
    var audio = 0
    repeat(500) {
      if (!pacer.tick(now).silence) audio += 1
      pacer.push(tone(UplinkPacer.FRAME_MS))
      now += tickNanos
    }

    assertThat(audio).isEqualTo(500)
    val stats = pacer.snapshot(now)
    assertThat(stats.sentFps).isBetween(49.5, 50.5)
    assertThat(stats.depthMs).isEqualTo(UplinkPacer.TARGET_MS)
    assertThat(stats.silenceFrames).isEqualTo(0L)
    assertThat(stats.driftCorrections).isEqualTo(0L)
  }

  @Test
  fun burstIsSmoothedToOneFramePerTick() {
    val pacer = UplinkPacer()
    // One 100 ms delivery, as the WebRTC audio thread bursts it.
    pacer.push(tone(100))
    val frames = (0 until 5).map { pacer.tick(it * tickNanos) }

    assertThat(frames.map { it.bytes.size }).containsOnly(frameBytes)
    assertThat(frames.none { it.silence }).isTrue()
    assertThat(pacer.depthMs()).isEqualTo(0)
  }

  @Test
  fun underrunEmitsSilenceWithoutLeavingRunning() {
    val pacer = UplinkPacer()
    var now = 0L
    pacer.push(tone(UplinkPacer.TARGET_MS))
    repeat(3) {
      pacer.tick(now)
      now += tickNanos
    }
    assertThat(pacer.depthMs()).isEqualTo(0)

    val frame = pacer.tick(now)
    assertThat(frame.silence).isTrue()
    assertThat(frame.bytes.size).isEqualTo(frameBytes)
    assertThat(pacer.state()).isEqualTo(UplinkPacer.State.RUNNING)
  }

  @Test
  fun prolongedOutageStarvesAndRebuildsHeadroomBeforeResuming() {
    val pacer = UplinkPacer()
    var now = 0L
    pacer.push(tone(UplinkPacer.TARGET_MS))
    repeat(3) {
      pacer.tick(now)
      now += tickNanos
    }

    // 1.5 s with no producer audio at all.
    repeat(75) {
      assertThat(pacer.tick(now).silence).isTrue()
      now += tickNanos
    }
    assertThat(pacer.state()).isEqualTo(UplinkPacer.State.STARVED)

    // Audio is back but below target: still silence, and no source audio is
    // consumed, so the rebuild is not spent immediately.
    pacer.push(tone(40))
    assertThat(pacer.tick(now).silence).isTrue()
    now += tickNanos
    assertThat(pacer.state()).isEqualTo(UplinkPacer.State.STARVED)
    assertThat(pacer.depthMs()).isEqualTo(40)

    pacer.push(tone(20))
    assertThat(pacer.tick(now).silence).isFalse()
    assertThat(pacer.state()).isEqualTo(UplinkPacer.State.RUNNING)
  }

  @Test
  fun depthAboveEmergencyCapDropsOldestDownToTarget() {
    val pacer = UplinkPacer()
    var now = 0L
    pacer.push(tone(UplinkPacer.TARGET_MS))
    pacer.tick(now)
    now += tickNanos

    pacer.push(tone(500))
    assertThat(pacer.tick(now).silence).isFalse()
    assertThat(pacer.controlDepthMs()).isEqualTo(UplinkPacer.TARGET_MS)
    val stats = pacer.snapshot(now)
    assertThat(stats.overflowDroppedMs).isEqualTo(480L)
    assertThat(stats.driftCorrections).isEqualTo(0L)
  }

  @Test
  fun fastProducerClockStaysInsideEnvelopeForAnHour() {
    val run = simulateDrift(ppm = 300.0, minutes = 60)

    assertThat(run.minControlMs).isGreaterThanOrEqualTo(UplinkPacer.LOW_MS)
    assertThat(run.maxControlMs).isLessThanOrEqualTo(UplinkPacer.HIGH_MS + UplinkPacer.CORRECTION_MS)
    assertThat(run.stats.silenceFrames).isEqualTo(0L)
    assertThat(run.stats.overflowDroppedMs).isEqualTo(0L)
    assertThat(run.stats.driftInsertedMs).isEqualTo(0L)
    // 300 ppm over an hour is ~1080 ms of excess audio to shed.
    assertThat(run.stats.driftDroppedMs).isBetween(900L, 1300L)
    assertThat(run.stats.driftCorrections).isLessThan(200L)
  }

  @Test
  fun slowProducerClockStaysInsideEnvelopeForAnHour() {
    val run = simulateDrift(ppm = -300.0, minutes = 60)

    assertThat(run.minControlMs).isGreaterThanOrEqualTo(UplinkPacer.LOW_MS - UplinkPacer.CORRECTION_MS)
    assertThat(run.maxControlMs).isLessThanOrEqualTo(UplinkPacer.HIGH_MS)
    assertThat(run.stats.silenceFrames).isEqualTo(0L)
    assertThat(run.stats.overflowDroppedMs).isEqualTo(0L)
    assertThat(run.stats.driftDroppedMs).isEqualTo(0L)
    assertThat(run.stats.driftInsertedMs).isBetween(900L, 1300L)
    assertThat(run.stats.driftCorrections).isLessThan(200L)
  }

  @Test
  fun resetRearmsPreroll() {
    val pacer = UplinkPacer()
    pacer.push(tone(UplinkPacer.TARGET_MS))
    pacer.tick(0)
    assertThat(pacer.state()).isEqualTo(UplinkPacer.State.RUNNING)

    pacer.reset()
    assertThat(pacer.state()).isEqualTo(UplinkPacer.State.PREROLLING)
    assertThat(pacer.depthMs()).isEqualTo(0)
    assertThat(pacer.snapshot(0).framesEmitted).isEqualTo(0L)
  }

  private class DriftRun(
    val minControlMs: Int,
    val maxControlMs: Int,
    val stats: UplinkPacer.Stats,
  )

  /**
   * Runs [minutes] of call time with a producer clock offset by [ppm], one
   * simulated 20 ms period per iteration. The pacer's injected clock is what
   * makes an hour cost milliseconds.
   */
  private fun simulateDrift(ppm: Double, minutes: Int): DriftRun {
    val pacer = UplinkPacer()
    var now = 0L
    var minMs = Int.MAX_VALUE
    var maxMs = Int.MIN_VALUE
    var owed = 0.0
    val bytesPerTick = frameBytes * (1.0 + ppm / 1_000_000.0)
    val ticks = minutes * 60 * 1000 / UplinkPacer.FRAME_MS

    pacer.push(tone(UplinkPacer.TARGET_MS))
    repeat(ticks) {
      pacer.tick(now)
      minMs = minOf(minMs, pacer.controlDepthMs())
      maxMs = maxOf(maxMs, pacer.controlDepthMs())
      owed += bytesPerTick
      // Sample-aligned: PCM16 frames never split a sample.
      val whole = (owed.toInt() / 2) * 2
      if (whole > 0) {
        pacer.push(ByteArray(whole) { 0x20 })
        owed -= whole
      }
      now += tickNanos
    }
    return DriftRun(minMs, maxMs, pacer.snapshot(now))
  }
}
