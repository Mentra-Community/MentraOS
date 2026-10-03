package com.mentra.glassesmedia.publisher

import java.nio.ByteBuffer
import java.util.concurrent.TimeUnit

/** Supplies the clock normally provided by a blocking AudioRecord.read, without using the mic. */
class RelayAudioInput(
  private val pcm: RelayPcmBuffer,
  private val nowNs: () -> Long = System::nanoTime,
  private val sleepNs: (Long) -> Unit = { TimeUnit.NANOSECONDS.sleep(it) },
) {
  private var nextFrameAtNs: Long? = null

  /** Called only by WebRTC's audio recording thread, with a complete PCM16 frame to fill. */
  fun read(buffer: ByteBuffer, channels: Int, sampleRate: Int): Long {
    require(channels > 0 && sampleRate > 0 && buffer.capacity() >= channels * 2)
    val durationNs = (buffer.capacity() / (channels * 2)).toLong() * 1_000_000_000L / sampleRate
    val deadline = nextFrameAtNs ?: nowNs()
    var now = nowNs()
    while (now < deadline) {
      sleepNs(deadline - now)
      now = nowNs()
    }
    // Preserve cadence across small scheduling delays, but never replay a backlog after a stall.
    nextFrameAtNs = if (now - deadline >= durationNs) now + durationNs else deadline + durationNs

    // External-recording mode reports bytesRead=0, then sends buffer.capacity() bytes to native.
    // Fill that entire frame; using bytesRead would send only the library's prefilled silence.
    if (channels == 1 && sampleRate == 48_000) pcm.read(buffer, buffer.capacity())
    else for (i in 0 until buffer.capacity()) buffer.put(i, 0)
    return now
  }
}
