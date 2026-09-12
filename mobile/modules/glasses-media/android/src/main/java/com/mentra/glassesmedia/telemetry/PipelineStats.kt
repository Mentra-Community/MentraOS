package com.mentra.glassesmedia.telemetry

import com.mentra.glassesmedia.video.I420Packer
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
  private val dropPaced = AtomicInteger(0)
  private val abandoned = AtomicInteger(0)
  private val dup = AtomicInteger(0)
  private val rot = AtomicInteger(0)

  private val destAlloc = AtomicInteger(0)
  private val planeAlloc = AtomicInteger(0)

  private val lastTickSink = AtomicInteger(0)
  private val lastTickSub = AtomicInteger(0)
  private val lastTickPackets = AtomicInteger(0)
  private val lastPacketsAtMs = AtomicLong(0)
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
   * How stale a frame already is when the decoder hands it to us.
   *
   * Everything else on this ladder measures work we do, so all of it can read healthy while the
   * wearer's picture lags seconds behind: capture, encode, and the network happen before our first
   * timestamp. WebRTC's extrapolated capture time is the only upstream clock we get, and it is an
   * estimate — read the trend, not the absolute value.
   */
  val age = RingPercentile()

  /**
   * Wait between handing a frame to the ACS sender and its single send thread picking it up.
   *
   * The one stage with no other symptom. `sendP95` times the ACS call itself, so a backed-up
   * `acs-i420-send` queue shows only as drops at the gate, with every timing on this ladder still
   * looking fast.
   */
  val queue = RingPercentile()

  /** Decoder-estimated capture time to ACS accepting the frame: the number the far end feels. */
  val e2e = RingPercentile()

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
  /** The fps we declared to ACS, so [VideoRateVerdict] can score against it. */
  @Volatile var advertisedFps: Double = 0.0
  /** The bitrate ceiling we granted ACS, for the starved-versus-CPU-bound split. */
  @Volatile var budgetBps: Int = 0
  /** Last rates computed by [tick], kept so the verdict scores the same numbers the ladder printed. */
  @Volatile var lastSinkFps: Double = 0.0
  @Volatile var lastSubFps: Double = 0.0
  @Volatile var decodedFps: Double? = null
  @Volatile var recvFps: Double? = null
  @Volatile var wireFps: Double? = null
  @Volatile var wireWidth: Int? = null
  @Volatile var wireHeight: Int? = null
  @Volatile var wireBitrateBps: Long? = null
  /** ACS cumulative outgoing packet count; differenced per tick into [lastPacketsPerSecond]. */
  @Volatile var wirePacketCount: Int? = null
  @Volatile var lastPacketsPerSecond: Double? = null

  /**
   * Latest ACS `networkSendQuality`, the only send-side network signal the SDK
   * exposes. It arrives on change rather than on a schedule, so it is latched here
   * and reprinted every tick — a GOOD/POOR that fired once before the bitrate
   * started sliding is exactly the line nobody scrolls back far enough to find.
   */
  @Volatile var sendQuality: String = ""
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
   * Dropped because it arrived sooner than the rate we advertised to ACS.
   *
   * Distinct from [onDropBusy]: the send thread is idle, we just refuse to
   * over-feed the software encoder. Counted in [dropCount] so conservation
   * still holds after the sink has already seen the frame.
   */
  fun onDropPaced() = dropPaced.incrementAndGet()

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
  fun dropCount(): Int =
    dropSize.get() + dropBusy.get() + dropNotStarted.get() + dropFail.get() + dropNullI420.get() + dropPaced.get()

  /** Read sink last: every frame hits sink before sub or drop, so this cannot go negative. */
  fun inFlightCount(): Int {
    val settled = sub.get() + dropCount()
    return sink.get() - settled
  }

  fun dupCount(): Int = dup.get()
  fun rotCount(): Int = rot.get()

  fun conserved(): Boolean = inFlightCount() >= 0

  /**
   * The phone-side stage with the highest p95, so a soak log names its own bottleneck.
   *
   * Only stages we actually perform are ranked. [age] is excluded on purpose: it is dominated by
   * capture, encode and the network, so including it would make every healthy call blame a stage
   * this device does not run. It is printed beside the verdict instead, which is what separates
   * "the phone is slow" from "the phone is fine and the frames arrive late".
   */
  fun slowestStage(): String {
    val stages = listOf(
      "scale" to scale.p95Ms(),
      "toI420" to toI420.p95Ms(),
      "copy" to copy.p95Ms(),
      "queue" to queue.p95Ms(),
      "send" to send.p95Ms(),
    )
    val worst = stages.filter { it.second >= 0 }.maxByOrNull { it.second } ?: return "na"
    return "${worst.first}=${format(worst.second)}"
  }

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
    lastSinkFps = sinkDelta * 1000.0 / dt
    lastSubFps = subDelta * 1000.0 / dt
    // ACS reports packets cumulatively on the MEDIA_STATISTICS interval, which is
    // several times longer than this 1 Hz tick. Differencing every tick reported
    // pps=0.0 on every tick between reports, so rate is measured across the gap
    // between actual changes and held in between rather than recomputed against a
    // count that did not move.
    wirePacketCount?.let { total ->
      val previous = lastTickPackets.get()
      if (total != previous) {
        val previousAt = lastPacketsAtMs.getAndSet(now)
        if (previous in 1..total && previousAt > 0) {
          lastPacketsPerSecond = (total - previous) * 1000.0 / (now - previousAt).coerceAtLeast(1L)
        }
        lastTickPackets.set(total)
      }
    }
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
      "drop{size=${dropSize.get()} busy=${dropBusy.get()} notStarted=${dropNotStarted.get()} fail=${dropFail.get()} nullI420=${dropNullI420.get()} pace=${dropPaced.get()} abandoned=${abandoned.get()}} " +
      "${recvLabel()} " +
      "path{mode=$pathMode copy=$pathCopy pix=$pix} " +
      "buf{tex=${bufTex.get()} i420=${bufI420.get()} other=${bufOther.get()}} " +
      "stride{y=$strideY u=$strideU v=$strideV tight=${strideTight.get()} padded=${stridePadded.get()}} " +
      "zc{on=$zcOn used=${zcUsed.get()} fell=${zcFell.get()} padded=${zcPadded.get()} heldMax=${zcHeldMax.get()} timeout=${zcTimeout.get()}} " +
      "ms{gapP50=${gap.p50()} gapP95=${gap.p95()} i420P95=${toI420.p95()} packP95=${pack.p95()} scaleP95=${scale.p95()} sinkCbP95=${sinkCb.p95()} splitP95=${split.p95()} copyP95=${copy.p95()} queueP95=${queue.p95()} sendP95=${send.p95()}} " +
      "lat{ageP50=${age.p50()} ageP95=${age.p95()} e2eP50=${e2e.p50()} e2eP95=${e2e.p95()} slowest=${slowestStage()}} " +
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
