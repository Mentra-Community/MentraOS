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
 */
object DecodedFrameTap {
  private const val TAG = "FRAME-PREVIEW"

  @Volatile
  private var sink: VideoFrameListener? = null

  @Volatile
  private var generation: Long = 0

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

  /**
   * Called on libwebrtc's decode thread, immediately before the frame goes to ACS.
   *
   * The catch is not defensive padding: the alternative is a preview bug throwing on the decoder
   * thread and taking the wearer's call video with it.
   */
  fun offer(planes: I420Planes) {
    val listener = sink ?: return
    try {
      listener.onVideoFrame(planes)
    } catch (error: Throwable) {
      Log.w(TAG, "preview sink threw; dropping frame and keeping the call intact", error)
    }
  }
}
