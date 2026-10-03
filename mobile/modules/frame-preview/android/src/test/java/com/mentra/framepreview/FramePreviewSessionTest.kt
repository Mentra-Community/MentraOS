package com.mentra.framepreview

import com.mentra.glassesmedia.source.DecodedFrameTap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.After
import org.junit.Before
import org.junit.Test

/**
 * The session end to end on the JVM: the real [DecodedFrameTap] and [CallSource], a fake
 * transport, and the libyuv scaler's JVM fallback. Every `DecodedFrameTap.offer` here stands in
 * for the ACS call site, which must return normally whatever the preview does.
 */
class FramePreviewSessionTest {
  private class FakeTransport : PreviewFrameTransport {
    override var onAuthenticated: (() -> Unit)? = null
    override var onAck: ((Int, Int) -> Unit)? = null
    override var onFailure: ((String, String) -> Unit)? = null
    val sent = CopyOnWriteArrayList<ByteArray>()
    var dropped = 0

    override fun rotateToken(token: String) = Unit

    override fun send(bytes: ByteArray, onSendMeasured: (queueWaitNs: Long, postNs: Long) -> Unit): Boolean {
      sent += bytes.copyOf()
      onSendMeasured(0, 0)
      return true
    }

    override fun dropConsumer() {
      dropped += 1
    }

    override fun destroy() = Unit

    fun authenticate() = onAuthenticated?.invoke()

    fun ackLast() {
      val frame = PreviewFrameParser.parse(sent.last()) as PreviewFrameParser.Result.Ok
      onAck?.invoke(frame.frame.sessionGeneration.toInt(), frame.frame.frameSequence.toInt())
    }
  }

  private val transport = FakeTransport()
  private val logs = CopyOnWriteArrayList<String>()
  private val stops = CopyOnWriteArrayList<String>()
  private val stopped = CountDownLatch(1)
  private lateinit var session: FramePreviewSession

  @Before
  fun setUp() {
    session = FramePreviewSession(transport, trace = PreviewTrace({ _, line -> logs += line }, clockMs = { 0 }))
    session.onStopped = { reason, _ ->
      stops += reason
      stopped.countDown()
    }
    session.setDiagnosticsEnabled(true)
  }

  @After
  fun tearDown() {
    session.close()
    DecodedFrameTap.setTelemetryEnabled(false)
    DecodedFrameTap.drainMetrics()
  }

  private fun startRendering(width: Int = 640, height: Int = 360) {
    session.configure(PreviewConfig(mode = PreviewMode.RENDER, targetWidth = width, targetHeight = height, maxFps = 15))
    session.prepareDocument("token", 1)
    transport.authenticate()
    session.start()
  }

