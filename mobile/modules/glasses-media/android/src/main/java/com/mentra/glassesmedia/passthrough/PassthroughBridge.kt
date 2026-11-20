package com.mentra.glassesmedia.passthrough

import java.util.concurrent.atomic.AtomicLong

/**
 * What the passthrough decoder and encoder have to agree on, which is one thing: whether the next
 * frame forwarded must be a key frame.
 *
 * The relay does not re-encode, so it cannot make a key frame. It can only wait for the glasses to
 * send one. Every delta frame sent downstream after a gap would be undecodable at Cloudflare, and
 * because the outgoing RTP stream is rebuilt here, Cloudflare would never see the gap that made it
 * so. Two events open the wait: a loss on the hotspot leg, and the uplink asking for a key frame
 * because it lost packets of its own. The wait closes when a key frame goes through.
 *
 * Nothing here touches libwebrtc, so it is plain Kotlin and plain-JVM testable.
 */
class PassthroughBridge {
  /** True until a key frame has gone through, so the first frame out is always one. */
  @Volatile private var waitingForKeyFrame = true

  private val sequence = AtomicLong()
  private val framesIn = AtomicLong()
  private val framesOut = AtomicLong()
  private val keyFramesOut = AtomicLong()
  private val framesDropped = AtomicLong()
  private val keyFrameRequests = AtomicLong()
  private val bytesOut = AtomicLong()

  /** The bitrate the uplink would allow, as the encoder was last told. Informational: nothing adapts. */
  @Volatile var uplinkTargetBps: Int = 0

  /** Called when a wait opens, with why. Logged by the owner; never throws into libwebrtc. */
  @Volatile var onKeyFrameWanted: ((String) -> Unit)? = null

  fun isWaitingForKeyFrame(): Boolean = waitingForKeyFrame

  /**
   * The next gap-free index for a forwarded frame. The decoder stamps it so the sender's encoder
   * can tell when libwebrtc dropped a frame between the two, since only forwarded frames advance it
   * and a jump at the encoder is a frame libwebrtc discarded.
   */
  fun nextSequence(): Long = sequence.getAndIncrement()

  /** Open the wait. Repeated requests while it is already open are not counted again. */
  fun wantKeyFrame(reason: String) {
    if (waitingForKeyFrame) return
    waitingForKeyFrame = true
    keyFrameRequests.incrementAndGet()
    runCatching { onKeyFrameWanted?.invoke(reason) }
  }

  /** A key frame is on its way out. */
  fun keyFrameForwarded() {
    waitingForKeyFrame = false
  }

  fun noteIn() {
    framesIn.incrementAndGet()
  }

  fun noteDropped() {
    framesDropped.incrementAndGet()
  }

  fun noteOut(bytes: Int, keyFrame: Boolean) {
    framesOut.incrementAndGet()
    bytesOut.addAndGet(bytes.toLong())
    if (keyFrame) keyFramesOut.incrementAndGet()
  }

  fun snapshot(): Snapshot = Snapshot(
    framesIn = framesIn.get(),
    framesOut = framesOut.get(),
    keyFramesOut = keyFramesOut.get(),
    framesDropped = framesDropped.get(),
    keyFrameRequests = keyFrameRequests.get(),
    bytesOut = bytesOut.get(),
    uplinkTargetBps = uplinkTargetBps,
    waitingForKeyFrame = waitingForKeyFrame,
  )

  data class Snapshot(
    val framesIn: Long,
    val framesOut: Long,
    val keyFramesOut: Long,
    val framesDropped: Long,
    val keyFrameRequests: Long,
    val bytesOut: Long,
    val uplinkTargetBps: Int,
    val waitingForKeyFrame: Boolean,
  ) {
    override fun toString(): String =
      "in=$framesIn out=$framesOut key=$keyFramesOut dropped=$framesDropped keyRequests=$keyFrameRequests " +
        "bytes=$bytesOut uplinkTargetBps=$uplinkTargetBps waitingForKey=$waitingForKeyFrame"
  }
}
