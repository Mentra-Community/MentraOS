package com.mentra.glassesmedia.telemetry

import kotlin.math.roundToInt

/**
 * How good the picture is, as opposed to how many frames of it there are.
 *
 * Every rate number we log can be healthy while Teams shows mush, because
 * "pixelated" is bits per pixel and nothing in the ladder computed that.
 * `wire=960x540@14.4 kbps=1276` reads fine and is 0.17 bits per pixel, which is
 * under what a head-mounted camera needs. ACS 2.16.0's
 * `OutgoingVideoStatistics` exposes no QP and no quality-limitation reason —
 * only codec, bitrate, packet count, rate, and size — so bits per pixel is the
 * only quality signal available and it has to be derived here.
 *
 * Bands come from the Kush gauge, the standard H.264 estimate
 * `bitrate ≈ width · height · fps · 0.07 · motion`, which rearranges to
 * `bpp ≈ 0.07 · motion`. Motion is 1 for a near-static scene, 2 for moderate,
 * and 4 for high. Glasses are strapped to someone's head, so the honest target
 * is the high-motion one — which is why a number sitting mid-band can still
 * look bad and the log says so rather than printing a bare "OK".
 */
object VideoQuality {
  enum class Band {
    /** Below what even a static scene needs. Visible blocking. */
    BLOCKY,

    /** Enough for a near-static scene only. Soft, smeared on movement. */
    SOFT,

    /** Enough for moderate motion. Still short for a head-mounted camera. */
    OK,

    /** Enough for high motion, which is what glasses actually produce. */
    GOOD,

    UNKNOWN,
  }

  /** bpp ≈ 0.07 · motion, for motion = 1, 2, and 4. */
  const val STATIC_BPP = 0.07
  const val MODERATE_BPP = 0.14
  const val HIGH_MOTION_BPP = 0.28

  fun bitsPerPixel(bitrateBps: Long?, width: Int?, height: Int?, fps: Double?): Double? {
    if (bitrateBps == null || width == null || height == null || fps == null) return null
    if (bitrateBps <= 0 || width <= 0 || height <= 0 || fps <= 0.0) return null
    return bitrateBps / (width.toDouble() * height * fps)
  }

  fun band(bpp: Double?): Band = when {
    bpp == null -> Band.UNKNOWN
    bpp < STATIC_BPP -> Band.BLOCKY
    bpp < MODERATE_BPP -> Band.SOFT
    bpp < HIGH_MOTION_BPP -> Band.OK
    else -> Band.GOOD
  }

  /** Bitrate this geometry needs to reach [bpp], so the log can name the shortfall. */
  fun neededBps(width: Int, height: Int, fps: Double, bpp: Double): Long {
    if (width <= 0 || height <= 0 || fps <= 0.0) return 0L
    return (width.toDouble() * height * fps * bpp).toLong()
  }

  /**
   * Whether the granted ceiling can even reach high motion at this geometry.
   *
   * This is the check that turns "the picture is bad" into a decision. 540p15
   * against a 1.5 Mbps budget tops out at 0.19 bpp even if ACS spends every bit,
   * so no encoder change and no rate fix can make that combination look sharp on
   * a moving camera — the budget is the ceiling, and it has to move.
   */
  fun budgetCapsQuality(width: Int, height: Int, fps: Double, budgetBps: Int): Boolean {
    if (budgetBps <= 0) return false
    return budgetBps < neededBps(width, height, fps, HIGH_MOTION_BPP)
  }

  /**
   * Whether ACS is actually spending what it was granted.
   *
   * The grant is a target, not a wall — a device run recorded `used=108%`, the wire
   * at 1623 kbps against a 1.5 Mbps grant — so falling short of it is a choice the
   * rate controller made rather than a limit it hit. That makes the shortfall
   * diagnostic: something upstream of the ceiling is holding the bitrate down, and
   * [hint] uses CPU to say which thing.
   */
  const val SPENDING_FRACTION = 0.85

