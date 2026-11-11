package com.mentra.glassesmedia.grab

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * The decoder-thread half of a stream frame grab: one waiting request, and when the last frame
 * was decoded.
 *
 * A grab takes the next decoded frame, not a stored one. Keeping a copy of every frame would cost
 * a full-frame copy fifteen times a second for a photo that is taken a few times a minute.
 *
 * With nothing waiting, a frame costs one volatile write ([noteFrame]) and one volatile read
 * ([claim]). Frame-agnostic so the ordering rules can be tested without WebRTC.
 */
class FrameGrabGate<F>(private val clock: () -> Long) {
  /** Settles once: a frame, or the reason there was none. Later calls do nothing. */
  class Request<F>(private val onFrame: (F) -> Unit, private val onFail: (String) -> Unit) {
    private val settled = AtomicBoolean(false)

    /** False when the request had already settled, so the caller still owns [frame]. */
    fun deliver(frame: F): Boolean {
      if (!settled.compareAndSet(false, true)) return false
      onFrame(frame)
      return true
    }

    fun fail(reason: String) {
      if (settled.compareAndSet(false, true)) onFail(reason)
    }
  }

  @Volatile
  private var lastFrameAt = NEVER

  private val pending = AtomicReference<Request<F>?>(null)

  /** Decoder thread, every frame. */
  fun noteFrame() {
    lastFrameAt = clock()
  }

  /** Milliseconds since the last decoded frame, or -1 when there has never been one. */
  fun frameAgeMs(): Long {
    val at = lastFrameAt
    return if (at == NEVER) -1 else (clock() - at).coerceAtLeast(0)
  }

  /** A frame was decoded within [maxAgeMs]: a stream is running through this phone. */
  fun isLive(maxAgeMs: Long): Boolean {
    val age = frameAgeMs()
    return age in 0..maxAgeMs
  }

  /** Wait for the next frame. False when another request is already waiting. */
  fun arm(request: Request<F>): Boolean = pending.compareAndSet(null, request)

  /** Decoder thread, every frame: the waiting request, removed, or null. */
  fun claim(): Request<F>? {
    if (pending.get() == null) return null
    return pending.getAndSet(null)
  }

  /** Stop waiting. False when a frame already claimed [request]. */
  fun expire(request: Request<F>): Boolean = pending.compareAndSet(request, null)

  companion object {
    private const val NEVER = Long.MIN_VALUE
  }
}
