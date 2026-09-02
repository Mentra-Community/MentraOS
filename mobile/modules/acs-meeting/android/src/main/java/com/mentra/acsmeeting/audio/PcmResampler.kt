package com.mentra.acsmeeting.audio

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Stateful PCM16 downmix + sample-rate converter.
 *
 * Both call directions cross a rate boundary (WHEP Opus decodes at 48 kHz,
 * ACS raw audio is 16 kHz). Picking every third sample without a low-pass
 * filter folds everything above 8 kHz back into the speech band, which is
 * audible as the hiss/crackle on the far end. This filters first (windowed
 * sinc at the input rate, cutoff just under the output Nyquist) and keeps
 * filter history plus the fractional phase across calls, so chunked input
 * produces the same samples as one contiguous buffer.
 */
class PcmResampler(
  private val targetRate: Int,
) {
  private var inRate = 0
  private var inChannels = 0
  private var taps = FloatArray(0)
  /** Raw (unfiltered) input tail so the FIR sees taps.size - 1 samples of context. */
  private var rawTail = FloatArray(0)
  /** Filtered samples not yet consumed by the interpolator. */
  private var history = FloatArray(0)
  /** Position of the next output sample, in input-sample units, relative to the start of [history]. */
  private var phase = 0.0

  fun reset() {
    inRate = 0
    inChannels = 0
    taps = FloatArray(0)
    rawTail = FloatArray(0)
    history = FloatArray(0)
    phase = 0.0
  }

  fun process(pcm16Le: ByteArray, sampleRate: Int, channels: Int): ByteArray {
    require(sampleRate > 0) { "sampleRate must be positive" }
    require(channels > 0) { "channels must be positive" }
    if (sampleRate != inRate || channels != inChannels) configure(sampleRate, channels)

    val mono = downmix(pcm16Le, channels)
    if (sampleRate == targetRate) return toBytes(mono)

    // Filtered input signal = history tail + newly filtered samples. The
    // history keeps taps.size - 1 raw samples so the FIR has full context,
    // plus one filtered sample so linear interpolation can straddle the seam.
    val filtered = if (taps.isEmpty()) mono else lowPass(mono)
    val signal = FloatArray(history.size + filtered.size)
    System.arraycopy(history, 0, signal, 0, history.size)
    System.arraycopy(filtered, 0, signal, history.size, filtered.size)

    val step = sampleRate.toDouble() / targetRate
    val capacity = maxOf(0, ((signal.size - phase) / step).toInt() + 2)
    val out = ShortArray(capacity)
    var count = 0
    var pos = phase
    while (pos + 1 < signal.size) {
      val i = pos.toInt()
      val frac = (pos - i).toFloat()
      val sample = signal[i] + (signal[i + 1] - signal[i]) * frac
      out[count++] = clamp(sample)
      pos += step
    }
    // Keep everything from the next output position onward so the seam interpolates.
    val keepFrom = maxOf(0, minOf(pos.toInt(), signal.size - 1))
    history = signal.copyOfRange(keepFrom, signal.size)
    phase = pos - keepFrom

    val result = ByteArray(count * 2)
    val bb = ByteBuffer.wrap(result).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until count) bb.putShort(out[i])
    return result
  }

  private fun configure(sampleRate: Int, channels: Int) {
    inRate = sampleRate
    inChannels = channels
    history = FloatArray(0)
    rawTail = FloatArray(0)
    phase = 0.0
    taps = if (sampleRate > targetRate) designLowPass(sampleRate, targetRate) else FloatArray(0)
  }

  private fun lowPass(mono: FloatArray): FloatArray {
    val n = taps.size
    val input = FloatArray(rawTail.size + mono.size)
    System.arraycopy(rawTail, 0, input, 0, rawTail.size)
    System.arraycopy(mono, 0, input, rawTail.size, mono.size)
    val outCount = input.size - (n - 1)
    if (outCount <= 0) {
      rawTail = input
      return FloatArray(0)
    }
    val out = FloatArray(outCount)
    for (i in 0 until outCount) {
      var acc = 0f
      for (k in 0 until n) acc += input[i + k] * taps[k]
      out[i] = acc
    }
    rawTail = input.copyOfRange(input.size - (n - 1), input.size)
    return out
  }

  companion object {
    /** Odd tap count keeps the group delay an integer number of samples. */
    private const val TAPS = 63

    fun designLowPass(sampleRate: Int, targetRate: Int): FloatArray {
      // Cutoff at 90% of the output Nyquist: full speech band through, the
      // transition band finished before anything can alias.
      val cutoff = 0.45 * targetRate / sampleRate
      val m = (TAPS - 1) / 2
      val taps = FloatArray(TAPS)
      var sum = 0.0
      for (i in 0 until TAPS) {
        val x = (i - m).toDouble()
        val sinc = if (x == 0.0) 2 * cutoff else sin(2 * PI * cutoff * x) / (PI * x)
        val window = 0.54 - 0.46 * cos(2 * PI * i / (TAPS - 1))
        val h = sinc * window
        taps[i] = h.toFloat()
        sum += h
      }
      for (i in 0 until TAPS) taps[i] = (taps[i] / sum).toFloat()
      return taps
    }

    fun downmix(pcm16Le: ByteArray, channels: Int): FloatArray {
      val frames = pcm16Le.size / (2 * channels)
      val shorts = ByteBuffer.wrap(pcm16Le, 0, frames * 2 * channels).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
      val mono = FloatArray(frames)
      if (channels == 1) {
        for (i in 0 until frames) mono[i] = shorts.get(i).toFloat()
      } else {
        for (i in 0 until frames) {
          var acc = 0f
          for (c in 0 until channels) acc += shorts.get(i * channels + c)
          mono[i] = acc / channels
        }
      }
      return mono
    }

    private fun clamp(v: Float): Short = v.roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()

    private fun toBytes(mono: FloatArray): ByteArray {
      val out = ByteArray(mono.size * 2)
      val bb = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
      for (v in mono) bb.putShort(clamp(v))
      return out
    }
  }
}
