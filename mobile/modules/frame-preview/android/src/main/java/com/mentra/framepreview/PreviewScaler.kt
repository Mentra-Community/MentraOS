package com.mentra.framepreview

import com.mentra.glassesmedia.source.I420Planes
import com.mentra.glassesmedia.video.I420Packer
import java.nio.ByteBuffer
import org.webrtc.JavaI420Buffer
import org.webrtc.VideoFrame

/** Downscales stride-aware I420 planes into a tight `Y | U | V` payload inside [dest]. */
interface I420Scaler {
  fun scale(source: I420Planes, output: PreviewSize, dest: ByteArray, offset: Int)
}

/**
 * Area-average downscale in plain Kotlin.
 *
 * The fallback when libyuv is unavailable (JVM unit tests, or a device where the WebRTC native
 * library failed to load), and the reference the libyuv path is compared against. Each output
 * sample averages the source rectangle it covers, so a 2:1 reduction is an exact 2x2 box.
 */
object BoxI420Scaler : I420Scaler {
  override fun scale(source: I420Planes, output: PreviewSize, dest: ByteArray, offset: Int) {
    val chromaSrcW = (source.width + 1) / 2
    val chromaSrcH = (source.height + 1) / 2
    val chromaOutW = (output.width + 1) / 2
    val chromaOutH = (output.height + 1) / 2
    var at = offset
    scalePlane(source.y, source.strideY, source.width, source.height, dest, at, output.width, output.height)
    at += output.width * output.height
    scalePlane(source.u, source.strideU, chromaSrcW, chromaSrcH, dest, at, chromaOutW, chromaOutH)
    at += chromaOutW * chromaOutH
    scalePlane(source.v, source.strideV, chromaSrcW, chromaSrcH, dest, at, chromaOutW, chromaOutH)
  }

  fun scalePlane(
    src: ByteBuffer,
    stride: Int,
    srcW: Int,
    srcH: Int,
    dest: ByteArray,
    destOffset: Int,
    outW: Int,
    outH: Int,
  ) {
    val origin = src.position()
    var out = destOffset
    for (oy in 0 until outH) {
      val y0 = (oy.toLong() * srcH / outH).toInt()
      val y1 = maxOf(y0 + 1, ((oy + 1).toLong() * srcH / outH).toInt())
      for (ox in 0 until outW) {
        val x0 = (ox.toLong() * srcW / outW).toInt()
        val x1 = maxOf(x0 + 1, ((ox + 1).toLong() * srcW / outW).toInt())
        var sum = 0
        for (sy in y0 until y1) {
          val row = origin + sy * stride
          for (sx in x0 until x1) sum += src.get(row + sx).toInt() and 0xFF
        }
        val count = (y1 - y0) * (x1 - x0)
        dest[out++] = ((sum + count / 2) / count).toByte()
      }
    }
  }
}

/**
 * libyuv `I420Scale` (box filter) through WebRTC's `JavaI420Buffer.cropAndScaleI420`, which the
 * app already links for the call.
 *
 * WebRTC exposes no libyuv entry point that writes into caller memory, so the scaled planes land
 * in a native buffer WebRTC allocates and frees synchronously, and are then copied into the slot.
 * That buffer is transient native memory, not a send slot: slots stay preallocated. If the native
 * library or a direct-buffer source is unavailable, [fallback] does the work instead and
 * [onFallback] is told once.
 */
class LibyuvI420Scaler(
  private val fallback: I420Scaler = BoxI420Scaler,
  private val onFallback: (String) -> Unit = {},
) : I420Scaler {
  @Volatile private var nativeUnavailable = false

  @Volatile var fallbackFrames = 0L
    private set

  override fun scale(source: I420Planes, output: PreviewSize, dest: ByteArray, offset: Int) {
    if (nativeUnavailable || !source.isDirect()) {
      useFallback(source, output, dest, offset, if (nativeUnavailable) null else "source_not_direct")
      return
    }
    val wrapped = try {
      JavaI420Buffer.wrap(
        source.width, source.height,
        source.y.slice(), source.strideY,
        source.u.slice(), source.strideU,
        source.v.slice(), source.strideV,
        null,
      )
    } catch (rejected: IllegalArgumentException) {
      // WebRTC wants a full stride on the last row; the geometry check only asks for the row.
      useFallback(source, output, dest, offset, "wrap_rejected")
      return
    }
    val scaled: VideoFrame.I420Buffer
    try {
      scaled = JavaI420Buffer.cropAndScaleI420(
        wrapped, 0, 0, source.width, source.height, output.width, output.height,
      ) as VideoFrame.I420Buffer
    } catch (missing: UnsatisfiedLinkError) {
      nativeUnavailable = true
      useFallback(source, output, dest, offset, "native_library_unavailable")
      return
    }
    try {
      val target = ByteBuffer.wrap(dest, offset, dest.size - offset).slice()
      val chromaW = (output.width + 1) / 2
      val chromaH = (output.height + 1) / 2
      I420Packer.copyPlane(scaled.dataY, scaled.strideY, output.width, output.height, target)
      I420Packer.copyPlane(scaled.dataU, scaled.strideU, chromaW, chromaH, target)
      I420Packer.copyPlane(scaled.dataV, scaled.strideV, chromaW, chromaH, target)
    } finally {
      scaled.release()
    }
  }

  private fun useFallback(source: I420Planes, output: PreviewSize, dest: ByteArray, offset: Int, reason: String?) {
    if (fallbackFrames == 0L && reason != null) onFallback(reason)
    fallbackFrames += 1
    fallback.scale(source, output, dest, offset)
  }
}
