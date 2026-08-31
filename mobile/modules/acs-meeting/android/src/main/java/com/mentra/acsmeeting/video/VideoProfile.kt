package com.mentra.acsmeeting.video

/**
 * The one place that decides what we send ACS: geometry, rate, and bitrate
 * ceiling. The declared format, the outgoing constraints, and the source target
 * size all read from here so they cannot drift apart.
 *
 * Drift is not cosmetic. ACS runs a rate controller over a fixed bitrate
 * budget, and its only levers are quality and dropped frames. If we advertise
 * 30 fps and send 15, it reserves budget for frames that never arrive; if we
 * advertise a rate we cannot sustain, it does the same. Either way the wire
 * rate collapses while our own counters look healthy.
 */
data class VideoProfile(
  val width: Int,
  val height: Int,
  val fps: Int,
  val maxBitrateBps: Int,
) {
  fun spec(): I420FormatSpec = I420FormatSpec.of(width, height, fps.toFloat())

  /** Bits available per frame at the ceiling. Below ~20 kbit the encoder starts dropping. */
  fun bitsPerFrame(): Int = maxBitrateBps / fps

  companion object {
    /**
     * 720p15. ACS encodes this in software on mid-range hardware (the media
     * statistics report `codecName: "h264 sw"`), so the pixel count is a real
     * CPU cost, not just a bitrate cost.
     */
    val HD = VideoProfile(width = 1280, height = 720, fps = 15, maxBitrateBps = 2_500_000)

    /** Quarter the pixels of [HD]. Use when the software encoder cannot hold 15 fps at 720p. */
    val SD = VideoProfile(width = 640, height = 360, fps = 15, maxBitrateBps = 1_000_000)

    /** Investigation flip. Ships as HD. SD is 360p — a quarter of the encode work. */
    val DEFAULT = HD
  }
}
