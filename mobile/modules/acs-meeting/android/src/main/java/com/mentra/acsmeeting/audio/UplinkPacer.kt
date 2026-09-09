package com.mentra.acsmeeting.audio

import kotlin.math.min

/**
 * Clock-domain adapter in front of ACS's raw outgoing audio stream.
 *
 * The producer (glasses → WHEP → [PcmBridge]) runs on the glasses' audio
 * clock; the consumer runs on the phone's monotonic clock. Those clocks never
 * agree exactly, so a plain FIFO drained by a 20 ms timer walks to empty or to
 * the cap over a long call even when there is no jitter at all. This class
 * locks the buffer depth to [TARGET_MS] instead of merely bounding it:
 *
 * - sustained depth above [HIGH_MS] (producer fast) discards a [CORRECTION_MS] slice
 * - sustained depth below [LOW_MS] (producer slow) inserts a [CORRECTION_MS] slice of silence
 * - depth above [EMERGENCY_CAP_MS] drops oldest down to target immediately
 *
 * Corrections read an EMA over roughly two seconds and are rate limited to one
 * per [CORRECTION_INTERVAL_MS], so ordinary jitter never triggers one; only
 * sustained error does. A cleaner follow-up is to nudge the WHEP → ACS
 * resampling ratio by the depth error instead of dropping and inserting
 * slices, which removes the discontinuity entirely.
 *
 * [tick] returns exactly one frame per call and never a burst. The pacing
 * deadline and the ACS I/O live in [UplinkSender]; this class is pure logic
 * driven by an injected clock so tests can run an hour in milliseconds.
 *
 * [push] runs on the WebRTC audio thread and [tick] on the pacing thread, so
 * every entry point is synchronized on this instance.
 */
class UplinkPacer(private val targetMs: Int = TARGET_MS) {
  enum class State { PREROLLING, RUNNING, STARVED }

  /** One [FRAME_MS] frame. [silence] marks a frame the pacer manufactured. */
  class Frame(val bytes: ByteArray, val silence: Boolean)

  data class Stats(
    val state: State,
    val depthMs: Int,
    val targetMs: Int,
    val sentFps: Double,
    val framesEmitted: Long,
    val silenceFrames: Long,
    val overflowDroppedMs: Long,
    val driftCorrections: Long,
    val driftDroppedMs: Long,
    val driftInsertedMs: Long,
  )

  private val ring = ByteArray(CAPACITY_BYTES)
  private var head = 0
  private var used = 0

  private var state = State.PREROLLING
  /** Negative until seeded on the first RUNNING tick. */
  private var depthEmaBytes = -1.0
  /**
   * Depth seen by the last tick's control decision, before it consumed a
   * frame. This — not the post-pop depth a between-ticks reader would see — is
   * the headroom a late producer actually gets, so it is what the envelope and
   * the log are stated in.
   */
  private var controlDepthBytes = 0
  private var starvingSinceNanos: Long? = null
  private var lastCorrectionNanos: Long? = null
  private var windowStartNanos: Long? = null
  private var windowFrames = 0L

  private var framesEmitted = 0L
  private var silenceFrames = 0L
  private var overflowDroppedBytes = 0L
  private var driftCorrections = 0L
  private var driftDroppedBytes = 0L
  private var driftInsertedBytes = 0L

  /** Appends 48 kHz mono PCM16 from the producer thread. */
  @Synchronized
  fun push(pcm16Le: ByteArray) {
    if (pcm16Le.isEmpty()) return
    var offset = 0
    var len = pcm16Le.size
    if (len > CAPACITY_BYTES) {
      // A single burst larger than the whole ring: keep only the newest audio.
      offset = len - CAPACITY_BYTES
      len = CAPACITY_BYTES
      overflowDroppedBytes += offset
    }
    val overflow = used + len - CAPACITY_BYTES
    if (overflow > 0) {
      dropOldest(overflow)
      overflowDroppedBytes += overflow
    }
    write(pcm16Le, offset, len)
  }

  /**
   * Advances one pacing period. Returns exactly one frame — real audio when
   * the state machine allows it, otherwise silence to keep the ACS cadence
   * unbroken.
   */
  @Synchronized
  fun tick(nowNanos: Long): Frame {
    if (windowStartNanos == null) windowStartNanos = nowNanos
    enforceCap()
    if (state == State.RUNNING) {
      depthEmaBytes =
        if (depthEmaBytes < 0) used.toDouble() else depthEmaBytes + EMA_ALPHA * (used - depthEmaBytes)
      correctDrift(nowNanos)
    }
    controlDepthBytes = used
    val frame = when (state) {
      // Hold the line until there is real headroom, so the first wobble of a
      // call does not underrun immediately.
      State.PREROLLING -> if (depthMs() >= targetMs) enterRunning() else silence()
      State.RUNNING -> if (used >= FRAME_BYTES) audio() else starve(nowNanos)
      // A WHEP outage would otherwise resume with zero headroom and underrun
      // again on the next wobble; rebuild the target first.
      State.STARVED -> if (depthMs() >= targetMs) enterRunning() else silence()
    }
    framesEmitted += 1
    windowFrames += 1
    return frame
  }

