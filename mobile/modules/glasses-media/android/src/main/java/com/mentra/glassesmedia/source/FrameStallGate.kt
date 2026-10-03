package com.mentra.glassesmedia.source

/**
 * Watches a *live* ingest for a decoder that has stopped advancing.
 *
 * [FirstFrameGate] only ever guards the first frame; once promoted it never
 * fires again. An ingest that dies mid-call therefore reads as healthy from
 * every angle above this layer — ICE stays connected, audio keeps flowing, and
 * the wearer sits behind a frozen tile while the call still reports live video.
 * Two "video frozen, audio still works" reports arrived with nothing in the
 * traces marking the moment frames stopped.
 *
 * Kept free of `org.webrtc` types so the decision is unit testable; the source
 * feeds it one stats sample at a time and acts on [Verdict.Stalled].
 */
internal class FrameStallGate(private val stallSamples: Int) {
  sealed interface Verdict {
    /** Frames are advancing, or this sample cannot say. */
    data object Healthy : Verdict

    /** Frames have stopped but not yet for long enough to call it. */
    data class Suspected(val samples: Int) : Verdict

    /** Report once, then stay quiet until the next arm. */
    data class Stalled(val samples: Int) : Verdict
  }

  private var stalled = 0
  private var reported = false

  val samples: Int
    get() = stalled

  /** A new peer generation, or a source that re-earned LIVE. */
  fun arm() {
    stalled = 0
    reported = false
  }

  /**
   * @param live the source has painted at least one frame; before that the first-frame gate owns
   *   the verdict.
   * @param iceConnected a disconnected transport is its own failure, already handled upstream.
   * @param fps decoded frames per second, negative when the sample has no prior read to rate
   *   against. A rate needs two reads, so the first sample is never evidence.
   */
  fun sample(live: Boolean, iceConnected: Boolean, fps: Double): Verdict {
    if (!live || !iceConnected || fps < 0.0) {
      stalled = 0
      return Verdict.Healthy
    }
    if (fps > 0.0) {
      stalled = 0
      return Verdict.Healthy
    }
    stalled++
    if (stalled < stallSamples || reported) return Verdict.Suspected(stalled)
    reported = true
    return Verdict.Stalled(stalled)
  }
}
