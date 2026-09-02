package com.mentra.acsmeeting.audio

import java.io.ByteArrayOutputStream

/**
 * ACS mixed-audio buffers → fixed-format chunks for the host PCM player.
 *
 * - Normalizes to [OUT_RATE] Hz mono regardless of what ACS actually
 *   delivers. The requested RawIncomingAudioStreamProperties are a hint;
 *   the event carries the real format, and playing 48 kHz data on a 16 kHz
 *   AudioTrack is exactly the "slow, low-pitched" symptom.
 * - Pre-rolls [prerollMs] before the first emit and then emits in
 *   [batchMs] chunks, so the player always has headroom over bridge jitter
 *   instead of underrunning between 20 ms callbacks.
 *
 * Not thread-safe: ACS delivers mixed audio from a single thread.
 */
class IncomingAudioPump(
  private val prerollMs: Int = DEFAULT_PREROLL_MS,
  private val batchMs: Int = DEFAULT_BATCH_MS,
  private val emit: (pcm16Le: ByteArray) -> Unit,
) {
  data class Format(val sampleRate: Int, val channels: Int)

  private val resampler = PcmResampler(OUT_RATE)
  private val pending = ByteArrayOutputStream()
  private var primed = false

  var format: Format? = null
    private set
  var formatChanges = 0
    private set
  var eventsIn = 0L
    private set
  var bytesIn = 0L
    private set
  var bytesOut = 0L
    private set

  fun push(pcm16Le: ByteArray, sampleRate: Int, channels: Int) {
    if (pcm16Le.isEmpty()) return
    val next = Format(sampleRate, channels)
    if (format != next) {
      if (format != null) formatChanges += 1
      format = next
    }
    eventsIn += 1
    bytesIn += pcm16Le.size
    val normalized = resampler.process(pcm16Le, sampleRate, channels)
    pending.write(normalized)
    drain(force = false)
  }

  /** Emit whatever is buffered (call on stop so the tail is not lost). */
  fun flush() {
    drain(force = true)
    primed = false
  }

  fun reset() {
    pending.reset()
    primed = false
    resampler.reset()
    format = null
  }

  private fun drain(force: Boolean) {
    val threshold = if (primed) bytesFor(batchMs) else bytesFor(prerollMs)
    if (pending.size() == 0) return
    if (!force && pending.size() < threshold) return
    val all = pending.toByteArray()
    pending.reset()
    // Chunk on batch boundaries so the player queue sees a steady cadence;
    // the remainder waits for the next callback unless flushing.
    val batch = bytesFor(batchMs)
    var offset = 0
    while (all.size - offset >= batch) {
      emitChunk(all.copyOfRange(offset, offset + batch))
      offset += batch
    }
    if (offset < all.size) {
      if (force) emitChunk(all.copyOfRange(offset, all.size)) else pending.write(all, offset, all.size - offset)
    }
    primed = true
  }

  private fun emitChunk(chunk: ByteArray) {
    bytesOut += chunk.size
    emit(chunk)
  }

  companion object {
    const val OUT_RATE = 16_000
    const val OUT_CHANNELS = 1
    const val DEFAULT_PREROLL_MS = 120
    const val DEFAULT_BATCH_MS = 60

    fun bytesFor(ms: Int): Int = OUT_RATE * OUT_CHANNELS * 2 * ms / 1000
  }
}
