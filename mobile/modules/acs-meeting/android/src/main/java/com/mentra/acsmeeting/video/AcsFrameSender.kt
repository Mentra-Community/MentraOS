package com.mentra.acsmeeting.video

import android.util.Log
import com.azure.android.communication.calling.RawOutgoingVideoStream
import com.azure.android.communication.calling.RawVideoFrameBuffer
import com.azure.android.communication.calling.VideoStreamFormat
import com.azure.android.communication.calling.VideoStreamFormatChangedListener
import com.azure.android.communication.calling.VideoStreamPixelFormat
import com.azure.android.communication.calling.VideoStreamResolution
import com.azure.android.communication.calling.VideoStreamState
import com.azure.android.communication.calling.VideoStreamStateChangedListener
import com.azure.android.communication.calling.VirtualOutgoingVideoStream
import com.mentra.acsmeeting.source.AcsInvestigation
import com.mentra.acsmeeting.source.I420Planes
import com.mentra.acsmeeting.source.PixelFormatArm
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
  private val held = AtomicInteger(0)
  private val cleanup = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "acs-zc-release").apply { isDaemon = true }
  }
  // Set on the session thread, read from ACS state/format listener threads.
  @Volatile private var onFormat: ((TargetSize) -> Unit)? = null
  private var attachedStream: VirtualOutgoingVideoStream? = null
  private var stateListener: VideoStreamStateChangedListener? = null
  private var formatListener: VideoStreamFormatChangedListener? = null

  fun attach(outgoing: VirtualOutgoingVideoStream, onFormat: ((TargetSize) -> Unit)? = null) {
    detach()
    this.onFormat = onFormat
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
        pushTarget(outgoing.format)
      }
    }
    val onFormatChanged = VideoStreamFormatChangedListener { args ->
      if (stream.get() !== outgoing) return@VideoStreamFormatChangedListener
      format.set(args.format)
      logFormat(args.format)
      pushTarget(args.format)
    }
    stateListener = onState
    formatListener = onFormatChanged
    outgoing.addOnStateChangedListener(onState)
    outgoing.addOnFormatChangedListener(onFormatChanged)
  }

  fun isReady(): Boolean = stream.get() != null && running.get() && format.get() != null

  fun sendPlanes(planes: I420Planes) {
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
    if (negotiated.width != planes.width || negotiated.height != planes.height) {
      stats.onDropSize()
      return
    }
    if (!planes.planesReadable()) {
      stats.onDropMalformed()
      Log.w(
        TAG,
        "P5 send plane too small ${planes.width}x${planes.height} " +
          "stride=${planes.strideY}/${planes.strideU}/${planes.strideV}",
      )
      return
    }

    val prepared = prepareSend(planes, negotiated)
    stats.setChroma(prepared.chroma)

    if (!gate.tryAcquire()) {
      stats.onDropBusy()
      releaseSendBuffers(prepared, planes)
      return
    }

    val seq = sendSeq.incrementAndGet()
    stats.onQueued()
    if (seq <= TRACE_SENDS) {
      Log.i(
        TAG,
        "P5 send-enter seq=$seq mode=${prepared.mode} buffers=${prepared.buffers.size} " +
          "sizes=${prepared.buffers.joinToString("/") { it.remaining().toString() }} " +
          "direct=${prepared.buffers.all { it.isDirect }} tight=${planes.isTight()} " +
          "sinkThread=${Thread.currentThread().name}",
      )
    }

    val submitted = try {
      sender.execute {
        var result = "ok"
        // A timed-out future is NOT cancelled: ACS still reads these direct buffers.
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
            captureNs = if (planes.timestampNs > 0) planes.timestampNs else System.nanoTime(),
            lastTicks = lastTicks.get(),
          )
          lastTicks.set(ticks)
          frame = RawVideoFrameBuffer()
          frame.buffers = prepared.buffers
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
          if (prepared.zeroCopy) {
            stats.onZcTimeout()
            scheduleZeroCopyRelease(planes)
          }
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
            releaseSendBuffers(prepared, planes)
          }
          gate.release()
          if (seq == 1 && result != "ok") {
            Log.w(TAG, "P5 send first frame did not complete result=$result mode=${prepared.mode}")
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
      releaseSendBuffers(prepared, planes)
    }
  }

  private data class PreparedSend(
    val buffers: List<ByteBuffer>,
    val zeroCopy: Boolean,
    val mode: String,
    val chroma: ChromaProbe.Sample,
  )

  private fun prepareSend(planes: I420Planes, negotiated: VideoStreamFormat): PreparedSend {
    if (negotiatedPixelIsNv12(negotiated)) {
      return prepareNv12(planes)
    }
    val ySize = planes.width * planes.height
    val uvSize = I420Packer.chromaStride(planes.width) * I420Packer.chromaStride(planes.height)
    val zeroCopy = tryZeroCopy(planes)
    val y: ByteBuffer
    val u: ByteBuffer
    val v: ByteBuffer
    if (zeroCopy) {
      planes.retain!!()
      val nowHeld = held.incrementAndGet()
      stats.onZcUsed(nowHeld)
      y = planes.y.duplicate()
      u = planes.u.duplicate()
      v = planes.v.duplicate()
    } else {
      y = borrow(ySize)
      u = borrow(uvSize)
      v = borrow(uvSize)
      val chromaW = I420Packer.chromaStride(planes.width)
      val chromaH = I420Packer.chromaStride(planes.height)
      val copyStart = System.nanoTime()
      I420Packer.copyPlane(planes.y, planes.strideY, planes.width, planes.height, y)
      I420Packer.copyPlane(planes.u, planes.strideU, chromaW, chromaH, u)
      I420Packer.copyPlane(planes.v, planes.strideV, chromaW, chromaH, v)
      y.flip()
      u.flip()
      v.flip()
      stats.copy.record(System.nanoTime() - copyStart)
    }
    return PreparedSend(
      buffers = listOf(y, u, v),
      zeroCopy = zeroCopy,
      mode = if (zeroCopy) "zerocopy" else "planes",
      chroma = ChromaProbe.samplePlanes(y, u, v),
    )
  }

  private fun prepareNv12(planes: I420Planes): PreparedSend {
    val ySize = planes.width * planes.height
    val uvSize = Nv12Packer.uvSize(planes.width, planes.height)
    val y = borrow(ySize)
    val uv = borrow(uvSize)
    val chromaW = I420Packer.chromaStride(planes.width)
    val chromaH = Nv12Packer.chromaHeight(planes.height)
    val copyStart = System.nanoTime()
    Nv12Packer.copyY(planes.y, planes.strideY, planes.width, planes.height, y)
    Nv12Packer.interleaveUv(
      planes.u, planes.strideU, planes.v, planes.strideV, chromaW, chromaH, uv,
    )
    y.flip()
    uv.flip()
    stats.copy.record(System.nanoTime() - copyStart)
    return PreparedSend(
      buffers = listOf(y, uv),
      zeroCopy = false,
      mode = "nv12",
      chroma = ChromaProbe.sampleNv12(y, uv),
    )
  }

  private fun negotiatedPixelIsNv12(negotiated: VideoStreamFormat): Boolean {
    return try {
      negotiated.pixelFormat == VideoStreamPixelFormat.NV12
    } catch (_: Exception) {
      AcsInvestigation.pixelFormat == PixelFormatArm.NV12
    }
  }

  private fun tryZeroCopy(planes: I420Planes): Boolean {
    if (!AcsInvestigation.zeroCopy) return false
    if (planes.retain == null || planes.release == null) {
      stats.onZcFell()
      return false
    }
    if (!planes.isDirect()) {
      stats.onZcFell()
      return false
    }
    if (!planes.isTight()) {
      stats.onZcPadded()
      stats.onZcFell()
      return false
    }
    if (held.get() >= MAX_HELD) {
      stats.onZcFell()
      return false
    }
    return true
  }

  private fun releaseSendBuffers(prepared: PreparedSend, planes: I420Planes) {
    if (prepared.zeroCopy) {
      try {
        planes.release?.invoke()
      } catch (_: Exception) {
      }
      held.decrementAndGet()
    } else {
      for (buffer in prepared.buffers) recycle(buffer)
    }
  }

  private fun scheduleZeroCopyRelease(planes: I420Planes) {
    cleanup.schedule({
      try {
        planes.release?.invoke()
      } catch (_: Exception) {
      } finally {
        held.decrementAndGet()
      }
    }, ZC_GRACE_MS, TimeUnit.MILLISECONDS)
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
    sendSeq.set(0)
    lastTicks.set(0L)
    pool.clear()
    onFormat = null
  }

  private fun pushTarget(fmt: VideoStreamFormat?) {
    if (fmt == null || fmt.width <= 0 || fmt.height <= 0) return
    onFormat?.invoke(TargetSize(fmt.width, fmt.height))
  }

  // Keyed by exact capacity: luma and chroma differ 4x, and a single queue made
  // a luma borrow evict a chroma buffer it could not use.
  private fun borrow(capacity: Int): ByteBuffer {
    val existing = pool[capacity]?.poll()
    if (existing != null) {
      existing.clear()
      return existing
    }
    stats.onPlaneAlloc()
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
    private const val MAX_HELD = 2
    private const val ZC_GRACE_MS = 1_000L

    fun outgoingFormat(profile: VideoProfile = VideoProfile.DEFAULT): VideoStreamFormat =
      when (AcsInvestigation.pixelFormat) {
        PixelFormatArm.NV12 -> nv12Format(profile)
        PixelFormatArm.I420 -> i420Format(profile)
      }

    fun i420Format(profile: VideoProfile = VideoProfile.DEFAULT): VideoStreamFormat =
      i420Format(profile.width, profile.height, profile.fps.toFloat())

    fun nv12Format(profile: VideoProfile = VideoProfile.DEFAULT): VideoStreamFormat =
      nv12Format(profile.width, profile.height, profile.fps.toFloat())

    fun i420Format(width: Int, height: Int, fps: Float): VideoStreamFormat {
      val spec = I420FormatSpec.of(width, height, fps)
      val format = VideoStreamFormat()
      format.pixelFormat = VideoStreamPixelFormat.I420
      applyNamedSize(format, spec.width, spec.height)
      format.framesPerSecond = spec.fps
      format.stride1 = spec.strideY
      format.stride2 = spec.strideU
      format.stride3 = spec.strideV
      return format
    }

    fun nv12Format(width: Int, height: Int, fps: Float): VideoStreamFormat {
      val spec = Nv12FormatSpec.of(width, height, fps)
      val format = VideoStreamFormat()
      format.pixelFormat = VideoStreamPixelFormat.NV12
      applyNamedSize(format, spec.width, spec.height)
      format.framesPerSecond = spec.fps
      format.stride1 = spec.strideY
      format.stride2 = spec.strideUv
      return format
    }

    private fun applyNamedSize(format: VideoStreamFormat, width: Int, height: Int) {
      when (I420FormatSpec.of(width, height).namedResolution()) {
        AcsNamedResolution.P1080 -> format.resolution = VideoStreamResolution.P1080
        AcsNamedResolution.P720 -> format.resolution = VideoStreamResolution.P720
        AcsNamedResolution.P540 -> format.resolution = VideoStreamResolution.P540
        AcsNamedResolution.P480 -> format.resolution = VideoStreamResolution.P480
        AcsNamedResolution.P360 -> format.resolution = VideoStreamResolution.P360
        AcsNamedResolution.P270 -> format.resolution = VideoStreamResolution.P270
        AcsNamedResolution.P240 -> format.resolution = VideoStreamResolution.P240
        AcsNamedResolution.P180 -> format.resolution = VideoStreamResolution.P180
        AcsNamedResolution.VGA -> format.resolution = VideoStreamResolution.VGA
        AcsNamedResolution.QVGA -> format.resolution = VideoStreamResolution.QVGA
        null -> {
          Log.w(TAG, "ACS format ${width}x${height} is not a VideoStreamResolution; advertising raw size")
          format.width = width
          format.height = height
        }
      }
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
