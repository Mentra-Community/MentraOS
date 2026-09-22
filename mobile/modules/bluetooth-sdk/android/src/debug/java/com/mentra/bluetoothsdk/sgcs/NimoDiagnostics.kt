package com.mentra.bluetoothsdk.sgcs

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID

/** ADB-only, debug-build framebuffer capture on the existing owning GATT connection.
 *
 * No display, lifecycle, firmware, memory-address, or arbitrary-command controls are exposed.
 * Captures are private device files, not application events or cloud logs. Two matching reads
 * are non-atomic panel-memory evidence, not proof of light emitted by the display.
 */
internal class NimoDiagnostics(
  context: Context,
  private val handler: Handler,
  private val send: (ByteArray, () -> Unit) -> Boolean,
  private val requestCanvasHold: ((() -> Unit) -> Unit) = { ready -> ready() },
  private val releaseCanvasHold: (resume: Boolean) -> Unit = {},
) {
  private val context = context.applicationContext
  private val random = SecureRandom()
  private var generation = 0L
  private var maxWriteBytes = 0
  private var registered = false
  private var closed = false
  private var active: Capture? = null

  private enum class Stage { VERSION, READINESS, PING, GATE, PAGE }
  private class Step(val stage: Stage, val request: NimoFramebufferProtocol.Request? = null) {
    var timeout: Runnable? = null
  }
  private class Capture(val mode: String, val directory: File, val generation: Long) {
    val started = SystemClock.elapsedRealtime()
    val startedWallTime = System.currentTimeMillis()
    val wire: BufferedWriter = File(directory, "wire.jsonl").bufferedWriter()
    val nonces = mutableSetOf<Long>()
    val banks = mutableListOf<NimoFramebufferProtocol.BankRead>()
    val bankReceipts = JSONArray()
    var wireCount = 0
    var version: String? = null
    var readiness: List<Int>? = null
    var pending: Step? = null
    var deadline: Runnable? = null
    var currentBank: NimoFramebufferProtocol.BankRead? = null
    var probeOk = false
    var verifiedBanks = 0
    var sampleState: NimoFramebufferProtocol.State? = null
    var readStarted: Long? = null
    var readFinished: Long? = null
    var holdRequested = false
    var holdReleased = false
  }

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      requireMain()
      if (intent?.action != ACTION) return
      val mode = intent.getStringExtra("mode") ?: "probe"
      if (mode !in listOf("probe", "capture", "sample", "held-capture", "held-sample")) {
        Log.w(TAG, "Rejected unsupported mode")
        return
      }
      start(mode)
    }
  }

  fun connected(maxWriteBytes: Int) {
    requireMain()
    if (closed) return
    disconnected()
    this.maxWriteBytes = maxWriteBytes
    try {
      val filter = IntentFilter(ACTION)
      if (Build.VERSION.SDK_INT >= 33) {
        context.registerReceiver(receiver, filter, "android.permission.DUMP", handler, Context.RECEIVER_EXPORTED)
      } else {
        @Suppress("DEPRECATION")
        context.registerReceiver(receiver, filter, "android.permission.DUMP", handler)
      }
      registered = true
      Log.i(TAG, "ADB diagnostic receiver ready; write capacity=$maxWriteBytes")
    } catch (error: RuntimeException) {
      Log.w(TAG, "Diagnostic receiver unavailable: ${error.javaClass.simpleName}")
    }
  }

  fun disconnected() {
    requireMain()
    generation += 1
    active?.let { finish(it, "GATT disconnected or connection generation changed", resumeHeldCanvas = false) }
    maxWriteBytes = 0
    if (registered) {
      registered = false
      try { context.unregisterReceiver(receiver) } catch (_: IllegalArgumentException) { }
    }
  }

  fun close() {
    requireMain()
    disconnected()
    closed = true
  }

  fun cancelHeldCapture(reason: String, resumeCanvas: Boolean = false) {
    requireMain()
    val capture = active ?: return
    if (isHeld(capture.mode)) finish(capture, reason, resumeCanvas)
  }

  /** Called only for notifications from the owning NIMO response characteristic. */
  fun onPacket(packet: ByteArray): Boolean {
    requireMain()
    val capture = active ?: return false
    if (packet.size < 10 || packet[8].toInt() != 2) return false
    val key = packet[9].toInt() and 255
    if (key !in listOf(0x0B, 0x19, 0x15)) return false
    try {
      recordWire(capture, "rx", packet)
      val step = capture.pending
      when (key) {
        0x0B -> {
          val payload = NimoFramebufferProtocol.basicPayload(packet, key)
          capture.version = if (payload.isNotEmpty()) payload.copyOfRange(1, payload.size).toString(Charsets.US_ASCII) else ""
          NimoFramebufferProtocol.version(packet)
          if (step?.stage == Stage.VERSION) {
            completeStep(capture, step)
            request(capture, Step(Stage.READINESS))
          }
        }
        0x19 -> {
          capture.readiness = NimoFramebufferProtocol.readiness(packet)
          val state = capture.readiness!!
          Log.i(TAG, "Readiness status=${state[0]} ready=${state[1]} tws=${state[2]} peerGatt=${state[3]}")
          if (step?.stage == Stage.READINESS) {
            completeStep(capture, step)
            request(capture, Step(Stage.PING, NimoFramebufferProtocol.Request(nonce(capture), 0, 0, 0)))
          }
        }
        0x15 -> {
          require(step != null && step.request != null) { "Unexpected FBP1 response without a pending request" }
          val reply = NimoFramebufferProtocol.reply(packet, step.request)
          completeStep(capture, step)
          when (step.stage) {
            Stage.PING -> request(capture, Step(Stage.GATE, NimoFramebufferProtocol.Request(nonce(capture), 1, 0, 0)))
            Stage.GATE -> {
              // A complete 275-byte response must succeed before any bulk read is attempted.
              capture.probeOk = true
              if (isSample(capture.mode)) capture.sampleState = reply.after
              Log.i(TAG, "FBP1 identity and full-page gate verified; mode=${capture.mode}")
              if (capture.mode == "probe") finish(capture, null) else nextBank(capture)
            }
            Stage.PAGE -> acceptPage(capture, reply)
            else -> throw IllegalArgumentException("FBP1 response arrived in an invalid phase")
          }
        }
      }
    } catch (error: Exception) {
      finish(capture, "${error.javaClass.simpleName}: ${error.message?.take(160)}")
    }
    // Basic responses remain visible to the production handshake. Private FBP1 never enters
    // the legacy assembler, whose response length convention is different.
    return key == 0x15
  }

  private fun start(mode: String) {
    if (closed || !registered) return
    if (active != null) { Log.w(TAG, "Capture already running; ignored duplicate request"); return }
    val capture = try {
      val root = File(context.filesDir, "nimo-framebuffer")
      require(root.isDirectory || root.mkdirs()) { "Cannot create private capture directory" }
      val directory = File(root, "${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(8)}")
      require(directory.mkdir()) { "Cannot create unique capture directory" }
      Capture(mode, directory, generation)
    } catch (error: Exception) {
      Log.e(TAG, "Cannot begin private capture: ${error.javaClass.simpleName}")
      return
    }
    active = capture
    Log.i(TAG, "Starting $mode; files=${capture.directory.absolutePath}")
    if (maxWriteBytes < 24) { finish(capture, "Write capacity below 24-byte diagnostic request"); return }
    val budgetMs = when (mode) {
      "held-sample" -> 15_000L
      "held-capture" -> 55_000L
      else -> 600_000L
    }
    val budgetDescription = when (mode) {
      "held-sample" -> "15-second budget"
      "held-capture" -> "55-second budget"
      else -> "10-minute budget"
    }
    val deadline = Runnable {
      if (active === capture) finish(capture, "Capture exceeded $budgetDescription")
    }
    capture.deadline = deadline
    handler.postDelayed(deadline, budgetMs)
    if (isHeld(mode)) {
      capture.holdRequested = true
      requestCanvasHold {
        requireMain()
        if (active === capture && capture.generation == generation) request(capture, Step(Stage.VERSION))
      }
    } else {
      request(capture, Step(Stage.VERSION))
    }
  }

  private fun request(capture: Capture, step: Step) {
    if (active !== capture || capture.generation != generation) return
    require(capture.pending == null) { "Only one diagnostic request may be in flight" }
    val frame = when (step.stage) {
      Stage.VERSION -> NimoFramebufferProtocol.queryFrame(0x0B)
      Stage.READINESS -> NimoFramebufferProtocol.queryFrame(0x19)
      else -> NimoFramebufferProtocol.requestFrame(requireNotNull(step.request))
    }
    capture.pending = step
    try {
      recordWire(capture, "tx", frame)
      val accepted = send(frame) {
        requireMain()
        // A response may beat Android's write callback. Never arm an old step's timeout.
        if (active === capture && capture.generation == generation && capture.pending === step) {
          val timeout = Runnable {
            if (active === capture && capture.pending === step) finish(capture, "${step.stage} response timeout")
          }
          step.timeout = timeout
          handler.postDelayed(timeout, 3_000L)
        }
      }
      if (!accepted && active === capture) finish(capture, "Owning GATT queue rejected diagnostic request")
    } catch (error: Exception) {
      finish(capture, "Diagnostic send failed: ${error.javaClass.simpleName}")
    }
  }

  private fun completeStep(capture: Capture, step: Step) {
    step.timeout?.let(handler::removeCallbacks)
    capture.pending = null
  }

  private fun nextBank(capture: Capture) {
    if (isSample(capture.mode) && capture.banks.size == 1) { finish(capture, null); return }
    if (capture.banks.size == 4) { finish(capture, null); return }
    val bank = if (isSample(capture.mode)) requireNotNull(capture.sampleState).prepared else capture.banks.size / 2
    val read = NimoFramebufferProtocol.BankRead(nonce(capture), bank)
    capture.currentBank = read
    capture.readStarted = SystemClock.elapsedRealtime() - capture.started
    request(capture, Step(Stage.PAGE, NimoFramebufferProtocol.Request(read.nonce, 1, bank, 0)))
  }

  private fun acceptPage(capture: Capture, reply: NimoFramebufferProtocol.Reply) {
    val read = requireNotNull(capture.currentBank)
    if (isSample(capture.mode)) {
      require(reply.before == capture.sampleState) { "Sample metadata differs from page gate" }
    }
    read.add(reply)
    if (read.pageCount % 63 == 0) Log.i(TAG, "bank=${read.bank} pass=${capture.banks.size % 2 + 1} pages=${read.pageCount}/315")
    if (read.pageCount < NimoFramebufferProtocol.PAGE_COUNT) {
      request(capture, Step(Stage.PAGE, NimoFramebufferProtocol.Request(read.nonce, 1, read.bank, read.pageCount)))
      return
    }
    val pass = capture.banks.size % 2 + 1
    val filename = "bank${read.bank}-pass$pass.bin"
    val bytes = read.bytes()
    capture.readFinished = SystemClock.elapsedRealtime() - capture.started
    File(capture.directory, filename).writeBytes(bytes)
    capture.bankReceipts.put(JSONObject().put("bank", read.bank).put("pass", pass).put("nonce", read.nonce)
      .put("file", filename).put("page_count", read.pageCount).put("sha256", sha256(bytes))
      .put("metadata", metadata(requireNotNull(read.metadata))))
    capture.banks.add(read)
    capture.currentBank = null
    if (pass == 2) {
      NimoFramebufferProtocol.verifyPair(capture.banks[capture.banks.size - 2], read)
      capture.verifiedBanks += 1
      Log.i(TAG, "Static pair verified for bank=${read.bank}; non-atomic panel memory only")
    }
    nextBank(capture)
  }

  private fun finish(capture: Capture, error: String?, resumeHeldCanvas: Boolean = true) {
    if (active !== capture) return
    active = null
    capture.deadline?.let(handler::removeCallbacks)
    capture.pending?.timeout?.let(handler::removeCallbacks)
    capture.pending = null
    if (capture.holdRequested && !capture.holdReleased) {
      capture.holdReleased = true
      releaseCanvasHold(resumeHeldCanvas)
    }
    var failure = error
    try { capture.wire.close() } catch (_: Exception) { failure = failure ?: "Wire evidence could not be flushed" }
    val complete = failure == null && !isSample(capture.mode) && capture.mode != "probe" &&
      capture.verifiedBanks == 2 && capture.banks.size == 4
    val sampleComplete = failure == null && isSample(capture.mode) && capture.banks.size == 1
    val receipt = JSONObject().put("mode", capture.mode).put("ok", complete)
      .put("sample_ok", sampleComplete)
      .put("probe_ok", capture.probeOk && failure == null).put("error", failure ?: JSONObject.NULL)
      .put("started_at_unix_ms", capture.startedWallTime).put("elapsed_ms", SystemClock.elapsedRealtime() - capture.started)
      .put("runtime_version", capture.version ?: JSONObject.NULL)
      .put("declared_installed_artifact_sha256", NimoFramebufferProtocol.ARTIFACT_SHA256)
      .put("artifact_provenance", "Previously installed local diagnostic artifact; runtime SHA-256 is not measured")
      .put("runtime_digest_measured", false)
      .put("evidence_kind", if (isSample(capture.mode)) "non_atomic_single_pass" else "non_atomic_static_scene")
      .put("pixel_stability_verified", complete)
      .put("atomic", false).put("optical", false).put("optical_output_verified", false)
      .put("notification_source", JSONObject().put("service", "7033").put("characteristic", "2022")
        .put("transport", "Mentra owning Android GATT"))
      .put("write_capacity", maxWriteBytes).put("width", NimoFramebufferProtocol.WIDTH)
      .put("height", NimoFramebufferProtocol.HEIGHT).put("format", "packed4_high_nibble_first")
      .put("wire_file", "wire.jsonl").put("wire_events", capture.wireCount).put("banks", capture.bankReceipts)
      .put("static_pairs_verified", capture.verifiedBanks)
    if (isSample(capture.mode)) {
      receipt.put("selection_policy", "prepared_at_page_gate")
        .put("selected_bank", capture.sampleState?.prepared ?: JSONObject.NULL)
        .put("selection_metadata", capture.sampleState?.let(::metadata) ?: JSONObject.NULL)
        .put("read_started_elapsed_ms", capture.readStarted ?: JSONObject.NULL)
        .put("read_finished_elapsed_ms", capture.readFinished ?: JSONObject.NULL)
    }
    capture.readiness?.let { state ->
      receipt.put("readiness", JSONObject().put("status", state[0]).put("ready", state[1])
        .put("tws", state[2]).put("peer_gatt", state[3]))
    }
    try {
      File(capture.directory, "session.json").writeText(receipt.toString(2) + "\n")
      Log.i(TAG, "Finished mode=${capture.mode} ok=$complete sample_ok=$sampleComplete probe_ok=${capture.probeOk && failure == null} error=${failure ?: "none"}; files=${capture.directory.absolutePath}")
    } catch (_: Exception) {
      Log.e(TAG, "Capture receipt could not be written; do not treat this capture as verified")
    }
  }

  private fun nonce(capture: Capture): Long {
    var value: Long
    do { value = random.nextInt().toLong() and 0xFFFFFFFFL } while (!capture.nonces.add(value))
    return value
  }

  private fun recordWire(capture: Capture, direction: String, packet: ByteArray) {
    require(packet.size <= 512 && capture.wireCount < 2700) { "Diagnostic wire evidence exceeded its bound" }
    capture.wire.write(JSONObject().put("direction", direction).put("elapsed_ms", SystemClock.elapsedRealtime() - capture.started)
      .put("hex", NimoFramebufferProtocol.hex(packet)).toString())
    capture.wire.newLine()
    capture.wireCount += 1
  }

  private fun metadata(state: NimoFramebufferProtocol.State) = JSONObject().put("draw", state.draw)
    .put("prepared", state.prepared).put("dirty", state.dirty).put("pending", state.pending)
  private fun sha256(bytes: ByteArray) = NimoFramebufferProtocol.hex(MessageDigest.getInstance("SHA-256").digest(bytes))
  private fun requireMain() { check(Looper.myLooper() == handler.looper) { "NIMO diagnostics must run on its owning handler" } }
  private fun isHeld(mode: String) = mode == "held-capture" || mode == "held-sample"
  private fun isSample(mode: String) = mode == "sample" || mode == "held-sample"

  companion object {
    private const val TAG = "NimoFramebuffer"
    private const val ACTION = "com.mentra.NIMO_FRAMEBUFFER_CAPTURE"
  }
}
