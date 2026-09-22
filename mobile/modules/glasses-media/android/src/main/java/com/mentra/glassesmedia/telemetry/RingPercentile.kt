package com.mentra.glassesmedia.telemetry

import kotlin.math.roundToInt

/** Thread-safe ring of nanosecond samples. p50/p95 for the 1 Hz ladder. */
class RingPercentile(private val capacity: Int = 32) {
  private val samples = LongArray(capacity)
  private var count = 0
  private var index = 0

  @Synchronized
  fun record(ns: Long) {
    samples[index] = ns
    index = (index + 1) % capacity
    if (count < capacity) count += 1
  }

  fun p50(): String = percentile(0.50)

  fun p95(): String = percentile(0.95)

  @Synchronized
  fun percentile(quantile: Double): String {
    if (count == 0) return "na"
    val copy = samples.copyOf(count)
    copy.sort()
    val idx = ((copy.size - 1) * quantile).roundToInt().coerceIn(0, copy.lastIndex)
    return ((copy[idx] / 1_000_000.0) * 10).roundToInt().div(10.0).toString()
  }

  /**
   * p95 in milliseconds, or -1 when nothing has been recorded.
   *
   * Numeric rather than the formatted [p95] because the ladder ranks stages against each other to
   * name the slowest one, and comparing the rendered strings would order "9.0" above "10.0".
   */
  @Synchronized
  fun p95Ms(): Double {
    if (count == 0) return -1.0
    val copy = samples.copyOf(count)
    copy.sort()
    val idx = ((copy.size - 1) * 0.95).roundToInt().coerceIn(0, copy.lastIndex)
    return copy[idx] / 1_000_000.0
  }

  @Synchronized
  fun size(): Int = count
}
