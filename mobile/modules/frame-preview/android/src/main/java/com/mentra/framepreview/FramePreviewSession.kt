package com.mentra.framepreview

import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.util.Log
import com.mentra.glassesmedia.source.DecodedFrameTap
import com.mentra.glassesmedia.source.I420Planes
import com.mentra.glassesmedia.video.I420Packer
import java.nio.ByteBuffer
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * Owns one preview subscription on Android: admission, packing, transport, and the numbers.
 *
 * The hard rule is that nothing here may slow the call down. Admission runs on the decoder
 * thread and does nothing but decide, retain, and hand off; the packing worker is a single
 * thread with a zero-length queue, so when it is busy the frame is refused rather than stacked.
 */
class FramePreviewSession {
  enum class Source { SYNTHETIC, CALL }

  enum class Mode(val wire: String) {
    OFF("off"),

    /** Produce the source frame and stop. Separates making a picture from moving it. */
    GENERATE_ONLY("generate_only"),

    /** Pack to the wire format and drop it. Isolates the stride copy. */
    PACK_ONLY("pack_only"),

    /** Send it; the page validates and acknowledges without drawing. */
    RECEIVE_DISCARD("receive_discard"),

    /** Send it; the page draws and then acknowledges. */
    RENDER("render"),
    ;

    val producesFrames get() = this != OFF
    val packs get() = this == PACK_ONLY || this == RECEIVE_DISCARD || this == RENDER
    val sends get() = this == RECEIVE_DISCARD || this == RENDER
  }

  private class AdmittedFrame(val planes: I420Planes, val releaseSource: () -> Unit)

  val port = FramePreviewPort()
  private val stats = PreviewStats()
  private val runLog = PreviewRunLog()
  private val pacer = PreviewPacer(DEFAULT_FPS)

  @Volatile private var runId = ""

  @Volatile private var runStartedAtNs = 0L

  @Volatile private var appContext: Context? = null

  /** Path of the current run's NDJSON file, surfaced so the panel can tell you where to look. */
  val runLogPath: String? get() = runLog.path

  /**
   * Zero-length queue on purpose. A bounded queue would still let one slow pack push the
   * following frame's latency onto the wearer; refusing is the honest answer and it is counted.
   */
  private val worker = ThreadPoolExecutor(
    1, 1, 0L, TimeUnit.MILLISECONDS, SynchronousQueue(),
  ) { runnable -> Thread(runnable, "frame-preview-pack").apply { isDaemon = true } }

  private var scheduler: ScheduledExecutorService? = null
  private var statusTicker: ScheduledExecutorService? = null

  @Volatile private var source = Source.SYNTHETIC

  @Volatile private var mode = Mode.OFF

  @Volatile private var targetFps = DEFAULT_FPS

  @Volatile private var width = 1280

  @Volatile private var height = 720

  @Volatile private var consumerDelayMs = 0

  /**
   * Synthetic grain. A control rather than a constant so a run can be compared against the same
   * picture with grain off — which is the only way to tell content-dependent cost (a transport
   * quietly compressing) apart from run-to-run variance.
   */
  @Volatile private var noiseAmplitude = PreviewTestPattern.DEFAULT_NOISE_AMPLITUDE

  @Volatile private var syntheticPool: SyntheticI420Pool? = null

  @Volatile private var syntheticIndex = 0

  @Volatile private var tapGeneration: Long? = null

  @Volatile private var lastSourceFrameAtNs = 0L

  @Volatile private var lastWidth = 0

  @Volatile private var lastHeight = 0

  /** Two send buffers, freed on acknowledgement. One frame is in flight, so two is slack. */
  private val sendSlots = arrayOfNulls<ByteArray>(2)
  private val slotInUse = booleanArrayOf(false, false)
  private val slotSequence = intArrayOf(-1, -1)
  private var slotCapacity = 0

  var onStatus: ((Map<String, Any?>) -> Unit)? = null
  var onStopped: ((String) -> Unit)? = null

