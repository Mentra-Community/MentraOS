package com.mentra.acsmeeting.telemetry

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class PipelineStatsTest {
  @Test
  fun conservationHoldsAcrossEveryDisposition() {
    val stats = PipelineStats()
    repeat(4) { stats.onSink() }
    stats.onQueued(); stats.onSub()
    stats.onDropSize()
    stats.onDropBusy()
    stats.onDropNullI420()
    assertThat(stats.conserved()).isTrue()
    assertThat(stats.sinkCount()).isEqualTo(4)
    assertThat(stats.subCount()).isEqualTo(1)
    assertThat(stats.dropCount()).isEqualTo(3)
    assertThat(stats.inFlightCount()).isEqualTo(0)
  }

  @Test
  fun latencyStraddleIsOneHundredPercentOverTenTicks() {
    var clock = 0L
    val stats = PipelineStats { clock }
    val ticks = ArrayList<String>()
    stats.onSink()
    stats.onQueued()
    clock += 1000
    ticks.add(stats.tick())
    stats.onSub()
    repeat(9) {
      clock += 1000
      ticks.add(stats.tick())
    }
    assertThat(stats.subCount()).isEqualTo(stats.sinkCount())
    assertThat(stats.conserved()).isTrue()
    val last = ticks.last()
    assertThat(last).contains("cum{sink=1 sub=1 drop=0 inFlight=0}")
    assertThat(last).doesNotContain("CONSERVE_FAIL")
  }

  @Test
  fun cumulativeCountersNeverDecrease() {
    var clock = 0L
    val stats = PipelineStats { clock }
    stats.onSink(); stats.onQueued(); stats.onSub()
    clock += 1000
    val first = stats.tick()
    clock += 1000
    val idle = stats.tick()
    assertThat(extractCum(first)).isEqualTo(extractCum(idle))
    assertThat(stats.sinkCount()).isEqualTo(1)
    assertThat(stats.subCount()).isEqualTo(1)
  }

  @Test
  fun idleTickStillEmitsSinkZero() {
    var clock = 0L
    val stats = PipelineStats { clock }
    clock += 1000
    val line = stats.tick()
    assertThat(line).startsWith("P6 ladder")
    assertThat(line).contains("sink=0.0")
    assertThat(line).contains("dec=na")
    assertThat(line).contains("wire=na")
    assertThat(line).contains("drop{")
    assertThat(line).contains("ms{")
    assertThat(line).contains("chroma{")
    assertThat(line).contains("cum{sink=0 sub=0 drop=0 inFlight=0}")
  }

  @Test
  fun queuedFrameCountsAsInFlightUntilSettled() {
    val stats = PipelineStats()
    stats.onSink()
    stats.onQueued()
    assertThat(stats.conserved()).isTrue()
    assertThat(stats.inFlightCount()).isEqualTo(1)
    stats.onSub()
    assertThat(stats.inFlightCount()).isEqualTo(0)
    assertThat(stats.conserved()).isTrue()
  }

  /**
   * The device logged 14 CONSERVE_FAIL lines on a pipeline with zero drops.
   * Cause was a tracked inFlight counter read mid-settle, not lost frames.
   */
  @Test
  fun concurrentSendsNeverReportConserveFail() {
    val stats = PipelineStats { 0L }
    val sender = Thread {
      repeat(20_000) {
        stats.onSink()
        stats.onQueued()
        stats.onSub()
      }
    }
    val failures = ArrayList<String>()
    val reader = Thread {
      repeat(20_000) {
        if (!stats.conserved()) failures.add("inFlight=${stats.inFlightCount()}")
      }
    }
    sender.start(); reader.start()
    sender.join(); reader.join()
    assertThat(failures).isEmpty()
    assertThat(stats.inFlightCount()).isEqualTo(0)
    assertThat(stats.tick()).doesNotContain("CONSERVE_FAIL")
  }

  @Test
  fun recvHealthReportsDeltasNotAbsolutes() {
    val stats = PipelineStats { 0L }
    assertThat(stats.recvLabel()).isEqualTo("recv{na}")
    stats.setRecvHealth(
      PipelineStats.RecvHealth(assembled = 100, dropped = 5, packetsLost = 40, nack = 7, pli = 2, freezes = 1),
    )
    assertThat(stats.recvLabel()).contains("drop=5", "lost=40", "nack=7", "pli=2", "freeze=1")
    stats.setRecvHealth(
      PipelineStats.RecvHealth(assembled = 115, dropped = 5, packetsLost = 52, nack = 9, pli = 2, freezes = 3),
    )
    assertThat(stats.recvLabel()).contains("drop=0", "lost=12", "nack=2", "pli=0", "freeze=2")
  }

  @Test
  fun recvHealthAveragesPerFrameTimings() {
    val stats = PipelineStats { 0L }
    stats.setRecvHealth(
      PipelineStats.RecvHealth(
        assembled = 200,
        decodeSec = 0.8,
        jitterBufferSec = 12.0,
        jitterBufferEmits = 200,
        jitter = 0.015,
      ),
    )
    val label = stats.recvLabel()
    assertThat(label).contains("decMs=4.0")
    assertThat(label).contains("jbMs=60.0")
    assertThat(label).contains("jit=15.0")
  }

  @Test
  fun recvHealthToleratesMissingMembers() {
    val stats = PipelineStats { 0L }
    stats.setRecvHealth(PipelineStats.RecvHealth())
    val label = stats.recvLabel()
    assertThat(label).contains("drop=na", "lost=na", "decMs=na", "jbMs=na")
    assertThat(stats.tick()).contains("recv{")
  }

  @Test
  fun ladderIncludesArmLabel() {
    var clock = 0L
    val stats = PipelineStats { clock }
    clock += 1000
    assertThat(stats.tick()).contains("arm=whep")
    stats.arm = "synthetic"
    clock += 1000
    assertThat(stats.tick()).contains("arm=synthetic")
  }

  @Test
  fun ladderExposesRecvRateSeparateFromDecode() {
    var clock = 0L
    val stats = PipelineStats { clock }
    stats.recvFps = 14.8
    stats.decodedFps = 8.1
    clock += 1000
    val line = stats.tick()
    assertThat(line).contains("recv=14.8")
    assertThat(line).contains("dec=8.1")
  }

  private fun extractCum(line: String): String =
    Regex("""cum\{[^}]+\}""").find(line)?.value ?: line
}
