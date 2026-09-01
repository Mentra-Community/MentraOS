package com.mentra.acsmeeting.source

import com.mentra.acsmeeting.video.I420Packer
import java.nio.ByteBuffer

/** Replaceable later by LocalGlassesVideoSource (SoftAP / local WebRTC). */
interface VideoSource {
  fun start(whepUrl: String)
  fun updateUrl(whepUrl: String)
  fun stop()
}

/**
 * Planes are valid only for the duration of the callback unless [retain] is
 * non-null and invoked before the callback returns. [release] must then be
 * called exactly once after ACS is done with the buffers.
 */
class I420Planes(
  val y: ByteBuffer,
  val strideY: Int,
  val u: ByteBuffer,
  val strideU: Int,
  val v: ByteBuffer,
  val strideV: Int,
  val width: Int,
  val height: Int,
  val timestampNs: Long,
  val retain: (() -> Unit)? = null,
  val release: (() -> Unit)? = null,
) {
  fun isTight(): Boolean {
    val chroma = I420Packer.chromaStride(width)
    return strideY == width && strideU == chroma && strideV == chroma
  }

  fun isDirect(): Boolean = y.isDirect && u.isDirect && v.isDirect

  fun planesReadable(): Boolean {
    val chromaW = I420Packer.chromaStride(width)
    val chromaH = I420Packer.chromaStride(height)
    return remaining(y) >= I420Packer.planeMinBytes(strideY, width, height) &&
      remaining(u) >= I420Packer.planeMinBytes(strideU, chromaW, chromaH) &&
      remaining(v) >= I420Packer.planeMinBytes(strideV, chromaW, chromaH)
  }

  companion object {
    fun remaining(buffer: ByteBuffer): Int = buffer.duplicate().remaining()
  }
}

fun interface VideoFrameListener {
  fun onVideoFrame(planes: I420Planes)
}

fun interface PcmListener {
  fun onPcm(pcm16Le: ByteArray, sampleRate: Int, channels: Int)
}
