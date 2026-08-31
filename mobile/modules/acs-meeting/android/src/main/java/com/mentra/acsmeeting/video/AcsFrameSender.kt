package com.mentra.acsmeeting.video

import android.util.Log
import com.azure.android.communication.calling.RawOutgoingVideoStream
import com.azure.android.communication.calling.RawVideoFrameBuffer
import com.azure.android.communication.calling.VideoStreamFormat
import com.azure.android.communication.calling.VideoStreamPixelFormat
import com.azure.android.communication.calling.VideoStreamState
import com.azure.android.communication.calling.VirtualOutgoingVideoStream
import com.mentra.acsmeeting.source.TargetSize
import com.mentra.acsmeeting.telemetry.ChromaProbe
import com.mentra.acsmeeting.telemetry.PipelineStats
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * I420 to ACS: three independent direct planes (Y, U, V). No inter-arrival
 * pacer — [SendGate] is the only backpressure. Size mismatch drops; the sink
 * owns scaling to the negotiated size.
 */
class AcsFrameSender(
  private val stats: PipelineStats = PipelineStats(),
) {
  private val running = AtomicBoolean(false)
  private val stream = AtomicReference<RawOutgoingVideoStream?>(null)
  private val format = AtomicReference<VideoStreamFormat?>(null)
  private val sender = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "acs-i420-send").apply { isDaemon = true }
  }
  private val gate = SendGate()
  private val pool = ConcurrentHashMap<Int, ConcurrentLinkedQueue<ByteBuffer>>()
  private val sendSeq = AtomicInteger(0)
  private val lastTicks = AtomicReference(0L)
  // Set on the session thread, read from ACS state/format listener threads.
  @Volatile private var onFormat: ((TargetSize) -> Unit)? = null

  fun attach(outgoing: VirtualOutgoingVideoStream, onFormat: ((TargetSize) -> Unit)? = null) {
    this.onFormat = onFormat
    stream.set(outgoing)
    outgoing.addOnStateChangedListener { _ ->
      val state = outgoing.state
      Log.i(TAG, "raw video state=$state")
      running.set(state == VideoStreamState.STARTED)
      if (state == VideoStreamState.STARTED) {
        format.set(outgoing.format)
        logFormat(outgoing.format)
        pushTarget(outgoing.format)
      }
    }
    outgoing.addOnFormatChangedListener { args ->
      format.set(args.format)
      logFormat(args.format)
      pushTarget(args.format)
    }
  }

  fun isReady(): Boolean = stream.get() != null && running.get() && format.get() != null

  fun sendI420(src: ByteBuffer, width: Int, height: Int, timestampNs: Long = 0L) {
    val out = stream.get()
    if (out == null || !running.get()) {
      stats.onDropNotStarted()
      return
    }
    val negotiated = format.get()
    if (negotiated == null) {
      stats.onDropNotStarted()
      return
    }
    if (negotiated.width != width || negotiated.height != height) {
      stats.onDropSize()
      return
    }

    src.rewind()
    val ySize = width * height
    val uvSize = I420Packer.chromaStride(width) * I420Packer.chromaStride(height)
    val expected = I420Packer.packedSize(width, height)
    if (src.remaining() < expected) {
      stats.onDropMalformed()
      Log.w(TAG, "P5 send packed src too small remaining=${src.remaining()} expected=$expected")
      return
    }
    val y = borrow(ySize)
    val u = borrow(uvSize)
    val v = borrow(uvSize)
    copyRegion(src, 0, ySize, y)
    copyRegion(src, ySize, uvSize, u)
    copyRegion(src, ySize + uvSize, uvSize, v)
    stats.setChroma(ChromaProbe.samplePacked(src, width, height))

    if (!gate.tryAcquire()) {
      stats.onDropBusy()
      recycle(y)
      recycle(u)
      recycle(v)
      return
    }

    val seq = sendSeq.incrementAndGet()
    stats.onQueued()
    if (seq <= TRACE_SENDS) {
      Log.i(
        TAG,
        "P5 send-enter seq=$seq mode=planes3 buffers=3 y=$ySize u=$uvSize v=$uvSize " +
          "direct=${y.isDirect} sinkThread=${Thread.currentThread().name}",
      )
    }

    val submitted = try {
      sender.execute {
        var result = "ok"
        // A timed-out future is NOT cancelled: ACS still reads these direct buffers.
        // Recycling them would let the next frame overwrite memory the encoder owns.
        var reclaimable = true
        var frame: RawVideoFrameBuffer? = null
        try {
          val streamTicks = try {
            out.timestampInTicks
          } catch (_: Exception) {
            0L
          }
          val ticks = AcsTimestamp.resolve(
            streamTicks = streamTicks,
            captureNs = if (timestampNs > 0) timestampNs else System.nanoTime(),
            lastTicks = lastTicks.get(),
          )
          lastTicks.set(ticks)
          frame = RawVideoFrameBuffer()
          frame.buffers = listOf(y, u, v)
          frame.streamFormat = negotiated
          frame.timestampInTicks = ticks
          val sendStart = System.nanoTime()
          out.sendRawVideoFrame(frame).get(SEND_TIMEOUT_MS, TimeUnit.MILLISECONDS)
          stats.send.record(System.nanoTime() - sendStart)
          stats.onSub()
          if (seq <= TRACE_SENDS) {
            Log.i(
              TAG,
              "P5 send-exit seq=$seq result=ok ticks=$ticks streamTicks=$streamTicks " +
                "thread=${Thread.currentThread().name}",
            )
          }
        } catch (error: TimeoutException) {
          result = "timeout"
          reclaimable = false
          stats.onDropFail()
          stats.onAbandoned()
          Log.w(TAG, "P5 send-exit seq=$seq result=timeout getMs>$SEND_TIMEOUT_MS buffers=abandoned")
        } catch (error: Exception) {
          result = "failed"
          stats.onDropFail()
          Log.w(TAG, "P5 send-exit seq=$seq result=failed ${describeAcs(error)}")
        } finally {
          if (reclaimable) {
            try {
              frame?.close()
            } catch (_: Exception) {
            }
            recycle(y)
            recycle(u)
            recycle(v)
          }
          gate.release()
          if (seq == 1 && result != "ok") {
            Log.w(TAG, "P5 send first frame did not complete result=$result mode=planes3")
          }
        }
      }
      true
    } catch (error: RejectedExecutionException) {
      false
    }
    if (!submitted) {
      stats.onDropFail()
      gate.release()
      recycle(y)
      recycle(u)
      recycle(v)
    }
  }

  fun detach() {
    running.set(false)
    stream.set(null)
    format.set(null)
    sendSeq.set(0)
    lastTicks.set(0L)
    pool.clear()
    onFormat = null
  }

  private fun pushTarget(fmt: VideoStreamFormat?) {
    if (fmt == null || fmt.width <= 0 || fmt.height <= 0) return
    onFormat?.invoke(TargetSize(fmt.width, fmt.height))
  }

  private fun copyRegion(src: ByteBuffer, offset: Int, size: Int, dest: ByteBuffer) {
    val view = src.duplicate()
    view.position(offset)
    view.limit(offset + size)
    dest.clear()
    dest.put(view)
    dest.flip()
  }

  // Keyed by exact capacity: luma and chroma differ 4x, and a single queue made
  // a luma borrow evict a chroma buffer it could not use.
  private fun borrow(capacity: Int): ByteBuffer {
    val existing = pool[capacity]?.poll()
    if (existing != null) {
      existing.clear()
      return existing
    }
    return ByteBuffer.allocateDirect(capacity)
  }

  private fun recycle(buffer: ByteBuffer) {
    val queue = pool.getOrPut(buffer.capacity()) { ConcurrentLinkedQueue() }
    if (queue.size >= POOL_PER_SIZE) return
    buffer.clear()
    queue.offer(buffer)
  }

  private fun logFormat(fmt: VideoStreamFormat?) {
    if (fmt == null) return
    Log.i(
      TAG,
      "P5 negotiated format pixel=${fmt.pixelFormat} ${fmt.width}x${fmt.height} fps=${fmt.framesPerSecond} " +
        "stride=${fmt.stride1}/${fmt.stride2}/${fmt.stride3}",
    )
  }

  companion object {
    private const val TAG = "ACS-SPIKE"
    private const val SEND_TIMEOUT_MS = 200L
    private const val TRACE_SENDS = 8
    private const val POOL_PER_SIZE = 4

    fun i420Format(profile: VideoProfile = VideoProfile.DEFAULT): VideoStreamFormat =
      i420Format(profile.width, profile.height, profile.fps.toFloat())

    fun i420Format(width: Int, height: Int, fps: Float): VideoStreamFormat {
      val spec = I420FormatSpec.of(width, height, fps)
      val format = VideoStreamFormat()
      format.pixelFormat = VideoStreamPixelFormat.I420
      format.width = spec.width
      format.height = spec.height
      format.framesPerSecond = spec.fps
      format.stride1 = spec.strideY
      format.stride2 = spec.strideU
      format.stride3 = spec.strideV
      return format
    }

    fun describeAcs(error: Throwable): String {
      val parts = ArrayList<String>(4)
      var current: Throwable? = error
      var depth = 0
      while (current != null && depth < 5) {
        val code = errorCodeOf(current)
        val message = current.message?.trim().orEmpty()
        parts.add(
          buildString {
            append(current!!.javaClass.simpleName)
            if (message.isNotEmpty()) append(':').append(message)
            if (code != null) append(" code=").append(code)
          },
        )
        current = current.cause
        depth += 1
      }
      return parts.joinToString(" | ")
    }

    private fun errorCodeOf(error: Throwable): String? {
      return try {
        val method = error.javaClass.methods.firstOrNull { it.name == "getErrorCode" && it.parameterCount == 0 }
          ?: return null
        method.invoke(error)?.toString()
      } catch (_: Exception) {
        null
      }
    }
  }
}
