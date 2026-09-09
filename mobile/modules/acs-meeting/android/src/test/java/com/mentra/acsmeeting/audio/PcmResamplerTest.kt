package com.mentra.acsmeeting.audio

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.sqrt

class PcmResamplerTest {
  private fun tone(rate: Int, hz: Double, seconds: Double, amplitude: Double = 8000.0, channels: Int = 1): ByteArray {
    val frames = (rate * seconds).toInt()
    val out = ByteArray(frames * channels * 2)
    val bb = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until frames) {
      val s = (amplitude * sin(2 * PI * hz * i / rate)).toInt().toShort()
      for (c in 0 until channels) bb.putShort(s)
    }
    return out
  }

  private fun shorts(pcm: ByteArray): ShortArray {
    val s = ShortArray(pcm.size / 2)
    ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(s)
    return s
  }

  private fun rms(s: ShortArray, from: Int = 0): Double {
    var acc = 0.0
    for (i in from until s.size) acc += s[i].toDouble() * s[i]
    return sqrt(acc / (s.size - from))
  }

  private fun zeroCrossings(s: ShortArray, from: Int = 0): Int {
    var n = 0
    for (i in from + 1 until s.size) if ((s[i - 1] < 0) != (s[i] < 0)) n++
    return n
  }

  @Test
  fun passthroughAt16kMonoIsByteExact() {
    val input = tone(16_000, 440.0, 0.1)
    val out = PcmResampler(16_000).process(input, 16_000, 1)
    assertThat(out).isEqualTo(input)
  }

  @Test
  fun stereoDownmixAveragesChannels() {
    val frames = 100
    val input = ByteArray(frames * 4)
    val bb = ByteBuffer.wrap(input).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until frames) {
      bb.putShort(1000)
      bb.putShort(-1000)
    }
    val out = shorts(PcmResampler(16_000).process(input, 16_000, 2))
    assertThat(out).hasSize(frames)
    assertThat(out.all { it == 0.toShort() }).isTrue()
  }

  @Test
  fun downsamples48kTo16kPreservingSpeechBandTone() {
    val input = tone(48_000, 1000.0, 1.0)
    val out = shorts(PcmResampler(16_000).process(input, 48_000, 1))
    // 1 s at 16 kHz minus FIR warm-up (62 input samples ≈ 20 output samples).
    assertThat(out.size).isBetween(16_000 - 30, 16_000)
    val settle = 200
    assertThat(rms(out, settle)).isBetween(8000 / sqrt(2.0) * 0.97, 8000 / sqrt(2.0) * 1.03)
    // 1 kHz tone: 2000 zero crossings per second.
    val seconds = (out.size - settle) / 16_000.0
    assertThat(zeroCrossings(out, settle) / seconds).isBetween(1990.0, 2010.0)
  }

  @Test
  fun downsamplingRejectsContentAboveOutputNyquist() {
    // 20 kHz at 48 kHz would alias to 4 kHz at full amplitude with plain decimation.
    val input = tone(48_000, 20_000.0, 1.0)
    val out = shorts(PcmResampler(16_000).process(input, 48_000, 1))
    assertThat(rms(out, 200)).isLessThan(8000 / sqrt(2.0) * 0.02)
  }

  @Test
  fun chunkedInputMatchesContiguousInput() {
    val input = tone(48_000, 700.0, 0.5)
    val whole = shorts(PcmResampler(16_000).process(input, 48_000, 1))

    val chunked = PcmResampler(16_000)
    val pieces = ArrayList<Short>()
    var offset = 0
    val chunk = 960 // 10 ms at 48 kHz, WebRTC's callback size
    while (offset < input.size) {
      val end = minOf(input.size, offset + chunk)
      pieces.addAll(shorts(chunked.process(input.copyOfRange(offset, end), 48_000, 1)).toList())
      offset = end
    }
    assertThat(pieces.size).isEqualTo(whole.size)
    for (i in whole.indices) {
      assertThat(pieces[i].toInt()).isCloseTo(whole[i].toInt(), org.assertj.core.data.Offset.offset(1))
    }
  }

  @Test
  fun upsamplesWithoutFilterAndKeepsLength() {
    val input = tone(8_000, 400.0, 0.5)
    val out = shorts(PcmResampler(16_000).process(input, 8_000, 1))
    assertThat(out.size).isBetween(8_000 - 4, 8_000)
    assertThat(rms(out, 50)).isBetween(8000 / sqrt(2.0) * 0.95, 8000 / sqrt(2.0) * 1.03)
  }

  @Test
  fun formatChangeResetsStateAndKeepsGoing() {
    val r = PcmResampler(16_000)
    r.process(tone(48_000, 1000.0, 0.1), 48_000, 1)
    val out = shorts(r.process(tone(16_000, 1000.0, 0.1), 16_000, 1))
    assertThat(out.size).isEqualTo(1600)
  }

  @Test
  fun lowPassTapsAreUnityGainAtDc() {
    val taps = PcmResampler.designLowPass(48_000, 16_000)
    assertThat(taps.sum().toDouble()).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-4))
    assertThat(taps.size % 2).isEqualTo(1)
  }
}
