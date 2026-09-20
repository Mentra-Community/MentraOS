package com.mentra.framepreview

import android.util.Log
import com.mentra.glassesmedia.source.DecodedFrameTap
import com.mentra.glassesmedia.source.I420Planes
import com.mentra.glassesmedia.video.I420Packer
import java.nio.ByteBuffer
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
  private val pacer = PreviewPacer(DEFAULT_FPS)

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
    }
    port.onAck = { generation, sequence -> handleAck(generation, sequence) }
    port.onFailure = { reason, detail ->
      stats.onTransportError()
      Log.w(TAG, "transport failure=$reason detail=$detail")
      if (reason == "auth_failed") pacer.setConsumerReady(false)
    }
  }

  fun prepareDocument(token: String): Int {
    val generation = pacer.beginGeneration()
    port.rotateToken(token)
    releaseAllSlots()
    return generation
  }

  fun configure(
    source: String?,
    mode: String?,
    targetFps: Int?,
    width: Int?,
    height: Int?,
    consumerDelayMs: Int?,
  ) {
    source?.let { this.source = if (it == "call") Source.CALL else Source.SYNTHETIC }
    mode?.let { raw -> Mode.entries.firstOrNull { it.wire == raw }?.let { this.mode = it } }
    targetFps?.let { this.targetFps = it.coerceIn(1, 30) }
    width?.let { this.width = it }
    height?.let { this.height = it }
    consumerDelayMs?.let { this.consumerDelayMs = it }
    pacer.setTargetFps(this.targetFps, System.nanoTime())
    if (scheduler != null || tapGeneration != null) restartProduction()
  }

  fun start() {
    pacer.setTargetFps(targetFps, System.nanoTime())
    pacer.start(System.nanoTime())
    restartProduction()
    startStatusTicker()
    Log.i(TAG, "start source=$source mode=${mode.wire} fps=$targetFps")
  }

  fun stop(reason: String) {
    if (!pacer.isRunning && scheduler == null && tapGeneration == null) return
    pacer.stop()
    stopProduction()
    statusTicker?.shutdownNow()
    statusTicker = null
    releaseAllSlots()
    Log.i(TAG, "stop reason=$reason")
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
        syntheticPool = SyntheticI420Pool(width, height)
        val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
          Thread(runnable, "frame-preview-synthetic").apply { isDaemon = true }
        }
        // Tick faster than the target so the pacer, not the timer, owns the schedule.
        val periodMs = (1000L / targetFps.coerceAtLeast(1) / 2).coerceAtLeast(4L)
        executor.scheduleAtFixedRate({ onSyntheticTick() }, 0, periodMs, TimeUnit.MILLISECONDS)
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
        val lease = pool.acquire(syntheticIndex, now)
        if (lease == null) {
          stats.onSkippedBusy()
          pacer.onPacked(admission.sequence, sent = false, nowNs = System.nanoTime())
          return
        }
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
    try {
      worker.execute { process(frame, sequence, timestampNs) }
    } catch (rejected: RejectedExecutionException) {
      // The single worker is busy. Releasing here is not optional: a retained frame dropped on
      // the floor is a decoder buffer that never comes back.
      frame.releaseSource()
      stats.onSkippedBusy()
      pacer.onPacked(sequence, sent = false, nowNs = System.nanoTime())
    }
  }

  private fun process(frame: AdmittedFrame, sequence: Int, timestampNs: Long) {
    var slot = -1
    try {
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
        stats.onSkippedBusy()
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

      val accepted = port.send(bytes) { sendNs -> stats.send.record(sendNs) }
      if (accepted) {
        stats.onDelivered(total)
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
    when (val result = pacer.onAck(generation, sequence, System.nanoTime())) {
      is PreviewAckResult.Accepted -> {
        stats.roundTrip.record(result.roundTripNs)
        releaseSlotForSequence(sequence)
      }
      is PreviewAckResult.Stale -> stats.onStaleAck()
    }
  }

  private fun checkAckTimeout(nowNs: Long) {
    if (!pacer.hasAckTimedOut(nowNs)) return
    stats.onAckTimeout()
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
    val hasSource = source == Source.SYNTHETIC ||
      (lastSourceFrameAtNs > 0 && now - lastSourceFrameAtNs < 2_000_000_000L)
    onStatus?.invoke(
      mapOf(
        "t" to "status",
        "platform" to "android",
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
        "delivered" to stats.delivered,
        "sourceFps" to round1(window.sourceFps),
        "deliveredFps" to round1(window.deliveredFps),
        "bytesPerSecond" to window.bytesPerSecond.toLong(),
        "packMsP50" to stats.pack.percentileMs(0.50),
        "packMsP95" to stats.pack.percentileMs(0.95),
        "sendMsP50" to stats.send.percentileMs(0.50),
        "sendMsP95" to stats.send.percentileMs(0.95),
        "rttMsP50" to stats.roundTrip.percentileMs(0.50),
        "rttMsP95" to stats.roundTrip.percentileMs(0.95),
        "outstanding" to pacer.outstandingFrames,
        "ackTimeouts" to stats.ackTimeouts,
        "staleAcks" to stats.staleAcks,
        "unsupportedFormat" to 0,
        "packFailures" to stats.packFailures,
        "transportErrors" to stats.transportErrors,
        "consumerReady" to pacer.consumerReady,
        "noSource" to !hasSource,
        "generation" to pacer.generation,
        "consumerDelayMs" to consumerDelayMs,
      ),
    )
  }

  private fun round1(value: Double): Double = Math.round(value * 10.0) / 10.0

  companion object {
    private const val TAG = "FRAME-PREVIEW"
    private const val DEFAULT_FPS = 15
  }
}