  init {
    port.onAuthenticated = {
      pacer.setConsumerReady(true)
      Log.i(TAG, "credit granted to authenticated consumer")
      logEvent("consumer", mapOf("authenticated" to true, "generation" to pacer.generation))
    }
    port.onAck = { generation, sequence -> handleAck(generation, sequence) }
    port.onFailure = { reason, detail ->
      stats.onTransportError()
      Log.w(TAG, "transport failure=$reason detail=$detail")
      logEvent("transport", mapOf("failure" to reason, "detail" to detail))
      if (reason == "auth_failed") pacer.setConsumerReady(false)
    }
  }

  fun prepareDocument(token: String): Int {
    val generation = pacer.beginGeneration()
    port.rotateToken(token)
    releaseAllSlots()
    logEvent("document", mapOf("sessionGen" to generation, "tokenRotated" to true))
    return generation
  }

  fun configure(
    source: String?,
    mode: String?,
    targetFps: Int?,
    width: Int?,
    height: Int?,
    consumerDelayMs: Int?,
    noiseAmplitude: Int? = null,
  ) {
    source?.let { this.source = if (it == "call") Source.CALL else Source.SYNTHETIC }
    mode?.let { raw -> Mode.entries.firstOrNull { it.wire == raw }?.let { this.mode = it } }
    targetFps?.let { this.targetFps = it.coerceIn(1, 30) }
    width?.let { this.width = it }
    height?.let { this.height = it }
    consumerDelayMs?.let { this.consumerDelayMs = it }
    noiseAmplitude?.let { this.noiseAmplitude = it.coerceIn(0, 96) }
    pacer.setTargetFps(this.targetFps, System.nanoTime())
    val restarted = scheduler != null || tapGeneration != null
    if (restarted) restartProduction()
    logEvent(
      "configure",
      mapOf(
        "sourceTo" to this.source.name.lowercase(Locale.US),
        "modeTo" to this.mode.wire,
        "targetFps" to this.targetFps,
        "consumerDelayMs" to this.consumerDelayMs,
        "productionRestarted" to restarted,
      ),
    )
  }

  fun start(context: Context?) {
    val now = System.nanoTime()
    context?.let { appContext = it.applicationContext }
    runId = makeRunId()
    runStartedAtNs = now
    stats.onRunStart(now)
    beginRunLog()
    pacer.setTargetFps(targetFps, now)
    pacer.start(now)
    restartProduction()
    startStatusTicker()
    Log.i(TAG, "start runId=$runId source=$source mode=${mode.wire} fps=$targetFps")
  }

  fun stop(reason: String) {
    if (!pacer.isRunning && scheduler == null && tapGeneration == null) return
    pacer.stop()
    stopProduction()
    statusTicker?.shutdownNow()
    statusTicker = null
    releaseAllSlots()
    Log.i(TAG, "stop reason=$reason")
    // One last status line before the file closes, so the run's tail is not missing the second
    // that explains why it ended.
    emitStatus()
    runLog.end(
      reason,
      mapOf(
        "durationMs" to if (runStartedAtNs > 0) (System.nanoTime() - runStartedAtNs) / 1_000_000.0 else 0.0,
        "delivered" to stats.delivered,
        "sourceFrames" to stats.sourceFrames,
      ),
    )
    onStopped?.invoke(reason)
  }

  /** Destroy the transport too. Used for unbind, backgrounding, and a new document. */
  fun teardown(reason: String) {
    stop(reason)
    port.destroy()
  }

  fun resetStats() = stats.reset(System.nanoTime())

  private fun stopProduction() {
    scheduler?.shutdownNow()
    scheduler = null
    syntheticPool = null
    tapGeneration?.let { DecodedFrameTap.detach(it) }
    tapGeneration = null
  }

