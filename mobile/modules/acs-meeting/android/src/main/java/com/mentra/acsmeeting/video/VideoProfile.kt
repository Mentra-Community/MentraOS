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

  /**
   * The format ACS's software encoder can actually hold on the phones we ship.
   *
   * Media statistics on SM_S948U (and earlier 720p soaks) report `codecName: "h264 sw"`
   * and a wire rate of ~8.8 fps no matter whether we asked for 15 or 30. Advertising
   * the faster rate makes ACS reserve budget for frames that encoder never produces,
   * and the wire collapses to a few hundred kbps while our own `sub` still reads 15.
   * Size stays; only the declared rate moves, so Teams still gets 540p/720p, just at
   * a cadence the software encoder can keep.
   */
  fun forSoftwareEncoder(): VideoProfile =
    if (fps <= SOFTWARE_ENCODER_FPS) this else copy(fps = SOFTWARE_ENCODER_FPS)

  companion object {
    /**
     * 720p15. ACS encodes this in software on mid-range hardware (the media
     * statistics report `codecName: "h264 sw"`), so the pixel count is a real
     * CPU cost, not just a bitrate cost.
     */
    val HD = VideoProfile(width = 1280, height = 720, fps = 15, maxBitrateBps = 2_500_000)

    /** Quarter the pixels of [HD]. Use when the software encoder cannot hold 15 fps at 720p. */
    val SD = VideoProfile(width = 640, height = 360, fps = 15, maxBitrateBps = 1_000_000)

    /**
     * Fastest rate the ACS software H.264 encoder has held on device.
     *
     * Every soak that reported `h264 sw` also reported wire ≈ 8.8 fps — 720p15,
     * 540p15, I420 and NV12. 8 is just under that so the rate controller is
     * never asked for a frame the encoder cannot produce.
     */
    const val SOFTWARE_ENCODER_FPS = 8

    /** Investigation flip. Ships as HD. SD is 360p — a quarter of the encode work. */
    val DEFAULT = HD

    /**
     * ACS P540. VirtualOutgoingVideoStream documents 960×540, not 540×960.
     * 540p A/B uses this size on both WHIP and ACS.
     */
    val P540 = VideoProfile(width = 960, height = 540, fps = 30, maxBitrateBps = 1_500_000)

    /**
     * Same P540 geometry at 15 fps. Selectable from Mentra Call; not the default.
     * Isolates pixel-count savings without doubling frame work versus [P540].
     *
     * The ceiling is sized from the picture rather than copied from [P540]. By the
     * Kush gauge a high-motion 960x540 at 15 fps needs `960·540·15·0.28` ≈ 2.18 Mbps
     * to avoid visible blocking, and a head-mounted camera is high motion by
     * definition. At the old 1.5 Mbps the same geometry topped out near 0.19 bits per
     * pixel even spending every bit, so 540p could not look sharp at any frame rate —
     * device runs sat at 0.165–0.217 and the picture was reported pixelated.
     *
     * Raising it is worth something because ACS treats this as a target, not a wall:
     * the `P9 quality` line recorded `used=108%` with the wire at 1623 kbps against
     * the old 1.5 Mbps grant. The rate controller was already reaching past the
     * number, so a larger one gives it somewhere to reach rather than being ignored.
     */
    val P540_15 = VideoProfile(width = 960, height = 540, fps = 15, maxBitrateBps = 2_200_000)

    fun parse(width: Int, height: Int, fps: Int, maxBitrateBps: Int): VideoProfile? {
      if (maxBitrateBps <= 0) return null
      I420FormatSpec.parseOrNull(width, height, fps.toFloat()) ?: return null
      return VideoProfile(width, height, fps, maxBitrateBps)
    }
  }
}
