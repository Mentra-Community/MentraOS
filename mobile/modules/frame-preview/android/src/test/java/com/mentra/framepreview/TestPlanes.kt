package com.mentra.framepreview

import com.mentra.glassesmedia.source.I420Planes
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger

/** Builds padded I420 planes for tests and counts retain/release so leaks are visible. */
class TestPlanes(
  val width: Int,
  val height: Int,
  private val fillY: Int = 0x80,
  private val fillU: Int = 0x40,
  private val fillV: Int = 0xC0,
  private val padding: Int = 8,
  private val direct: Boolean = true,
) {
  val retains = AtomicInteger()
  val releases = AtomicInteger()

  val chromaWidth = (width + 1) / 2
  val chromaHeight = (height + 1) / 2
  val strideY = width + padding
  val strideC = chromaWidth + padding

  private fun plane(stride: Int, rows: Int, fill: Int): ByteBuffer {
    val bytes = stride * rows
    val buffer = if (direct) ByteBuffer.allocateDirect(bytes) else ByteBuffer.allocate(bytes)
    for (index in 0 until bytes) buffer.put(index, fill.toByte())
    return buffer
  }

  fun planes(
    yBytes: Int = strideY * height,
    strideYOverride: Int = strideY,
    lendable: Boolean = true,
  ): I420Planes {
    val y = plane(strideY, height, fillY)
    y.limit(minOf(yBytes, y.capacity()))
    return I420Planes(
      y = y,
      strideY = strideYOverride,
      u = plane(strideC, chromaHeight, fillU),
      strideU = strideC,
      v = plane(strideC, chromaHeight, fillV),
      strideV = strideC,
      width = width,
      height = height,
      timestampNs = 1234L,
      retain = if (lendable) ({ retains.incrementAndGet(); Unit }) else null,
      release = if (lendable) ({ releases.incrementAndGet(); Unit }) else null,
    )
  }
}