  /**
   * Process CPU at which a software encoder is a plausible cap.
   *
   * The figure is a percentage of a *single* core, not of the device, so on an
   * 8-core phone 88% means one core nearly full while seven sit idle. That still
   * binds a single-threaded encoder, which is why the threshold sits near one core
   * rather than near the machine.
   */
  const val ENCODER_BUSY_PERCENT = 90.0

  fun spendingBudget(wireBitrateBps: Long?, budgetBps: Int): Boolean {
    if (wireBitrateBps == null || budgetBps <= 0) return false
    return wireBitrateBps >= budgetBps * SPENDING_FRACTION
  }

  fun hint(
    band: Band,
    budgetCapped: Boolean,
    spendingBudget: Boolean,
    encoderBusy: Boolean,
  ): String = when {
    band == Band.UNKNOWN -> "no wire report yet"
    band == Band.GOOD -> "enough for high motion"
    !spendingBudget && encoderBusy ->
      "bits unspent with a core nearly full; encoder is the cap -- cut pixels, not the ceiling"
    !spendingBudget ->
      "bits unspent while CPU is idle; congestion control is holding the rate down, " +
        "so neither a bigger ceiling nor fewer pixels addresses it -- check the network"
    budgetCapped ->
      "budget cannot reach high motion at this geometry; raise maxBitrateBps or drop resolution"
    band == Band.BLOCKY -> "far below any usable bitrate; check for a rate-controller collapse"
    band == Band.SOFT -> "only enough for a static scene; a head camera will smear"
    else -> "fine for moderate motion, still short for a head-mounted camera"
  }

  /**
   * One line per tick. Prints the derived figures and the bitrate that would be
   * needed, because "0.17 bpp" alone does not tell anyone what to change.
   */
  fun line(
    wireWidth: Int?,
    wireHeight: Int?,
    wireFps: Double?,
    wireBitrateBps: Long?,
    budgetBps: Int,
    packetsPerSecond: Double?,
    cpuPercent: Double?,
    sendQuality: String,
  ): String {
    val bpp = bitsPerPixel(wireBitrateBps, wireWidth, wireHeight, wireFps)
    val band = band(bpp)
    val capped = if (wireWidth != null && wireHeight != null && wireFps != null) {
      budgetCapsQuality(wireWidth, wireHeight, wireFps, budgetBps)
    } else {
      false
    }
    val bitsPerFrame = if (wireBitrateBps != null && wireFps != null && wireFps > 0) {
      (wireBitrateBps / wireFps).roundToInt().toString()
    } else {
      "na"
    }
    val goodKbps = if (wireWidth != null && wireHeight != null && wireFps != null) {
      (neededBps(wireWidth, wireHeight, wireFps, HIGH_MOTION_BPP) / 1000).toString()
    } else {
      "na"
    }
    val usedKbps = wireBitrateBps?.let { (it / 1000).toString() } ?: "na"
    val usedPercent = if (wireBitrateBps != null && budgetBps > 0) {
      ((wireBitrateBps * 100.0 / budgetBps).roundToInt()).toString()
    } else {
      "na"
    }
    return "P9 quality band=$band bpp=${bpp?.let { decimal(it) } ?: "na"} " +
      "size=${wireWidth ?: 0}x${wireHeight ?: 0}@${wireFps?.let { PipelineStats.formatRate(it) } ?: "na"} " +
      "bitsPerFrame=$bitsPerFrame kbps=$usedKbps budgetKbps=${budgetBps / 1000} used=$usedPercent% " +
      "goodNeedsKbps=$goodKbps budgetCapped=$capped " +
      "pps=${packetsPerSecond?.let { PipelineStats.formatRate(it) } ?: "na"} " +
      "cpu=${cpuPercent?.let { PipelineStats.formatRate(it) } ?: "na"} " +
      "sendQuality=${sendQuality.ifBlank { "na" }} -- " +
      hint(
        band = band,
        budgetCapped = capped,
        spendingBudget = spendingBudget(wireBitrateBps, budgetBps),
        encoderBusy = cpuPercent != null && cpuPercent >= ENCODER_BUSY_PERCENT,
      )
  }

  /** Three places, because bpp differences that matter show up in the third. */
  private fun decimal(value: Double): String = ((value * 1000).roundToInt() / 1000.0).toString()
}
