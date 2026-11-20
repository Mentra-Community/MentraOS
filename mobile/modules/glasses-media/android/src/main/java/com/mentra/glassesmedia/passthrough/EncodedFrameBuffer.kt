package com.mentra.glassesmedia.passthrough

import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger
import org.webrtc.JavaI420Buffer
import org.webrtc.VideoFrame

/**
 * One H.264 access unit, carried through libwebrtc's video frame types without being decoded.
 *
 * libwebrtc only moves decoded pictures between a receiver and a sender, so the managed relay's
 * passthrough smuggles the encoded bytes in a [VideoFrame.Buffer]: [PassthroughH264Decoder] wraps each
 * frame it is handed in one of these, and [PassthroughH264Encoder] unwraps it again.
 *
 * It has no pixels. Anything that asks for them is a bug in the wiring, not a case to serve, so
 * [toI420] returns a black picture of the right size instead of throwing on a native thread, and
 * [cropAndScale] cannot resize: it returns the same frame.
 */
class EncodedFrameBuffer(
  /** Annex B bytes in a direct buffer at position 0. Never modified after construction. */
  val data: ByteBuffer,
  private val width: Int,
  private val height: Int,
  val isKeyFrame: Boolean,
  /**
   * A gap-free index the decoder stamps on every frame it produces, counted before libwebrtc can
   * touch it. The sender's [PassthroughH264Encoder] compares consecutive values so it can see a
   * frame that libwebrtc's own bitrate dropper discarded after the decoder and before encode, which
   * no callback reports. [UNSET_SEQUENCE] on frames that do not track it, such as in tests.
   */
  val sequence: Long = UNSET_SEQUENCE,
) : VideoFrame.Buffer {
  private val references = AtomicInteger(1)

  val sizeBytes: Int get() = data.limit()

  override fun getWidth(): Int = width

  override fun getHeight(): Int = height

  override fun toI420(): VideoFrame.I420Buffer {
    val black = JavaI420Buffer.allocate(width, height)
    fill(black.dataY, 16)
    fill(black.dataU, 128)
    fill(black.dataV, 128)
    return black
  }

  override fun retain() {
    references.incrementAndGet()
  }

  /** Nothing native is owned, so this only keeps the count honest for tests and logs. */
  override fun release() {
    references.decrementAndGet()
  }

  /** A passthrough frame has a fixed size: asking for another one gets the frame back, retained. */
  override fun cropAndScale(
    cropX: Int,
    cropY: Int,
    cropWidth: Int,
    cropHeight: Int,
    scaleWidth: Int,
    scaleHeight: Int,
  ): VideoFrame.Buffer {
    retain()
    return this
  }

  internal fun referenceCount(): Int = references.get()

  private fun fill(plane: ByteBuffer, value: Int) {
    val target = plane.duplicate()
    while (target.hasRemaining()) target.put(value.toByte())
  }

  companion object {
    /** Marks a frame whose delivery order is not tracked, so the encoder skips gap detection. */
    const val UNSET_SEQUENCE: Long = -1L
  }
}
