package com.mentra.glassesmedia.publisher

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertArrayEquals
import org.junit.Test

class RelayPcmBufferTest {
  private fun pcm(vararg values: Int): ByteArray = ByteBuffer.allocate(values.size * 2).order(ByteOrder.LITTLE_ENDIAN).apply {
    values.forEach { putShort(it.toShort()) }
  }.array()
  private fun read(buffer: RelayPcmBuffer, count: Int): ShortArray {
    val out = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN)
    buffer.read(out, out.capacity())
    return ShortArray(count) { out.getShort(it * 2) }
  }
  @Test fun `stereo is downmixed and underflow is silence`() {
    val buffer = RelayPcmBuffer()
    buffer.push(pcm(1000, 3000, -1000, 1000, 2000, 2000), 48000, 2)
    assertArrayEquals(shortArrayOf(2000, 0, 0, 0), read(buffer, 4))
  }
  @Test fun `resampling is continuous across packet boundaries`() {
    val single = RelayPcmBuffer()
    val split = RelayPcmBuffer()
    single.push(pcm(0, 300, 600, 900), 16000, 1)
    split.push(pcm(0, 300), 16000, 1)
    split.push(pcm(600, 900), 16000, 1)
    assertArrayEquals(read(single, 12), read(split, 12))
  }
  @Test fun `overrun drops oldest samples and bounds latency`() {
    val buffer = RelayPcmBuffer(3)
    buffer.push(pcm(1, 2, 3, 4, 5, 6), 48000, 1)
    assertArrayEquals(shortArrayOf(3, 4, 5, 0), read(buffer, 4))
  }
}
