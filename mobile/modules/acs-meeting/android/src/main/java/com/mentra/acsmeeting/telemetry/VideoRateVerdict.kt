package com.mentra.acsmeeting.telemetry

/**
 * Names what is holding the outgoing frame rate down.
 *
 * The fps question kept being answered by inference: a soak put ~8.8 fps on the
 * wire, so the ACS software encoder "holds 8.8 fps". That does not follow. At
 * least four different things produce a low wire rate, they are trivial to tell
 * apart from numbers we already collect, and two of them want opposite fixes —
 * cutting resolution rescues an encoder that is genuinely CPU-bound and makes a
 * bitrate-starved stream strictly worse.
 *
 * So this prints the answer instead of leaving it to be guessed:
 *
 * - [Bound.SOURCE_SHORT] the glasses are not sending enough frames. Nothing
 *   downstream of the decoder can raise the rate.
 * - [Bound.PACER_SHORT] our own gate is the limit — it admitted fewer frames
 *   than we advertised while the source had plenty. This is what a greedy
 *   `FramePacer` did: 14.6 fps in, 7.3 out, against an advertised 8.
 * - [Bound.ENCODER_SHORT] ACS took the frames and put fewer on the wire while
 *   the CPU was busy. The real encoder ceiling. Cut pixels.
 * - [Bound.BITRATE_STARVED] ACS took the frames and put fewer on the wire with
 *   CPU to spare and the bitrate far under the budget we granted. The rate
 *   controller is throttling an encoder that could keep up. Cutting fps or
 *   pixels here makes it worse; fix delivery consistency.
 * - [Bound.CAP_BOUND] every frame is on the wire and the bitrate is pressed
 *   against the ceiling we granted. Nothing is broken; the grant is simply the
 *   limit, so the picture cannot get sharper until the number does.
 */
object VideoRateVerdict {
  enum class Bound {
    OK,
    SOURCE_SHORT,
    PACER_SHORT,
    ENCODER_SHORT,
    BITRATE_STARVED,
    CAP_BOUND,
    UNKNOWN,
  }

  /** Below this fraction of the target a rate counts as short rather than noise. */
  const val SHORT_FRACTION = 0.85

  /**
   * The pacer is held to a tighter tolerance than anything else, because it is
   * deterministic code we own rather than a jittery encoder or radio. The bug
   * this class was written for delivered 7.3 against an advertised 8 — a 9%
   * chronic shortfall, comfortably inside [SHORT_FRACTION] and still enough to
   * bias the ACS rate controller down on every hiccup.
   */
  const val PACER_SHORT_FRACTION = 0.95

  /** Process CPU at or above this is treated as the encoder being the cost. */
  const val CPU_BUSY_PERCENT = 80.0

  /** Wire bitrate below this fraction of the granted budget is a throttled stream. */
  const val STARVED_FRACTION = 0.6

  /**
   * Wire bitrate at or above this fraction of the grant counts as riding the ceiling.
   *
   * The grant is a target rather than a wall — a device run recorded the wire at 1623 kbps
   * against a 1.5 Mbps grant, 108% — so "pressed against it" has to mean near, not exactly at.
   * 0.95 is below the noise on a controller that routinely overshoots and well above the 0.85
   * that [VideoQuality.SPENDING_FRACTION] treats as merely spending the budget.
   */
  const val CAP_BOUND_FRACTION = 0.95

  fun of(
    advertisedFps: Double,
    sinkFps: Double,
    admittedFps: Double,
    wireFps: Double?,
    wireBitrateBps: Long?,
    budgetBps: Int,
    cpuPercent: Double?,
  ): Bound {
    if (advertisedFps <= 0.0) return Bound.UNKNOWN
    // Source first: when the glasses are short, every rate below them is short
    // too, and blaming the encoder for that sends the next fix to the wrong leg.
    if (sinkFps < advertisedFps * SHORT_FRACTION) return Bound.SOURCE_SHORT
    // Against what the source actually supplied, not against the advertise. The
    // pacer cannot admit frames that never arrived, and scoring it on the
    // advertise alone would read a merely slow source as our own bug.
    val deliverable = minOf(advertisedFps, sinkFps)
    if (admittedFps < deliverable * PACER_SHORT_FRACTION) return Bound.PACER_SHORT
    if (wireFps == null) return Bound.UNKNOWN
    if (wireFps >= admittedFps * SHORT_FRACTION) {
      // A full frame rate is not the same as a good picture, and this is the one case where the
      // fix is the ceiling itself. Reporting it as a plain OK is how "the quality is low" turns
      // into an argument about the encoder: every rate number looks healthy, so the grant — the
      // one thing actually holding the bits down — never comes up.
      val capBound =
        wireBitrateBps != null && budgetBps > 0 && wireBitrateBps >= budgetBps * CAP_BOUND_FRACTION
      return if (capBound) Bound.CAP_BOUND else Bound.OK
    }
    if (cpuPercent != null && cpuPercent >= CPU_BUSY_PERCENT) return Bound.ENCODER_SHORT
    val starved =
      wireBitrateBps != null && budgetBps > 0 && wireBitrateBps < budgetBps * STARVED_FRACTION
    return if (starved) Bound.BITRATE_STARVED else Bound.ENCODER_SHORT
  }

  /** What to do about it, so the log line does not need a reader who has this file open. */
  fun hint(bound: Bound): String = when (bound) {
    Bound.OK -> "wire is holding the advertised rate"
    Bound.SOURCE_SHORT -> "glasses/WHIP leg is short; raising ACS fps cannot help"
    Bound.PACER_SHORT -> "our gate drops frames the source supplied; check FramePacer interval"
    Bound.ENCODER_SHORT -> "ACS encoder is the ceiling; cut pixels (VideoProfile.SD) not fps"
    Bound.BITRATE_STARVED -> "rate controller is throttling, not CPU; do not cut fps or pixels"
    Bound.CAP_BOUND -> "wire is riding the granted ceiling; raising maxBitrateBps is the only lever"
    Bound.UNKNOWN -> "not enough evidence yet"
  }

  /**
   * One line per tick. Prints every input beside the verdict: a verdict whose
   * inputs are not visible is the same guess this class exists to replace.
   */
  fun line(
    advertisedFps: Double,
    sinkFps: Double,
    admittedFps: Double,
    wireFps: Double?,
    wireBitrateBps: Long?,
    budgetBps: Int,
    cpuPercent: Double?,
    codecName: String,
  ): String {
    val bound = of(
      advertisedFps = advertisedFps,
      sinkFps = sinkFps,
      admittedFps = admittedFps,
      wireFps = wireFps,
      wireBitrateBps = wireBitrateBps,
      budgetBps = budgetBps,
      cpuPercent = cpuPercent,
    )
    val wireLabel = wireFps?.let { PipelineStats.formatRate(it) } ?: "na"
    val wireKbps = wireBitrateBps?.let { (it / 1000).toString() } ?: "na"
    return "P7 rate bound=$bound advertised=${PipelineStats.formatRate(advertisedFps)} " +
      "sink=${PipelineStats.formatRate(sinkFps)} admitted=${PipelineStats.formatRate(admittedFps)} " +
      "wire=$wireLabel kbps=$wireKbps budgetKbps=${budgetBps / 1000} " +
      "cpu=${cpuPercent?.let { PipelineStats.formatRate(it) } ?: "na"} " +
      "codec=${codecName.ifBlank { "na" }.replace(' ', '_')} -- ${hint(bound)}"
  }
}
