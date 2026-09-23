package com.mentra.glassesmedia.source

import android.util.Log

/**
 * A second, optional consumer of decoded glasses video, sitting beside the ACS sender.
 *
 * The call owns this pipeline; the preview is a guest. [offer] therefore never blocks, never lets
 * a `Throwable` reach the decoder thread, and never does real work — a sink may only decide
 * whether it wants the frame, retain it, and schedule bounded work elsewhere. A preview that
 * crashes, stalls, or falls behind must cost the call nothing.
 *
 * [detach] is generation-checked because sessions overlap: a call ending late must not tear down
 * the subscription a newer call already installed.
 *
 * ## Cost with nothing attached
 *
 * With no sink and telemetry off, [offer] is one volatile read and a return. Sink, error handler
 * and the telemetry flag live in one immutable [State] so that read is the only thing the decoder
 * thread pays.
 *
 * ## Why the metrics live here
 *
 * These describe the call, not the preview. With [setTelemetryEnabled] on they are collected even
 * with no sink attached, so a preview-off run is a usable baseline for the same numbers with the
 * preview on.
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
    /** Frames the ACS sender accepted, recorded at its call sites after [offer]. */
    val acsFramesSent: Long = 0,
  ) {
    /** Mean time inside [offer] over every timed frame, with or without a sink. */
    val offerMeanUs: Double get() = if (framesOffered > 0) offerTotalNs.toDouble() / framesOffered / 1000.0 else 0.0
    val offerMaxUs: Double get() = offerMaxNs / 1000.0
    val cadenceMeanMs: Double get() = if (cadenceSamples > 0) cadenceTotalNs.toDouble() / cadenceSamples / 1_000_000.0 else 0.0
    val cadenceMaxMs: Double get() = cadenceMaxNs / 1_000_000.0
  }

  private class State(
    val sink: VideoFrameListener?,
    val onSinkError: ((Throwable) -> Unit)?,
    val generation: Long,
  )

  @Volatile
  private var state: State? = null

  private var generation: Long = 0
  private var currentSink: VideoFrameListener? = null
  private var currentOnSinkError: ((Throwable) -> Unit)? = null

  @Volatile
  var telemetryEnabled: Boolean = false
    private set

  private val metricsLock = Any()
  private var framesOffered = 0L
  private var framesWithSink = 0L
  private var offerTotalNs = 0L
  private var offerMaxNs = 0L
  private var cadenceSamples = 0L
  private var cadenceTotalNs = 0L
  private var cadenceMaxNs = 0L
  private var sinkExceptions = 0L
  private var acsFramesSent = 0L
  private var lastOfferAtNs = 0L

  /**
   * Install [listener] and return the generation that owns it. [onSinkError] runs on the decoder
   * thread after a throw has been caught and counted; it must only schedule work elsewhere.
   */
  @Synchronized
  fun attach(listener: VideoFrameListener, onSinkError: ((Throwable) -> Unit)? = null): Long {
    generation += 1
    currentSink = listener
    currentOnSinkError = onSinkError
    publish()
    Log.i(TAG, "tap attached generation=$generation")
    return generation
  }

  /** Remove the sink only if it is still the one [generation] installed. */
  @Synchronized
  fun detach(generation: Long): Boolean {
    if (generation != this.generation || currentSink == null) return false
    currentSink = null
    currentOnSinkError = null
    publish()
    Log.i(TAG, "tap detached generation=$generation")
    return true
  }

  /** True while [generation] still owns the installed sink. */
  @Synchronized
  fun isCurrent(generation: Long): Boolean = generation == this.generation && currentSink != null

  /** Collect cadence and offer cost even with no sink, so preview off/on can be compared. */
  @Synchronized
  fun setTelemetryEnabled(enabled: Boolean) {
    telemetryEnabled = enabled
    publish()
  }

  fun hasSink(): Boolean = state?.sink != null

  private fun publish() {
    val wasCollecting = state != null
    state = if (currentSink == null && !telemetryEnabled) {
      null
    } else {
      State(currentSink, currentOnSinkError, generation)
    }
    if (!wasCollecting && state != null) {
      // The first gap after collection resumes would span the whole idle period.
      synchronized(metricsLock) { lastOfferAtNs = 0L }
    }
  }

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
      acsFramesSent = acsFramesSent,
    )
    framesOffered = 0
    framesWithSink = 0
    offerTotalNs = 0
    offerMaxNs = 0
    cadenceSamples = 0
    cadenceTotalNs = 0
    cadenceMaxNs = 0
    sinkExceptions = 0
    acsFramesSent = 0
    snapshot
  }

  /**
   * The ACS sender accepted a frame. Counted under the same gate as [offer], so the send rate is
   * available whenever the tap's other call metrics are, including preview-off baselines.
   */
  fun recordAcsSend() {
    if (state == null) return
    synchronized(metricsLock) { acsFramesSent += 1 }
  }

  /**
   * Called on libwebrtc's decode thread, immediately before the frame goes to ACS.
   *
   * The catch is not defensive padding: the alternative is a preview bug throwing on the decoder
   * thread and taking the wearer's call video with it.
   */
  fun offer(planes: I420Planes) {
    val current = state ?: return
    val started = System.nanoTime()
    val listener = current.sink

    var failure: Throwable? = null
    if (listener != null) {
      try {
        listener.onVideoFrame(planes)
      } catch (error: Throwable) {
        failure = error
      }
    }

    val elapsed = System.nanoTime() - started
    val firstFailure: Boolean
    synchronized(metricsLock) {
      framesOffered += 1
      if (lastOfferAtNs > 0) {
        val gap = started - lastOfferAtNs
        cadenceSamples += 1
        cadenceTotalNs += gap
        if (gap > cadenceMaxNs) cadenceMaxNs = gap
      }
      lastOfferAtNs = started
      offerTotalNs += elapsed
      if (elapsed > offerMaxNs) offerMaxNs = elapsed
      if (listener != null) framesWithSink += 1
      firstFailure = failure != null && sinkExceptions == 0L
      if (failure != null) sinkExceptions += 1
    }

    if (failure != null) {
      if (firstFailure) {
        Log.w(TAG, "preview sink threw generation=${current.generation}; call frame unaffected", failure)
      }
      try {
        current.onSinkError?.invoke(failure)
      } catch (ignored: Throwable) {
        // The handler is preview code too; it gets no more access to this thread than the sink.
      }
    }
  }
}
