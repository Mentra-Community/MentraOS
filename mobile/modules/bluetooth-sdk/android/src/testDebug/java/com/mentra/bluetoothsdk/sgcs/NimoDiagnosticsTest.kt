package com.mentra.bluetoothsdk.sgcs

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
class NimoDiagnosticsTest {
  private data class Write(val packet: ByteArray, val completed: () -> Unit)
  private val writes = mutableListOf<Write>()
  private var heldReady: (() -> Unit)? = null
  private val holdReleases = mutableListOf<Boolean>()
  private lateinit var diagnostics: NimoDiagnostics
  private lateinit var root: File
  private lateinit var previousDirectories: Set<String>

  @Before fun setup() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    root = File(context.filesDir, "nimo-framebuffer")
    previousDirectories = root.listFiles()?.map { it.name }?.toSet() ?: emptySet()
    diagnostics = NimoDiagnostics(
      context,
      Handler(Looper.getMainLooper()),
      { frame, complete -> writes.add(Write(frame.copyOf(), complete)); true },
      { ready -> heldReady = ready },
      { resume -> holdReleases += resume },
    )
    diagnostics.connected(512)
  }

  @After fun dispose() { diagnostics.close() }

  @Test fun probePreservesNotReadyAndAcceptsResponsesBeforeWriteCallbacks() {
    start("probe")
    driveToPageGate()
    assertTrue(diagnostics.onPacket(fbpReply(writes[3].packet, ByteArray(240))))
    val result = receipt()
    assertTrue(result.getBoolean("probe_ok"))
    assertFalse(result.getBoolean("ok"))
    assertTrue(result.isNull("error"))
    assertEquals(0, result.getJSONObject("readiness").getInt("ready"))
    assertEquals(1, result.getJSONObject("readiness").getInt("tws"))
    assertEquals(NimoFramebufferProtocol.EXPECTED_VERSION, result.getString("runtime_version"))
    assertEquals(8, result.getInt("wire_events"))
    assertEquals(8, File(captureDirectory(), "wire.jsonl").readLines().size)
    writes.toList().forEach { it.completed() }
    idle(4_000)
    assertEquals(4, writes.size)
    assertTrue(receipt().getBoolean("probe_ok"))
    assertTrue(writes.all { it.packet[8] == 2.toByte() && (it.packet[9].toInt() and 255) in listOf(0x0B, 0x19, 0x15) })
  }

  @Test fun duplicateTriggerDoesNotStartAnotherRead() {
    start("capture")
    start("probe")
    assertEquals(1, writes.size)
    assertEquals(1, newDirectories().size)
  }

  @Test fun disconnectCancelsPendingTimeoutAndIgnoresLateWriteCompletion() {
    start("capture")
    writes.single().completed()
    diagnostics.disconnected()
    val error = receipt().getString("error")
    assertTrue(error.contains("disconnected"))
    diagnostics.connected(512)
    writes.single().completed()
    idle(4_000)
    assertEquals(error, receipt().getString("error"))
    assertEquals(1, writes.size)
    assertFalse(diagnostics.onPacket(versionReply()))
    assertFalse(receipt().getBoolean("ok"))
  }

  @Test fun timeoutStartsAtWriteCompletionAndDoesNotRetry() {
    start("probe")
    idle(5_000)
    assertFalse(File(captureDirectory(), "session.json").exists())
    writes.single().completed()
    idle(2_900)
    assertFalse(File(captureDirectory(), "session.json").exists())
    idle(200)
    assertTrue(receipt().getString("error").contains("response timeout"))
    assertEquals(1, writes.size)
  }

  @Test fun captureRejectsCrcBeforeRequestingBulkPages() {
    start("capture")
    driveToPageGate()
    val corrupted = fbpReply(writes[3].packet, ByteArray(240)).also { it[4] = (it[4].toInt() xor 1).toByte() }
    assertTrue(diagnostics.onPacket(corrupted))
    assertFalse(receipt().getBoolean("ok"))
    assertFalse(receipt().getBoolean("probe_ok"))
    assertTrue(receipt().getString("error").contains("CRC mismatch"))
    assertEquals(4, writes.size)
    assertEquals(0, receipt().getJSONArray("banks").length())
  }

  @Test fun totalDeadlineBoundsAWriteThatNeverCompletes() {
    start("capture")
    idle(600_001)
    assertTrue(receipt().getString("error").contains("10-minute budget"))
    writes.single().completed()
    idle(4_000)
    assertEquals(1, writes.size)
  }

  @Test fun heldSampleBudgetIncludesCanvasDrainAndStaleReadyCannotStartCapture() {
    start("held-sample")
    assertTrue(writes.isEmpty())
    assertNotNull(heldReady)

    idle(15_001)

    assertEquals(listOf(true), holdReleases)
    assertTrue(receipt().getString("error").contains("15-second budget"))
    heldReady?.invoke()
    assertTrue(writes.isEmpty())
    assertEquals(listOf(true), holdReleases)
  }

  @Test fun disconnectBeforeHeldCaptureIsReadyReleasesWithoutResumingCanvas() {
    start("held-capture")

    diagnostics.disconnected()

    assertEquals(listOf(false), holdReleases)
    assertTrue(receipt().getString("error").contains("disconnected"))
    heldReady?.invoke()
    assertTrue(writes.isEmpty())
    assertEquals(listOf(false), holdReleases)
  }

  @Test fun duplicateHeldCaptureDoesNotReplaceHoldOrDeadline() {
    start("held-sample")
    val firstReady = heldReady

    start("held-capture")

    assertSame(firstReady, heldReady)
    assertEquals(1, newDirectories().size)
    idle(15_001)
    assertEquals(listOf(true), holdReleases)
  }

  @Test fun insufficientCapacityFailsWithoutSendingDiagnosticCommands() {
    diagnostics.connected(20)
    start("capture")
    assertEquals(0, writes.size)
    assertTrue(receipt().getString("error").contains("Write capacity"))
  }

  @Test fun samplePinsPreparedBankAndNeverClaimsStaticPairVerification() {
    assertSample(1)
  }

  @Test fun sampleAlsoPinsPreparedBankZero() {
    assertSample(0)
  }

  @Test fun heldSampleStartsOnlyAfterDrainAndReleasesOnSuccess() {
    assertSample(1, "held-sample")
    assertEquals(listOf(true), holdReleases)
  }

  private fun assertSample(bank: Int, mode: String = "sample") {
    val state = byteArrayOf((1 - bank).toByte(), bank.toByte(), 0, 0)
    start(mode)
    if (mode == "held-sample") {
      assertTrue(writes.isEmpty())
      requireNotNull(heldReady).invoke()
    }
    driveToPageGate()
    diagnostics.onPacket(fbpReply(writes.last().packet, ByteArray(240), state))
    // The gate always probes bank0/page0; the sample follows its prepared selector.
    repeat(315) { page ->
      val request = writes.last().packet
      assertEquals(bank, request[21].toInt())
      assertEquals(page, (request[22].toInt() and 255) or ((request[23].toInt() and 255) shl 8))
      diagnostics.onPacket(fbpReply(request, ByteArray(240) { page.toByte() }, state))
    }
    val result = receipt()
    assertTrue(result.getBoolean("sample_ok"))
    assertFalse(result.getBoolean("ok"))
    assertFalse(result.getBoolean("atomic"))
    assertFalse(result.getBoolean("optical"))
    assertEquals("non_atomic_single_pass", result.getString("evidence_kind"))
    assertEquals(0, result.getInt("static_pairs_verified"))
    assertEquals(1, result.getJSONArray("banks").length())
    assertEquals(319, writes.size)
    assertEquals(638, result.getInt("wire_events"))
    assertFalse(result.getBoolean("pixel_stability_verified"))
    assertEquals(mode, result.getString("mode"))
    assertEquals(75_600, File(captureDirectory(), "bank$bank-pass1.bin").length().toInt())
  }

  @Test fun sampleRejectsSelectorChangeBetweenGateAndFirstPageWithoutRetrying() {
    start("sample")
    driveToPageGate()
    diagnostics.onPacket(fbpReply(writes.last().packet, ByteArray(240)))
    diagnostics.onPacket(fbpReply(writes.last().packet, ByteArray(240), byteArrayOf(1, 0, 0, 0)))
    val result = receipt()
    assertFalse(result.getBoolean("sample_ok"))
    assertFalse(result.getBoolean("ok"))
    assertTrue(result.getString("error").contains("Sample metadata differs from page gate"))
    assertEquals(5, writes.size)
    assertEquals(0, result.getJSONArray("banks").length())
  }

  @Test fun sampleTimeoutCannotProduceSuccessOrStartASecondPass() {
    start("sample")
    driveToPageGate()
    diagnostics.onPacket(fbpReply(writes.last().packet, ByteArray(240)))
    writes.last().completed()
    idle(3_001)
    assertFalse(receipt().getBoolean("sample_ok"))
    assertFalse(receipt().getBoolean("ok"))
    assertEquals(5, writes.size)
  }

  @Test fun fullCaptureStillRequiresFourCompleteReadsAndTwoStaticPairs() {
    start("capture")
    driveToPageGate()
    diagnostics.onPacket(fbpReply(writes.last().packet, ByteArray(240)))
    repeat(4) { pass ->
      repeat(315) { page ->
        val request = writes.last().packet
        assertEquals(pass / 2, request[21].toInt())
        diagnostics.onPacket(fbpReply(request, ByteArray(240) { page.toByte() }))
      }
      if (pass < 3) assertFalse(File(captureDirectory(), "session.json").exists())
    }
    assertTrue(receipt().getBoolean("ok"))
    assertEquals(2, receipt().getInt("static_pairs_verified"))
    assertEquals(4, receipt().getJSONArray("banks").length())
    assertEquals(1264, writes.size)
  }

  private fun driveToPageGate() {
    assertEquals(1, writes.size)
    assertFalse(diagnostics.onPacket(versionReply()))
    assertEquals(2, writes.size)
    assertFalse(diagnostics.onPacket(frame(0x19, byteArrayOf(0, 0, 1, 0))))
    assertEquals(3, writes.size)
    assertTrue(diagnostics.onPacket(fbpReply(writes[2].packet, "537cf1p1".toByteArray())))
    assertEquals(4, writes.size)
  }

  // Exercise the production coordinator without pretending Robolectric proves Android's
  // signature-permission enforcement for the ADB receiver. That boundary needs a device test.
  private fun start(mode: String) {
    NimoDiagnostics::class.java.getDeclaredMethod("start", String::class.java).apply { isAccessible = true }
      .invoke(diagnostics, mode)
  }
  private fun idle(milliseconds: Long) = Shadows.shadowOf(Looper.getMainLooper()).idleFor(milliseconds, TimeUnit.MILLISECONDS)
  private fun newDirectories() = root.listFiles()?.filter { it.name !in previousDirectories } ?: emptyList()
  private fun captureDirectory() = newDirectories().single()
  private fun receipt() = JSONObject(File(captureDirectory(), "session.json").readText())
  private fun versionReply() = frame(0x0B, byteArrayOf(0) + NimoFramebufferProtocol.EXPECTED_VERSION.toByteArray())

  private fun fbpReply(request: ByteArray, data: ByteArray, state: ByteArray = byteArrayOf(0, 1, 0, 0)): ByteArray {
    val payload = byteArrayOf(0) + "FBP1".toByteArray() + request.copyOfRange(16, 24) + state + state +
      byteArrayOf(data.size.toByte(), (data.size shr 8).toByte()) + data
    return frame(0x15, payload)
  }
  private fun frame(key: Int, payload: ByteArray): ByteArray {
    val body = byteArrayOf(2, key.toByte(), payload.size.toByte(), (payload.size shr 8).toByte()) + payload
    val crc = NimoCanvasCodec.crc16(body)
    return byteArrayOf(0xBF.toByte(), 0, body.size.toByte(), (body.size shr 8).toByte(),
      crc.toByte(), (crc shr 8).toByte(), 0, 0) + body
  }
}
