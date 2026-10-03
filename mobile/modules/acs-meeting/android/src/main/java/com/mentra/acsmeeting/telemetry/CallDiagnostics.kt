package com.mentra.acsmeeting.telemetry

import com.mentra.glassesmedia.telemetry.PipelineStats

/**
 * The field sets behind the ACS call diagnostics, separated from the session that emits them.
 *
 * TEMPORARY DIAGNOSTIC — these feed `scripts/acs-quality-compare.mjs` and go away with it. They
 * live here because the session cannot be constructed in a JVM test (Android, plus the ACS SDK),
 * and a trace whose field names drift from the analyzer that parses them is worse than no trace:
 * the analyzer reports a call with no data rather than an error.
 */
object CallDiagnostics {

  /** Dense sampling while a call is still settling. */
  const val DENSE_INTERVAL_MS = 2_000L

  /** And sparse once it has, so a 20-minute call does not bury the interesting first minute. */
  const val SPARSE_INTERVAL_MS = 10_000L

  /** How long after `connected` the dense rate lasts. */
  const val DENSE_WINDOW_MS = 90_000L

  /**
   * "Visibly bad" and "gone", in bits per second. Same numbers as the analyzer.
   *
   * 500k at 540p15 is soft and blocky but legible; 250k is the mush the wearer calls potato. They
   * are duplicated in `scripts/acs-quality-compare.mjs` on purpose — native decides when to look
   * harder, the analyzer decides how to score, and neither should silently inherit the other's
   * threshold. If one moves, move both.
   */
  const val LOW_BITRATE_BPS = 500_000L
  const val VERY_LOW_BITRATE_BPS = 250_000L

  /** Above this the picture is back. Below it a call is still degraded, however far it has climbed. */
  const val RECOVERED_BITRATE_BPS = 1_000_000L

  /**
   * How long a dip or a downscale holds the dense cadence after it ends.
   *
   * The climb back has been measured at ~170 s against a 90 s dip, so the recovery ramp is the
   * larger half of what the wearer sits through and the part a sparse sampler renders as three
   * points. Held open by time rather than by rate so the ramp is sampled all the way up.
   */
  const val RECOVERY_WATCH_MS = 30_000L

  /**
   * What the ACS hop is doing, which decides how often it is worth looking.
   *
   * The old cadence was dense for 90 s after `connected` and sparse forever after, on the
   * assumption that a call which settles low does so early. An 8-minute capture disproved it: the
   * collapse began at t=150 s, so the interesting 90 s was sampled every 10 s — nine points for
   * the event the whole investigation was about — while the uneventful first minute got forty-five.
   *
   * `SILENT` is deliberately dense and deliberately not `LOW`. ACS publishing a report with unset
   * fields is a fact about ACS, not a bitrate of zero, and the Start path has been observed doing
   * it for most of a seven-minute call; that blindness is worth sampling closely for what the
   * other columns still say (sent fps, subscriber count, glasses hop) even though the rate is
   * unknown.
   */
  enum class WireHealth { SETTLING, SILENT, LOW, RECOVERING, HEALTHY }

  /**
   * @param sinceConnectedMs negative before `connected`
   * @param wireBitrateBps null or non-positive when ACS has not published a filled report
   * @param msSinceLow time since the rate was last under [LOW_BITRATE_BPS], or -1 if never
   * @param msSinceAdaptation time since the wire size last changed, or -1 if never
   */
  fun wireHealth(
    sinceConnectedMs: Long,
    wireBitrateBps: Long?,
    msSinceLow: Long,
    msSinceAdaptation: Long,
  ): WireHealth {
    if (sinceConnectedMs < 0 || sinceConnectedMs <= DENSE_WINDOW_MS) return WireHealth.SETTLING
    if (wireBitrateBps == null || wireBitrateBps <= 0) return WireHealth.SILENT
    if (wireBitrateBps < LOW_BITRATE_BPS) return WireHealth.LOW
    val watching = (msSinceLow in 0..RECOVERY_WATCH_MS) || (msSinceAdaptation in 0..RECOVERY_WATCH_MS)
    if (wireBitrateBps < RECOVERED_BITRATE_BPS || watching) return WireHealth.RECOVERING
    return WireHealth.HEALTHY
  }

  /** Sparse only when there is nothing happening; everything else is worth 2 s. */
  fun sampleIntervalMs(health: WireHealth): Long =
    if (health == WireHealth.HEALTHY) SPARSE_INTERVAL_MS else DENSE_INTERVAL_MS

