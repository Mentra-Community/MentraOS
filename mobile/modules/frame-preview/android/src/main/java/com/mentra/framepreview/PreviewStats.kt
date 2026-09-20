package com.mentra.framepreview

import kotlin.math.roundToInt

/**
 * Fixed-size sample ring with numeric percentiles.
 *
 * Numeric rather than the formatted helper in `glasses-media`: these values cross into the
 * WebView as JSON and the page charts them, so "na" in a number field would be a parse error
 * rather than a missing sample.
 */
class PreviewPercentileRing(private val capacity: Int = 64) {
  private val samples = LongArray(capacity)
  private var count = 0
  private var index = 0

  @Synchronized
  fun record(valueNs: Long) {
    samples[index] = valueNs
    index = (index + 1) % capacity
    if (count < capacity) count += 1
  }

  @Synchronized
  fun percentileMs(quantile: Double): Double {
    if (count == 0) return 0.0
    val sorted = samples.copyOf(count)
    sorted.sort()
    val position = ((sorted.size - 1) * quantile).roundToInt().coerceIn(0, sorted.lastIndex)
    return Math.round(sorted[position] / 1_000_000.0 * 100.0) / 100.0
  }

  @Synchronized
  fun reset() {
    count = 0
    index = 0
  }
}

/**
 * Counters for one preview subscription.
 *
 * Every drop has its own counter on purpose: "delivered fps is low" is not a finding, but
 * "delivered is low because the pacer skipped, not because the consumer was busy" is.
 */
class PreviewStats {
  @Volatile
  var sourceFrames = 0L
    private set

  @Volatile
  var admitted = 0L
    private set

  @Volatile
  var skippedPacing = 0L
    private set

  @Volatile
  var skippedBusy = 0L
    private set

  @Volatile
  var delivered = 0L
    private set

  @Volatile
  var payloadBytes = 0L
    private set

  @Volatile
  var ackTimeouts = 0L
    private set

  @Volatile
  var staleAcks = 0L
    private set

  @Volatile
  var packFailures = 0L
    private set

  @Volatile
  var transportErrors = 0L
    private set

  val pack = PreviewPercentileRing()
  val send = PreviewPercentileRing()
  val roundTrip = PreviewPercentileRing()

  private var windowStartNs = 0L
  private var windowSourceFrames = 0L
  private var windowDelivered = 0L
  private var windowPayloadBytes = 0L

  @Synchronized
  fun onSourceFrame() {
    sourceFrames++
    windowSourceFrames++
  }

  @Synchronized
  fun onAdmitted() {
    admitted++
  }

  @Synchronized
  fun onSkippedPacing() {
    skippedPacing++
  }

  @Synchronized
  fun onSkippedBusy() {
    skippedBusy++
  }

  @Synchronized
  fun onAckTimeout() {
    ackTimeouts++
  }

  @Synchronized
  fun onStaleAck() {
    staleAcks++
  }

  @Synchronized
  fun onPackFailure() {
    packFailures++
  }

  @Synchronized
  fun onTransportError() {
    transportErrors++
  }

  @Synchronized
  fun onDelivered(bytes: Int) {
    delivered++
    windowDelivered++
    payloadBytes += bytes
    windowPayloadBytes += bytes
  }

  data class Window(val sourceFps: Double, val deliveredFps: Double, val bytesPerSecond: Double)

  /** Read and restart the rate window. Zeros on the first call of a subscription. */
  @Synchronized
  fun takeWindow(nowNs: Long): Window {
    val start = windowStartNs
    windowStartNs = nowNs
    val frames = windowSourceFrames
    val deliveredInWindow = windowDelivered
    val bytes = windowPayloadBytes
    windowSourceFrames = 0
    windowDelivered = 0
    windowPayloadBytes = 0
    if (start <= 0L || nowNs <= start) return Window(0.0, 0.0, 0.0)
    val seconds = (nowNs - start) / 1_000_000_000.0
    return Window(frames / seconds, deliveredInWindow / seconds, bytes / seconds)
  }

  @Synchronized
  fun reset(nowNs: Long) {
    sourceFrames = 0
    admitted = 0
    skippedPacing = 0
    skippedBusy = 0
    delivered = 0
    payloadBytes = 0
    ackTimeouts = 0
    staleAcks = 0
    packFailures = 0
    transportErrors = 0
    pack.reset()
    send.reset()
    roundTrip.reset()
    windowStartNs = nowNs
    windowSourceFrames = 0
    windowDelivered = 0
    windowPayloadBytes = 0
  }
}
