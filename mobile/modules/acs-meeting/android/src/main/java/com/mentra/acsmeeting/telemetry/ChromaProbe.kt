package com.mentra.acsmeeting.telemetry

import com.mentra.acsmeeting.video.I420Packer
import java.nio.ByteBuffer
import kotlin.math.max

/** 64-sample plane averages. Neutral content sits near u≈v≈128. */
object ChromaProbe {
  const val SAMPLES = 64

  data class Sample(val y: Int, val u: Int, val v: Int)

  fun sampleNv12(y: ByteBuffer, uv: ByteBuffer): Sample {
    val yView = y.duplicate()
    val uvView = uv.duplicate()
    val origin = uvView.position()
    val size = uvView.remaining()
    return Sample(
      y = average(yView, yView.position(), yView.remaining()),
      u = averageEveryOther(uvView, origin, size, even = true),
      v = averageEveryOther(uvView, origin, size, even = false),
    )
  }

  fun samplePlanes(y: ByteBuffer, u: ByteBuffer, v: ByteBuffer): Sample {
    val yView = y.duplicate()
    val uView = u.duplicate()
    val vView = v.duplicate()
    return Sample(
      y = average(yView, yView.position(), yView.remaining()),
      u = average(uView, uView.position(), uView.remaining()),
      v = average(vView, vView.position(), vView.remaining()),
    )
  }

  fun samplePacked(src: ByteBuffer, width: Int, height: Int): Sample {
    val ySize = width * height
    val uvSize = I420Packer.chromaStride(width) * I420Packer.chromaStride(height)
    val view = src.duplicate()
    return Sample(
      y = average(view, 0, ySize),
      u = average(view, ySize, uvSize),
      v = average(view, ySize + uvSize, uvSize),
    )
  }

  fun average(buffer: ByteBuffer, offset: Int, size: Int): Int {
    if (size <= 0) return 0
    val step = max(1, size / SAMPLES)
    var sum = 0L
    var count = 0
    var i = offset
    val end = offset + size
    while (i < end && count < SAMPLES) {
      sum += buffer.get(i).toInt() and 0xFF
      i += step
      count += 1
    }
    return if (count == 0) 0 else (sum / count).toInt()
  }

  private fun averageEveryOther(buffer: ByteBuffer, offset: Int, size: Int, even: Boolean): Int {
    if (size <= 1) return 0
    val start = offset + if (even) 0 else 1
    val raw = max(2, size / SAMPLES)
    val step = raw + (raw and 1)
    var sum = 0L
    var count = 0
    var i = start
    val end = offset + size
    while (i < end && count < SAMPLES) {
      sum += buffer.get(i).toInt() and 0xFF
      i += step
      count += 1
    }
    return if (count == 0) 0 else (sum / count).toInt()
  }
}
