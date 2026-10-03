package com.mentra.framepreview

/** Outcome of asking the pacer whether a source frame may enter the preview pipeline. */
sealed interface PreviewAdmission {
  data class Admit(val sequence: Int) : PreviewAdmission

  /** Not yet due under the frame-rate schedule. */
  data object SkipPacing : PreviewAdmission

  /** A previous frame is still being packed or is still unacknowledged. */
  data object SkipBusy : PreviewAdmission

  /** Production is stopped, or no authenticated consumer holds credit. */
  data object NotRunning : PreviewAdmission
}

sealed interface PreviewAckResult {
  data class Accepted(val roundTripNs: Long) : PreviewAckResult

  /** From a previous generation, a previous frame, or arriving with nothing outstanding. */
  data object Stale : PreviewAckResult
}

/**
 * One-frame credit and an absolute frame-rate schedule.
 *
 * The failure this exists to prevent is a preview that keeps accepting frames a slow consumer
 * has not drawn yet: latency grows without bound and the wearer watches the past. So exactly one
 * frame may be in the pipeline at a time, and a frame is only admitted when the clock says its
 * slot is due. A slow consumer therefore lowers delivered fps; it never builds a queue.
 *
 * The schedule is absolute (`nextDue += period`) rather than "wait one period after finishing",
 * which would add the consumer's latency to every interval and quietly halve the frame rate.
 *
 * Mirrors `PreviewPacer.swift`; the two are covered by the same cases in their own languages.
 */
class PreviewPacer(targetFps: Int, private val ackTimeoutNs: Long = DEFAULT_ACK_TIMEOUT_NS) {
  private sealed interface State {
    data object Idle : State

    data class Packing(val sequence: Int) : State

    data class AwaitingAck(val sequence: Int, val sentAtNs: Long) : State
  }

  var generation: Int = 0
    private set

  var isRunning: Boolean = false
    private set

  /** Set once a consumer has authenticated for the current document. No credit exists before. */
  var consumerReady: Boolean = false
    private set

  private var state: State = State.Idle
  private var sequence = 0
  private var periodNs = periodForFps(targetFps)
  private var nextDueNs = 0L

  val outstandingFrames: Int
    get() = if (state is State.Idle) 0 else 1

  @Synchronized
  fun setTargetFps(fps: Int, nowNs: Long) {
    periodNs = periodForFps(fps)
    nextDueNs = nowNs
  }

  @Synchronized
  fun setConsumerReady(ready: Boolean) {
    consumerReady = ready
    if (!ready) state = State.Idle
  }

  @Synchronized
  fun start(nowNs: Long) {
    isRunning = true
    state = State.Idle
    nextDueNs = nowNs
  }

  /**
   * Halt production. The transport and the consumer's authentication survive by design, so a
   * later [start] does not need another handshake.
   */
  @Synchronized
  fun stop() {
    isRunning = false
    state = State.Idle
  }

  /** A new document invalidates every outstanding frame and every credit the old page held. */
  @Synchronized
  fun beginGeneration(): Int {
    generation += 1
    sequence = 0
    state = State.Idle
    consumerReady = false
    return generation
  }

  @Synchronized
  fun admit(nowNs: Long): PreviewAdmission {
    if (!isRunning || !consumerReady) return PreviewAdmission.NotRunning
    if (state !is State.Idle) return PreviewAdmission.SkipBusy
    if (nowNs < nextDueNs) return PreviewAdmission.SkipPacing
    advanceSchedule(nowNs)
    sequence += 1
    state = State.Packing(sequence)
    return PreviewAdmission.Admit(sequence)
  }

  /**
   * The worker finished with an admitted frame. [sent] is false for the diagnostic modes that
   * never reach the transport, which return their own credit immediately.
   */
  @Synchronized
  fun onPacked(sequence: Int, sent: Boolean, nowNs: Long) {
    val packing = state as? State.Packing ?: return
    if (packing.sequence != sequence) return
    state = if (sent) State.AwaitingAck(sequence, nowNs) else State.Idle
  }

  @Synchronized
  fun onAck(generation: Int, sequence: Int, nowNs: Long): PreviewAckResult {
    val awaiting = state as? State.AwaitingAck ?: return PreviewAckResult.Stale
    if (generation != this.generation || awaiting.sequence != sequence) return PreviewAckResult.Stale
    state = State.Idle
    return PreviewAckResult.Accepted(nowNs - awaiting.sentAtNs)
  }

  /**
   * True when the outstanding frame has gone unacknowledged past the deadline. The caller stops
   * the subscription; it must not hand out a replacement credit.
   */
  @Synchronized
  fun hasAckTimedOut(nowNs: Long): Boolean {
    val awaiting = state as? State.AwaitingAck ?: return false
    return nowNs - awaiting.sentAtNs > ackTimeoutNs
  }

  private fun advanceSchedule(nowNs: Long) {
    nextDueNs += periodNs
    // More than a whole period late (a stall, a thermal dip, a backgrounded app): resync instead
    // of trying to catch up, which would emit a burst the consumer never asked for.
    if (nextDueNs <= nowNs) nextDueNs = nowNs + periodNs
  }

  companion object {
    /**
     * Generous next to a 15 fps period: this is the "the consumer is gone" line, not a pacing
     * knob, and tripping it stops the subscription rather than minting credit.
     */
    const val DEFAULT_ACK_TIMEOUT_NS = 2_000_000_000L

    fun periodForFps(fps: Int): Long = 1_000_000_000L / maxOf(fps, 1)
  }
}
