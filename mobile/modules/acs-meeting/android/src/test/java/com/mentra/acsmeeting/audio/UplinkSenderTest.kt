package com.mentra.acsmeeting.audio

import java.util.Collections
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class UplinkSenderTest {
  private fun tone(ms: Int): ByteArray = ByteArray(ms * UplinkPacer.BYTES_PER_MS) { 0x20 }

  private class FakeTransport : UplinkTransport {
    val sent = mutableListOf<ByteArray>()
    private val pending = mutableListOf<(Throwable?) -> Unit>()
    var autoComplete = true
    var failWith: Throwable? = null

    override fun send(frame: ByteArray, onComplete: (Throwable?) -> Unit) {
      sent.add(frame)
      if (autoComplete) onComplete(failWith) else pending.add(onComplete)
    }

    fun completeAll(error: Throwable? = null) {
      val drained = pending.toList()
      pending.clear()
      drained.forEach { it(error) }
    }
  }

  /** Preroll, then one 20 ms production per period: steady 60 ms of headroom. */
  private fun pump(sender: UplinkSender, pacer: UplinkPacer, periods: Int, from: Int = 0) {
    repeat(periods) {
      sender.pumpOnce((from + it) * UplinkSender.PERIOD_NANOS)
      pacer.push(tone(UplinkPacer.FRAME_MS))
    }
  }

  @Test
  fun aStallSendsOneFrameAndCountsSkippedTicks() {
    val pacer = UplinkPacer()
    val transport = FakeTransport()
    val sender = UplinkSender(pacer, transport, clock = { 0L }, log = {})
    pacer.push(tone(UplinkPacer.TARGET_MS))

    sender.pumpOnce(0)
    pacer.push(tone(UplinkPacer.FRAME_MS))
    sender.pumpOnce(20_000_000L)
    pacer.push(tone(UplinkPacer.FRAME_MS))
    // 80 ms stall: this wake is 60 ms past its 40 ms deadline.
    sender.pumpOnce(100_000_000L)

    assertThat(transport.sent).hasSize(3)
    val stats = sender.stats()
    assertThat(stats.framesSubmitted).isEqualTo(3L)
    assertThat(stats.skippedTicks).isEqualTo(3L)
    assertThat(stats.tickLateMaxMs).isEqualTo(60L)

    // The deadline is re-based on now, so the very next period is 20 ms out
    // rather than three frames being replayed back to back.
    pacer.push(tone(UplinkPacer.FRAME_MS))
    sender.pumpOnce(120_000_000L)
    assertThat(transport.sent).hasSize(4)
    assertThat(sender.stats().skippedTicks).isEqualTo(3L)
  }

  @Test
  fun everySubmissionGetsItsOwnStorageUntilCompletion() {
    val pacer = UplinkPacer()
    val transport = FakeTransport().apply { autoComplete = false }
    val sender = UplinkSender(pacer, transport, clock = { 0L }, log = {})
    pacer.push(tone(UplinkPacer.TARGET_MS))

    pump(sender, pacer, 5)

    assertThat(transport.sent).hasSize(5)
    // ACS still holds all five, so no two may share an array.
    val identities = transport.sent.mapTo(mutableSetOf()) { System.identityHashCode(it) }
    assertThat(identities).hasSize(5)
    assertThat(transport.sent).allSatisfy { frame ->
      assertThat(frame).hasSize(UplinkPacer.FRAME_BYTES)
      assertThat(frame.all { it == 0x20.toByte() }).isTrue()
    }
    assertThat(sender.stats().inFlight).isEqualTo(5)

    transport.completeAll()
    assertThat(sender.stats().inFlight).isEqualTo(0)
    assertThat(sender.stats().sendFailures).isEqualTo(0L)
  }

  @Test
  fun failedSendIsSurfacedNotSwallowed() {
    val pacer = UplinkPacer()
    val transport = FakeTransport().apply {
      failWith = IllegalStateException("FAILED_TO_SEND_RAW_AUDIO_BUFFER")
    }
    val errors = mutableListOf<String>()
    val sender = UplinkSender(
      pacer,
      transport,
      clock = { 0L },
      log = {},
      logError = { message, _ -> errors.add(message) },
    )
    pacer.push(tone(UplinkPacer.TARGET_MS))

    sender.pumpOnce(0)

    assertThat(sender.stats().sendFailures).isEqualTo(1L)
    assertThat(errors).hasSize(1)
    assertThat(errors[0]).contains("sendRawAudioBuffer failed").contains("total=1")
  }

  @Test
  fun backpressureStopsFeedingWhileAcsIsBehind() {
    val pacer = UplinkPacer()
    val transport = FakeTransport().apply { autoComplete = false }
    val sender = UplinkSender(pacer, transport, clock = { 0L }, log = {})
    pacer.push(tone(UplinkPacer.TARGET_MS))

    pump(sender, pacer, UplinkSender.MAX_IN_FLIGHT + 5)

    assertThat(transport.sent).hasSize(UplinkSender.MAX_IN_FLIGHT)
    assertThat(sender.stats().backpressureDrops).isEqualTo(5L)

    transport.completeAll()
    pump(sender, pacer, 1, from = UplinkSender.MAX_IN_FLIGHT + 5)
    assertThat(transport.sent).hasSize(UplinkSender.MAX_IN_FLIGHT + 1)
  }

  @Test
  fun logsOneP8LinePerSecond() {
    val pacer = UplinkPacer()
    val logs = mutableListOf<String>()
    val sender = UplinkSender(pacer, FakeTransport(), clock = { 0L }, log = { logs.add(it) })
    pacer.push(tone(UplinkPacer.TARGET_MS))

    // 0 .. 1980 ms: one 1 Hz boundary crossed.
    pump(sender, pacer, 100)

    val lines = logs.filter { it.startsWith("P8 audio-up state=") }
    assertThat(lines).hasSize(1)
    assertThat(lines[0])
      .contains("state=RUNNING")
      .contains("depthMs=60")
      .contains("targetMs=60")
      .contains("silenceFrames=0")
      .contains("skippedTicks=0")
      .contains("sendFailures=0")
      .contains("backpressureDrops=0")
  }

  @Test
  fun secondStartIsANoOp() {
    val logs = Collections.synchronizedList(mutableListOf<String>())
    val sender = UplinkSender(UplinkPacer(), FakeTransport(), clock = { 0L }, log = { logs.add(it) })

    sender.start()
    sender.start()
    assertThat(sender.isRunning()).isTrue()
    sender.stop()
    sender.stop()

    assertThat(sender.isRunning()).isFalse()
    assertThat(logs.count { it.contains("sender started") }).isEqualTo(1)
    assertThat(logs.count { it.contains("already started") }).isEqualTo(1)
    assertThat(logs.count { it.contains("sender stopped") }).isEqualTo(1)
  }
}
