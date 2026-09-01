package com.mentra.acsmeeting.video

import java.nio.ByteBuffer

/**
 * I420 → NV12. ACS NV12 is two planes: tight Y, then interleaved UV with
 * [strideUv] = chromaW * 2. Pure so JVM tests stay cheap.
 */
object Nv12Packer {
  fun chromaHeight(height: Int): Int = I420Packer.chromaStride(height)

  fun strideUv(width: Int): Int = I420Packer.chromaStride(width) * 2

  fun uvSize(width: Int, height: Int): Int = strideUv(width) * chromaHeight(height)

  fun packedSize(width: Int, height: Int): Int = width * height + uvSize(width, height)

  fun copyY(src: ByteBuffer, strideY: Int, width: Int, height: Int, dest: ByteBuffer) {
    I420Packer.copyPlane(src, strideY, width, height, dest)
  }

  /**
   * Writes UVUV… rows into [dest]. Last visible chroma column is [chromaW];
   * [strideUv] must be `chromaW * 2`.
   */
  fun interleaveUv(
    u: ByteBuffer,
    strideU: Int,
    v: ByteBuffer,
    strideV: Int,
    chromaW: Int,
    chromaH: Int,
    dest: ByteBuffer,
  ) {
    val uView = u.duplicate()
    val vView = v.duplicate()
    val uOrigin = uView.position()
    val vOrigin = vView.position()
    val row = ByteArray(chromaW * 2)
    for (r in 0 until chromaH) {
      var di = 0
      val uRow = uOrigin + r * strideU
      val vRow = vOrigin + r * strideV
      for (c in 0 until chromaW) {
        row[di++] = uView.get(uRow + c)
        row[di++] = vView.get(vRow + c)
      }
      dest.put(row)
    }
  }
}