  /**
   * One sample of both hops at one instant.
   *
   * Every rate is nullable or negative-for-unknown rather than defaulted to zero: a call with no
   * MEDIA_STATISTICS report yet and a call sending nothing look identical once both print 0.
   */
  data class BweSample(
    val state: String,
    val sinceJoinMs: Long,
    val sinceConnectedMs: Long,
    val lobbyDwellMs: Long,
    val sendQuality: String,
    val wireBitrateBps: Long?,
    val wireWidth: Int?,
    val wireHeight: Int?,
    val sentFps: Double,
    val wireFps: Double?,
    /**
     * The glasses hop's rate at this instant.
     *
     * On the same line as the ACS rate rather than left to `whip_ingest_sample`, because the
     * comparison between the two is the finding and pairing them by log timestamp was guesswork.
     * A collapsed wire next to a full-rate source is ACS's rate controller; both low is a starved
     * pipeline. Those need different fixes and the analyzer should not have to infer which it is.
     */
    val inboundBitrateBps: Long?,
    val inboundFps: Double?,
    val decodedFps: Double?,
    val framesGated: Int,
    val pacerDrops: Int,
    val budgetBps: Int,
    val rateArm: String,
    /** How many MEDIA_STATISTICS reports this call has received so far. Zero with a live `sentFps` is "ACS is silent", not "we are sending nothing". */
    val mediaStatsReports: Int = 0,
    val mediaStatsAttached: Boolean = false,
    /** `none` / ACS `VideoStreamState` name. Independent of whether MEDIA_STATISTICS ever reports. */
    val videoOut: String = "none",
    val packetsPerSecond: Double? = null,
    val subCount: Int = 0,
    val sinkCount: Int = 0,
  )

  /**
   * `origin` and `callId` on the front of every diagnostic.
   *
   * Without `origin` the Start-versus-Join comparison cannot be made from the log at all; without
   * `callId` two calls in one capture merge into one timeline whenever the trace id is reused.
   */
  fun stamp(origin: String, callId: String, vararg fields: Pair<String, Any?>): Array<Pair<String, Any?>> =
    arrayOf("origin" to origin.ifEmpty { "unknown" }, "callId" to callId.ifEmpty { "none" }, *fields)

  fun bweFields(origin: String, callId: String, sample: BweSample): Array<Pair<String, Any?>> = stamp(
    origin,
    callId,
    "state" to sample.state,
    "sinceJoinMs" to sample.sinceJoinMs,
    "sinceConnectedMs" to sample.sinceConnectedMs,
    "lobbyDwellMs" to sample.lobbyDwellMs,
    "sendQuality" to sample.sendQuality.ifBlank { "na" },
    // The ACS hop: what MEDIA_STATISTICS says actually left this phone, which is what the far end
    // sees and what the comparison ranks calls by.
    "wireBitrateBps" to (sample.wireBitrateBps ?: -1L),
    "wireWidth" to (sample.wireWidth ?: -1),
    "wireHeight" to (sample.wireHeight ?: -1),
    "sentFps" to PipelineStats.formatRate(sample.sentFps),
    "wireFps" to rate(sample.wireFps),
    // The glasses hop at the same instant: a phone sending little because it is receiving little
    // is a different fault from one throttling its own uplink from plenty.
    "inboundBitrateBps" to (sample.inboundBitrateBps ?: -1L),
    "inboundFps" to rate(sample.inboundFps),
    "decodedFps" to rate(sample.decodedFps),
    "framesGated" to sample.framesGated,
    "pacerDrops" to sample.pacerDrops,
    "budgetBps" to sample.budgetBps,
    "p7RateBound" to sample.rateArm,
    // Present even when `wireBitrateBps` stays -1, so a Start that never gets MEDIA_STATISTICS
    // still has a row that can be compared to Join on "is the phone feeding frames" and "did ACS
    // attach / report".
    "mediaStatsReports" to sample.mediaStatsReports,
    "mediaStatsAttached" to sample.mediaStatsAttached,
    "videoOut" to sample.videoOut.ifBlank { "none" },
    "packetsPerSecond" to rate(sample.packetsPerSecond),
    "subCount" to sample.subCount,
    "sinkCount" to sample.sinkCount,
  )

  fun mediaStatsAttachFields(
    origin: String,
    callId: String,
    ok: Boolean,
    error: String = "",
  ): Array<Pair<String, Any?>> = stamp(
    origin,
    callId,
    "ok" to ok,
    "error" to error.ifBlank { "none" },
  )

  fun mediaStatsIntervalFields(
    origin: String,
    callId: String,
    attempt: Int,
    ok: Boolean,
    seconds: Int,
    error: String = "",
  ): Array<Pair<String, Any?>> = stamp(
    origin,
    callId,
    "attempt" to attempt,
    "ok" to ok,
    "seconds" to seconds,
    "error" to error.ifBlank { "none" },
  )

