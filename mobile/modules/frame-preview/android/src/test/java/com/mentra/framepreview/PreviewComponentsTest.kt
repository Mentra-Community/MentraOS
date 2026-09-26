package com.mentra.framepreview

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.Test

class PreviewSlotPoolTest {
  @Test
  fun `never hands out a slot that is still held`() {
    val pool = PreviewSlotPool(slotCount = 2)
    val first = pool.acquire(100, 1)!!
    val second = pool.acquire(100, 2)!!
    assertThat(first.bytes).isNotSameAs(second.bytes)
    assertThat(pool.acquire(100, 3)).isNull()
    pool.release(first)
    assertThat(pool.acquire(100, 4)!!.bytes).isSameAs(first.bytes)
  }

  @Test
  fun `reallocates only when the produced size changes`() {
    val pool = PreviewSlotPool()
    repeat(10) { sequence -> pool.release(pool.acquire(100, sequence)!!) }
    assertThat(pool.reallocations).isEqualTo(1)
    pool.release(pool.acquire(200, 11)!!)
    assertThat(pool.reallocations).isEqualTo(2)
    pool.prepare(200)
    assertThat(pool.reallocations).isEqualTo(2)
  }

  @Test
  fun `a reshape retires held slots instead of reusing them`() {
    val pool = PreviewSlotPool(slotCount = 1)
    val held = pool.acquire(100, 1)!!
    val next = pool.acquire(200, 2)!!
    assertThat(next.bytes).isNotSameAs(held.bytes)
    // The old holder's late release must not free the new epoch's slot.
    pool.release(held)
    assertThat(pool.heldCount()).isEqualTo(1)
    assertThat(pool.acquire(200, 3)).isNull()
  }

  @Test
  fun `an ack frees the slot carrying its sequence`() {
    val pool = PreviewSlotPool(slotCount = 1)
    pool.acquire(64, 7)!!
    pool.releaseSequence(6)
    assertThat(pool.acquire(64, 8)).isNull()
    pool.releaseSequence(7)
    assertThat(pool.acquire(64, 8)).isNotNull
  }
}

class BoxI420ScalerTest {
  @Test
  fun `a two to one reduction averages each two by two box`() {
    val source = TestPlanes(4, 2, fillY = 0, padding = 3).planes()
    // Luma row 0: 0 20 40 60, row 1: 100 120 140 160.
    val values = intArrayOf(0, 20, 40, 60, 100, 120, 140, 160)
    for (index in values.indices) {
      val row = index / 4
      val col = index % 4
      source.y.put(row * (4 + 3) + col, values[index].toByte())
    }
    val out = ByteArray(PreviewPixelFormat.I420.packedSize(2, 1))
    BoxI420Scaler.scale(source, PreviewSize(2, 1), out, 0)
    assertThat(out[0].toInt() and 0xFF).isEqualTo((0 + 20 + 100 + 120) / 4)
    assertThat(out[1].toInt() and 0xFF).isEqualTo((40 + 60 + 140 + 160) / 4)
  }

  @Test
  fun `flat planes stay flat and land in Y U V order`() {
    val source = TestPlanes(1280, 720, fillY = 0x11, fillU = 0x22, fillV = 0x33).planes()
    val out = ByteArray(PreviewFrameHeader.BYTE_COUNT + PreviewPixelFormat.I420.packedSize(640, 360))
    BoxI420Scaler.scale(source, PreviewSize(640, 360), out, PreviewFrameHeader.BYTE_COUNT)
    val luma = 640 * 360
    val chroma = 320 * 180
    val base = PreviewFrameHeader.BYTE_COUNT
    assertThat(out.copyOfRange(base, base + luma).toSet()).containsExactly(0x11.toByte())
    assertThat(out.copyOfRange(base + luma, base + luma + chroma).toSet()).containsExactly(0x22.toByte())
    assertThat(out.copyOfRange(base + luma + chroma, base + luma + 2 * chroma).toSet()).containsExactly(0x33.toByte())
  }

  @Test
  fun `the libyuv scaler falls back when WebRTC's native library is absent`() {
    val reasons = mutableListOf<String>()
    val scaler = LibyuvI420Scaler(onFallback = { reasons += it })
    val source = TestPlanes(64, 36, fillY = 0x50).planes()
    val out = ByteArray(PreviewPixelFormat.I420.packedSize(32, 18))
    scaler.scale(source, PreviewSize(32, 18), out, 0)
    scaler.scale(source, PreviewSize(32, 18), out, 0)
    assertThat(out.copyOfRange(0, 32 * 18).toSet()).containsExactly(0x50.toByte())
    assertThat(scaler.fallbackFrames).isEqualTo(2)
    assertThat(reasons).hasSize(1)
  }
}