  private fun restartProduction() {
    stopProduction()
    if (!mode.producesFrames) return
    when (source) {
      Source.SYNTHETIC -> {
        syntheticPool = SyntheticI420Pool(width, height, noiseAmplitude = noiseAmplitude)
        val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
          Thread(runnable, "frame-preview-synthetic").apply { isDaemon = true }
        }
        // Tick twice per frame period so the pacer, not the timer, owns the schedule.
        //
        // In microseconds, not milliseconds, because the tick has to divide the period exactly.
        // Integer milliseconds do not: at 30 fps `1000/30/2` truncates to 16 ms, two ticks make
        // 32 ms against a 33.33 ms period, and the pacer's absolute schedule then lands on the
        // beat between them — delivering a measured 30.0 fps whose gaps alternate 32/48 ms.
        val tickUs = (PreviewPacer.periodForFps(targetFps.coerceAtLeast(1)) / 2 / 1000).coerceAtLeast(2000L)
        executor.scheduleAtFixedRate({ onSyntheticTick() }, 0, tickUs, TimeUnit.MICROSECONDS)
        scheduler = executor
      }
      Source.CALL -> {
        tapGeneration = DecodedFrameTap.attach { planes -> onSourceFrame(planes) }
      }
    }
  }

  private fun startStatusTicker() {
    statusTicker?.shutdownNow()
    val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, "frame-preview-status").apply { isDaemon = true }
    }
    executor.scheduleAtFixedRate({ emitStatus() }, 1, 1, TimeUnit.SECONDS)
    statusTicker = executor
  }

  private fun onSyntheticTick() {
    val pool = syntheticPool ?: return
    if (!mode.producesFrames) return
    val now = System.nanoTime()
    checkAckTimeout(now)
    stats.onSourceFrame()
    lastSourceFrameAtNs = now

    when (val admission = pacer.admit(now)) {
      is PreviewAdmission.SkipPacing -> stats.onSkippedPacing()
      is PreviewAdmission.SkipBusy -> stats.onSkippedBusy()
      is PreviewAdmission.NotRunning -> Unit
      is PreviewAdmission.Admit -> {
        stats.onAdmitted()
        syntheticIndex += 1
        // Pool exhaustion means the previous frame is still being read. Skipping is correct;
        // overwriting it would tear the picture the consumer is drawing.
        val generateStart = System.nanoTime()
        val lease = pool.acquire(syntheticIndex, now)
        if (lease == null) {
          stats.onSkippedBusy()
          pacer.onPacked(admission.sequence, sent = false, nowNs = System.nanoTime())
          return
        }
        // Inventing a 720p picture is the synthetic source's own cost and has nothing to do with
        // moving one. Timed separately, or it would be charged to the pipeline it is only a
        // stand-in for — and `generate_only` would have nothing to subtract.
        stats.generate.record(System.nanoTime() - generateStart)
        dispatch(AdmittedFrame(lease.planes) { lease.release() }, admission.sequence, now)
      }
    }
  }

  /**
   * Called on libwebrtc's decode thread, before the ACS sender. Decide, retain, hand off. No
   * packing, no allocation of consequence, and no exception may escape into the caller.
   */
  private fun onSourceFrame(planes: I420Planes) {
    val now = System.nanoTime()
    checkAckTimeout(now)
    stats.onSourceFrame()
    lastSourceFrameAtNs = now

    when (val admission = pacer.admit(now)) {
      is PreviewAdmission.SkipPacing -> stats.onSkippedPacing()
      is PreviewAdmission.SkipBusy -> stats.onSkippedBusy()
      is PreviewAdmission.NotRunning -> Unit
      is PreviewAdmission.Admit -> {
        stats.onAdmitted()
        val retain = planes.retain
        val release = planes.release
        if (retain == null || release == null) {
          // The source cannot lend its buffers past the callback, and copying them here would
          // put the pack on the decoder thread. Refuse rather than delay the call.
          stats.onSkippedBusy()
          pacer.onPacked(admission.sequence, sent = false, nowNs = System.nanoTime())
          return
        }
        retain()
        dispatch(AdmittedFrame(planes) { release() }, admission.sequence, now)
      }
    }
  }

  private fun dispatch(frame: AdmittedFrame, sequence: Int, timestampNs: Long) {
    val admittedAtNs = System.nanoTime()
    try {
      worker.execute { process(frame, sequence, timestampNs, admittedAtNs) }
    } catch (rejected: RejectedExecutionException) {
      // The single worker is busy. Releasing here is not optional: a retained frame dropped on
      // the floor is a decoder buffer that never comes back.
      frame.releaseSource()
      // Refused before the worker, which is a different problem from a slow consumer even though
      // both end up as a skip. `preDispatchDrops` is a sub-reason of `skippedBusy`, not a second
      // skip: do not add them.
      stats.onSkippedBusy()
      stats.onPreDispatchDrop()
      pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
    }
  }

  private fun process(frame: AdmittedFrame, sequence: Int, timestampNs: Long, admittedAtNs: Long) {
    var slot = -1
    try {
      // Admission happens on the decoder (or synthetic) thread, packing on this one. The gap is
      // the handoff, measured apart from the pack so a scheduling problem cannot be read as a
      // slow memcpy.
      stats.admitToPack.record(System.nanoTime() - admittedAtNs)

      if (!mode.packs) {
        // generate_only: the source frame existed and that is the whole measurement.
        pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
        return
      }

      val planes = frame.planes
      if (!planes.planesReadable()) {
        stats.onPackFailure()
        pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
        return
      }

      val payloadLength = PreviewPixelFormat.I420.packedSize(planes.width, planes.height)
      val total = PreviewFrameHeader.BYTE_COUNT + payloadLength
      slot = acquireSlot(total, sequence)
      if (slot < 0) {
        // `slotStarved` is a sub-reason of `skippedBusy`, not a second skip: do not add them.
        stats.onSkippedBusy()
        stats.onSlotStarved()
        pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
        return
      }
      val bytes = sendSlots[slot]!!

      val packStart = System.nanoTime()
      // The packer calls clear() on whatever buffer it is given, so it must never see the one
      // holding the header. A slice positioned past the header keeps the two apart.
      // Not chained: `Buffer.position(int)` only gained a covariant ByteBuffer return in
      // later API levels, and chaining would fail to compile against the older one.
      val window = ByteBuffer.wrap(bytes)
      window.position(PreviewFrameHeader.BYTE_COUNT)
      val payload = window.slice()
      I420Packer.pack(
        planes.y, planes.strideY,
        planes.u, planes.strideU,
        planes.v, planes.strideV,
        planes.width, planes.height,
        payload,
      )
      PreviewFrameHeader(
        payloadLength = payloadLength,
        sessionGeneration = pacer.generation,
        frameSequence = sequence,
        width = planes.width,
        height = planes.height,
        pixelFormat = PreviewPixelFormat.I420,
        // libwebrtc already applied rotation before handing over I420, and the decoded frames
        // this taps are BT.601 limited in practice; both are declared rather than assumed.
        colorMatrix = PreviewColorMatrix.BT601,
        colorRange = PreviewColorRange.LIMITED,
        flags = PreviewFrameHeader.FLAG_COLOR_METADATA_FALLBACK,
        timestampNs = planes.timestampNs,
        sentAtNs = System.nanoTime(),
      ).writeInto(bytes)
      stats.pack.record(System.nanoTime() - packStart)

      lastWidth = planes.width
      lastHeight = planes.height

      if (!mode.sends) {
        releaseSlot(slot)
        slot = -1
        pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
        return
      }

      val accepted = port.send(bytes) { queueWaitNs, postNs ->
        stats.mainQueueWait.record(queueWaitNs)
        stats.sendComplete.record(postNs)
      }
      if (accepted) {
        stats.onDelivered(total, System.nanoTime())
        pacer.onPacked(sequence, sent = true, nowNs = System.nanoTime())
        slot = -1 // freed when the acknowledgement arrives
      } else {
        releaseSlot(slot)
        slot = -1
        stats.onSkippedBusy()
        pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
      }
    } catch (error: Throwable) {
      Log.w(TAG, "pack failed", error)
      stats.onPackFailure()
      pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
    } finally {
      if (slot >= 0) releaseSlot(slot)
      // Always, on every path. The decoder is waiting for this buffer back.
      frame.releaseSource()
    }
  }

  private fun handleAck(generation: Int, sequence: Int) {
    val now = System.nanoTime()
    when (val result = pacer.onAck(generation, sequence, now)) {
      is PreviewAckResult.Accepted -> {
        stats.onAckAccepted(result.roundTripNs, now)
        releaseSlotForSequence(sequence)
      }
      is PreviewAckResult.Stale -> {
        stats.onStaleAck()
        logEvent("staleAck", mapOf("gen" to generation, "seq" to sequence))
      }
    }
  }

  private fun checkAckTimeout(nowNs: Long) {
    if (!pacer.hasAckTimedOut(nowNs)) return
    stats.onAckTimeout()
    logEvent("ackTimeout", mapOf("generation" to pacer.generation, "outstanding" to pacer.outstandingFrames))
    // The consumer stopped answering. Stop the subscription rather than mint a replacement
    // credit, which is how an unbounded queue gets built one "recovery" at a time.
    stop("ack_timeout")
  }

  @Synchronized
  private fun acquireSlot(byteCount: Int, sequence: Int): Int {
    if (slotCapacity != byteCount) {
      for (index in sendSlots.indices) {
        sendSlots[index] = ByteArray(byteCount)
        slotInUse[index] = false
        slotSequence[index] = -1
      }
      slotCapacity = byteCount
    }
    for (index in sendSlots.indices) {
      if (!slotInUse[index]) {
        slotInUse[index] = true
        slotSequence[index] = sequence
        return index
      }
    }
    return -1
  }

  @Synchronized
  private fun releaseSlot(index: Int) {
    if (index !in sendSlots.indices) return
    slotInUse[index] = false
    slotSequence[index] = -1
  }

  @Synchronized
  private fun releaseSlotForSequence(sequence: Int) {
    for (index in sendSlots.indices) {
      if (slotSequence[index] == sequence) {
        slotInUse[index] = false
        slotSequence[index] = -1
      }
    }
  }

  @Synchronized
  private fun releaseAllSlots() {
    for (index in sendSlots.indices) {
      slotInUse[index] = false
      slotSequence[index] = -1
    }
  }

  private fun emitStatus() {
    val now = System.nanoTime()
    val window = stats.takeWindow(now)
    val tap = DecodedFrameTap.drainMetrics()
    // One sort per ring, not one per percentile: at 30 fps this must not become part of what
    // it reports.
    val generate = stats.generate.distribution()
    val pack = stats.pack.distribution()
    val complete = stats.sendComplete.distribution()
    val queueWait = stats.mainQueueWait.distribution()
    val handoff = stats.admitToPack.distribution()
    val gap = stats.deliveryGap.distribution()
    val rtt = stats.roundTrip.distribution()
    val hasSource = source == Source.SYNTHETIC ||
      (lastSourceFrameAtNs > 0 && now - lastSourceFrameAtNs < 2_000_000_000L)
    val status = mapOf(
      "t" to "status",
      "platform" to "android",
      "runId" to runId,
      "running" to pacer.isRunning,
      "source" to if (source == Source.CALL) "call" else "synthetic",
      "mode" to mode.wire,
      "targetFps" to targetFps,
      "width" to lastWidth,
      "height" to lastHeight,
      "pixelFormat" to "i420",
      "sourceFrames" to stats.sourceFrames,
      "admitted" to stats.admitted,
      "skippedPacing" to stats.skippedPacing,
      "skippedBusy" to stats.skippedBusy,
      "preDispatchDrops" to stats.preDispatchDrops,
      "slotStarved" to stats.slotStarved,
      "delivered" to stats.delivered,
      "sourceFps" to round1(window.sourceFps),
      "deliveredFps" to round1(window.deliveredFps),
      "bytesPerSecond" to window.bytesPerSecond.toLong(),
      "generateMsP50" to generate.p50,
      "generateMsP95" to generate.p95,
      "generateMsMax" to generate.max,
      "packMsP50" to pack.p50,
      "packMsP95" to pack.p95,
      "packMsP99" to pack.p99,
      "packMsMax" to pack.max,
      // Chromium copies inside postMessage, so this is the whole send. iOS reports an enqueue
      // and a completion instead, because there the first returns before the copy happens.
      "sendCompleteMsP50" to complete.p50,
      "sendCompleteMsP95" to complete.p95,
      "sendCompleteMsMax" to complete.max,
      // How long our send runnable sat behind the app's own UI work. Interference, not our cost.
      "mainQueueWaitMsP95" to queueWait.p95,
      "mainQueueWaitMsMax" to queueWait.max,
      "admitToPackMsP95" to handoff.p95,
      "admitToPackMsMax" to handoff.max,
      // Cadence, not rate. A steady 29.5 fps and an alternating 20/45 ms 29.5 fps are the same
      // number above and very different to look at.
      "deliveryGapMsP50" to gap.p50,
      "deliveryGapMsP95" to gap.p95,
      "deliveryGapMsMax" to gap.max,
      "firstDeliveredMs" to round1(stats.firstDeliveredLatencyMs),
      "firstAckMs" to round1(stats.firstAckLatencyMs),
      "rttMsP50" to rtt.p50,
      "rttMsP95" to rtt.p95,
      "rttMsP99" to rtt.p99,
      "rttMsMax" to rtt.max,
      // The call's numbers, not the preview's. These are the ones that decide the experiment.
      "tapFramesOffered" to tap.framesOffered,
      "tapFramesWithSink" to tap.framesWithSink,
      "tapOfferMeanUs" to round2(tap.offerMeanUs),
      "tapOfferMaxUs" to round2(tap.offerMaxUs),
      "tapCadenceMeanMs" to round2(tap.cadenceMeanMs),
      "tapCadenceMaxMs" to round2(tap.cadenceMaxMs),
      "tapSinkExceptions" to tap.sinkExceptions,
      "thermalState" to thermalStateName(),
      "memoryFootprintMb" to memoryFootprintMb(),
      "outstanding" to pacer.outstandingFrames,
      "ackTimeouts" to stats.ackTimeouts,
      "staleAcks" to stats.staleAcks,
      "packFailures" to stats.packFailures,
      "transportErrors" to stats.transportErrors,
      "consumerReady" to pacer.consumerReady,
      "noSource" to !hasSource,
      "generation" to pacer.generation,
      "consumerDelayMs" to consumerDelayMs,
      "noiseAmplitude" to noiseAmplitude,
    )
    onStatus?.invoke(status)
    runLog.write(status)
  }

  // region Run log

  private fun beginRunLog() {
    val context = appContext ?: return
    runLog.begin(
      context,
      runId,
      mapOf(
        "platform" to "android",
        "schema" to RUN_LOG_SCHEMA,
        "startedAt" to SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).format(Date()),
        "deviceModel" to "${Build.MANUFACTURER} ${Build.MODEL}",
        "osVersion" to Build.VERSION.RELEASE,
        "sdkInt" to Build.VERSION.SDK_INT,
        "source" to source.name.lowercase(Locale.US),
        "mode" to mode.wire,
        "targetFps" to targetFps,
        "width" to width,
        "height" to height,
        "consumerDelayMs" to consumerDelayMs,
        "transport" to "webmessage",
      ),
    )
  }

  /**
   * A discrete thing that happened, on the same file as the 1 Hz lines. State changes are what
   * turn "the numbers got worse at second 40" into "the numbers got worse when the page
   * reconnected at second 40".
   */
  private fun logEvent(event: String, fields: Map<String, Any?>) {
    runLog.write(
      fields + mapOf(
        "t" to "event",
        "event" to event,
        "runId" to runId,
        "atMs" to if (runStartedAtNs > 0) (System.nanoTime() - runStartedAtNs) / 1_000_000.0 else 0.0,
      ),
    )
  }

  private fun makeRunId(): String =
    "android-${System.currentTimeMillis() / 1000}-${UUID.randomUUID().toString().take(8)}"

  private fun thermalStateName(): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "unavailable"
    val power = appContext?.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return "unavailable"
    return when (power.currentThermalStatus) {
      PowerManager.THERMAL_STATUS_NONE -> "none"
      PowerManager.THERMAL_STATUS_LIGHT -> "light"
      PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
      PowerManager.THERMAL_STATUS_SEVERE -> "severe"
      PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
      PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
      PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
      else -> "unknown"
    }
  }

  /**
   * JVM heap in use. Sampled every second so growth over a soak is a slope rather than two
   * endpoints. This is not the process RSS — the packed frames live in `ByteArray`s on the heap,
   * which is the allocation this experiment can actually be blamed for.
   */
  private fun memoryFootprintMb(): Double {
    val runtime = Runtime.getRuntime()
    return round1((runtime.totalMemory() - runtime.freeMemory()) / 1_048_576.0)
  }

  // endregion

  private fun round1(value: Double): Double = Math.round(value * 10.0) / 10.0

  private fun round2(value: Double): Double = Math.round(value * 100.0) / 100.0

  companion object {
    private const val TAG = "FRAME-PREVIEW"
    /**
     * The page always configures before starting; this only covers the window before it does.
     * 30 matches the panel's default so a run that somehow skips configure still stresses.
     */
    private const val DEFAULT_FPS = 30
    private const val RUN_LOG_SCHEMA = 1
  }
}
