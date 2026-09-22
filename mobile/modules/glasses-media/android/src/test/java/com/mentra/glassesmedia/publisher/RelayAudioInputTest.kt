package com.mentra.glassesmedia.publisher

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.*
import org.junit.Test

class RelayAudioInputTest {
  private class Fixture {
    var now = 1_000_000_000L
    val sleeps = mutableListOf<Long>()
    val pcm = RelayPcmBuffer()
    val input = RelayAudioInput(pcm, { now }, { sleeps.add(it); now += it })
    val output = ByteBuffer.allocateDirect(960).order(ByteOrder.LITTLE_ENDIAN)
    fun read() = input.read(output, 1, 48_000)
  }

  @Test fun `external callbacks supply ten milliseconds of audio at real-time cadence`() {
    val f = Fixture()
    val samples = ByteBuffer.allocate(962).order(ByteOrder.LITTLE_ENDIAN)
    repeat(481) { samples.putShort(1234) }
    f.pcm.push(samples.array(), 48_000, 1)

    val first = f.read()
    repeat(480) { assertEquals(1234, f.output.getShort(it * 2).toInt()) }
    repeat(99) { f.read() }

    assertEquals(990_000_000L, f.now - first)
    assertEquals(99, f.sleeps.size)
    assertTrue(f.sleeps.all { it == 10_000_000L })
    repeat(480) { assertEquals(0, f.output.getShort(it * 2).toInt()) }
  }

  @Test fun `a stalled callback resumes without flooding native audio with catch-up frames`() {
    val f = Fixture()
    f.read()
    f.now += 500_000_000L
    val resumed = f.read()
    assertEquals(resumed + 10_000_000L, f.read())
    assertEquals(listOf(10_000_000L), f.sleeps)
  }

  @Test fun `an early wake waits for the remaining frame interval`() {
    var now = 0L
    var wakes = 0
    val input = RelayAudioInput(RelayPcmBuffer(), { now }, {
      now += minOf(it, 5_000_000L)
      wakes++
    })
    val output = ByteBuffer.allocate(960)
    input.read(output, 1, 48_000)
    assertEquals(10_000_000L, input.read(output, 1, 48_000))
    assertEquals(2, wakes)
  }

  @Test fun `unexpected audio format is paced and fully silenced`() {
    val f = Fixture()
    val output = ByteBuffer.allocate(1764)
    repeat(output.capacity()) { output.put(it, 127) }
    val first = f.input.read(output, 2, 44_100)
    assertEquals(first + 10_000_000L, f.input.read(output, 2, 44_100))
    repeat(output.capacity()) { assertEquals(0, output.get(it).toInt()) }
  }
}
