package com.mentra.acsmeeting.video

import java.util.concurrent.atomic.AtomicLong

/**
 * Drops frames that arrive sooner than the rate we advertised to ACS.
 *
 * [SendGate] only serializes in-flight sends. `sendRawVideoFrame` returns in about
 * a millisecond, so without a time gate we hand ACS fifteen frames a second and
 * its software encoder — which holds ~8.8 fps — is the one that has to drop them.
 * That is exactly the over-reservation that collapses the wire bitrate.
 *
 * The gate keeps an absolute schedule rather than measuring from the last admit.
 * That distinction is the whole rate: a "has [minIntervalNs] elapsed since the
 * last admit" test turns a 14.6 fps source into exact 2:1 decimation, because the
 * frame 68 ms after an admit is inside the 125 ms window and the next one lands at
 * 137 ms. Admits then run at 7.3 fps against an advertised 8 — the same
 * under-delivery this class exists to prevent, just one ladder rung down. Device
 * logs showed it: `sub` sat at 7.0 with `wire=960x540@7.0`, and every arrival
 * hiccup cost another 50% of the ACS bitrate budget. Advancing a deadline by whole
 * intervals lets a frame that lands late still fill its own slot, so the average
 * locks to the advertised rate for any source faster than it.
 */
class FramePacer {
  private val nextDueNs = AtomicLong(UNSET)

  fun reset() {
    nextDueNs.set(UNSET)
  }

  /**
   * True when this frame is due. [minIntervalNs] is derived from the advertised
   * fps so the emit rate cannot drift from the format we declared.
   */
  fun tryAdmit(minIntervalNs: Long, nowNs: Long = System.nanoTime()): Boolean {
    if (minIntervalNs <= 0) return true
    while (true) {
      val due = nextDueNs.get()
      if (due == UNSET) {
        if (nextDueNs.compareAndSet(due, nowNs + minIntervalNs)) return true
        continue
      }
      if (nowNs < due) return false
      // Resync instead of catching up when the source has been away for longer
      // than RESYNC_INTERVALS. Carrying that whole debt forward would admit a
      // burst back-to-back, which is over-delivery against the same advertised
      // rate and hits the ACS encoder the way the ungated path did.
      val next =
        if (nowNs - due > minIntervalNs * RESYNC_INTERVALS) {
          nowNs + minIntervalNs
        } else {
          due + minIntervalNs
        }
      if (nextDueNs.compareAndSet(due, next)) return true
    }
  }

  companion object {
    /** Not a legal timestamp. 0 is — [System.nanoTime] can start there in tests. */
    private const val UNSET = Long.MIN_VALUE

    /** How far behind schedule we still treat as catch-up rather than a new start. */
    private const val RESYNC_INTERVALS = 2

    fun intervalNs(fps: Float): Long {
      if (fps <= 0f) return 0L
      return (1_000_000_000.0 / fps).toLong()
    }
  }
}
