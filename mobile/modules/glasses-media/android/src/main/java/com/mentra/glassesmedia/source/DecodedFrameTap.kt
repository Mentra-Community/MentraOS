package com.mentra.glassesmedia.source

import android.util.Log

/**
 * A second, optional consumer of decoded glasses video, sitting beside the ACS sender.
 *
 * The call owns this pipeline; the preview is a guest. [offer] therefore never blocks, never lets
 * an exception reach the decoder thread, and never does real work — a sink may only decide
 * whether it wants the frame, retain it, and schedule bounded work elsewhere. A preview that
 * crashes, stalls, or falls behind must cost the call nothing.
 *
 * [detach] is generation-checked because sessions overlap: a call ending late must not tear down
 * the subscription a newer call already installed.
 *
 * ## Why the metrics live here
 *
 * Every other counter in the experiment describes the preview. These describe the call, which is
 * the thing the decision actually turns on. The cadence counters run whether or not a sink is
 * installed: the question is what the decoder was doing *before* the preview attached, and a
 * counter that only ticks while attached cannot answer it.
 */
object DecodedFrameTap {
  private const val TAG = "FRAME-PREVIEW"

  /**
   * A snapshot of decoder-thread observations, drained by the reader.
   *
   * Sums rather than a percentile ring because this object cannot depend on the preview module,
   * and because the two questions here are "is the mean cost negligible" and "was there ever a
   * bad one" — a mean and a max answer both.
   */
  data class Metrics(
    val framesOffered: Long,
    val framesWithSink: Long,
    val offerTotalNs: Long,
    val offerMaxNs: Long,
    val cadenceSamples: Long,
    val cadenceTotalNs: Long,
    val cadenceMaxNs: Long,
    val sinkExceptions: Long,
  ) {
    val offerMeanUs: Double get() = if (framesWithSink > 0) offerTotalNs / framesWithSink / 1000.0 else 0.0
    val offerMaxUs: Double get() = offerMaxNs / 1000.0
    val cadenceMeanMs: Double get() = if (cadenceSamples > 0) cadenceTotalNs / cadenceSamples / 1_000_000.0 else 0.0
    val cadenceMaxMs: Double get() = cadenceMaxNs / 1_000_000.0
  }

  @Volatile
  private var sink: VideoFrameListener? = null

  @Volatile
  private var generation: Long = 0

  private val metricsLock = Any()
  private var framesOffered = 0L
  private var framesWithSink = 0L
  private var offerTotalNs = 0L
  private var offerMaxNs = 0L
  private var cadenceSamples = 0L
  private var cadenceTotalNs = 0L
  private var cadenceMaxNs = 0L
  private var sinkExceptions = 0L
  private var lastOfferAtNs = 0L

  @Synchronized
  fun attach(listener: VideoFrameListener): Long {
    generation += 1
    sink = listener
    Log.i(TAG, "tap attached generation=$generation")
    return generation
  }

  @Synchronized
  fun detach(generation: Long) {
    if (generation != this.generation) return
    sink = null
    Log.i(TAG, "tap detached generation=$generation")
  }

  fun hasSink(): Boolean = sink != null

  /** Read and clear the accumulated observations. Called about once a second by the reporter. */
  fun drainMetrics(): Metrics = synchronized(metricsLock) {
    val snapshot = Metrics(
      framesOffered = framesOffered,
      framesWithSink = framesWithSink,
      offerTotalNs = offerTotalNs,
      offerMaxNs = offerMaxNs,
      cadenceSamples = cadenceSamples,
      cadenceTotalNs = cadenceTotalNs,
      cadenceMaxNs = cadenceMaxNs,
      sinkExceptions = sinkExceptions,
    )
    framesOffered = 0
    framesWithSink = 0
    offerTotalNs = 0
    offerMaxNs = 0
    cadenceSamples = 0
    cadenceTotalNs = 0
    cadenceMaxNs = 0
    sinkExceptions = 0
    snapshot
  }

  /**
   * Called on libwebrtc's decode thread, immediately before the frame goes to ACS.
   *
   * The catch is not defensive padding: the alternative is a preview bug throwing on the decoder
   * thread and taking the wearer's call video with it.
   */
  fun offer(planes: I420Planes) {
    val started = System.nanoTime()
    val listener = sink

    synchronized(metricsLock) {
      framesOffered += 1
      if (lastOfferAtNs > 0) {
        val gap = started - lastOfferAtNs
        cadenceSamples += 1
        cadenceTotalNs += gap
        if (gap > cadenceMaxNs) cadenceMaxNs = gap
      }
      lastOfferAtNs = started
    }

    if (listener == null) return

    var threw = false
    try {
      listener.onVideoFrame(planes)
    } catch (error: Throwable) {
      threw = true
      Log.w(TAG, "preview sink threw; dropping frame and keeping the call intact", error)
    }

    val elapsed = System.nanoTime() - started
    synchronized(metricsLock) {
      framesWithSink += 1
      offerTotalNs += elapsed
      if (elapsed > offerMaxNs) offerMaxNs = elapsed
      if (threw) sinkExceptions += 1
    }
  }
}
