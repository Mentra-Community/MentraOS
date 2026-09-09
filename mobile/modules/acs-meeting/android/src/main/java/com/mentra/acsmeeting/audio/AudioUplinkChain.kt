package com.mentra.acsmeeting.audio

/**
 * Everything between "a microphone buffer arrived" and "the pacer has it", behind one lock.
 *
 * The lock is the point. Muting an audio path is not one flag: the wearer's voice is spread across
 * a delay ring, a resampler's filter history, a partial 20 ms frame, and the pacer's ring, and
 * clearing them one at a time leaves whichever stage the producer thread happened to be writing to.
 * Serializing ingest against mute is what makes "mute" mean the same thing at every stage.
 *
 * It cannot make mute instantaneous at the far end. Buffers already handed to ACS cannot be
 * recalled, so the residual tail is bounded by [UplinkSender.MAX_IN_FLIGHT] frames and measured
 * rather than assumed — see the sender's `muteTailMs`.
 *
 * @param bridge downmix/resample to the 48 kHz mono 20 ms frames ACS wants
 * @param pacer the clock-domain adapter the sender drains
 * @param delayMs how long to hold input before the bridge, for A/V alignment (0 = passthrough)
 */
class AudioUplinkChain(
  private val bridge: PcmBridge,
  private val pacer: UplinkPacer,
  private val delayMs: Int = 0,
  private val clock: () -> Long = System::nanoTime,
) {
  private val lock = Any()
  private val delay = DelayLine(delayMs.coerceIn(0, MAX_DELAY_MS))
  @Volatile private var muted = false

  /**
   * Accept one microphone buffer. A no-op while muted, so muted audio never enters any stage and
   * an unmute cannot resurrect words the wearer said while muted.
   */
  fun ingest(pcm: ByteArray, sampleRate: Int, channels: Int) {
    synchronized(lock) {
      if (muted) return
      for (chunk in delay.push(pcm, clock())) {
        for (frame in bridge.ingest(chunk, sampleRate, channels)) pacer.push(frame)
      }
    }
  }

  /** Stop accepting audio and drop everything already buffered, atomically against [ingest]. */
  fun mute() {
    synchronized(lock) {
      muted = true
      resetLocked()
    }
  }

  /** Accept audio again. The pacer re-prerolls, so Teams hears voice one preroll later. */
  fun unmute() {
    synchronized(lock) { muted = false }
  }

  fun isMuted(): Boolean = muted

  /** Drop buffered audio without changing the mute state. For leave and source rebuilds. */
  fun reset() {
    synchronized(lock) { resetLocked() }
  }

  /** Buffered input held for A/V alignment, in bytes. Diagnostics and tests. */
  fun delayedBytes(): Int = synchronized(lock) { delay.heldBytes() }

  private fun resetLocked() {
    delay.reset()
    bridge.reset()
    pacer.reset()
  }

  /**
   * Holds input until it is [delayMs] old.
   *
   * In front of the resampler rather than behind it so the delay is expressed in the input's own
   * arrival times, which is what a receiver-side A/V measurement calibrates against.
   */
  private class DelayLine(private val delayMs: Int) {
    private class Chunk(val bytes: ByteArray, val atNanos: Long)

    private val queue = ArrayDeque<Chunk>()
    private var bytesHeld = 0

    fun push(pcm: ByteArray, nowNanos: Long): List<ByteArray> {
      if (delayMs <= 0) return listOf(pcm)
      queue.addLast(Chunk(pcm, nowNanos))
      bytesHeld += pcm.size
      val threshold = delayMs * 1_000_000L
      val released = mutableListOf<ByteArray>()
      while (queue.isNotEmpty()) {
        val head = queue.first()
        if (nowNanos - head.atNanos < threshold) break
        queue.removeFirst()
        bytesHeld -= head.bytes.size
        released.add(head.bytes)
      }
      // Age alone bounds this in normal operation. The cap is for the case it cannot see: a clock
      // that does not advance would otherwise turn a held buffer into an unbounded one.
      val cap = delayMs * MAX_BYTES_PER_MS
      while (bytesHeld > cap && queue.isNotEmpty()) {
        val dropped = queue.removeFirst()
        bytesHeld -= dropped.bytes.size
        released.add(dropped.bytes)
      }
      return released
    }

    fun reset() {
      queue.clear()
      bytesHeld = 0
    }

    fun heldBytes(): Int = bytesHeld
  }

  companion object {
    /** Half a second is already unusable as conversation; past that it is a bug, not a setting. */
    const val MAX_DELAY_MS = 500

    /** 48 kHz stereo PCM16, the widest input the bridge accepts. Sizes the safety cap only. */
    internal const val MAX_BYTES_PER_MS = 48_000 * 2 * 2 / 1000
  }
}
