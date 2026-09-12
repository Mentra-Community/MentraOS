package com.mentra.glassesmedia.publisher

import java.nio.ByteBuffer

/** Bounded 200ms mono PCM queue. Downmix/resample decoded audio to WebRTC's 48kHz clock. */
class RelayPcmBuffer(private val capacity: Int = 9_600) {
  private val samples = ShortArray(capacity)
  private var head = 0
  private var count = 0
  private var phase = 0.0
  private var rate = 0
  private var channels = 0
  private var previous: Double? = null

  @Synchronized fun push(bytes: ByteArray, sampleRate: Int, channelCount: Int) {
    if (sampleRate !in 8_000..192_000 || channelCount !in 1..8) return
    if (rate != sampleRate || channels != channelCount) {
      rate = sampleRate; channels = channelCount; phase = 0.0; previous = null
    }
    val step = sampleRate / 48_000.0
    for (frame in 0 until bytes.size / (2 * channelCount)) {
      var sum = 0.0
      for (channel in 0 until channelCount) {
        val offset = (frame * channelCount + channel) * 2
        sum += ((bytes[offset].toInt() and 255) or (bytes[offset + 1].toInt() shl 8)).toShort()
      }
      val value = sum / channelCount
      val prior = previous
      if (prior != null) {
        while (phase < 1.0) {
          append((prior + (value - prior) * phase).toInt().toShort())
          phase += step
        }
        phase -= 1.0
      }
      previous = value
    }
  }

  private fun append(value: Short) {
    if (count == capacity) { head = (head + 1) % capacity; count-- }
    samples[(head + count) % capacity] = value
    count++
  }

  /** Always fills the requested buffer. Underruns are silence, never stale microphone data. */
  @Synchronized fun read(output: ByteBuffer, byteCount: Int) {
    for (offset in 0 until minOf(byteCount, output.capacity()) step 2) {
      val value = if (count > 0) samples[head].also { head = (head + 1) % capacity; count-- } else 0
      output.put(offset, (value.toInt() and 255).toByte())
      if (offset + 1 < output.capacity()) output.put(offset + 1, (value.toInt() shr 8).toByte())
    }
  }
}