  /**
   * Stats for the 1 Hz ladder. `sentFps` covers the window since the previous
   * call, so exactly one caller (the sender's logger) may invoke this.
   */
  @Synchronized
  fun snapshot(nowNanos: Long): Stats {
    val start = windowStartNanos
    val elapsedNanos = if (start == null) 0L else nowNanos - start
    val fps = if (elapsedNanos > 0) windowFrames * 1_000_000_000.0 / elapsedNanos else 0.0
    windowStartNanos = nowNanos
    windowFrames = 0
    return Stats(
      state = state,
      depthMs = controlDepthBytes / BYTES_PER_MS,
      targetMs = targetMs,
      sentFps = fps,
      framesEmitted = framesEmitted,
      silenceFrames = silenceFrames,
      overflowDroppedMs = overflowDroppedBytes / BYTES_PER_MS,
      driftCorrections = driftCorrections,
      driftDroppedMs = driftDroppedBytes / BYTES_PER_MS,
      driftInsertedMs = driftInsertedBytes / BYTES_PER_MS,
    )
  }

  @Synchronized
  fun reset() {
    head = 0
    used = 0
    state = State.PREROLLING
    depthEmaBytes = -1.0
    controlDepthBytes = 0
    starvingSinceNanos = null
    lastCorrectionNanos = null
    windowStartNanos = null
    windowFrames = 0
    framesEmitted = 0
    silenceFrames = 0
    overflowDroppedBytes = 0
    driftCorrections = 0
    driftDroppedBytes = 0
    driftInsertedBytes = 0
  }

  @Synchronized
  fun state(): State = state

  /** Buffered audio right now, i.e. after the last tick consumed its frame. */
  @Synchronized
  fun depthMs(): Int = used / BYTES_PER_MS

  /** Headroom the last tick decided on, before it consumed its frame. */
  @Synchronized
  fun controlDepthMs(): Int = controlDepthBytes / BYTES_PER_MS

  private fun enterRunning(): Frame {
    state = State.RUNNING
    starvingSinceNanos = null
    // Seed at target, not at the observed depth: preroll just guaranteed the
    // target, and seeding from one sample would let the very first period of a
    // stalled producer look like sustained drift.
    depthEmaBytes = (targetMs * BYTES_PER_MS).toDouble()
    return audio()
  }

  private fun audio(): Frame {
    starvingSinceNanos = null
    return Frame(readFrame(), silence = false)
  }

  private fun silence(): Frame {
    silenceFrames += 1
    return Frame(ByteArray(FRAME_BYTES), silence = true)
  }

  private fun starve(nowNanos: Long): Frame {
    val since = starvingSinceNanos
    if (since == null) {
      starvingSinceNanos = nowNanos
    } else if (nowNanos - since >= STARVE_MS * 1_000_000L) {
      state = State.STARVED
      depthEmaBytes = -1.0
    }
    return silence()
  }

  private fun enforceCap() {
    val cap = EMERGENCY_CAP_MS * BYTES_PER_MS
    if (used <= cap) return
    val excess = used - targetMs * BYTES_PER_MS
    dropOldest(excess)
    overflowDroppedBytes += excess
    depthEmaBytes = used.toDouble()
  }

  private fun correctDrift(nowNanos: Long) {
    if (depthEmaBytes < 0) return
    val last = lastCorrectionNanos
    if (last != null && nowNanos - last < CORRECTION_INTERVAL_MS * 1_000_000L) return
    val emaMs = depthEmaBytes / BYTES_PER_MS
    val slice = CORRECTION_MS * BYTES_PER_MS
    when {
      emaMs > HIGH_MS -> {
        dropOldest(slice)
        driftDroppedBytes += slice
      }
      emaMs < LOW_MS -> {
        if (used + slice > CAPACITY_BYTES) return
        write(SILENCE_SLICE, 0, slice)
        driftInsertedBytes += slice
      }
      else -> return
    }
    driftCorrections += 1
    lastCorrectionNanos = nowNanos
    depthEmaBytes = used.toDouble()
  }

  private fun dropOldest(bytes: Int) {
    val n = min(bytes, used)
    head = (head + n) % CAPACITY_BYTES
    used -= n
  }

  private fun write(src: ByteArray, srcOffset: Int, len: Int) {
    var tail = (head + used) % CAPACITY_BYTES
    var from = srcOffset
    var remaining = len
    while (remaining > 0) {
      val chunk = min(remaining, CAPACITY_BYTES - tail)
      System.arraycopy(src, from, ring, tail, chunk)
      tail = (tail + chunk) % CAPACITY_BYTES
      from += chunk
      remaining -= chunk
    }
    used += len
  }

  private fun readFrame(): ByteArray {
    val out = ByteArray(FRAME_BYTES)
    var from = head
    var to = 0
    var remaining = FRAME_BYTES
    while (remaining > 0) {
      val chunk = min(remaining, CAPACITY_BYTES - from)
      System.arraycopy(ring, from, out, to, chunk)
      from = (from + chunk) % CAPACITY_BYTES
      to += chunk
      remaining -= chunk
    }
    head = from
    used -= FRAME_BYTES
    return out
  }

  companion object {
    const val RATE = 48_000
    const val CHANNELS = 1
    const val FRAME_MS = 20
    const val BYTES_PER_MS = RATE * CHANNELS * 2 / 1000
    const val FRAME_BYTES = FRAME_MS * BYTES_PER_MS

    const val TARGET_MS = 60
    const val LOW_MS = 40
    const val HIGH_MS = 100
    const val EMERGENCY_CAP_MS = 200

    const val CORRECTION_MS = 10
    const val CORRECTION_INTERVAL_MS = 500L
    const val STARVE_MS = 200L

    private const val CAPACITY_MS = 2_000
    private const val CAPACITY_BYTES = CAPACITY_MS * BYTES_PER_MS
    /** ~2 s at 50 ticks/s: long enough that jitter does not move it. */
    private const val EMA_ALPHA = 0.02
    private val SILENCE_SLICE = ByteArray(CORRECTION_MS * BYTES_PER_MS)
  }
}
