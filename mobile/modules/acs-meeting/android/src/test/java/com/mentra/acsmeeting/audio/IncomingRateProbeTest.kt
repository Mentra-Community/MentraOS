package com.mentra.acsmeeting.audio

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class IncomingRateProbeTest {
  @Test
  fun measuresTrueRateFromElapsedTimeNotAssumedCadence() {
    val probe = IncomingRateProbe()
    var now = 0L
    var reading: IncomingRateProbe.Reading? = null

    // 16 kHz mono, 320 samples every 20 ms, for slightly over a second.
    repeat(52) {
      reading = probe.record(now, bytes = 640, sampleRate = 16_000, channels = 1) ?: reading
      now += 20_000_000L
    }

    val result = requireNotNull(reading)
    assertThat(result.declaredRate).isEqualTo(16_000)
    assertThat(result.samplesPerCallback).isEqualTo(320)
    assertThat(result.callbackHz).isBetween(49.5, 50.5)
    assertThat(result.measuredRate).isBetween(15_900.0, 16_100.0)
    assertThat(result.events).isEqualTo(50L)
  }

  @Test
  fun mislabeledRateShowsAsMeasuredDisagreeingWithDeclared() {
    val probe = IncomingRateProbe()
    var now = 0L
    var reading: IncomingRateProbe.Reading? = null

    // ACS declares 16 kHz but hands over 48 kHz worth of samples per 20 ms.
    repeat(52) {
      reading = probe.record(now, bytes = 1920, sampleRate = 16_000, channels = 1) ?: reading
      now += 20_000_000L
    }

    val result = requireNotNull(reading)
    assertThat(result.declaredRate).isEqualTo(16_000)
    assertThat(result.measuredRate).isBetween(47_500.0, 48_500.0)
  }

  @Test
  fun halfRateCadenceShowsInCallbackHz() {
    val probe = IncomingRateProbe()
    var now = 0L
    var reading: IncomingRateProbe.Reading? = null

    // One 40 ms callback instead of two 20 ms ones: same rate, half the Hz.
    repeat(27) {
      reading = probe.record(now, bytes = 1280, sampleRate = 16_000, channels = 1) ?: reading
      now += 40_000_000L
    }

    val result = requireNotNull(reading)
    assertThat(result.samplesPerCallback).isEqualTo(640)
    assertThat(result.callbackHz).isBetween(24.5, 25.5)
    assertThat(result.measuredRate).isBetween(15_900.0, 16_100.0)
  }

  @Test
  fun stereoCountsSamplesPerChannel() {
    val probe = IncomingRateProbe()
    probe.record(0, bytes = 1920, sampleRate = 48_000, channels = 2)
    val reading = probe.record(1_000_000_000L, bytes = 1920, sampleRate = 48_000, channels = 2)

    assertThat(requireNotNull(reading).samplesPerCallback).isEqualTo(480)
  }

  @Test
  fun resetReopensTheWindow() {
    val probe = IncomingRateProbe()
    probe.record(0, bytes = 640, sampleRate = 16_000, channels = 1)
    probe.reset()
    assertThat(probe.record(2_000_000_000L, bytes = 640, sampleRate = 16_000, channels = 1)).isNull()
  }
}
