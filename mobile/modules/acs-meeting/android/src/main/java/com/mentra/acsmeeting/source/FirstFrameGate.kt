package com.mentra.acsmeeting.source

/**
 * Guards the promotion to [SourceState.LIVE] on the first video frame.
 *
 * `LIVE` used to fire on the WHEP answer, which is three hops and several
 * seconds before ACS is handed a frame — long enough that Mentra Call told the
 * wearer video was restored 7.5 s before Teams got one. It now means a frame
 * reached the sink, and an answer that never produces one expires instead of
 * reading healthy forever behind a frozen last frame.
 *
 * Armed per peer generation so a frame — or a deadline — belonging to a peer
 * being torn down can neither promote nor fail its replacement.
 */
internal class FirstFrameGate {
  private var armedGeneration = -1
  // Read on every sink callback; the slow path takes the lock.
  @Volatile private var promoted = false

  /** The answer landed (or ICE came back): frames are promised, not delivered. */
  @Synchronized fun arm(generation: Int) {
    armedGeneration = generation
    promoted = false
  }

  /** True exactly once per [arm]: this frame is the one that makes the source live. */
  fun onFrame(generation: Int): Boolean {
    if (promoted) return false
    return promote(generation)
  }

  /** True while [generation] is armed and still frameless, so it must be rebuilt. */
  @Synchronized fun expired(generation: Int): Boolean = generation == armedGeneration && !promoted

  @Synchronized fun reset() {
    armedGeneration = -1
    promoted = false
  }

  @Synchronized private fun promote(generation: Int): Boolean {
    if (promoted || generation != armedGeneration) return false
    promoted = true
    return true
  }
}
