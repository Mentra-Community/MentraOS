package com.mentra.acsmeeting.audio

import kotlin.math.max

/**
 * Measures what ACS actually delivers on the incoming mixed-audio callback.
 *
 * Deriving a rate as `bytes / (2 * channels) * 50` only holds if ACS really
 * fires exactly every 20 ms — which is the assumption being diagnosed. This
 * accumulates samples against elapsed monotonic time instead, so a rate ACS
 * mislabels shows up as `measuredRate` disagreeing with `declaredRate` and a
 * cadence that is not 20 ms shows up in `callbackHz`.
 */
class IncomingRateProbe(private val windowNanos: Long = DEFAULT_WINDOW_NANOS) {
  data class Reading(
    val declaredRate: Int,
    val channels: Int,
    val samplesPerCallback: Int,
    val callbackHz: Double,
    val measuredRate: Double,
    val events: Long,
  )

  private var windowStartNanos: Long? = null
  private var events = 0L
  private var samples = 0L

  /** Returns a reading at most once per window; null in between. */
  fun record(nowNanos: Long, bytes: Int, sampleRate: Int, channels: Int): Reading? {
    val samplesPerCallback = bytes / (2 * max(1, channels))
    val start = windowStartNanos
    if (start == null) {
      // This callback only opens the window; it arrived before it.
      windowStartNanos = nowNanos
      return null
    }
    events += 1
    samples += samplesPerCallback
    val elapsedNanos = nowNanos - start
    if (elapsedNanos < windowNanos) return null
    val seconds = elapsedNanos / 1_000_000_000.0
    val reading = Reading(
      declaredRate = sampleRate,
      channels = channels,
      samplesPerCallback = samplesPerCallback,
      callbackHz = events / seconds,
      measuredRate = samples / seconds,
      events = events,
    )
    windowStartNanos = nowNanos
    events = 0
    samples = 0
    return reading
  }

  fun reset() {
    windowStartNanos = null
    events = 0
    samples = 0
  }

  companion object {
    const val DEFAULT_WINDOW_NANOS = 1_000_000_000L
  }
}
