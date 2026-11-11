package com.mentra.glassesmedia.grab

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.os.SystemClock
import com.mentra.glassesmedia.trace.MediaLog as Log
import java.io.ByteArrayOutputStream
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import org.webrtc.VideoFrame

/**
 * A photo taken from the glasses stream this phone is already decoding.
 *
 * While the glasses stream, their camera cannot also take a photo. Every stream that passes
 * through this phone (an ACS call on either transport, the managed WebRTC relay) is decoded here,
 * so the next decoded frame is the photo: nothing is asked of the glasses and the stream does not
 * pause. A stream the glasses publish straight to the internet (RTMP, SRT) never reaches
 * [offer], [isLive] stays false, and the caller's ordinary photo request gets the glasses'
 * CAMERA_BUSY.
 *
 * The stream owns the decoder thread; the grab is a guest. [offer] only retains the frame and
 * hands it to a worker, and nothing it does can throw into the decoder.
 */
object StreamFrameGrab {
  private const val TAG = "FRAME-GRAB"

  /** A stream that has not decoded a frame for this long is not one a photo can come from. */
  const val LIVE_WINDOW_MS = 1_000L

  class Frame(val jpeg: ByteArray, val width: Int, val height: Int)

  private class Captured(val i420: VideoFrame.I420Buffer, val rotation: Int)

  private val gate = FrameGrabGate<Captured> { SystemClock.elapsedRealtime() }

  private val worker = ScheduledThreadPoolExecutor(1) { task ->
    Thread(task, "stream-frame-grab").apply { isDaemon = true }
  }

  fun frameAgeMs(): Long = gate.frameAgeMs()

  fun isLive(): Boolean = gate.isLive(LIVE_WINDOW_MS)

  /**
   * Called on libwebrtc's decode thread for every decoded glasses frame, before any scaling, so a
   * grab gets the stream's own resolution rather than the size ACS negotiated down to.
   */
  fun offer(buffer: VideoFrame.Buffer, rotation: Int) {
    gate.noteFrame()
    val request = gate.claim() ?: return
    try {
      val i420 = buffer.toI420()
      if (i420 == null) {
        request.fail("frame_unreadable")
      } else if (!request.deliver(Captured(i420, rotation))) {
        i420.release()
      }
    } catch (error: Throwable) {
      // Only toI420 can throw here: a delivered frame is handed over or released by the request.
      runCatching { request.fail("frame_unreadable") }
    }
  }

  /**
   * Encode the next decoded frame as a JPEG. [onResult] is called exactly once, on the worker
   * thread or the caller's, with the frame or the reason there is none: `not_live`, `busy`,
   * `no_frame`, `frame_unreadable` or `encode_failed`.
   */
  fun grab(quality: Int, timeoutMs: Long, onResult: (Frame?, String?) -> Unit) {
    if (!isLive()) {
      onResult(null, "not_live")
      return
    }
    val request = FrameGrabGate.Request<Captured>(
      onFrame = { captured ->
        try {
          worker.execute {
            val frame = try {
              encode(captured, quality)
            } catch (error: Throwable) {
              Log.w(TAG, "encode failed ${captured.i420.width}x${captured.i420.height}", error)
              null
            } finally {
              captured.i420.release()
            }
            onResult(frame, if (frame == null) "encode_failed" else null)
          }
        } catch (error: RejectedExecutionException) {
          captured.i420.release()
          onResult(null, "encode_failed")
        }
      },
      onFail = { reason -> onResult(null, reason) },
    )
    if (!gate.arm(request)) {
      onResult(null, "busy")
      return
    }
    worker.schedule({ if (gate.expire(request)) request.fail("no_frame") }, timeoutMs, TimeUnit.MILLISECONDS)
  }

  private fun encode(captured: Captured, quality: Int): Frame {
    val i420 = captured.i420
    // YuvImage needs whole chroma samples. An odd edge loses one pixel.
    val width = i420.width and 1.inv()
    val height = i420.height and 1.inv()
    val nv21 = Nv21.fromI420(
      i420.dataY, i420.strideY, i420.dataU, i420.strideU, i420.dataV, i420.strideV, width, height,
    )
    val out = ByteArrayOutputStream(nv21.size / 6)
    check(YuvImage(nv21, ImageFormat.NV21, width, height, null).compressToJpeg(Rect(0, 0, width, height), quality, out)) {
      "JPEG encoder refused the frame"
    }
    val rotation = ((captured.rotation % 360) + 360) % 360
    if (rotation == 0) return Frame(out.toByteArray(), width, height)

    // The stream carries rotation as metadata beside unrotated pixels. A photo has to carry it in
    // the pixels: nothing downstream of a JPEG upload reads that metadata.
    val upright = BitmapFactory.decodeByteArray(out.toByteArray(), 0, out.size())
      ?: error("could not decode the frame to rotate it")
    val rotated = Bitmap.createBitmap(
      upright, 0, 0, upright.width, upright.height, Matrix().apply { postRotate(rotation.toFloat()) }, true,
    )
    try {
      val turned = ByteArrayOutputStream(out.size())
      check(rotated.compress(Bitmap.CompressFormat.JPEG, quality, turned)) { "JPEG encoder refused the rotated frame" }
      return Frame(turned.toByteArray(), rotated.width, rotated.height)
    } finally {
      if (rotated !== upright) rotated.recycle()
      upright.recycle()
    }
  }
}
