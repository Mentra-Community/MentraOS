package com.mentra.acsmeeting.source

import android.util.Log
import com.mentra.acsmeeting.telemetry.PipelineStats
import com.mentra.acsmeeting.video.I420Packer
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Fixed-rate packed-I420 source. Bypasses glasses, Cloudflare, WHEP and decode.
 * Ticks that fail [isReady] or lack a target size are withheld and uncounted.
 */
class SyntheticI420Source(
  private val video: VideoFrameListener,
  private val stats: PipelineStats,
  private val isReady: () -> Boolean,
  private val config: SyntheticConfig = SyntheticConfig(),
) : GlassesMediaSource {
  private val factory = SyntheticFrameFactory(config.entropy)
  private val targetSize = AtomicReference<TargetSize?>(null)
  private val pcmEnabled = AtomicBoolean(false)
  private val frameIndex = AtomicInteger(0)
  private val withheld = AtomicInteger(0)
  private val withheldThisGap = AtomicInteger(0)
  private val emitted = AtomicInteger(0)
  private val emitting = AtomicBoolean(false)
  private val firstLogged = AtomicBoolean(false)
  private val fpsWindowStartNs = AtomicLong(0)
  private val fpsWindowCount = AtomicInteger(0)
  @Volatile private var stampFps: Double? = null
  @Volatile override var state: SourceState = SourceState.IDLE
    private set
  @Volatile private var dest: ByteBuffer? = null
  @Volatile private var destWidth = 0
  @Volatile private var destHeight = 0
  private var scheduler: ScheduledExecutorService? = null

  /** Test-visible gate transitions. Production also writes them to ACS-SPIKE. */
  internal val events = mutableListOf<String>()

  /** Puts the source in LIVE without starting the scheduler. For emitOnce tests. */
  internal fun becomeLive() {
    state = SourceState.LIVE
  }

  override fun start(config: SourceConfig) {
    stop()
    becomeLive()
    val fps = this.config.fps.coerceAtLeast(1)
    val periodUs = 1_000_000L / fps
    val exec = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, "acs-synthetic-i420").apply { isDaemon = true }
    }
    scheduler = exec
    exec.scheduleAtFixedRate({ emitOnce() }, 0, periodUs, TimeUnit.MICROSECONDS)
  }

  override fun restart(config: SourceConfig) {
    stop()
    start(config)
  }

  override fun stop() {
    scheduler?.shutdownNow()
    scheduler = null
    frameIndex.set(0)
    withheld.set(0)
    withheldThisGap.set(0)
    emitted.set(0)
    emitting.set(false)
    firstLogged.set(false)
    fpsWindowStartNs.set(0)
    fpsWindowCount.set(0)
    stampFps = null
    dest = null
    destWidth = 0
    destHeight = 0
    state = SourceState.IDLE
  }

  override fun setPcmDeliveryEnabled(enabled: Boolean) {
    pcmEnabled.set(enabled)
  }

  override fun setTargetSize(size: TargetSize?) {
    targetSize.set(size)
  }

  internal fun pcmDeliveryEnabled(): Boolean = pcmEnabled.get()

  /**
   * Generate-and-emit one frame if the sender is ready and a target size exists.
   * Returns true only when a frame was handed to [video].
   */
  internal fun emitOnce(): Boolean {
    if (state != SourceState.LIVE) return false
    val size = targetSize.get()
    val ready = isReady() && size != null
    if (!ready) {
      withheld.incrementAndGet()
      withheldThisGap.incrementAndGet()
      if (emitting.compareAndSet(true, false)) {
        logEvent("P6 synthetic paused reason=not-ready afterFrames=${emitted.get()}")
      }
      return false
    }
    val gap = withheldThisGap.getAndSet(0)
    if (!emitting.get() && emitted.get() > 0) {
      logEvent("P6 synthetic resumed withheld=$gap")
    }
    emitting.set(true)

    val w = size!!.width
    val h = size.height
    val buffer = ensureDest(w, h)
    val index = frameIndex.getAndIncrement()
    stampFps = sampleStampFps()
    factory.write(buffer, w, h, index, stampFps)
    val packStart = System.nanoTime()
    buffer.rewind()
    stats.pack.record(System.nanoTime() - packStart)
    stats.onSink()
    stats.recordGap()
    stats.setSize(w, h)
    video.onVideoFrame(buffer, w, h, System.nanoTime())
    val count = emitted.incrementAndGet()
    if (firstLogged.compareAndSet(false, true)) {
      logEvent(
        "P6 synthetic first-frame withheld=${withheld.get()} size=${w}x${h} " +
          "fps=${config.fps} entropy=${config.entropy}",
      )
    }
    return count > 0
  }

  /** 1-second emit rate, same window Recall uses for the P column on the stamp. */
  private fun sampleStampFps(): Double? {
    val now = System.nanoTime()
    val started = fpsWindowStartNs.get()
    if (started == 0L) {
      fpsWindowStartNs.set(now)
      fpsWindowCount.set(1)
      return stampFps
    }
    fpsWindowCount.incrementAndGet()
    val elapsedNs = now - started
    if (elapsedNs >= 1_000_000_000L) {
      val rate = fpsWindowCount.get() * 1_000_000_000.0 / elapsedNs
      fpsWindowCount.set(0)
      fpsWindowStartNs.set(now)
      return rate
    }
    return stampFps
  }

  private fun ensureDest(width: Int, height: Int): ByteBuffer {
    val needed = I420Packer.packedSize(width, height)
    val existing = dest
    if (existing != null && destWidth == width && destHeight == height && existing.capacity() >= needed) {
      existing.clear()
      return existing
    }
    val next = ByteBuffer.allocateDirect(needed)
    dest = next
    destWidth = width
    destHeight = height
    return next
  }

  private fun logEvent(line: String) {
    synchronized(events) { events.add(line) }
    try {
      Log.i(TAG, line)
    } catch (_: Throwable) {
    }
  }

  companion object {
    private const val TAG = "ACS-SPIKE"
  }
}
