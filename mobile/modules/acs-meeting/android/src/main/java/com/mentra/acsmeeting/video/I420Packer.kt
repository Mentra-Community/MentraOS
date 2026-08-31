package com.mentra.acsmeeting.video

import java.nio.ByteBuffer
import kotlin.math.roundToInt

/** Tight I420 pack + stride math. No Android / ACS / WebRTC types so JVM tests stay cheap. */
object I420Packer {
  fun packedSize(width: Int, height: Int): Int {
    val chromaW = (width + 1) / 2
    val chromaH = (height + 1) / 2
    return width * height + 2 * chromaW * chromaH
  }

  fun chromaStride(width: Int): Int = (width + 1) / 2

  /**
   * Packs padded WebRTC planes into tight I420 (strideY=width, strideU=strideV=(width+1)/2).
   */
  fun pack(
    dataY: ByteBuffer,
    strideY: Int,
    dataU: ByteBuffer,
    strideU: Int,
    dataV: ByteBuffer,
    strideV: Int,
    width: Int,
    height: Int,
    dest: ByteBuffer,
  ) {
    dest.clear()
    val chromaW = chromaStride(width)
    val chromaH = chromaStride(height)
    copyPlane(dataY, strideY, width, height, dest)
    copyPlane(dataU, strideU, chromaW, chromaH, dest)
    copyPlane(dataV, strideV, chromaW, chromaH, dest)
    dest.flip()
  }

  fun copyPlane(src: ByteBuffer, stride: Int, width: Int, height: Int, dest: ByteBuffer) {
    val plane = src.duplicate()
    val origin = plane.position()
    if (stride == width && plane.remaining() >= width * height) {
      plane.limit(origin + width * height)
      dest.put(plane)
      return
    }
    for (row in 0 until height) {
      val start = origin + row * stride
      plane.limit(start + width)
      plane.position(start)
      dest.put(plane)
    }
  }

  fun percentileMs(samplesNs: LongArray, quantile: Double): String {
    if (samplesNs.isEmpty()) return "na"
    val sorted = samplesNs.copyOf()
    sorted.sort()
    val index = ((sorted.size - 1) * quantile).roundToInt().coerceIn(0, sorted.lastIndex)
    return ((sorted[index] / 1_000_000.0) * 10).roundToInt().div(10.0).toString()
  }
}
