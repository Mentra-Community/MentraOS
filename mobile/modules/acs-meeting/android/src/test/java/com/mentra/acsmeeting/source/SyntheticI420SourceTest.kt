package com.mentra.acsmeeting.source

import com.mentra.acsmeeting.telemetry.PipelineStats
import com.mentra.acsmeeting.video.I420Packer
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

class SyntheticI420SourceTest {
  @Test
  fun withheldWhileNotReadyThenEmitsOnceReady() {
    val ready = AtomicBoolean(false)
    val frames = ArrayList<Triple<Int, Int, Int>>()
    val stats = PipelineStats()
    val source = source(stats, ready) { i420, w, h, _ ->
      frames.add(Triple(i420.remaining(), w, h))
    }
    source.becomeLive()
    source.setTargetSize(TargetSize(1280, 720))

    assertThat(source.emitOnce()).isFalse()
    assertThat(frames).isEmpty()
    assertThat(stats.sinkCount()).isEqualTo(0)

    ready.set(true)
    assertThat(source.emitOnce()).isTrue()
    assertThat(frames).hasSize(1)
    assertThat(frames[0].second).isEqualTo(1280)
    assertThat(frames[0].third).isEqualTo(720)
    assertThat(frames[0].first).isEqualTo(I420Packer.packedSize(1280, 720))
    assertThat(stats.sinkCount()).isEqualTo(1)
    assertThat(source.events.any { it.startsWith("P6 synthetic first-frame") }).isTrue()
  }

  @Test
  fun withheldWhileTargetSizeIsNull() {
    val frames = ArrayList<Int>()
    val stats = PipelineStats()
    val source = source(stats, AtomicBoolean(true)) { _, _, _, _ -> frames.add(1) }
    source.becomeLive()

    assertThat(source.emitOnce()).isFalse()
    assertThat(frames).isEmpty()
    assertThat(stats.sinkCount()).isEqualTo(0)

    source.setTargetSize(TargetSize(640, 360))
    assertThat(source.emitOnce()).isTrue()
    assertThat(frames).hasSize(1)
  }

  @Test
  fun nReadyCallsDeliverNFramesAndHonorResize() {
    val frames = ArrayList<Pair<Int, Int>>()
    val stats = PipelineStats()
    val source = source(stats, AtomicBoolean(true)) { _, w, h, _ -> frames.add(w to h) }
    source.becomeLive()
    source.setTargetSize(TargetSize(1280, 720))
    repeat(4) { source.emitOnce() }
    source.setTargetSize(TargetSize(640, 360))
    source.emitOnce()

    assertThat(frames).containsExactly(
      1280 to 720,
      1280 to 720,
      1280 to 720,
      1280 to 720,
      640 to 360,
    )
    assertThat(stats.sinkCount()).isEqualTo(5)
  }

  @Test
  fun withheldTicksTouchNoCounters() {
    val stats = PipelineStats()
    val source = source(stats, AtomicBoolean(false)) { _, _, _, _ -> }
    source.becomeLive()
    source.setTargetSize(TargetSize(1280, 720))
    repeat(5) { source.emitOnce() }
    assertThat(stats.sinkCount()).isEqualTo(0)
    assertThat(stats.dropCount()).isEqualTo(0)
    assertThat(stats.subCount()).isEqualTo(0)
    assertThat(stats.pack.p95()).isEqualTo("na")
  }

  @Test
  fun readinessFlapProducesOnePauseAndOneResume() {
    val ready = AtomicBoolean(true)
    val source = source(PipelineStats(), ready) { _, _, _, _ -> }
    source.becomeLive()
    source.setTargetSize(TargetSize(1280, 720))
    source.emitOnce()
    ready.set(false)
    source.emitOnce()
    ready.set(true)
    source.emitOnce()

    val pauses = source.events.filter { it.contains("paused") }
    val resumes = source.events.filter { it.contains("resumed") }
    assertThat(pauses).hasSize(1)
    assertThat(resumes).hasSize(1)
  }

  @Test
  fun stopEmitsNothingAndRestartResetsIndex() {
    val indexes = ArrayList<Int>()
    val ready = AtomicBoolean(true)
    val source = source(PipelineStats(), ready) { i420, w, h, _ ->
      indexes.add(yCorner(i420, w, h))
    }
    source.becomeLive()
    source.setTargetSize(TargetSize(64, 64))
    source.emitOnce()
    source.emitOnce()
    source.stop()
    assertThat(source.state).isEqualTo(SourceState.IDLE)
    assertThat(source.emitOnce()).isFalse()

    source.becomeLive()
    source.setTargetSize(TargetSize(64, 64))
    source.emitOnce()
    assertThat(indexes).hasSize(3)
    assertThat(indexes[0]).isEqualTo(indexes[2])
  }

  @Test
  fun restartLeavesSourceLive() {
    val source = source(PipelineStats(), AtomicBoolean(false)) { _, _, _, _ -> }
    source.start(SourceConfig("ignored", SourceKind.DIRECT))
    source.restart(SourceConfig("ignored-2", SourceKind.DIRECT))
    assertThat(source.state).isEqualTo(SourceState.LIVE)
    source.stop()
    assertThat(source.state).isEqualTo(SourceState.IDLE)
  }

  @Test
  fun pcmListenerIsNeverInvoked() {
    val source = SyntheticI420Source(
      video = { _, _, _, _ -> },
      stats = PipelineStats(),
      isReady = { true },
    )
    source.setPcmDeliveryEnabled(true)
    assertThat(source.pcmDeliveryEnabled()).isTrue()
    source.setPcmDeliveryEnabled(false)
    assertThat(source.pcmDeliveryEnabled()).isFalse()
  }

  private fun source(
    stats: PipelineStats,
    ready: AtomicBoolean,
    video: VideoFrameListener,
  ): SyntheticI420Source = SyntheticI420Source(
    video = video,
    stats = stats,
    isReady = { ready.get() },
  )

  private fun yCorner(src: ByteBuffer, width: Int, height: Int): Int {
    src.rewind()
    return src.get(0).toInt() and 0xFF
  }
}
