package com.mentra.acsmeeting.audio

import android.util.Log
import com.azure.android.communication.calling.RawAudioBuffer
import com.azure.android.communication.calling.RawOutgoingAudioStream
import com.mentra.glassesmedia.source.MediaDiagnostics
import com.mentra.glassesmedia.telemetry.RingPercentile
import com.mentra.acsmeeting.video.AcsTimestamp
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.LockSupport

/**
 * Submits one paced frame to ACS.
 *
 * The implementation owns immutable storage for the frame until it invokes
 * `onComplete`; the caller's array is free the moment `send` returns. This is
 * the whole point of the seam: `sendRawAudioBuffer` is asynchronous, so a
 * buffer reused on the next tick could be overwritten mid-send.
 */
fun interface UplinkTransport {
  fun send(frame: ByteArray, onComplete: (Throwable?) -> Unit)
}

/**
 * [UplinkTransport] over ACS's raw outgoing audio stream.
 *
 * Every buffer is stamped on the same 100-nanosecond tick base the outgoing video uses
 * ([AcsTimestamp]), because `System.nanoTime()` is the only reference the two streams share — the
 * audio arrives over BLE and the video over the SoftAP peer, so submission order says nothing about
 * capture order. Unlike `VirtualOutgoingVideoStream`, `RawOutgoingAudioStream` in 2.16.0 offers no
 * stream clock to prefer, so the capture time is always the source.
 *
 * Whether ACS actually *uses* these ticks to lip-sync raw audio at the receiver is an open question
 * that only a receiver-side recording answers. Stamping them is the precondition for asking it, not
 * the answer, and it is separately worth doing: a run of zero timestamps is what makes the Teams
 * jitter buffer hold. [MediaDiagnostics.acsAudioTimestamps] turns it off so the question can be
 * asked both ways on the same device.
 */
class AcsUplinkTransport(
  private val stream: RawOutgoingAudioStream,
  private val clock: () -> Long = System::nanoTime,
  private val stamp: Boolean = MediaDiagnostics.acsAudioTimestamps,
) : UplinkTransport {
  private var lastTicks = 0L

  override fun send(frame: ByteArray, onComplete: (Throwable?) -> Unit) {
    // Fresh direct storage per submission. Pooling is a valid follow-up, but
    // only if buffers return to the pool on completion rather than on return.
    val direct = ByteBuffer.allocateDirect(frame.size)
    direct.put(frame)
    direct.flip()
    val buffer = RawAudioBuffer()
    buffer.buffer = direct
    if (stamp) {
      val ticks = AcsTimestamp.resolve(streamTicks = 0L, captureNs = clock(), lastTicks = lastTicks)
      lastTicks = ticks
      buffer.timestampInTicks = ticks
    }
    stream.sendRawAudioBuffer(buffer).whenComplete { _, error ->
      try {
        buffer.close()
      } catch (closeError: Exception) {
        Log.w(TAG, "RawAudioBuffer close failed", closeError)
      }
      onComplete(error)
    }
  }

  private companion object {
    const val TAG = "ACS-SPIKE"
  }
}

/**
 * Drains [UplinkPacer] on a monotonic deadline and hands frames to ACS.
 *
 * A fixed-rate executor is deliberately not used: after a GC or CPU-contention
 * stall it is allowed to replay the missed periods back to back, recreating
 * exactly the burstiness the pacer exists to remove. This loop advances a
 * `System.nanoTime()` deadline instead and sends exactly one frame per wake,
 * counting what it skipped.
 */
