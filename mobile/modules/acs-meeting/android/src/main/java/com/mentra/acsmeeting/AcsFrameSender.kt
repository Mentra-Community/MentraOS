package com.mentra.acsmeeting

import android.util.Log
import com.azure.android.communication.calling.RawOutgoingVideoStream
import com.azure.android.communication.calling.RawVideoFrameBuffer
import com.azure.android.communication.calling.VideoStreamFormat
import com.azure.android.communication.calling.VideoStreamFormatChangedListener
import com.azure.android.communication.calling.VideoStreamPixelFormat
import com.azure.android.communication.calling.VideoStreamState
import com.azure.android.communication.calling.VideoStreamStateChangedListener
import com.azure.android.communication.calling.VirtualOutgoingVideoStream
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Adapted from RealWear Collaborate `VideoFrameSender.kt` (Apache 2.0):
 * https://github.com/realwear/collaborate
 * File: android/apps/rwt/app/src/main/java/com/realwear/acs/util/thermal/VideoFrameSender.kt
 *
 * Patterns retained: direct ByteBuffer pooling, format negotiation from the
 * raw stream, frame pacing to negotiated FPS, start/stop/format-changed handling.
 * Mentra conversion: WHEP I420 → ACS-negotiated RGBA ByteBuffer (Microsoft's
 * Android raw-video sample), not a hardcoded I420→NV12 path.
 */
class AcsFrameSender {
  private val pool = ConcurrentLinkedQueue<ByteBuffer>()
  private val running = AtomicBoolean(false)
  private val stream = AtomicReference<RawOutgoingVideoStream?>(null)
  private val format = AtomicReference<VideoStreamFormat?>(null)
  private var lastSentNs = 0L
  private var attachedStream: VirtualOutgoingVideoStream? = null
  private var stateListener: VideoStreamStateChangedListener? = null
  private var formatListener: VideoStreamFormatChangedListener? = null

  fun attach(outgoing: VirtualOutgoingVideoStream) {
    detach()
    stream.set(outgoing)
    attachedStream = outgoing
    val onState = VideoStreamStateChangedListener {
      // Ignore late events from a previous call's stream so a stale STOPPED
      // cannot freeze outgoing video for the current meeting.
      if (stream.get() !== outgoing) return@VideoStreamStateChangedListener
      val state = outgoing.state
      Log.i(TAG, "raw video state=$state")
      running.set(state == VideoStreamState.STARTED)
      if (state == VideoStreamState.STARTED) {
        format.set(outgoing.format)
        logFormat(outgoing.format)
      }
    }
    val onFormat = VideoStreamFormatChangedListener { args ->
      if (stream.get() !== outgoing) return@VideoStreamFormatChangedListener
      format.set(args.format)
      logFormat(args.format)
    }
    stateListener = onState
    formatListener = onFormat
    outgoing.addOnStateChangedListener(onState)
    outgoing.addOnFormatChangedListener(onFormat)
  }

  fun sendRgba(src: ByteBuffer, width: Int, height: Int) {
    val out = stream.get() ?: return
    if (!running.get()) return
    val negotiated = format.get() ?: return
    val fps = negotiated.framesPerSecond.let { if (it > 0f) it else 15f }
    val minIntervalNs = (1_000_000_000.0 / fps.toDouble()).toLong()
    val now = System.nanoTime()
    if (lastSentNs != 0L && now - lastSentNs < minIntervalNs) return
    lastSentNs = now

    val capacity = width * height * 4
    val buffer = borrow(capacity)
    buffer.clear()
    src.rewind()
    buffer.put(src)
    buffer.flip()

    try {
      val frame = RawVideoFrameBuffer()
      frame.buffers = listOf(buffer)
      frame.streamFormat = negotiated
      out.sendRawVideoFrame(frame).get()
    } catch (error: Exception) {
      Log.w(TAG, "sendRawVideoFrame failed", error)
    } finally {
      recycle(buffer)
    }
  }

  fun detach() {
    running.set(false)
    val previous = attachedStream
    if (previous != null) {
      stateListener?.let { previous.removeOnStateChangedListener(it) }
      formatListener?.let { previous.removeOnFormatChangedListener(it) }
    }
    attachedStream = null
    stateListener = null
    formatListener = null
    stream.set(null)
    format.set(null)
    pool.clear()
  }

  private fun borrow(capacity: Int): ByteBuffer {
    val existing = pool.poll()
    if (existing != null && existing.capacity() >= capacity) {
      existing.clear()
      return existing
    }
    return ByteBuffer.allocateDirect(capacity)
  }

  private fun recycle(buffer: ByteBuffer) {
    buffer.clear()
    pool.offer(buffer)
  }

  private fun logFormat(fmt: VideoStreamFormat?) {
    if (fmt == null) return
    Log.i(
      TAG,
      "P5 negotiated format pixel=${fmt.pixelFormat} ${fmt.width}x${fmt.height} fps=${fmt.framesPerSecond}",
    )
  }

  companion object {
    private const val TAG = "ACS-SPIKE"

    fun rgbaFormat(width: Int = 1280, height: Int = 720, fps: Float = 15f): VideoStreamFormat {
      val format = VideoStreamFormat()
      format.pixelFormat = VideoStreamPixelFormat.RGBA
      format.width = width
      format.height = height
      format.framesPerSecond = fps
      format.stride1 = width * 4
      return format
    }
  }
}