  private fun offerUntil(planes: TestPlanes, timeoutMs: Long = 3000, done: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!done() && System.currentTimeMillis() < deadline) {
      DecodedFrameTap.offer(planes.planes())
      Thread.sleep(10)
    }
    assertThat(done()).describedAs("condition before timeout").isTrue()
  }

  @Test
  fun `a call frame is downscaled into the box and the header reports what was produced`() {
    startRendering()
    val source = TestPlanes(1280, 720, fillY = 0x30)
    offerUntil(source) { transport.sent.isNotEmpty() }
    val frame = (PreviewFrameParser.parse(transport.sent.first()) as PreviewFrameParser.Result.Ok).frame
    assertThat(frame.width to frame.height).isEqualTo(640 to 360)
    assertThat(transport.sent.first().size).isEqualTo(PreviewFrameHeader.BYTE_COUNT + frame.payloadLength)
    assertThat(transport.sent.first()[PreviewFrameHeader.BYTE_COUNT].toInt() and 0xFF).isEqualTo(0x30)
    val status = session.emitStatus()
    assertThat(status["outWidth"]).isEqualTo(640)
    assertThat(status["srcWidth"]).isEqualTo(1280)
  }

  @Test
  fun `a source smaller than the box is sent at its own size`() {
    startRendering()
    offerUntil(TestPlanes(480, 270)) { transport.sent.isNotEmpty() }
    val frame = (PreviewFrameParser.parse(transport.sent.first()) as PreviewFrameParser.Result.Ok).frame
    assertThat(frame.width to frame.height).isEqualTo(480 to 270)
  }

  @Test
  fun `one credit means nothing more is sent until the ack arrives`() {
    startRendering()
    val source = TestPlanes(320, 180)
    offerUntil(source) { transport.sent.size == 1 }
    repeat(20) {
      DecodedFrameTap.offer(source.planes())
      Thread.sleep(5)
    }
    assertThat(transport.sent).hasSize(1)
    transport.ackLast()
    offerUntil(source) { transport.sent.size == 2 }
  }

  @Test
  fun `every retained decoder buffer is released`() {
    startRendering()
    val source = TestPlanes(320, 180)
    offerUntil(source) { transport.sent.size == 1 }
    session.stop("host")
    Thread.sleep(50)
    assertThat(source.releases.get()).isEqualTo(source.retains.get())
  }

  @Test
  fun `a throw in the tap sink is caught, counted, and stops with pack_failed`() {
    startRendering()
    session.injectFault(PreviewFaultKind.SINK_THROW, 0)
    val source = TestPlanes(320, 180)
    // The ACS call site: must return normally.
    DecodedFrameTap.offer(source.planes())
    assertThat(stopped.await(2, TimeUnit.SECONDS)).isTrue()
    assertThat(stops).containsExactly("pack_failed")
    DecodedFrameTap.offer(source.planes())
    val status = session.emitStatus()
    assertThat(status["packFailures"]).isEqualTo(mapOf("sink_error" to 1L))
    assertThat(status["tapSinkExceptions"]).isEqualTo(1L)
    assertThat(logs.any { it.contains("phase=pack_failed") && it.contains("reason=sink_error") }).isTrue()
  }

  @Test
  fun `a throw in the pack worker is caught, counted, and stops with pack_failed`() {
    startRendering()
    session.injectFault(PreviewFaultKind.PACK_THROW, 0)
    offerUntil(TestPlanes(320, 180)) { stops.isNotEmpty() }
    assertThat(stops).containsExactly("pack_failed")
    assertThat(transport.sent).isEmpty()
    assertThat(session.emitStatus()["packFailures"]).isEqualTo(mapOf("worker_error" to 1L))
  }

  @Test
  fun `malformed geometry is rejected before any copy`() {
    startRendering()
    val source = TestPlanes(320, 180)
    val deadline = System.currentTimeMillis() + 2000
    while (stops.isEmpty() && System.currentTimeMillis() < deadline) {
      DecodedFrameTap.offer(source.planes(yBytes = 100))
      Thread.sleep(10)
    }
    assertThat(stops).containsExactly("pack_failed")
    assertThat(transport.sent).isEmpty()
    assertThat(session.emitStatus()["packFailures"]).isEqualTo(mapOf("plane_out_of_bounds" to 1L))
    assertThat(source.releases.get()).isEqualTo(source.retains.get())
  }

  @Test
  fun `dropped acks end in ack_timeout rather than a new credit`() {
    startRendering()
    session.injectFault(PreviewFaultKind.ACK_DROP, 0)
    val source = TestPlanes(320, 180)
    offerUntil(source) { transport.sent.size == 1 }
    transport.ackLast()
    offerUntil(source, timeoutMs = 4000) { stops.isNotEmpty() }
    assertThat(stops).containsExactly("ack_timeout")
    assertThat(transport.sent).hasSize(1)
    assertThat(session.emitStatus()["ackTimeouts"]).isEqualTo(1L)
  }

  @Test
  fun `a closed transport stops with transport_failed`() {
    startRendering()
    session.injectFault(PreviewFaultKind.TRANSPORT_CLOSE, 0)
    offerUntil(TestPlanes(320, 180)) { stops.isNotEmpty() }
    assertThat(stops).containsExactly("transport_failed")
    assertThat(transport.dropped).isEqualTo(1)
  }

  @Test
  fun `stale acks are counted and ignored`() {
    startRendering()
    val source = TestPlanes(320, 180)
    offerUntil(source) { transport.sent.size == 1 }
    transport.onAck?.invoke(99, 1)
    assertThat(session.emitStatus()["staleAcks"]).isEqualTo(1L)
    assertThat(session.emitStatus()["outstanding"]).isEqualTo(1)
  }

  @Test
  fun `a tier change swaps the output without re-attaching the source`() {
    startRendering(640, 360)
    val source = TestPlanes(1280, 720)
    offerUntil(source) { transport.sent.size == 1 }
    val attachLines = logs.count { it.contains("phase=source_attach") }
    session.configure(PreviewConfig(mode = PreviewMode.RENDER, targetWidth = 320, targetHeight = 180, maxFps = 15))
    transport.ackLast()
    offerUntil(source) { transport.sent.size == 2 }
    val frame = (PreviewFrameParser.parse(transport.sent.last()) as PreviewFrameParser.Result.Ok).frame
    assertThat(frame.width to frame.height).isEqualTo(320 to 180)
    assertThat(logs.count { it.contains("phase=source_attach") }).isEqualTo(attachLines)
    assertThat(session.emitStatus()["tierChanges"]).isEqualTo(1L)
  }

  @Test
  fun `release configuration rejects diagnostics and clamps to the product ceiling`() {
    session.setDiagnosticsEnabled(false)
    assertThatThrownBy {
      session.configure(PreviewConfig(source = PreviewSourceKind.SYNTHETIC, mode = PreviewMode.RENDER))
    }.isInstanceOfSatisfying(PreviewRejection::class.java) { assertThat(it.code).isEqualTo("diagnostics_disabled") }
    assertThatThrownBy { session.configure(PreviewConfig(mode = PreviewMode.PACK_ONLY)) }
      .isInstanceOf(PreviewRejection::class.java)
    assertThatThrownBy { session.injectFault(PreviewFaultKind.PACK_THROW, 0) }
      .isInstanceOf(PreviewRejection::class.java)
    session.configure(PreviewConfig(mode = PreviewMode.RENDER, targetWidth = 1280, targetHeight = 720, maxFps = 30))
    val status = session.emitStatus()
    assertThat(status["targetWidth"] to status["targetHeight"]).isEqualTo(640 to 360)
    assertThat(status["targetFps"]).isEqualTo(15)
  }

  @Test
  fun `turning diagnostics off stops a diagnostics-only run`() {
    session.configure(PreviewConfig(source = PreviewSourceKind.SYNTHETIC, mode = PreviewMode.PACK_ONLY, targetWidth = 64, targetHeight = 36))
    session.prepareDocument("token", 1)
    transport.authenticate()
    session.start()
    session.setDiagnosticsEnabled(false)
    assertThat(stops).containsExactly("diagnostics_disabled")
  }

  @Test
  fun `tap telemetry collects call metrics and the ACS send rate with no sink`() {
    session.setTapTelemetry(true)
    session.emitStatus()
    val source = TestPlanes(64, 36)
    repeat(10) {
      DecodedFrameTap.offer(source.planes())
      DecodedFrameTap.recordAcsSend()
      Thread.sleep(5)
    }
    val status = session.emitStatus()
    assertThat(status["tapFramesOffered"]).isEqualTo(10L)
    assertThat(status["tapFramesWithSink"]).isEqualTo(0L)
    assertThat(status["acsSendFps"] as Double).isGreaterThan(0.0)
    assertThat(source.retains.get()).isZero()
  }

  @Test
  fun `status carries every contract counter`() {
    startRendering()
    val status = session.emitStatus()
    assertThat(status.keys).containsAll(FramePreviewSession.CONTRACT_COUNTERS + listOf("acsSendFps", "tapFramesOffered"))
    assertThat(status["packFailures"]).isInstanceOf(Map::class.java)
  }

  @Test
  fun `no line logs a token`() {
    startRendering()
    offerUntil(TestPlanes(320, 180)) { transport.sent.isNotEmpty() }
    session.stop("host")
    assertThat(logs).isNotEmpty
    assertThat(logs.none { it.contains("token=token") }).isTrue()
    assertThat(logs.all { it.startsWith("[PREVIEW_TRACE]") }).isTrue()
  }
}
