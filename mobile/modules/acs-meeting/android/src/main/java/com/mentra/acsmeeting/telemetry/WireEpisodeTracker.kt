package com.mentra.acsmeeting.telemetry

/**
 * Watches the ACS uplink rate and calls out each stretch where the picture went bad.
 *
 * TEMPORARY DIAGNOSTIC — pairs with `scripts/acs-quality-compare.mjs` and goes away with it.
 *
 * This exists because the failure that matters is an interval, not a number. The capture that
 * motivated it ran eight minutes: the wire sat at ~1.3 Mbps and 960x540, fell to 33 kbps and
 * 320x180 at t=150 s, stayed there about 90 s, then took another ~170 s to climb back — while the
 * glasses hop held ~2 Mbps at 14.5 fps throughout and the phone kept handing ACS 15 fps. No single
 * sample says that. A mean over the call says the opposite.
 *
 * It is a separate, dependency-free class so the state machine can be tested without Android or
 * the ACS SDK, which the session cannot be.
 *
 * The one rule that is easy to get wrong: **a missing rate is not a low rate.** ACS publishes
 * MEDIA_STATISTICS reports with the fields unset — 32 empty against 12 filled across one
 * seven-minute call — and treating those as zero would invent an episode for every silence and
 * bury the real ones. Silence leaves the state machine exactly where it was.
 */
class WireEpisodeTracker(
  private val lowBps: Long = CallDiagnostics.LOW_BITRATE_BPS,
  private val recoveredBps: Long = CallDiagnostics.RECOVERED_BITRATE_BPS,
) {

  /** What just happened to the episode, if anything. */
  enum class Phase {
    /** The rate just fell below the low threshold. */
    BEGIN,

    /** It just came back above it. The dip is over; the climb is not. */
    END,

    /** It reached [recoveredBps]. This is when the wearer has their picture back. */
    RECOVERED,
  }

  /**
   * @param durationMs time under the threshold; 0 on [Phase.BEGIN], final on [Phase.END]
   * @param recoveryMs time from the end of the dip to [recoveredBps]; -1 until [Phase.RECOVERED]
   * @param inboundBitrateBps the glasses hop during the episode — the field that assigns blame
   */
  data class Event(
    val phase: Phase,
    val startedAtMs: Long,
    val durationMs: Long,
    val minBitrateBps: Long,
    val minResolution: String,
    val recoveryMs: Long,
    val inboundBitrateBps: Double?,
    val sentFps: Double,
  )

  private var startedAtMs = -1L
  private var endedAtMs = -1L
  private var minBitrateBps = Long.MAX_VALUE
  private var minPixels = Long.MAX_VALUE
  private var minResolution = ""
  private var inboundSum = 0.0
  private var inboundCount = 0
  private var inEpisode = false
  private var awaitingRecovery = false

  /** True while the wire is under the threshold, so the caller can hold its dense cadence. */
  fun isInEpisode(): Boolean = inEpisode

  /** True after a dip has ended but before the rate has climbed back to [recoveredBps]. */
  fun isAwaitingRecovery(): Boolean = awaitingRecovery

  /**
   * Feed one observation. Returns the transition it caused, or null for "carry on".
   *
   * At most one transition per observation: a rate that jumps from 33 kbps straight past 1 Mbps
   * reports [Phase.END] now and [Phase.RECOVERED] on the next observation, so no caller has to
   * unpack two events from one return.
   */
  fun observe(
    atMs: Long,
    bitrateBps: Long?,
    width: Int?,
    height: Int?,
    inboundBitrateBps: Double?,
    sentFps: Double,
  ): Event? {
    // Silence is not evidence. See the class comment: this is the branch that keeps ACS's empty
    // reports from manufacturing an episode per gap.
    if (bitrateBps == null || bitrateBps <= 0) return null

    if (inEpisode) {
      if (bitrateBps < lowBps) {
        accumulate(atMs, bitrateBps, width, height, inboundBitrateBps)
        return null
      }
      inEpisode = false
      awaitingRecovery = true
      endedAtMs = atMs
      return event(Phase.END, atMs, recoveryMs = -1L, sentFps = sentFps)
    }

    if (bitrateBps < lowBps) {
      // A dip that returns before recovering is a new episode rather than a continuation: the
      // wearer saw the picture come back and go again, and averaging the two would hide that.
      startedAtMs = atMs
      endedAtMs = -1L
      minBitrateBps = Long.MAX_VALUE
      minPixels = Long.MAX_VALUE
      minResolution = ""
      inboundSum = 0.0
      inboundCount = 0
      inEpisode = true
      awaitingRecovery = false
      accumulate(atMs, bitrateBps, width, height, inboundBitrateBps)
      return event(Phase.BEGIN, atMs, recoveryMs = -1L, sentFps = sentFps)
    }

    if (awaitingRecovery && bitrateBps >= recoveredBps) {
      awaitingRecovery = false
      return event(Phase.RECOVERED, endedAtMs, recoveryMs = atMs - endedAtMs, sentFps = sentFps)
    }

    return null
  }

  private fun accumulate(atMs: Long, bitrateBps: Long, width: Int?, height: Int?, inboundBitrateBps: Double?) {
    endedAtMs = atMs
    if (bitrateBps < minBitrateBps) minBitrateBps = bitrateBps
    if (width != null && height != null && width > 0 && height > 0) {
      val pixels = width.toLong() * height
      if (pixels < minPixels) {
        minPixels = pixels
        minResolution = "${width}x$height"
      }
    }
    if (inboundBitrateBps != null && inboundBitrateBps > 0) {
      inboundSum += inboundBitrateBps
      inboundCount += 1
    }
  }

  private fun event(phase: Phase, atMs: Long, recoveryMs: Long, sentFps: Double): Event = Event(
    phase = phase,
    startedAtMs = startedAtMs,
    durationMs = if (phase == Phase.BEGIN) 0L else (atMs - startedAtMs).coerceAtLeast(0L),
    minBitrateBps = if (minBitrateBps == Long.MAX_VALUE) -1L else minBitrateBps,
    minResolution = minResolution,
    recoveryMs = recoveryMs,
    inboundBitrateBps = if (inboundCount > 0) inboundSum / inboundCount else null,
    sentFps = sentFps,
  )
}
