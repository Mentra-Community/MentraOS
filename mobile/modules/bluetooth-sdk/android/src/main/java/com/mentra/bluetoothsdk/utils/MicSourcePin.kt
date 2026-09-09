package com.mentra.bluetoothsdk.utils

/**
 * Call-scoped microphone lock.
 *
 * The ranking in `DeviceManager` answers "which microphone can we get?", and for captions or the
 * cloud uplink that is the right question — any working microphone beats none. A call is the case
 * where it is the wrong question: the wearer agreed to be heard from the glasses, so falling
 * through to the phone puts the room they are standing in onto a Teams call that still reports
 * "glasses". A pin turns the fallback off for exactly as long as the call holds it.
 */
object MicSourcePin {
  /**
   * Validate a pin request. Only the glasses microphone can be pinned: every other source is one
   * the ranking would have picked anyway, so pinning it buys nothing and only adds a way to strand
   * the selection on a microphone no consumer asked for.
   */
  fun normalize(source: String?): String? {
    val trimmed = source?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    require(trimmed == MicTypes.GLASSES_CUSTOM) { "unsupported mic source pin: $trimmed" }
    return trimmed
  }

  /**
   * The sources selection may consider. A pin replaces the ranking outright rather than reordering
   * it, so "the pinned source is unavailable" resolves to no microphone instead of the next best
   * one.
   */
  fun selectionOrder(ranking: List<String>, pin: String?): List<String> =
    if (pin == null) ranking else listOf(pin)
}
