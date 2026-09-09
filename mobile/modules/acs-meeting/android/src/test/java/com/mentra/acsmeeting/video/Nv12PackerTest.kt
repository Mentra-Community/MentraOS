package com.mentra.acsmeeting.video

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import java.nio.ByteBuffer

class Nv12PackerTest {
  @Test
  fun strideUvIsTwiceChromaWidth() {
    assertThat(Nv12Packer.strideUv(1280)).isEqualTo(1280)
    assertThat(Nv12Packer.strideUv(3)).isEqualTo(4)
    assertThat(Nv12Packer.uvSize(1280, 720)).isEqualTo(1280 * 360)
    assertThat(Nv12Packer.packedSize(1280, 720)).isEqualTo(1280 * 720 * 3 / 2)
  }

  @Test
  fun interleaveWritesUvPairsFromPaddedPlanes() {
    val width = 4
    val height = 4
    val chromaW = 2
    val chromaH = 2
    val u = ByteBuffer.allocate(4 * 2)
    val v = ByteBuffer.allocate(4 * 2)
    // visible U: 10 11 / 12 13   V: 20 21 / 22 23, stride 4
    u.put(0, 10); u.put(1, 11); u.put(4, 12); u.put(5, 13)
    v.put(0, 20); v.put(1, 21); v.put(4, 22); v.put(5, 23)
    val dest = ByteBuffer.allocate(Nv12Packer.uvSize(width, height))
    Nv12Packer.interleaveUv(u, 4, v, 4, chromaW, chromaH, dest)
    dest.flip()
    val out = ByteArray(dest.remaining())
    dest.get(out)
    assertThat(out).containsExactly(10, 20, 11, 21, 12, 22, 13, 23)
  }

  @Test
  fun copyYThenInterleaveMatchesPackedNv12() {
    val width = 4
    val height = 2
    val y = ByteBuffer.allocate(width * height)
    repeat(width * height) { y.put(it, (40 + it).toByte()) }
    val u = ByteBuffer.allocate(2)
    val v = ByteBuffer.allocate(2)
    u.put(0, 80); u.put(1, 81)
    v.put(0, 90); v.put(1, 91)
    val destY = ByteBuffer.allocate(width * height)
    val destUv = ByteBuffer.allocate(Nv12Packer.uvSize(width, height))
    Nv12Packer.copyY(y, width, width, height, destY)
    Nv12Packer.interleaveUv(u, 2, v, 2, 2, 1, destUv)
    destY.flip()
    destUv.flip()
    val yOut = ByteArray(destY.remaining())
    val uvOut = ByteArray(destUv.remaining())
    destY.get(yOut)
    destUv.get(uvOut)
    assertThat(yOut).containsExactly(40, 41, 42, 43, 44, 45, 46, 47)
    assertThat(uvOut).containsExactly(80, 90, 81, 91)
  }
}
