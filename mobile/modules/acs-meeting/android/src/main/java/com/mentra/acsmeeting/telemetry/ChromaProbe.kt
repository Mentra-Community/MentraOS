package com.mentra.acsmeeting.telemetry

import com.mentra.acsmeeting.video.I420Packer
import java.nio.ByteBuffer
import kotlin.math.max

/** 64-sample plane averages. Neutral content sits near u≈v≈128. */
object ChromaProbe {
  const val SAMPLES = 64

  data class Sample(val y: Int, val u: Int, val v: Int)

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
}
