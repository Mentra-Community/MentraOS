package com.mentra.framepreview

import android.content.Context
import android.os.Build
import android.os.PowerManager
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
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** A configure or fault call refused with a contract error code. */
class PreviewRejection(val code: String, message: String) : IllegalStateException(message)

/**
 * Owns one preview subscription on Android: admission, packing, transport, and the numbers.
 *
 * The hard rule is that nothing here may slow the call down. Admission runs on the decoder
 * thread and does nothing but decide, retain, and hand off; the packing worker is a single
 * thread with a zero-length queue, so when it is busy the frame is refused rather than stacked.
 *
 * Failure isolation: a `Throwable` from the tap sink is caught by [DecodedFrameTap]; one from the
 * pack worker is caught here. Either is counted and stops the subscription with `pack_failed`.
 * Geometry is validated before any copy, so a malformed frame is refused while it is still just
 * numbers.
 */
class FramePreviewSession(
  val transport: PreviewFrameTransport,
  private val callSource: PreviewSourcePort = CallSource,
  val trace: PreviewTrace = PreviewTrace({ _, _ -> }),
  private val scaler: I420Scaler = LibyuvI420Scaler(),
  private val tapMetrics: () -> DecodedFrameTap.Metrics = DecodedFrameTap::drainMetrics,
  private val applyTapTelemetry: (Boolean) -> Unit = DecodedFrameTap::setTelemetryEnabled,
) {
  private class AdmittedFrame(val planes: I420Planes, val releaseSource: () -> Unit)

  private val stats = PreviewStats()
  private val runLog = PreviewRunLog()
  private val pacer = PreviewPacer(PreviewLimits.RELEASE.maxFps)
  private val slots = PreviewSlotPool()
  val faults = PreviewFaults()

  @Volatile private var runId = ""

  @Volatile private var runStartedAtNs = 0L

  @Volatile private var runKind: String? = null

  @Volatile private var appContext: Context? = null

  @Volatile var diagnosticsEnabled = false
    private set

  @Volatile var runLogEnabled = false
    private set

  @Volatile var tapTelemetryEnabled = false
    private set

  @Volatile private var config = PreviewConfig()

  /** The box frames must fit inside, after the build's ceiling. */
  @Volatile private var box = PreviewLimits.RELEASE.maxBox

  @Volatile private var fps = PreviewLimits.RELEASE.maxFps

  @Volatile private var docGen = 0

  @Volatile private var srcWidth = 0

  @Volatile private var srcHeight = 0

  @Volatile private var outWidth = 0

  @Volatile private var outHeight = 0

  @Volatile private var syntheticPool: SyntheticI420Pool? = null

  @Volatile private var syntheticIndex = 0

  @Volatile private var tapGeneration: Long? = null

  @Volatile private var lastSourceFrameAtNs = 0L

  @Volatile private var lastTapDrainNs = 0L

  private val stopRequested = AtomicBoolean(false)

  /** Path of the current run's NDJSON file, or null when the run log is off. */
  val runLogPath: String? get() = runLog.path

  /**
   * Zero-length queue on purpose. A bounded queue would still let one slow pack push the
   * following frame's latency onto the wearer; refusing is the honest answer and it is counted.
   */
  private val worker = ThreadPoolExecutor(
    1, 1, 0L, TimeUnit.MILLISECONDS, SynchronousQueue(),
  ) { runnable -> Thread(runnable, "frame-preview-pack").apply { isDaemon = true } }

  /** Status ticks, delayed acks and internally requested stops. Never the frame path. */
  private val control: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "frame-preview-control").apply { isDaemon = true }
  }

  private var synthetic: ScheduledExecutorService? = null
  private var statusTick: ScheduledFuture<*>? = null

  var onStatus: ((Map<String, Any?>) -> Unit)? = null

  /** `(reason, docGen)` whenever a running subscription stops. */
  var onStopped: ((String, Int) -> Unit)? = null

  init {
    transport.onAuthenticated = {
      stats.onHandshake()
      pacer.setConsumerReady(true)
      trace.info("hello_accepted", mapOf("sessionGen" to pacer.generation))
      logEvent("consumer", mapOf("authenticated" to true, "generation" to pacer.generation))
    }
    transport.onAck = { generation, sequence -> onAckReceived(generation, sequence) }
    transport.onFailure = { reason, detail -> onTransportFailure(reason, detail) }
  }

  fun attachContext(context: Context?) {
    context?.let { appContext = it.applicationContext }
  }

  // region Lifecycle

  /** Arm the transport for one document. Returns the session generation stamped on its frames. */
  @Synchronized
  fun prepareDocument(token: String, documentGeneration: Int): Int {
    docGen = documentGeneration
    trace.docGen = documentGeneration
    val generation = pacer.beginGeneration()
    transport.rotateToken(token)
    slots.releaseAll()
    trace.info("token_rotated", mapOf("sessionGen" to generation))
    logEvent("document", mapOf("docGen" to documentGeneration, "sessionGen" to generation))
    return generation
  }

  /** Apply one `configure`. Throws [PreviewRejection] when diagnostics are needed and off. */
  @Synchronized
  fun configure(next: PreviewConfig) {
    PreviewDiagnosticsPolicy.check(next, diagnosticsEnabled)?.let { code ->
      trace.warn("configure_rejected", mapOf("code" to code, "source" to next.source.wire, "mode" to next.mode.wire))
      throw PreviewRejection(code, "${next.source.wire}/${next.mode.wire} needs diagnostics")
    }
    val previous = config
    val limits = PreviewLimits.of(diagnosticsEnabled)
    val nextBox = if (next.targetWidth > 0 && next.targetHeight > 0) {
      PreviewScalePlan.clampBox(next.targetWidth, next.targetHeight, limits.maxPixels)
    } else {
      limits.maxBox
    }
    val nextFps = next.maxFps.coerceIn(1, limits.maxFps)
    val tierChanged = nextBox != box
    config = next
    fps = nextFps
    pacer.setTargetFps(nextFps, System.nanoTime())
    if (tierChanged) {
      box = nextBox
      stats.onTierChange()
      if (srcWidth > 0 && srcHeight > 0) {
        val size = PreviewScalePlan.fit(srcWidth, srcHeight, nextBox.width, nextBox.height)
        slots.prepare(PreviewFrameHeader.BYTE_COUNT + PreviewPixelFormat.I420.packedSize(size.width, size.height))
      }
      trace.info("tier_change", mapOf("box" to "${nextBox.width}x${nextBox.height}", "fps" to nextFps))
    }
    // A tier or rate change never restarts production or the transport; only what produces
    // frames does. The synthetic source draws at the box size, so it follows the tier.
    val restart = pacer.isRunning && (
      previous.source != next.source || previous.mode != next.mode ||
        (next.source == PreviewSourceKind.SYNTHETIC && (tierChanged || previous.noiseAmplitude != next.noiseAmplitude))
      )
    if (restart) restartProduction()
    trace.info(
      "configure",
      mapOf("source" to next.source.wire, "mode" to next.mode.wire, "box" to "${box.width}x${box.height}", "fps" to fps),
    )
    logEvent(
      "configure",
      mapOf(
        "sourceTo" to next.source.wire,
        "modeTo" to next.mode.wire,
        "targetWidth" to box.width,
        "targetHeight" to box.height,
        "maxFps" to fps,
        "consumerDelayMs" to next.consumerDelayMs,
        "productionRestarted" to restart,
      ),
    )
  }

  @Synchronized
  fun start() {
    if (pacer.isRunning) return
    stopRequested.set(false)
    if (runKind != null) endRun("preview_started")
    val now = System.nanoTime()
    beginRun("preview", now)
    pacer.setTargetFps(fps, now)
    pacer.start(now)
    restartProduction()
    ensureStatusTick()
    trace.info("start", mapOf("source" to config.source.wire, "mode" to config.mode.wire, "runId" to runId))
  }

  /** Halt production. The transport and its authenticated consumer survive. */
  @Synchronized
  fun stop(reason: String) {
    if (!pacer.isRunning && synthetic == null && tapGeneration == null) return
    pacer.stop()
    stopProduction()
    slots.releaseAll()
    trace.info("stop", mapOf("reason" to reason))
    endRun(reason)
    if (tapTelemetryEnabled) beginRun("telemetry", System.nanoTime()) else cancelStatusTick()
    onStopped?.invoke(reason, docGen)
  }

  /** Destroy the transport too. The page must handshake again. */
  @Synchronized
  fun teardown(reason: String) {
    stop(reason)
    transport.destroy()
    trace.info("unbind", mapOf("reason" to reason))
  }

  /** Release the executors. The session is unusable afterwards. */
  fun close() {
    teardown("destroy")
    worker.shutdownNow()
    control.shutdownNow()
  }

  @Synchronized
  fun resetStats() = stats.reset(System.nanoTime())

  fun onInstallReload() {
    stats.onInstallReload()
    trace.warn("install_reload", mapOf("installReloads" to stats.installReloads))
  }

  @Synchronized
  fun setDiagnosticsEnabled(enabled: Boolean) {
    diagnosticsEnabled = enabled
    if (enabled) return
    faults.clear()
    val current = config
    if (PreviewDiagnosticsPolicy.needsDiagnostics(current)) {
      stop(PreviewDiagnosticsPolicy.DIAGNOSTICS_DISABLED)
      config = current.copy(source = PreviewSourceKind.CALL, mode = PreviewMode.OFF, noiseAmplitude = 0, consumerDelayMs = 0)
    }
    val limits = PreviewLimits.RELEASE
    box = PreviewScalePlan.clampBox(box.width, box.height, limits.maxPixels)
    fps = fps.coerceAtMost(limits.maxFps)
    pacer.setTargetFps(fps, System.nanoTime())
  }

  @Synchronized
  fun setRunLogEnabled(enabled: Boolean) {
    if (runLogEnabled == enabled) return
    runLogEnabled = enabled
    if (!enabled) runLog.end("run_log_disabled")
  }

  @Synchronized
  fun setTapTelemetry(enabled: Boolean) {
    if (tapTelemetryEnabled == enabled) return
    tapTelemetryEnabled = enabled
    applyTapTelemetry(enabled)
    trace.info("tap_telemetry", mapOf("enabled" to enabled))
    if (pacer.isRunning) return
    if (enabled) {
      beginRun("telemetry", System.nanoTime())
      ensureStatusTick()
    } else {
      endRun("telemetry_off")
      cancelStatusTick()
    }
  }

  /** Arm a diagnostics-only fault. Throws [PreviewRejection] when diagnostics are off. */
  fun injectFault(kind: PreviewFaultKind, ms: Int) {
    if (!diagnosticsEnabled) {
      throw PreviewRejection(PreviewDiagnosticsPolicy.DIAGNOSTICS_DISABLED, "fault injection needs diagnostics")
    }
    faults.arm(kind, ms)
    trace.warn("fault_armed", mapOf("kind" to kind.wire, "ms" to ms))
  }

  // endregion

  // region Production

  private fun stopProduction() {
    synthetic?.shutdownNow()
    synthetic = null
    syntheticPool = null
    tapGeneration?.let { generation ->
      callSource.detach(generation)
      trace.info("source_detach", mapOf("gen" to generation))
    }
    tapGeneration = null
    trace.tapGeneration = null
  }

  private fun restartProduction() {
    stopProduction()
    val current = config
    if (!current.mode.producesFrames) return
    when (current.source) {
      PreviewSourceKind.SYNTHETIC -> {
        syntheticPool = SyntheticI420Pool(box.width, box.height, noiseAmplitude = current.noiseAmplitude)
        val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
          Thread(runnable, "frame-preview-synthetic").apply { isDaemon = true }
        }
        // Tick twice per frame period so the pacer, not the timer, owns the schedule. In
        // microseconds because integer milliseconds do not divide a 30 fps period exactly.
        val tickUs = (PreviewPacer.periodForFps(fps.coerceAtLeast(1)) / 2 / 1000).coerceAtLeast(2000L)
        executor.scheduleAtFixedRate({ onSyntheticTick() }, 0, tickUs, TimeUnit.MICROSECONDS)
        synthetic = executor
      }
      PreviewSourceKind.CALL -> {
        val generation = callSource.attach(::onSourceFrame, ::onSinkError)
        tapGeneration = generation
        trace.tapGeneration = generation
        trace.info("source_attach", mapOf("gen" to generation))
      }
    }
  }

  private fun onSyntheticTick() {
    val pool = syntheticPool ?: return
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
        val generateStart = System.nanoTime()
        // Pool exhaustion means the previous frame is still being read; overwriting it would
        // tear the picture the consumer is drawing.
        val lease = pool.acquire(syntheticIndex, now)
        if (lease == null) {
          stats.onSkippedBusy()
          pacer.onPacked(admission.sequence, sent = false, nowNs = System.nanoTime())
          return
        }
        stats.generate.record(System.nanoTime() - generateStart)
        dispatch(AdmittedFrame(lease.planes) { lease.release() }, admission.sequence, now)
      }
    }
  }

  /**
   * Called on libwebrtc's decode thread, before the ACS sender. Decide, retain, hand off. Every
   * statement that can throw runs before `retain()`, so a throw never strands a decoder buffer.
   */
  private fun onSourceFrame(planes: I420Planes) {
    if (faults.takeSinkThrow()) throw InjectedPreviewFault(PreviewFaultKind.SINK_THROW)
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

  /** Decoder thread, after [DecodedFrameTap] caught and counted the throw. Schedule only. */
  private fun onSinkError(error: Throwable) {
    stats.onPackFailure(PackFailureReason.SINK_ERROR)
    requestStop("pack_failed", PackFailureReason.SINK_ERROR, error)
  }

  private fun dispatch(frame: AdmittedFrame, sequence: Int, timestampNs: Long) {
    val admittedAtNs = System.nanoTime()
    try {
      worker.execute { process(frame, sequence, timestampNs, admittedAtNs) }
    } catch (rejected: RejectedExecutionException) {
      // Releasing here is not optional: a retained frame dropped on the floor is a decoder
      // buffer that never comes back. `preDispatchDrops` is a sub-reason of `skippedBusy`.
      frame.releaseSource()
      stats.onSkippedBusy()
      stats.onPreDispatchDrop()
      pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
    }
  }

  private fun process(frame: AdmittedFrame, sequence: Int, timestampNs: Long, admittedAtNs: Long) {
    var slot: PreviewSlotPool.Slot? = null
    try {
      stats.admitToPack.record(System.nanoTime() - admittedAtNs)
      val mode = config.mode
      if (!mode.packs) {
        // generate_only: the source frame existed and that is the whole measurement.
        pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
        return
      }
      if (faults.takePackThrow()) throw InjectedPreviewFault(PreviewFaultKind.PACK_THROW)

      val planes = frame.planes
      val target = box
      val output = PreviewScalePlan.fit(planes.width, planes.height, target.width, target.height)
      val payloadLength = PreviewPixelFormat.I420.packedSize(output.width, output.height)
      val total = PreviewFrameHeader.BYTE_COUNT + payloadLength
      PreviewGeometry.validateI420(
        planes.width, planes.height,
        I420Planes.remaining(planes.y), planes.strideY,
        I420Planes.remaining(planes.u), planes.strideU,
        I420Planes.remaining(planes.v), planes.strideV,
        output, payloadLength,
      )?.let { reason ->
        failPack(reason, sequence, null)
        return
      }

      val acquired = slots.acquire(total, sequence)
      if (acquired == null) {
        // `slotStarved` is a sub-reason of `skippedBusy`, not a second skip: do not add them.
        stats.onSkippedBusy()
        stats.onSlotStarved()
        pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
        return
      }
      slot = acquired
      PreviewGeometry.validateSlot(acquired.bytes.size, total)?.let { reason ->
        failPack(reason, sequence, null)
        return
      }
      val bytes = acquired.bytes

      val packStart = System.nanoTime()
      if (output.width == planes.width && output.height == planes.height) {
        // The packer calls clear() on its buffer, so it gets a slice past the header.
        val window = ByteBuffer.wrap(bytes)
        window.position(PreviewFrameHeader.BYTE_COUNT)
        I420Packer.pack(
          planes.y, planes.strideY,
          planes.u, planes.strideU,
          planes.v, planes.strideV,
          planes.width, planes.height,
          window.slice(),
        )
      } else {
        scaler.scale(planes, output, bytes, PreviewFrameHeader.BYTE_COUNT)
      }
      PreviewFrameHeader(
        payloadLength = payloadLength,
        sessionGeneration = pacer.generation,
        frameSequence = sequence,
        width = output.width,
        height = output.height,
        pixelFormat = PreviewPixelFormat.I420,
        // libwebrtc applied rotation before handing over I420, and these decoded frames are
        // BT.601 limited in practice; both are declared rather than assumed.
        colorMatrix = PreviewColorMatrix.BT601,
        colorRange = PreviewColorRange.LIMITED,
        flags = PreviewFrameHeader.FLAG_COLOR_METADATA_FALLBACK,
        timestampNs = planes.timestampNs,
        sentAtNs = System.nanoTime(),
      ).writeInto(bytes)
      stats.pack.record(System.nanoTime() - packStart)
      srcWidth = planes.width
      srcHeight = planes.height
      outWidth = output.width
      outHeight = output.height

      if (!mode.sends) {
        slots.release(acquired)
        slot = null
        pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
        return
      }

      if (faults.takeTransportClose()) {
        transport.dropConsumer()
        onTransportFailure("send_failed", "injected")
        slots.release(acquired)
        slot = null
        pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
        return
      }

      val accepted = transport.send(bytes) { queueWaitNs, postNs ->
        stats.mainQueueWait.record(queueWaitNs)
        stats.sendComplete.record(postNs)
      }
      if (accepted) {
        stats.onDelivered(total, System.nanoTime())
        pacer.onPacked(sequence, sent = true, nowNs = System.nanoTime())
        slot = null // freed when the acknowledgement arrives
      } else {
        stats.onSkippedBusy()
        pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
      }
    } catch (error: Throwable) {
      failPack(PackFailureReason.WORKER_ERROR, sequence, error)
    } finally {
      slot?.let { slots.release(it) }
      // Always, on every path. The decoder is waiting for this buffer back.
      frame.releaseSource()
    }
  }

  private fun failPack(reason: PackFailureReason, sequence: Int, error: Throwable?) {
    stats.onPackFailure(reason)
    pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
    requestStop("pack_failed", reason, error)
  }

  // endregion

  // region Acks, transport, stops

  private fun onAckReceived(generation: Int, sequence: Int) {
    if (faults.dropAcks) {
      trace.warnLimited("ack_dropped", "ack_dropped", mapOf("fault" to true))
      return
    }
    val delayMs = maxOf(config.consumerDelayMs, faults.ackDelayMs)
    if (delayMs <= 0) {
      handleAck(generation, sequence)
      return
    }
    try {
      control.schedule({ handleAck(generation, sequence) }, delayMs.toLong(), TimeUnit.MILLISECONDS)
    } catch (rejected: RejectedExecutionException) {
      // Closing; the ack no longer matters.
    }
  }

  private fun handleAck(generation: Int, sequence: Int) {
    val now = System.nanoTime()
    when (val result = pacer.onAck(generation, sequence, now)) {
      is PreviewAckResult.Accepted -> {
        stats.onAckAccepted(result.roundTripNs, now)
        slots.releaseSequence(sequence)
      }
      is PreviewAckResult.Stale -> {
        stats.onStaleAck()
        trace.warnLimited("stale_ack", "stale_ack", mapOf("ackGen" to generation, "seq" to sequence))
        logEvent("staleAck", mapOf("gen" to generation, "seq" to sequence))
      }
    }
  }

  private fun onTransportFailure(reason: String, detail: String) {
    stats.onTransportError()
    logEvent("transport", mapOf("failure" to reason, "detail" to detail))
    if (reason == "auth_failed") {
      // A stale page presenting an old token must not revoke the current consumer's credit.
      trace.warnLimited("hello_rejected", "hello_rejected", mapOf("reason" to detail))
      return
    }
    trace.warn("transport_failed", mapOf("reason" to reason, "detail" to detail))
    if (pacer.isRunning) requestStop("transport_failed", null, null)
  }

  private fun checkAckTimeout(nowNs: Long) {
    if (!pacer.hasAckTimedOut(nowNs)) return
    stats.onAckTimeout()
    // The consumer stopped answering. Stop rather than mint a replacement credit.
    requestStop("ack_timeout", null, null)
  }

  /** Stop from a frame, ack or decoder thread without doing the work there. */
  private fun requestStop(reason: String, packReason: PackFailureReason?, error: Throwable?) {
    if (!stopRequested.compareAndSet(false, true)) return
    try {
      control.execute {
        if (reason == "ack_timeout") {
          trace.warn("ack_timeout", mapOf("sessionGen" to pacer.generation, "outstanding" to pacer.outstandingFrames))
          logEvent("ackTimeout", mapOf("generation" to pacer.generation))
        }
        if (packReason != null) {
          trace.warn(
            "pack_failed",
            mapOf("reason" to packReason.wire, "error" to error?.javaClass?.simpleName, "src" to "${srcWidth}x$srcHeight"),
          )
          logEvent("packFailed", mapOf("reason" to packReason.wire, "error" to error?.javaClass?.simpleName))
        }
        stop(reason)
      }
    } catch (rejected: RejectedExecutionException) {
      // Closing; nothing left to stop.
    }
  }

  // endregion

  // region Status and run log

  private fun ensureStatusTick() {
    if (statusTick != null) return
    lastTapDrainNs = System.nanoTime()
    statusTick = control.scheduleAtFixedRate({ onStatusTick() }, 1, 1, TimeUnit.SECONDS)
  }

  private fun cancelStatusTick() {
    statusTick?.cancel(false)
    statusTick = null
  }

  private fun onStatusTick() {
    try {
      val now = System.nanoTime()
      checkAckTimeout(now)
      val generation = tapGeneration
      if (pacer.isRunning && generation != null && !callSource.isCurrent(generation)) {
        trace.warn("source_detached", mapOf("gen" to generation))
        requestStop("source_detached", null, null)
      }
      emitStatus()
      trace.flushLimited()
    } catch (error: Throwable) {
      trace.warnLimited("status_failed", "status_failed", mapOf("error" to error.javaClass.simpleName))
    }
  }

  /** Build, emit and log one status. Visible for tests. */
  fun emitStatus(): Map<String, Any?> {
    val now = System.nanoTime()
    val window = stats.takeWindow(now)
    val tap = tapMetrics()
    val tapSeconds = if (lastTapDrainNs > 0 && lastTapDrainNs < now) (now - lastTapDrainNs) / 1_000_000_000.0 else 0.0
    lastTapDrainNs = now
    if (tap.sinkExceptions > 0) stats.onTapSinkExceptions(tap.sinkExceptions)
    val generate = stats.generate.distribution()
    val pack = stats.pack.distribution()
    val complete = stats.sendComplete.distribution()
    val queueWait = stats.mainQueueWait.distribution()
    val handoff = stats.admitToPack.distribution()
    val gap = stats.deliveryGap.distribution()
    val rtt = stats.roundTrip.distribution()
    val current = config
    val hasSource = current.source == PreviewSourceKind.SYNTHETIC ||
      (lastSourceFrameAtNs > 0 && now - lastSourceFrameAtNs < 2_000_000_000L)
    val status = linkedMapOf<String, Any?>(
      "t" to "status",
      "platform" to "android",
      "runId" to runId,
      "running" to pacer.isRunning,
      "source" to current.source.wire,
      "mode" to current.mode.wire,
      "docGen" to docGen,
      // Contract counters.
      "deliveredFps" to round1(window.deliveredFps),
      "outstanding" to pacer.outstandingFrames,
      "skippedBusy" to stats.skippedBusy,
      "skippedPacing" to stats.skippedPacing,
      "packMsP95" to pack.p95,
      "rttMsP95" to rtt.p95,
      "deliveryGapMsP50" to gap.p50,
      "deliveryGapMsP95" to gap.p95,
      "tapOfferMeanUs" to round2(tap.offerMeanUs),
      "tapCadenceMaxMs" to round2(tap.cadenceMaxMs),
      "tapSinkExceptions" to stats.tapSinkExceptions,
      "packFailures" to stats.packFailuresByReason(),
      "staleAcks" to stats.staleAcks,
      "ackTimeouts" to stats.ackTimeouts,
      "installReloads" to stats.installReloads,
      "handshakes" to stats.handshakes,
      "tierChanges" to stats.tierChanges,
      "outWidth" to outWidth,
      "outHeight" to outHeight,
      "srcWidth" to srcWidth,
      "srcHeight" to srcHeight,
      // The call's own send rate, counted at the ACS send call sites.
      "acsSendFps" to if (tapSeconds > 0) round1(tap.acsFramesSent / tapSeconds) else 0.0,
      "tapFramesOffered" to tap.framesOffered,
      "tapFramesWithSink" to tap.framesWithSink,
      "tapOfferMaxUs" to round2(tap.offerMaxUs),
      "tapCadenceMeanMs" to round2(tap.cadenceMeanMs),
      "tapTelemetry" to tapTelemetryEnabled,
      // Diagnostic detail.
      "targetFps" to fps,
      "targetWidth" to box.width,
      "targetHeight" to box.height,
      "pixelFormat" to "i420",
      "sourceFrames" to stats.sourceFrames,
      "admitted" to stats.admitted,
      "preDispatchDrops" to stats.preDispatchDrops,
      "slotStarved" to stats.slotStarved,
      "slotReallocations" to slots.reallocations,
      "delivered" to stats.delivered,
      "sourceFps" to round1(window.sourceFps),
      "bytesPerSecond" to window.bytesPerSecond.toLong(),
      "generateMsP95" to generate.p95,
      "packMsP50" to pack.p50,
      "packMsP99" to pack.p99,
      "packMsMax" to pack.max,
      "sendCompleteMsP50" to complete.p50,
      "sendCompleteMsP95" to complete.p95,
      "sendCompleteMsMax" to complete.max,
      "mainQueueWaitMsP95" to queueWait.p95,
      "mainQueueWaitMsMax" to queueWait.max,
      "admitToPackMsP95" to handoff.p95,
      "admitToPackMsMax" to handoff.max,
      "deliveryGapMsMax" to gap.max,
      "firstDeliveredMs" to round1(stats.firstDeliveredLatencyMs),
      "firstAckMs" to round1(stats.firstAckLatencyMs),
      "rttMsP50" to rtt.p50,
      "rttMsP99" to rtt.p99,
      "rttMsMax" to rtt.max,
      "packFailuresTotal" to stats.packFailures,
      "transportErrors" to stats.transportErrors,
      "consumerReady" to pacer.consumerReady,
      "noSource" to !hasSource,
      "generation" to pacer.generation,
      "thermalState" to thermalStateName(),
      "memoryFootprintMb" to memoryFootprintMb(),
      "diagnostics" to diagnosticsEnabled,
    )
    if (current.source == PreviewSourceKind.SYNTHETIC) status["noiseAmplitude"] = current.noiseAmplitude
    if (current.consumerDelayMs != 0) status["consumerDelayMs"] = current.consumerDelayMs
    onStatus?.invoke(status)
    if (runLogEnabled) {
      runLog.write(status)
      trace.info(
        "status",
        mapOf(
          "running" to pacer.isRunning,
          "deliveredFps" to status["deliveredFps"],
          "acsSendFps" to status["acsSendFps"],
          "skippedBusy" to stats.skippedBusy,
          "skippedPacing" to stats.skippedPacing,
          "packMsP95" to pack.p95,
          "rttMsP95" to rtt.p95,
          "outstanding" to pacer.outstandingFrames,
          "packFailures" to stats.packFailures,
          "ackTimeouts" to stats.ackTimeouts,
          "tapSinkExceptions" to stats.tapSinkExceptions,
        ),
      )
    }
    return status
  }

  /**
   * One NDJSON file per run. `preview` runs span start..stop; `telemetry` runs are the
   * preview-off baseline recorded while tap telemetry is on and nothing is producing.
   */
  private fun beginRun(kind: String, nowNs: Long) {
    runKind = kind
    runId = "android-${System.currentTimeMillis() / 1000}-${UUID.randomUUID().toString().take(8)}"
    runStartedAtNs = nowNs
    stats.onRunStart(nowNs)
    lastTapDrainNs = nowNs
    if (!runLogEnabled) return
    val context = appContext ?: return
    runLog.begin(
      context,
      runId,
      mapOf(
        "platform" to "android",
        "schema" to RUN_LOG_SCHEMA,
        "runKind" to kind,
        "previewTraceId" to trace.traceId,
        "startedAt" to SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).format(Date()),
        "deviceModel" to "${Build.MANUFACTURER} ${Build.MODEL}",
        "osVersion" to Build.VERSION.RELEASE,
        "sdkInt" to Build.VERSION.SDK_INT,
        "source" to config.source.wire,
        "mode" to config.mode.wire,
        "targetFps" to fps,
        "targetWidth" to box.width,
        "targetHeight" to box.height,
        "tapTelemetry" to tapTelemetryEnabled,
        "transport" to "webmessage",
      ),
    )
  }

  private fun endRun(reason: String) {
    if (runKind == null) return
    val status = emitStatus()
    if (runLogEnabled) {
      runLog.end(
        reason,
        status.filterKeys { it in END_KEYS } + mapOf(
          "durationMs" to if (runStartedAtNs > 0) (System.nanoTime() - runStartedAtNs) / 1_000_000.0 else 0.0,
          "delivered" to stats.delivered,
          "sourceFrames" to stats.sourceFrames,
        ),
      )
    }
    runKind = null
  }

  /** A discrete lifecycle event on the same file as the 1 Hz lines. */
  private fun logEvent(event: String, fields: Map<String, Any?>) {
    if (!runLogEnabled) return
    runLog.write(
      fields + mapOf(
        "t" to "event",
        "event" to event,
        "runId" to runId,
        "atMs" to if (runStartedAtNs > 0) (System.nanoTime() - runStartedAtNs) / 1_000_000.0 else 0.0,
      ),
    )
  }

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

  /** JVM heap in use: the packed frames live in `ByteArray`s on the heap. */
  private fun memoryFootprintMb(): Double {
    val runtime = Runtime.getRuntime()
    return round1((runtime.totalMemory() - runtime.freeMemory()) / 1_048_576.0)
  }

  // endregion

  private fun round1(value: Double): Double = Math.round(value * 10.0) / 10.0

  private fun round2(value: Double): Double = Math.round(value * 100.0) / 100.0

  companion object {
    const val RUN_LOG_SCHEMA = 2

    /** Counters the NDJSON `end` line repeats from the final status, per the contract. */
    val CONTRACT_COUNTERS = listOf(
      "deliveredFps", "outstanding", "skippedBusy", "skippedPacing", "packMsP95", "rttMsP95",
      "deliveryGapMsP50", "deliveryGapMsP95", "tapOfferMeanUs", "tapCadenceMaxMs", "tapSinkExceptions",
      "packFailures", "staleAcks", "ackTimeouts", "installReloads", "handshakes", "tierChanges",
      "outWidth", "outHeight", "srcWidth", "srcHeight",
    )

    private val END_KEYS = CONTRACT_COUNTERS.toSet() + setOf("acsSendFps", "tapFramesOffered")
  }
}
