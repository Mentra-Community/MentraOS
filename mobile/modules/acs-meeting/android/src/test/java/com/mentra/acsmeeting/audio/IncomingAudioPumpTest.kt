package com.mentra.acsmeeting.audio

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class IncomingAudioPumpTest {
  private fun silence(ms: Int, rate: Int, channels: Int = 1) = ByteArray(rate * channels * 2 * ms / 1000)

  @Test
  fun bytesForMatches16kMono() {
    assertThat(IncomingAudioPump.bytesFor(20)).isEqualTo(640)
    assertThat(IncomingAudioPump.bytesFor(60)).isEqualTo(1920)
    assertThat(IncomingAudioPump.bytesFor(120)).isEqualTo(3840)
  }

  @Test
  fun holdsPrerollThenEmitsBatches() {
    val emitted = mutableListOf<ByteArray>()
    val pump = IncomingAudioPump(prerollMs = 120, batchMs = 60) { emitted.add(it) }

    // Five 20 ms ACS callbacks = 100 ms: below the 120 ms preroll.
    repeat(5) { pump.push(silence(20, 16_000), 16_000, 1) }
    assertThat(emitted).isEmpty()

    pump.push(silence(20, 16_000), 16_000, 1)
    assertThat(emitted).hasSize(2)
    assertThat(emitted.all { it.size == IncomingAudioPump.bytesFor(60) }).isTrue()

    // Steady state: one 60 ms batch per three callbacks.
    repeat(2) { pump.push(silence(20, 16_000), 16_000, 1) }
    assertThat(emitted).hasSize(2)
    pump.push(silence(20, 16_000), 16_000, 1)
    assertThat(emitted).hasSize(3)
  }

  @Test
  fun normalizes48kStereoTo16kMono() {
    val emitted = mutableListOf<ByteArray>()
    val pump = IncomingAudioPump(prerollMs = 0, batchMs = 20) { emitted.add(it) }
    // 200 ms of 48 kHz stereo (as ACS would deliver if it ignored our 16 kHz request).
    repeat(10) { pump.push(silence(20, 48_000, channels = 2), 48_000, 2) }
    val total = emitted.sumOf { it.size }
    // 200 ms at 16 kHz mono = 6400 bytes, minus FIR warm-up and one held batch.
    assertThat(total).isBetween(IncomingAudioPump.bytesFor(140), IncomingAudioPump.bytesFor(200))
    assertThat(pump.format).isEqualTo(IncomingAudioPump.Format(48_000, 2))
    assertThat(pump.formatChanges).isEqualTo(0)
  }

  @Test
  fun flushEmitsTailAndRearmsPreroll() {
    val emitted = mutableListOf<ByteArray>()
    val pump = IncomingAudioPump(prerollMs = 120, batchMs = 60) { emitted.add(it) }
    pump.push(silence(20, 16_000), 16_000, 1)
    pump.flush()
    assertThat(emitted).hasSize(1)
    assertThat(emitted[0].size).isEqualTo(IncomingAudioPump.bytesFor(20))

    repeat(5) { pump.push(silence(20, 16_000), 16_000, 1) }
    assertThat(emitted).hasSize(1)
  }

  @Test
  fun countsFormatChanges() {
    val pump = IncomingAudioPump(prerollMs = 0, batchMs = 20) {}
    pump.push(silence(20, 16_000), 16_000, 1)
    pump.push(silence(20, 48_000), 48_000, 1)
    assertThat(pump.formatChanges).isEqualTo(1)
    assertThat(pump.eventsIn).isEqualTo(2)
  }
}
