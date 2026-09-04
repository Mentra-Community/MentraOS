package com.mentra.acsmeeting.telemetry

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

  @Synchronized
  fun size(): Int = count
}
