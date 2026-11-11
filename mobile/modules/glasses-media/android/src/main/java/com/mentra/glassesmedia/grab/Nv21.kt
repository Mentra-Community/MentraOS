package com.mentra.glassesmedia.grab

import java.nio.ByteBuffer

/** I420 planes to the NV21 layout `YuvImage` encodes: Y rows, then interleaved V,U rows. */
object Nv21 {
  /**
   * [width] and [height] must be even and positive, and no larger than the planes. Strides may be
   * wider than the rows. The buffers' positions are not moved.
   */
  fun fromI420(
    y: ByteBuffer,
    strideY: Int,
    u: ByteBuffer,
    strideU: Int,
    v: ByteBuffer,
    strideV: Int,
    width: Int,
    height: Int,
  ): ByteArray {
    require(width > 0 && height > 0 && width % 2 == 0 && height % 2 == 0) { "bad size ${width}x$height" }
    val chromaWidth = width / 2
    val chromaHeight = height / 2
    require(strideY >= width && strideU >= chromaWidth && strideV >= chromaWidth) { "stride narrower than row" }
    val ySrc = y.duplicate()
    val uSrc = u.duplicate()
    val vSrc = v.duplicate()
    val yBase = ySrc.position()
    val uBase = uSrc.position()
    val vBase = vSrc.position()
    require(ySrc.remaining() >= strideY * (height - 1) + width) { "Y plane too small" }
    require(uSrc.remaining() >= strideU * (chromaHeight - 1) + chromaWidth) { "U plane too small" }
    require(vSrc.remaining() >= strideV * (chromaHeight - 1) + chromaWidth) { "V plane too small" }

    val out = ByteArray(width * height * 3 / 2)
    for (row in 0 until height) {
      ySrc.position(yBase + row * strideY)
      ySrc.get(out, row * width, width)
    }
    val uRow = ByteArray(chromaWidth)
    val vRow = ByteArray(chromaWidth)
    var offset = width * height
    for (row in 0 until chromaHeight) {
      uSrc.position(uBase + row * strideU)
      uSrc.get(uRow, 0, chromaWidth)
      vSrc.position(vBase + row * strideV)
      vSrc.get(vRow, 0, chromaWidth)
      for (column in 0 until chromaWidth) {
        out[offset++] = vRow[column]
        out[offset++] = uRow[column]
      }
    }
    return out
  }
}
