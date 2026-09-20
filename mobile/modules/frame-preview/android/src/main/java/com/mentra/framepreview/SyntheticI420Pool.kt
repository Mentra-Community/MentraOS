package com.mentra.framepreview

import com.mentra.glassesmedia.source.I420Planes
import com.mentra.glassesmedia.video.I420Packer
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Synthetic 720p I420 frames delivered as ordinary [I420Planes], padded strides and all.
 *
 * Two things here are deliberate. The planes are padded rather than tight, so the synthetic path
 * exercises the same stride-aware copy a hardware decoder forces — a tight synthetic source
 * would make the packer look free and the measurement would be a lie. And the pool is capped at
 * two leases, which is the ownership rule: if the packing worker still holds the previous frame,
 * the generator cannot get a buffer and the tick is skipped instead of overwriting pixels
 * somebody is reading.
 */
class SyntheticI420Pool(private val width: Int, private val height: Int, slots: Int = 2) {
  class Lease internal constructor(val planes: I420Planes, private val slot: Slot) {
    fun release() = slot.release()
  }

  internal class Slot(width: Int, height: Int) {
    private val chromaWidth = I420Packer.chromaStride(width)
    private val chromaHeight = I420Packer.chromaStride(height)

    // Padding a decoder would plausibly produce. Deliberately not a multiple of the chroma
    // stride, so a packer that confuses the two planes' strides fails loudly.
    val strideY = width + 16
    val strideU = chromaWidth + 8
    val strideV = chromaWidth + 8

    val y: ByteBuffer = ByteBuffer.allocateDirect(strideY * height)
    val u: ByteBuffer = ByteBuffer.allocateDirect(strideU * chromaHeight)
    val v: ByteBuffer = ByteBuffer.allocateDirect(strideV * chromaHeight)
    private val busy = AtomicBoolean(false)

    fun tryAcquire(): Boolean = busy.compareAndSet(false, true)

    fun release() {
      busy.set(false)
    }

    fun fill(scratch: ByteArray, width: Int, height: Int) {
      copyRows(scratch, 0, y, strideY, width, height)
      val uOffset = width * height
      copyRows(scratch, uOffset, u, strideU, chromaWidth, chromaHeight)
      copyRows(scratch, uOffset + chromaWidth * chromaHeight, v, strideV, chromaWidth, chromaHeight)
    }

    private fun copyRows(source: ByteArray, sourceOffset: Int, plane: ByteBuffer, stride: Int, rowWidth: Int, rows: Int) {
      plane.clear()
      for (row in 0 until rows) {
        plane.position(row * stride)
        plane.put(source, sourceOffset + row * rowWidth, rowWidth)
      }
      plane.clear()
    }
  }

  private val slots = List(slots) { Slot(width, height) }
  private val scratch = ByteArray(PreviewPixelFormat.I420.packedSize(width, height))

  /** Null when every lease is still out — the caller counts that as a skip, not an error. */
  @Synchronized
  fun acquire(frameIndex: Int, timestampNs: Long): Lease? {
    val slot = slots.firstOrNull { it.tryAcquire() } ?: return null
    PreviewTestPattern.writeI420(scratch, width, height, frameIndex)
    slot.fill(scratch, width, height)
    val planes = I420Planes(
      y = slot.y,
      strideY = slot.strideY,
      u = slot.u,
      strideU = slot.strideU,
      v = slot.v,
      strideV = slot.strideV,
      width = width,
      height = height,
      timestampNs = timestampNs,
    )
    return Lease(planes, slot)
  }
}
