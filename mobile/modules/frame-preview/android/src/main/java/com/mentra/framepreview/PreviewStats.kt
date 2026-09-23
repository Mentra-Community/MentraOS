package com.mentra.framepreview

import kotlin.math.roundToInt

/** One ring's shape, produced by a single sort. */
data class PreviewDistribution(
  val p50: Double,
  val p95: Double,
  val p99: Double,
  val max: Double,
  val count: Int,
) {
  companion object {
    val EMPTY = PreviewDistribution(0.0, 0.0, 0.0, 0.0, 0)
  }
}

/**
 * Fixed-size sample ring with numeric percentiles and a running maximum.
 *
 * Numeric rather than the formatted helper in `glasses-media`: these values cross into the
 * WebView as JSON and the page charts them, so "na" in a number field would be a parse error
 * rather than a missing sample.
 *
 * The capacity is part of the claim being made. At 30 fps a 64-sample ring only describes the
 * last two seconds, so a p95 read off it after a ten-minute soak is a two-second p95 wearing a
 * ten-minute label. [maxMs] is deliberately not windowed: the worst frame of the run is the one
 * that shows up as a visible hitch, and a lapped ring would have thrown it away.
 */
class PreviewPercentileRing(private val capacity: Int = 2048) {
  private val samples = LongArray(capacity)
  private var count = 0
  private var index = 0
  private var maxNs = 0L

  @Synchronized
  fun record(valueNs: Long) {
    samples[index] = valueNs
    index = (index + 1) % capacity
    if (count < capacity) count += 1
    if (valueNs > maxNs) maxNs = valueNs
  }

  /**
   * Every percentile from one sort.
   *
   * Reading p50, p95 and p99 as three separate calls sorts the ring three times, and the
   * reporter reads seven rings every second. At 30 fps that is tens of thousands of needless
   * comparisons per second while frames are being packed — the measurement showing up inside
   * the thing being measured.
   */
  @Synchronized
  fun distribution(): PreviewDistribution {
    if (count == 0) return PreviewDistribution.EMPTY
    val sorted = samples.copyOf(count)
    sorted.sort()
    fun at(quantile: Double): Double {
      val position = ((sorted.size - 1) * quantile).roundToInt().coerceIn(0, sorted.lastIndex)
      return Math.round(sorted[position] / 1_000_000.0 * 100.0) / 100.0
    }
    return PreviewDistribution(at(0.50), at(0.95), at(0.99), maxMs(), count)
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
  fun maxMs(): Double = Math.round(maxNs / 1_000_000.0 * 100.0) / 100.0

  @Synchronized
  fun sampleCount(): Int = count

  @Synchronized
  fun reset() {
    count = 0
    index = 0
    maxNs = 0
  }
}

/**
 * Counters for one preview subscription.
 *
 * Every drop has its own counter on purpose: "delivered fps is low" is not a finding, but
 * "delivered is low because the pacer skipped, not because the consumer was busy" is.
 *
 * The timing rings are split finer than they strictly need to be for the same reason. A single
 * `sendMs` would average an enqueue that returns immediately together with a copy that has not
 * happened yet, and the two platforms would then be reporting different things under one name.
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

  /**
   * Frames refused on the decoder thread because the worker had not finished the previous one.
   * Counted apart from [skippedBusy] so a decoder-side refusal is not confused with a
   * consumer-side one; they have different fixes.
   */
  @Volatile
  var preDispatchDrops = 0L
    private set

  /** The pack worker wanted a send buffer and both were still held by the transport. */
  @Volatile
  var slotStarved = 0L
    private set

  /** Pages that presented the current document's token. */
  @Volatile
  var handshakes = 0L
    private set

  /** Android fallback reloads because the listener was installed after navigation. Should stay 0. */
  @Volatile
  var installReloads = 0L
    private set

  /** Output tier changes applied without restarting production or the transport. */
  @Volatile
  var tierChanges = 0L
    private set

  /** Throwables caught from the tap sink on the decoder thread, accumulated across drains. */
  @Volatile
  var tapSinkExceptions = 0L
    private set

  private val packFailureCounts = LinkedHashMap<String, Long>()

  /**
   * Producing the source frame. Only the synthetic source pays this; a real decoder hands over a
   * buffer it has already made. Kept apart from [pack] so a slow test pattern cannot be read as
   * a slow pipeline.
   */
  val generate = PreviewPercentileRing()

  val pack = PreviewPercentileRing()

  /**
   * Duration of `postMessage` itself, on the UI thread. Chromium copies inside that call, so on
   * Android this is the whole send; iOS has to split it because its enqueue returns early.
   */
  val sendComplete = PreviewPercentileRing()

