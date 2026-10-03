package com.mentra.glassesmedia.publisher

import org.junit.Assert.*
import org.junit.Test

class RelayPcmInputTest {
  @Test fun `late PCM cannot enter a replacement publisher or a stopped session`() {
    val input = RelayPcmInput()
    val frames = mutableListOf<String>()
    val pcm = byteArrayOf(1, 2)
    assertFalse(input.push("first", pcm, 16_000, 1))
    input.attach("first") { bytes, rate, channels ->
      assertArrayEquals(pcm, bytes)
      assertEquals(16_000, rate)
      assertEquals(1, channels)
      frames.add("first")
    }
    assertTrue(input.push("first", pcm, 16_000, 1))
    input.detach()
    assertFalse(input.push("first", pcm, 16_000, 1))
    input.attach("second") { _, _, _ -> frames.add("second") }
    assertFalse(input.push("first", pcm, 16_000, 1))
    assertTrue(input.push("second", pcm, 16_000, 1))
    assertEquals(listOf("first", "second"), frames)
  }

  @Test fun `invalid PCM formats never reach the publisher`() {
    val input = RelayPcmInput()
    input.attach("live") { _, _, _ -> fail("Invalid PCM was forwarded") }
    assertFalse(input.push("live", byteArrayOf(), 16_000, 1))
    assertFalse(input.push("live", byteArrayOf(1, 2), 0, 1))
    assertFalse(input.push("live", byteArrayOf(1, 2), 16_000, 0))
  }
}
