package com.mentra.acsmeeting.source

import android.util.Log
import com.mentra.acsmeeting.telemetry.PipelineStats
import com.mentra.acsmeeting.video.FrameGeometry
import org.webrtc.AudioTrackSink
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Hands decoded WebRTC tracks to ACS.
 *
 * Extracted from [CloudflareWhepSource] so the SoftAP path shares it rather than copying it. The
 * scaling and geometry handling here is subtle enough that two copies would drift: buffer
 * coordinates rather than display coordinates, crop-and-scale before `toI420` so libyuv does the
 * work, and a retain/release pair the ACS sender owns. Whether the bitstream arrived from Cloudflare
 * or straight off the hotspot makes no difference past the decoder, so neither should the code.
 *
 * Thread confinement: [videoSink] and [audioSink] are called on libwebrtc's decode and audio
 * threads. Nothing here blocks, and the mutable settings are atomics because they are written from
 * the session thread.
 */
class DecodedTrackRelay(
  private val videoListener: VideoFrameListener,
  private val pcmListener: PcmListener,
  private val stats: PipelineStats,
  /** Called on the first frame of each generation so the owner can promote itself to LIVE. */
  private val onPromotableFrame: () -> Unit,
) {
  private val targetSize = AtomicReference<TargetSize?>(null)
  private val rotationLogged = AtomicBoolean(false)

  /**
   * Fail closed. The audio policy turns delivery on once the ACS virtual stream is live, and this
   * survives a transport rebuild so a reconnect cannot silently re-open the uplink against a
   * decision that has since changed.
   */
  @Volatile
  private var pcmEnabled = false

  fun setTargetSize(size: TargetSize?) = targetSize.set(size)

  fun setPcmDeliveryEnabled(enabled: Boolean) {
    pcmEnabled = enabled
  }

  fun resetRotationLog() = rotationLogged.set(false)

  val videoSink = VideoSink { frame ->
    val sinkStart = System.nanoTime()
    onPromotableFrame()
    stats.onSink()
    stats.recordGap()
    val buffer = frame.buffer
    stats.onFrameBuffer(classifyBuffer(buffer))
    val geometry = FrameGeometry.packSize(buffer.width, buffer.height, frame.rotation)
    if (geometry.rotationNonZero) {
      stats.onRotation()
      if (rotationLogged.compareAndSet(false, true)) {
        Log.w(
          TAG,
          "P3 rotation=${frame.rotation} using buffer ${geometry.width}x${geometry.height} " +
            "(rotatedWidth=${frame.rotatedWidth}x${frame.rotatedHeight} would overrun I420 planes)",
        )
      }
    }
    val target = targetSize.get()
    var scaled: VideoFrame.Buffer? = null
    val source = if (needsScale(target, geometry.width, geometry.height)) {
      val scaleStart = System.nanoTime()
      scaled = buffer.cropAndScale(0, 0, geometry.width, geometry.height, target!!.width, target.height)
      stats.scale.record(System.nanoTime() - scaleStart)
      scaled
    } else {
      buffer
    }
    val i420Start = System.nanoTime()
    val i420 = source.toI420()
    stats.toI420.record(System.nanoTime() - i420Start)
    if (i420 == null) {
      stats.onDropNullI420()
      scaled?.release()
      stats.sinkCb.record(System.nanoTime() - sinkStart)
      return@VideoSink
    }
    try {
      val w = i420.width
      val h = i420.height
      stats.onStrides(i420.strideY, i420.strideU, i420.strideV, w)
      stats.setSize(w, h)
      videoListener.onVideoFrame(
        I420Planes(
          y = i420.dataY,
          strideY = i420.strideY,
          u = i420.dataU,
          strideU = i420.strideU,
          v = i420.dataV,
          strideV = i420.strideV,
          width = w,
          height = h,
          timestampNs = frame.timestampNs,
          retain = { i420.retain() },
          release = { i420.release() },
        ),
      )
    } finally {
      i420.release()
      scaled?.release()
      stats.sinkCb.record(System.nanoTime() - sinkStart)
    }
  }

  val audioSink = AudioTrackSink { audioData, bitsPerSample, sampleRate, numberOfChannels, _, _ ->
    if (!pcmEnabled || bitsPerSample != 16) return@AudioTrackSink
    val bytes = ByteArray(audioData.remaining())
    audioData.get(bytes)
    pcmListener.onPcm(bytes, sampleRate, numberOfChannels)
  }

  companion object {
    private const val TAG = "ACS-SPIKE"

    /**
     * Whether a frame needs resizing before ACS sees it.
     *
     * Split out and made pure because it decides whether libyuv runs on every single frame, and
     * because getting it backwards is invisible: an unnecessary scale is a silent CPU cost, and a
     * skipped one is a plane-size mismatch at the sender. A null target means ACS has not
     * negotiated a size yet, so the buffer passes through untouched.
     */
    fun needsScale(target: TargetSize?, width: Int, height: Int): Boolean =
      target != null && (target.width != width || target.height != height)

    fun classifyBuffer(buffer: VideoFrame.Buffer): String = when (buffer) {
      is VideoFrame.TextureBuffer -> "tex"
      is VideoFrame.I420Buffer -> "i420"
      else -> "other"
    }
  }
}