class UplinkSender(
  private val pacer: UplinkPacer,
  private val transport: UplinkTransport,
  private val clock: () -> Long = System::nanoTime,
  /**
   * Read immediately before every submission, not once per period.
   *
   * The last gate on the path. The pacer pops a frame and the transport accepts it on the same
   * thread but not at the same instant, and a mute that lands in between would otherwise put the
   * wearer's last word on the call after they asked not to be heard.
   */
  private val muted: () -> Boolean = { false },
  /**
   * Latest 16-bit mean-abs from [PcmBridge]. Mute flags and a RUNNING pacer both look healthy on
   * analog-silent LC3; this is what tells a soak that Teams is hearing the noise floor.
   */
  private val pcmMeanAbs: () -> Int = { -1 },
  private val log: (String) -> Unit = { Log.i(TAG, it) },
  private val logError: (String, Throwable?) -> Unit = { message, error -> Log.e(TAG, message, error) },
) {
  data class Stats(
    val framesSubmitted: Long,
    val skippedTicks: Long,
    val tickLateMaxMs: Long,
    val inFlight: Int,
    val sendFailures: Long,
    val backpressureDrops: Long,
    /** Frames replaced by silence by the mute gate, i.e. voice that never reached Teams. */
    val mutedFrames: Long,
    /**
     * How long after a mute the buffers ACS had already accepted took to drain, or null while no
     * mute has completed. This is the honest measure of "when did Teams stop hearing the wearer";
     * the gate itself is instantaneous, `sendRawAudioBuffer` is not.
     */
    val muteTailMs: Long?,
  )

  private val running = AtomicBoolean(false)
  private val inFlight = AtomicInteger(0)
  private val sendFailures = AtomicLong(0)
  private val framesSubmitted = AtomicLong(0)
  private val lateness = RingPercentile(64)
  private val completion = RingPercentile(64)

  private var thread: Thread? = null
  @Volatile private var nextDeadlineNanos: Long? = null
  @Volatile private var skippedTicks = 0L
  @Volatile private var maxLateNanos = 0L
  @Volatile private var backpressureDrops = 0L
  @Volatile private var lastLogNanos: Long? = null
  @Volatile private var lastFailureLogNanos: Long? = null
  @Volatile private var mutedFrames = 0L
  @Volatile private var mutedSinceNanos: Long? = null
  @Volatile private var muteTailNanos: Long? = null
  private var lastLoggedOverflowMs = 0L
  private var lastLoggedSilence = 0L

  /** Idempotent: a second call is a no-op so a session can only ever pace once. */
  @Synchronized
  fun start() {
    if (thread != null) {
      log("P8 audio-up sender already started; ignoring")
      return
    }
    nextDeadlineNanos = null
    lastLogNanos = null
    lastLoggedOverflowMs = 0
    lastLoggedSilence = 0
    running.set(true)
    // Audio cadence: a late frame is an artifact, so outrank the RN and
    // decoder threads this competes with.
    val started = Thread(::loop, "acs-uplink-pacer").apply {
      priority = Thread.MAX_PRIORITY
      isDaemon = true
    }
    thread = started
    started.start()
    log("P8 audio-up sender started periodMs=$PERIOD_MS frameBytes=${UplinkPacer.FRAME_BYTES}")
  }

  /** Idempotent. Stops feeding ACS and joins the pacing thread. */
  @Synchronized
  fun stop() {
    val current = thread ?: return
    thread = null
    running.set(false)
    current.interrupt()
    current.join(JOIN_TIMEOUT_MS)
    log(
      "P8 audio-up sender stopped frames=${framesSubmitted.get()} " +
        "skippedTicks=$skippedTicks sendFailures=${sendFailures.get()}",
    )
  }

  fun isRunning(): Boolean = running.get()

  fun stats(): Stats = Stats(
    framesSubmitted = framesSubmitted.get(),
    skippedTicks = skippedTicks,
    tickLateMaxMs = maxLateNanos / 1_000_000L,
    inFlight = inFlight.get(),
    sendFailures = sendFailures.get(),
    backpressureDrops = backpressureDrops,
    mutedFrames = mutedFrames,
    muteTailMs = muteTailNanos?.let { it / 1_000_000L },
  )

  private fun loop() {
    while (running.get()) {
      val deadline = nextDeadlineNanos
      val now = clock()
      if (deadline == null || now - deadline >= 0) {
        pumpOnce(now)
        continue
      }
      LockSupport.parkNanos(deadline - now)
    }
  }

  /**
   * One pacing period: exactly one frame out, deadline advanced, nothing
   * replayed. Returns the next deadline. Package-visible so tests can run the
   * loop body against a fake clock.
   */
  internal fun pumpOnce(nowNanos: Long): Long {
    val deadline = nextDeadlineNanos ?: nowNanos
    val lateNanos = nowNanos - deadline
    if (lateNanos > 0) {
      lateness.record(lateNanos)
      if (lateNanos > maxLateNanos) maxLateNanos = lateNanos
    }
    val next = if (lateNanos >= PERIOD_NANOS) {
      // A whole period or more was lost. Re-base on now instead of catching
      // up, so the frames ACS already missed stay missed.
      skippedTicks += lateNanos / PERIOD_NANOS
      nowNanos + PERIOD_NANOS
    } else {
      deadline + PERIOD_NANOS
    }
    nextDeadlineNanos = next
    // Before the submission, because this period's own frame is silence once muted and counting it
    // as in flight would make the tail look like it never finished draining.
    trackMuteTail(nowNanos)
    submit(pacer.tick(nowNanos))
    maybeLog(nowNanos)
    return next
  }

  private fun submit(frame: UplinkPacer.Frame) {
    // ACS is not keeping up; feeding it harder only grows the queue.
    if (inFlight.get() >= MAX_IN_FLIGHT) {
      backpressureDrops += 1
      return
    }
    // Silence rather than nothing: the cadence ACS reads as a healthy stream has to continue, and
    // a gap is a glitch on the far end rather than a mute.
    val bytes = if (!frame.silence && muted()) {
      mutedFrames += 1
      SILENCE_FRAME
    } else {
      frame.bytes
    }
    inFlight.incrementAndGet()
    framesSubmitted.incrementAndGet()
    val startedNanos = clock()
    try {
      transport.send(bytes) { error ->
        inFlight.decrementAndGet()
        completion.record(clock() - startedNanos)
        if (error != null) recordFailure(error)
      }
    } catch (error: Exception) {
      inFlight.decrementAndGet()
      recordFailure(error)
    }
  }

  /**
   * Time the drain of the buffers ACS accepted before the mute.
   *
   * Measured from the first period that observed the mute to the first period with nothing left in
   * flight, which is the last moment any pre-mute voice can still be played out at the receiver.
   */
  private fun trackMuteTail(nowNanos: Long) {
    if (!muted()) {
      mutedSinceNanos = null
      return
    }
    val since = mutedSinceNanos
    if (since == null) {
      mutedSinceNanos = nowNanos
      muteTailNanos = null
      return
    }
    if (muteTailNanos == null && inFlight.get() == 0) {
      val tail = nowNanos - since
      muteTailNanos = tail
      log("P8 audio-up muteTailMs=${tail / 1_000_000L} mutedFrames=$mutedFrames")
    }
  }

  private fun recordFailure(error: Throwable) {
    sendFailures.incrementAndGet()
    val now = clock()
    val last = lastFailureLogNanos
    if (last != null && now - last < LOG_INTERVAL_NANOS) return
    lastFailureLogNanos = now
    logError("P8 audio-up sendRawAudioBuffer failed total=${sendFailures.get()}", error)
  }

  private fun maybeLog(nowNanos: Long) {
    val last = lastLogNanos
    if (last != null && nowNanos - last < LOG_INTERVAL_NANOS) return
    lastLogNanos = nowNanos
    if (last == null) return
    val pace = pacer.snapshot(nowNanos)
    val overflowDelta = pace.overflowDroppedMs - lastLoggedOverflowMs
    val silenceDelta = pace.silenceFrames - lastLoggedSilence
    lastLoggedOverflowMs = pace.overflowDroppedMs
    lastLoggedSilence = pace.silenceFrames
    log(
      "P8 audio-up state=${pace.state} depthMs=${pace.depthMs} targetMs=${pace.targetMs} " +
        "sentFps=${"%.1f".format(pace.sentFps)} silenceFrames=${pace.silenceFrames} " +
        "overflowDroppedMs=${pace.overflowDroppedMs} dropMs=$overflowDelta silenceDelta=$silenceDelta " +
        "driftCorrections=${pace.driftCorrections} " +
        "driftDroppedMs=${pace.driftDroppedMs} driftInsertedMs=${pace.driftInsertedMs} " +
        "tickLateP95Ms=${lateness.p95()} tickLateMaxMs=${maxLateNanos / 1_000_000L} " +
        "skippedTicks=$skippedTicks inFlight=${inFlight.get()} " +
        "sendFailures=${sendFailures.get()} sendCompletionP95Ms=${completion.p95()} " +
        "backpressureDrops=$backpressureDrops mutedFrames=$mutedFrames " +
        "muteTailMs=${muteTailNanos?.let { it / 1_000_000L } ?: -1} " +
        "pcmMeanAbs=${pcmMeanAbs()}",
    )
  }

  companion object {
    private const val TAG = "ACS-SPIKE"
    const val PERIOD_MS = UplinkPacer.FRAME_MS
    const val PERIOD_NANOS = PERIOD_MS * 1_000_000L
    const val MAX_IN_FLIGHT = 10
    private const val JOIN_TIMEOUT_MS = 500L
    private const val LOG_INTERVAL_NANOS = 1_000_000_000L

    /**
     * Shared, and safe to share: [UplinkTransport] contracts to copy into its own storage before
     * returning, so nothing downstream retains this array.
     */
    private val SILENCE_FRAME = ByteArray(UplinkPacer.FRAME_BYTES)
  }
}