  fun mediaStatsReportFields(
    origin: String,
    callId: String,
    n: Int,
    videos: Int,
    audios: Int,
    wireBitrateBps: Long?,
    width: Int?,
    height: Int?,
    fps: Double?,
    codec: String,
    packetCount: Int?,
  ): Array<Pair<String, Any?>> = stamp(
    origin,
    callId,
    "n" to n,
    "videos" to videos,
    "audios" to audios,
    "wireBitrateBps" to (wireBitrateBps ?: -1L),
    "width" to (width ?: -1),
    "height" to (height ?: -1),
    "fps" to rate(fps),
    "codec" to codec.ifBlank { "na" }.replace(' ', '_'),
    "packetCount" to (packetCount ?: -1),
  )

  /**
   * The wire size ACS actually chose, logged on change.
   *
   * A permanent downscale is the single most misleading thing in these captures: ACS trades
   * resolution for frames inside its budget, so 320x180 at a steady 15 fps prints as a healthy
   * ladder line and reads like a working call. Until this event existed the drop was a `Log.w` the
   * analyzer could not see, which is how a call that spent 90 s at 320x180 was scored as fine.
   *
   * `ceilingBps` rides along because the whole point of the ceiling A/B is to ask whether a
   * smaller grant downscales less, and an event that cannot name its own arm cannot answer that.
   */
  fun wireAdaptationFields(
    origin: String,
    callId: String,
    width: Int,
    height: Int,
    direction: String,
    sinceConnectedMs: Long,
    askedWidth: Int,
    askedHeight: Int,
    wireBitrateBps: Long?,
    ceilingBps: Int,
    fps: Double?,
  ): Array<Pair<String, Any?>> = stamp(
    origin,
    callId,
    "width" to width,
    "height" to height,
    "direction" to direction,
    "sinceConnectedMs" to sinceConnectedMs,
    "asked" to "${askedWidth}x$askedHeight",
    "percentOfAsked" to percentOf(width, height, askedWidth, askedHeight),
    "wireBitrateBps" to (wireBitrateBps ?: -1L),
    "ceilingBps" to ceilingBps,
    "fps" to rate(fps),
  )

  /**
   * One low-bitrate episode, as it begins, as it ends, and once it is paid for.
   *
   * Emitted as well as being derivable from the samples because the two answer different
   * questions. The analyzer reconstructs episodes from whatever it can see, and says so when that
   * is thin; this event is the session's own account, so an episode is on the record even when
   * MEDIA_STATISTICS went quiet in the middle of it and the reconstruction has a hole.
   *
   * `inboundBitrateBps` is the glasses hop measured during the same window. It is the field that
   * assigns blame, and it belongs on the episode rather than only on the periodic sample: a full
   * source rate alongside a collapsed wire rate is ACS's rate controller and nothing upstream.
   */
  fun episodeFields(
    origin: String,
    callId: String,
    episode: String,
    startedAtMs: Long,
    durationMs: Long,
    minBitrateBps: Long,
    minResolution: String,
    recoveryMs: Long,
    inboundBitrateBps: Double?,
    sentFps: Double,
    ceilingBps: Int,
  ): Array<Pair<String, Any?>> = stamp(
    origin,
    callId,
    "episode" to episode,
    "startedAtMs" to startedAtMs,
    "durationMs" to durationMs,
    "minBitrateBps" to minBitrateBps,
    "minResolution" to minResolution.ifBlank { "na" },
    // -1 rather than 0: "has not climbed back yet" and "climbed back instantly" are different
    // findings, and on the capture that started this the difference was 170 seconds.
    "recoveryMs" to recoveryMs,
    "inboundBitrateBps" to rate(inboundBitrateBps),
    "sentFps" to PipelineStats.formatRate(sentFps),
    "ceilingBps" to ceilingBps,
  )

  private fun percentOf(width: Int, height: Int, askedWidth: Int, askedHeight: Int): Int {
    val asked = askedWidth.toLong() * askedHeight
    if (asked <= 0) return -1
    return (width.toLong() * height * 100 / asked).toInt()
  }

  /** Dense until [DENSE_WINDOW_MS] past `connected`; -1 for "not connected yet" keeps it dense. */
  fun sampleIntervalMs(sinceConnectedMs: Long): Long =
    if (sinceConnectedMs in 0..DENSE_WINDOW_MS || sinceConnectedMs < 0) DENSE_INTERVAL_MS else SPARSE_INTERVAL_MS

  private fun rate(value: Double?): String = value?.let { PipelineStats.formatRate(it) } ?: "na"
}
