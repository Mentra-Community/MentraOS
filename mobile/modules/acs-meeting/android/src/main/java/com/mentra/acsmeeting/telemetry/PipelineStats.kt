package com.mentra.acsmeeting.telemetry

import com.mentra.acsmeeting.video.I420Packer
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.roundToInt

/**
 * Monotonic pipeline counters. The 1 Hz [tick] prints rates for eyes; [cum]
 * is what pass/fail uses.
 *
 * inFlight is derived (sink - sub - drop), never tracked. A tracked counter
 * cannot be read atomically alongside the others, so onSub's increment-then-
 * decrement window printed CONSERVE_FAIL on a healthy pipeline. Deriving it
 * makes conservation an identity; reading sink last keeps it non-negative.
 */
class PipelineStats(
  private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
  private val sink = AtomicInteger(0)
  private val sub = AtomicInteger(0)
  private val dropSize = AtomicInteger(0)
  private val dropBusy = AtomicInteger(0)
  private val dropNotStarted = AtomicInteger(0)
  private val dropFail = AtomicInteger(0)
  private val dropNullI420 = AtomicInteger(0)
  private val abandoned = AtomicInteger(0)
  private val dup = AtomicInteger(0)
  private val rot = AtomicInteger(0)

  private val destAlloc = AtomicInteger(0)
  private val planeAlloc = AtomicInteger(0)

  private val lastTickSink = AtomicInteger(0)
  private val lastTickSub = AtomicInteger(0)
  private val lastTickMs = AtomicLong(0)

  private val lastArrivalNs = AtomicLong(0)

  val gap = RingPercentile()
  val pack = RingPercentile()
  val scale = RingPercentile()
  val toI420 = RingPercentile()
  val sinkCb = RingPercentile()
  val split = RingPercentile()
  val copy = RingPercentile()
  val send = RingPercentile()

  /**
   * WebRTC inbound-rtp disposition. Cumulative; the ladder prints deltas so a
   * climbing counter is visible without reading absolute values.
   */
  data class RecvHealth(
    val assembled: Long = -1L,
    val dropped: Long = -1L,
    val packetsLost: Long = -1L,
    val nack: Long = -1L,
    val pli: Long = -1L,
    val freezes: Long = -1L,
    val freezeSec: Double = -1.0,
    val jitter: Double = -1.0,
    val decodeSec: Double = -1.0,
    val jitterBufferSec: Double = -1.0,
    val jitterBufferEmits: Long = -1L,
    val decImpl: String = "",
  )

  @Volatile var arm: String = "whep"
  /** texture | bytebuf — which decoder factory we built. */
  @Volatile var pathMode: String = "texture"
  /** packsplit | planes | zerocopy | nv12 — how pixels reach ACS. */
  @Volatile var pathCopy: String = "packsplit"
  /** i420 | nv12 — pixel format advertised to ACS. */
  @Volatile var pix: String = "i420"
  /** MEDIA_STATISTICS codecName, underscored. Empty until the first report. */
  @Volatile var codecName: String = ""
  @Volatile var decodedFps: Double? = null
  @Volatile var recvFps: Double? = null
  @Volatile var wireFps: Double? = null
  @Volatile var wireWidth: Int? = null
  @Volatile var wireHeight: Int? = null
  @Volatile var wireBitrateBps: Long? = null
  @Volatile private var recv: RecvHealth? = null
  @Volatile private var recvPrev: RecvHealth? = null
  @Volatile var width: Int = 0
  @Volatile var height: Int = 0
  @Volatile var chromaY: Int = 0
  @Volatile var chromaU: Int = 0
  @Volatile var chromaV: Int = 0
  @Volatile var strideY: Int = 0
  @Volatile var strideU: Int = 0
  @Volatile var strideV: Int = 0
  @Volatile var zcOn: Int = 0

  private val bufTex = AtomicInteger(0)
  private val bufI420 = AtomicInteger(0)
  private val bufOther = AtomicInteger(0)
  private val strideTight = AtomicInteger(0)
  private val stridePadded = AtomicInteger(0)
  private val zcUsed = AtomicInteger(0)
  private val zcFell = AtomicInteger(0)
  private val zcPadded = AtomicInteger(0)
  private val zcHeldMax = AtomicInteger(0)
  private val zcTimeout = AtomicInteger(0)

  fun onSink() {
    sink.incrementAndGet()
  }

  fun recordGap(nowNs: Long = System.nanoTime()) {
    val prev = lastArrivalNs.getAndSet(nowNs)
    if (prev != 0L) gap.record(nowNs - prev)
  }

  /** Kept as the explicit hand-off point; inFlight is derived, so this records nothing. */
  fun onQueued() = Unit

  fun onSub() {
    sub.incrementAndGet()
  }

  fun onDropSize() = dropSize.incrementAndGet()
  fun onDropBusy() = dropBusy.incrementAndGet()
  fun onDropNotStarted() = dropNotStarted.incrementAndGet()
  fun onDropFail() = dropFail.incrementAndGet()
  fun onDropMalformed() = dropFail.incrementAndGet()

  /**
   * A send that timed out. The future is not cancelled, so ACS may still read those
   * direct buffers; they are never recycled. Non-zero here means the pool is leaking.
   */
  fun onAbandoned() = abandoned.incrementAndGet()

  fun abandonedCount(): Int = abandoned.get()
  fun onDropNullI420() = dropNullI420.incrementAndGet()
  fun onDup() = dup.incrementAndGet()
  fun onRotation() = rot.incrementAndGet()
  fun onDestAlloc() = destAlloc.incrementAndGet()
  fun onPlaneAlloc() = planeAlloc.incrementAndGet()
  fun destAllocCount(): Int = destAlloc.get()
  fun planeAllocCount(): Int = planeAlloc.get()

  /**
   * Classify the WebRTC [VideoFrame.Buffer] without importing WebRTC here.
   * [kind] is "tex", "i420", or anything else ("other").
   */
  fun onFrameBuffer(kind: String) {
    when (kind) {
      "tex" -> bufTex.incrementAndGet()
      "i420" -> bufI420.incrementAndGet()
      else -> bufOther.incrementAndGet()
    }
  }

  fun onStrides(strideY: Int, strideU: Int, strideV: Int, width: Int) {
    this.strideY = strideY
    this.strideU = strideU
    this.strideV = strideV
    val chroma = I420Packer.chromaStride(width)
    if (strideY == width && strideU == chroma && strideV == chroma) {
      strideTight.incrementAndGet()
    } else {
      stridePadded.incrementAndGet()
    }
  }

  fun onZcUsed(heldNow: Int) {
    zcUsed.incrementAndGet()
    zcHeldMax.updateAndGet { current -> if (heldNow > current) heldNow else current }
  }

  fun onZcFell() = zcFell.incrementAndGet()
  fun onZcPadded() = zcPadded.incrementAndGet()
  fun onZcTimeout() = zcTimeout.incrementAndGet()

  fun zcUsedCount(): Int = zcUsed.get()
  fun zcFellCount(): Int = zcFell.get()
  fun zcTimeoutCount(): Int = zcTimeout.get()
  fun zcHeldMax(): Int = zcHeldMax.get()
  fun strideTightCount(): Int = strideTight.get()
  fun stridePaddedCount(): Int = stridePadded.get()
  fun bufTexCount(): Int = bufTex.get()
  fun bufI420Count(): Int = bufI420.get()
  fun bufOtherCount(): Int = bufOther.get()

  fun setSize(w: Int, h: Int) {
    width = w
    height = h
  }

  fun setRecvHealth(next: RecvHealth) {
    recvPrev = recv
    recv = next
  }

  /** Per-tick deltas plus the two absolutes that only mean something cumulatively. */
  fun recvLabel(): String {
    val now = recv ?: return "recv{na}"
    val was = recvPrev
    fun d(pick: (RecvHealth) -> Long): String {
      val current = pick(now)
      if (current < 0) return "na"
      val previous = was?.let(pick) ?: return current.toString()
      return if (previous < 0) current.toString() else (current - previous).toString()
    }
    val decodeMs = if (now.decodeSec < 0 || now.assembled <= 0) "na"
      else format(now.decodeSec * 1000.0 / now.assembled)
    val jbMs = if (now.jitterBufferSec < 0 || now.jitterBufferEmits <= 0) "na"
      else format(now.jitterBufferSec * 1000.0 / now.jitterBufferEmits)
    val impl = now.decImpl.ifBlank { "na" }.replace(' ', '_')
    return "recv{drop=${d { it.dropped }} lost=${d { it.packetsLost }} nack=${d { it.nack }} " +
      "pli=${d { it.pli }} freeze=${d { it.freezes }} freezeSec=${format(now.freezeSec)} " +
      "jit=${format(now.jitter * 1000.0)} decMs=$decodeMs jbMs=$jbMs decImpl=$impl}"
  }

  fun setChroma(sample: ChromaProbe.Sample) {
    chromaY = sample.y
    chromaU = sample.u
    chromaV = sample.v
  }

  fun sinkCount(): Int = sink.get()
  fun subCount(): Int = sub.get()
  fun dropCount(): Int = dropSize.get() + dropBusy.get() + dropNotStarted.get() + dropFail.get() + dropNullI420.get()

  /** Read sink last: every frame hits sink before sub or drop, so this cannot go negative. */
  fun inFlightCount(): Int {
    val settled = sub.get() + dropCount()
    return sink.get() - settled
  }

  fun dupCount(): Int = dup.get()
  fun rotCount(): Int = rot.get()

  fun conserved(): Boolean = inFlightCount() >= 0

  fun tick(): String {
    val now = nowMs()
    val previous = lastTickMs.get()
    val dt = if (previous == 0L) 1000L else (now - previous).coerceAtLeast(1L)
    lastTickMs.set(now)
    val sinkNow = sink.get()
    val subNow = sub.get()
    val sinkDelta = sinkNow - lastTickSink.getAndSet(sinkNow)
    val subDelta = subNow - lastTickSub.getAndSet(subNow)
    val sinkRate = rate(sinkDelta, dt)
    val subRate = rate(subDelta, dt)
    val dec = decodedFps?.let { formatRate(it) } ?: "na"
    val rcv = recvFps?.let { formatRate(it) } ?: "na"
    val wireFpsLabel = wireFps?.let { formatRate(it) } ?: "na"
    val wireW = wireWidth ?: 0
    val wireH = wireHeight ?: 0
    val wireKbps = wireBitrateBps?.let { (it / 1000).toString() } ?: "na"
    val codec = codecName.ifBlank { "na" }.replace(' ', '_')
    val wire = "${wireW}x${wireH}@$wireFpsLabel kbps=$wireKbps codec=$codec"
    val sizeLabel = if (width > 0 && height > 0) "${width}x${height}" else "0x0"
    val inFlightNow = inFlightCount()
    val conserve = if (inFlightNow >= 0) "" else " CONSERVE_FAIL"
    return "P6 ladder arm=$arm $sizeLabel recv=$rcv dec=$dec sink=$sinkRate dup=${dup.get()} sub=$subRate wire=$wire rot=${rot.get()} " +
      "drop{size=${dropSize.get()} busy=${dropBusy.get()} notStarted=${dropNotStarted.get()} fail=${dropFail.get()} nullI420=${dropNullI420.get()} abandoned=${abandoned.get()}} " +
      "${recvLabel()} " +
      "path{mode=$pathMode copy=$pathCopy pix=$pix} " +
      "buf{tex=${bufTex.get()} i420=${bufI420.get()} other=${bufOther.get()}} " +
      "stride{y=$strideY u=$strideU v=$strideV tight=${strideTight.get()} padded=${stridePadded.get()}} " +
      "zc{on=$zcOn used=${zcUsed.get()} fell=${zcFell.get()} padded=${zcPadded.get()} heldMax=${zcHeldMax.get()} timeout=${zcTimeout.get()}} " +
      "ms{gapP50=${gap.p50()} gapP95=${gap.p95()} i420P95=${toI420.p95()} packP95=${pack.p95()} scaleP95=${scale.p95()} sinkCbP95=${sinkCb.p95()} splitP95=${split.p95()} copyP95=${copy.p95()} sendP95=${send.p95()}} " +
      "alloc{dest=${destAlloc.get()} plane=${planeAlloc.get()}} " +
      "chroma{y=$chromaY u=$chromaU v=$chromaV} " +
      "cum{sink=$sinkNow sub=$subNow drop=${dropCount()} inFlight=$inFlightNow}" +
      conserve
  }

  private fun rate(delta: Int, dtMs: Long): String = formatRate(delta * 1000.0 / dtMs)

  companion object {
    fun formatRate(value: Double): String = ((value * 10).roundToInt() / 10.0).toString()

    fun format(value: Double): String =
      if (value < 0) "na" else ((value * 10).roundToInt() / 10.0).toString()
  }
}