class PreviewDiagnosticsPolicyTest {
  @Test
  fun `release configuration allows only the call source rendering`() {
    assertThat(PreviewDiagnosticsPolicy.check(PreviewConfig(mode = PreviewMode.RENDER), false)).isNull()
    assertThat(PreviewDiagnosticsPolicy.check(PreviewConfig(mode = PreviewMode.OFF), false)).isNull()
  }

  @Test
  fun `release configuration rejects synthetic sources, diagnostic modes and knobs`() {
    val rejected = listOf(
      PreviewConfig(source = PreviewSourceKind.SYNTHETIC, mode = PreviewMode.RENDER),
      PreviewConfig(mode = PreviewMode.GENERATE_ONLY),
      PreviewConfig(mode = PreviewMode.PACK_ONLY),
      PreviewConfig(mode = PreviewMode.RECEIVE_DISCARD),
      PreviewConfig(mode = PreviewMode.RENDER, noiseAmplitude = 10),
      PreviewConfig(mode = PreviewMode.RENDER, consumerDelayMs = 50),
    )
    for (config in rejected) {
      assertThat(PreviewDiagnosticsPolicy.check(config, false)).describedAs(config.toString()).isEqualTo("diagnostics_disabled")
      assertThat(PreviewDiagnosticsPolicy.check(config, true)).describedAs(config.toString()).isNull()
    }
  }

  @Test
  fun `configure options parse per the JS contract`() {
    val config = PreviewConfig.fromMap(
      mapOf(
        "source" to "synthetic",
        "mode" to "pack_only",
        "targetWidth" to 320,
        "targetHeight" to 180.0,
        "maxFps" to 15,
        "diagnostics" to mapOf("noiseAmplitude" to 12, "consumerDelayMs" to 40),
      ),
    )
    assertThat(config).isEqualTo(PreviewConfig(PreviewSourceKind.SYNTHETIC, PreviewMode.PACK_ONLY, 320, 180, 15, 12, 40))
    assertThatThrownBy { PreviewConfig.fromMap(mapOf("mode" to "turbo")) }.isInstanceOf(IllegalArgumentException::class.java)
    assertThatThrownBy { PreviewConfig.fromMap(mapOf("source" to "glasses")) }.isInstanceOf(IllegalArgumentException::class.java)
  }

  @Test
  fun `one-shot faults disarm when taken`() {
    val faults = PreviewFaults()
    faults.arm(PreviewFaultKind.PACK_THROW)
    assertThat(faults.takePackThrow()).isTrue()
    assertThat(faults.takePackThrow()).isFalse()
    faults.arm(PreviewFaultKind.ACK_DELAY, 250)
    faults.arm(PreviewFaultKind.ACK_DROP)
    assertThat(faults.anyArmed).isTrue()
    faults.arm(PreviewFaultKind.CLEAR)
    assertThat(faults.anyArmed).isFalse()
  }
}

class PreviewTraceTest {
  @Test
  fun `lines carry the marker, ids, phase and monotonic time`() {
    val lines = mutableListOf<String>()
    val trace = PreviewTrace({ _, line -> lines += line }, clockMs = { 42 })
    trace.traceId = "abc123"
    trace.docGen = 3
    trace.tapGeneration = 9
    trace.info("source_attach", mapOf("reason" to "host stop"))
    assertThat(lines.single())
      .isEqualTo("[PREVIEW_TRACE] previewTraceId=abc123 phase=source_attach t=42 docGen=3 gen=9 reason=\"host stop\"")
  }

  @Test
  fun `tokens and meeting urls are redacted and url secrets stripped`() {
    val line = PreviewTrace.format(
      "",
      "transport_bind",
      1,
      mapOf(
        "token" to "secret-token",
        "meetingUrl" to "https://teams.example/join/1",
        "url" to "ws://127.0.0.1:5000/preview?token=abc",
      ),
    )
    assertThat(line).doesNotContain("secret-token").doesNotContain("teams.example").doesNotContain("abc")
    assertThat(line).contains("token=<redacted>").contains("url=ws://127.0.0.1:5000/preview?<redacted>")
  }

  @Test
  fun `repeated warnings log once and then a count per window`() {
    var now = 0L
    val lines = mutableListOf<String>()
    val trace = PreviewTrace({ _, line -> lines += line }, clockMs = { now })
    repeat(5) { trace.warnLimited("stale", "stale_ack") }
    assertThat(lines).hasSize(1)
    now = 10_000
    trace.warnLimited("stale", "stale_ack")
    assertThat(lines).hasSize(2)
    assertThat(lines.last()).contains("suppressed=4")
    trace.warnLimited("stale", "stale_ack")
    now = 20_001
    trace.flushLimited()
    assertThat(lines.last()).contains("phase=repeated_warning").contains("suppressed=1")
  }
}