  val roundTrip = PreviewPercentileRing()

  /** Admission to the first instruction of the pack worker: the handoff cost, not the work. */
  val admitToPack = PreviewPercentileRing()

  /** Gap between consecutive delivered frames. Mean fps hides a 30/100 ms alternation; this does not. */
  val deliveryGap = PreviewPercentileRing()

  /** How long the UI-thread send runnable waited before it ran. The app's jank, not ours to hide. */
  val mainQueueWait = PreviewPercentileRing()

  /**
   * Start of run to first delivered frame, and to its acknowledgement. A slow cold start is
   * invisible in steady-state fps but very visible to someone opening the panel.
   */
  @Volatile
  var firstDeliveredLatencyMs = 0.0
    private set

  @Volatile
  var firstAckLatencyMs = 0.0
    private set

  // Nullable rather than a zero sentinel. A monotonic clock reading of exactly zero is unlikely
  // on a device but trivial in a test, and "not yet set" and "set to zero" have to stay distinct
  // or the first gap of every run goes unrecorded.
  private var runStartNs: Long? = null
  private var lastDeliveredAtNs: Long? = null
  private var hasFirstDelivered = false
  private var hasFirstAck = false

  private var windowStartNs: Long? = null
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
  fun onPackFailure(reason: PackFailureReason) {
    packFailures++
    packFailureCounts[reason.wire] = (packFailureCounts[reason.wire] ?: 0L) + 1
  }

  /** Pack failures keyed by [PackFailureReason.wire]; only reasons that occurred are present. */
  @Synchronized
  fun packFailuresByReason(): Map<String, Long> = LinkedHashMap(packFailureCounts)

  @Synchronized
  fun onHandshake() {
    handshakes++
  }

  @Synchronized
  fun onInstallReload() {
    installReloads++
  }

  @Synchronized
  fun onTierChange() {
    tierChanges++
  }

  @Synchronized
  fun onTapSinkExceptions(count: Long) {
    tapSinkExceptions += count
  }

  @Synchronized
  fun onTransportError() {
    transportErrors++
  }

  @Synchronized
  fun onPreDispatchDrop() {
    preDispatchDrops++
  }

  @Synchronized
  fun onSlotStarved() {
    slotStarved++
  }

  /**
   * Mark the beginning of a run so the first-frame latencies have an origin.
   *
   * This also restarts the rate window. Without that, the first second after a stop/start would
   * be averaged over however long the preview sat idle and report a frame rate near zero.
   */
  @Synchronized
  fun onRunStart(nowNs: Long) {
    runStartNs = nowNs
    lastDeliveredAtNs = null
    hasFirstDelivered = false
    hasFirstAck = false
    firstDeliveredLatencyMs = 0.0
    firstAckLatencyMs = 0.0
    windowStartNs = nowNs
    windowSourceFrames = 0
    windowDelivered = 0
    windowPayloadBytes = 0
  }

  @Synchronized
  fun onDelivered(bytes: Int, nowNs: Long) {
    delivered++
    windowDelivered++
    payloadBytes += bytes
    windowPayloadBytes += bytes
    lastDeliveredAtNs?.let { deliveryGap.record(nowNs - it) }
    lastDeliveredAtNs = nowNs
    val start = runStartNs
    if (!hasFirstDelivered && start != null) {
      hasFirstDelivered = true
      firstDeliveredLatencyMs = (nowNs - start) / 1_000_000.0
    }
  }

  @Synchronized
  fun onAckAccepted(roundTripNs: Long, nowNs: Long) {
    roundTrip.record(roundTripNs)
    val start = runStartNs
    if (!hasFirstAck && start != null) {
      hasFirstAck = true
      firstAckLatencyMs = (nowNs - start) / 1_000_000.0
    }
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
    if (start == null || nowNs <= start) return Window(0.0, 0.0, 0.0)
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
    preDispatchDrops = 0
    slotStarved = 0
    handshakes = 0
    installReloads = 0
    tierChanges = 0
    tapSinkExceptions = 0
    packFailureCounts.clear()
    generate.reset()
    pack.reset()
    sendComplete.reset()
    roundTrip.reset()
    admitToPack.reset()
    deliveryGap.reset()
    mainQueueWait.reset()
    firstDeliveredLatencyMs = 0.0
    firstAckLatencyMs = 0.0
    hasFirstDelivered = false
    hasFirstAck = false
    runStartNs = nowNs
    lastDeliveredAtNs = null
    windowStartNs = nowNs
    windowSourceFrames = 0
    windowDelivered = 0
    windowPayloadBytes = 0
  }
}
