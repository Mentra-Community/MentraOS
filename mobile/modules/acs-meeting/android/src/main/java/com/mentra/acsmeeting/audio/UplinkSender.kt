package com.mentra.acsmeeting.audio

import android.util.Log
import com.azure.android.communication.calling.RawAudioBuffer
import com.azure.android.communication.calling.RawOutgoingAudioStream
import com.mentra.acsmeeting.telemetry.RingPercentile
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

/** [UplinkTransport] over ACS's raw outgoing audio stream. */
class AcsUplinkTransport(private val stream: RawOutgoingAudioStream) : UplinkTransport {
  override fun send(frame: ByteArray, onComplete: (Throwable?) -> Unit) {
    // Fresh direct storage per submission. Pooling is a valid follow-up, but
    // only if buffers return to the pool on completion rather than on return.
    val direct = ByteBuffer.allocateDirect(frame.size)
    direct.put(frame)
    direct.flip()
    val buffer = RawAudioBuffer()
    buffer.buffer = direct
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

  /** Idempotent: a second call is a no-op so a session can only ever pace once. */
  @Synchronized
  fun start() {
    if (thread != null) {
      log("P8 audio-up sender already started; ignoring")
      return
    }
    nextDeadlineNanos = null
    lastLogNanos = null
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
    inFlight.incrementAndGet()
    framesSubmitted.incrementAndGet()
    val startedNanos = clock()
    try {
      transport.send(frame.bytes) { error ->
        inFlight.decrementAndGet()
        completion.record(clock() - startedNanos)
        if (error != null) recordFailure(error)
      }
    } catch (error: Exception) {
      inFlight.decrementAndGet()
      recordFailure(error)
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
    log(
      "P8 audio-up state=${pace.state} depthMs=${pace.depthMs} targetMs=${pace.targetMs} " +
        "sentFps=${"%.1f".format(pace.sentFps)} silenceFrames=${pace.silenceFrames} " +
        "overflowDroppedMs=${pace.overflowDroppedMs} driftCorrections=${pace.driftCorrections} " +
        "driftDroppedMs=${pace.driftDroppedMs} driftInsertedMs=${pace.driftInsertedMs} " +
        "tickLateP95Ms=${lateness.p95()} tickLateMaxMs=${maxLateNanos / 1_000_000L} " +
        "skippedTicks=$skippedTicks inFlight=${inFlight.get()} " +
        "sendFailures=${sendFailures.get()} sendCompletionP95Ms=${completion.p95()} " +
        "backpressureDrops=$backpressureDrops",
    )
  }

  companion object {
    private const val TAG = "ACS-SPIKE"
    const val PERIOD_MS = UplinkPacer.FRAME_MS
    const val PERIOD_NANOS = PERIOD_MS * 1_000_000L
    const val MAX_IN_FLIGHT = 10
    private const val JOIN_TIMEOUT_MS = 500L
    private const val LOG_INTERVAL_NANOS = 1_000_000_000L
  }
}
