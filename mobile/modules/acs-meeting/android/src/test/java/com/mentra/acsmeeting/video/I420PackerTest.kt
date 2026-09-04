package com.mentra.acsmeeting.video

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import java.nio.ByteBuffer

class I420PackerTest {
  @Test
  fun percentileMsHandlesEmptyAndOrder() {
    assertThat(I420Packer.percentileMs(LongArray(0), 0.50)).isEqualTo("na")
    assertThat(I420Packer.percentileMs(longArrayOf(10_000_000, 20_000_000, 40_000_000), 0.50)).isEqualTo("20.0")
  }

  @Test
  fun packedSizeUsesChromaRounding() {
    assertThat(I420Packer.packedSize(4, 4)).isEqualTo(24)
    assertThat(I420Packer.packedSize(3, 3)).isEqualTo(3 * 3 + 2 * 2 * 2)
    assertThat(I420Packer.packedSize(1280, 720)).isEqualTo(1280 * 720 * 3 / 2)
  }

  @Test
  fun planeMinBytesIsLastRowPlusFullStrides() {
    assertThat(I420Packer.planeMinBytes(8, 8, 4)).isEqualTo(32)
    assertThat(I420Packer.planeMinBytes(16, 8, 4)).isEqualTo(16 * 3 + 8)
    assertThat(I420Packer.planeMinBytes(4, 8, 4)).isEqualTo(0)
  }

  @Test
  fun copyPlaneFromPaddedStrideWritesTightDest() {
    val width = 4
    val height = 4
    val padded = buildPlanes(width, height, strideY = 8, strideUv = 4, seed = 7)
    val dest = ByteBuffer.allocate(width * height)
    I420Packer.copyPlane(padded.y, 8, width, height, dest)
    dest.flip()
    val out = ByteArray(dest.remaining())
    dest.get(out)
    assertThat(out).containsExactly(
      7, 8, 9, 10,
      11, 12, 13, 14,
      15, 16, 17, 18,
      19, 20, 21, 22,
    )
  }

  @Test
  fun chromaStrideMatchesAcsI420Offer() {
    assertThat(I420Packer.chromaStride(1280)).isEqualTo(640)
    assertThat(I420Packer.chromaStride(3)).isEqualTo(2)
  }

  @Test
  fun paddedStridesPackIdenticallyToTightStrides() {
    val width = 4
    val height = 4
    val tight = buildPlanes(width, height, strideY = 4, strideUv = 2, seed = 7)
    val padded = buildPlanes(width, height, strideY = 8, strideUv = 4, seed = 7)
    val tightOut = ByteBuffer.allocate(I420Packer.packedSize(width, height))
    val paddedOut = ByteBuffer.allocate(I420Packer.packedSize(width, height))
    I420Packer.pack(
      tight.y, 4, tight.u, 2, tight.v, 2, width, height, tightOut,
    )
    I420Packer.pack(
      padded.y, 8, padded.u, 4, padded.v, 4, width, height, paddedOut,
    )
    assertThat(bytes(paddedOut)).isEqualTo(bytes(tightOut))
    assertThat(tightOut.remaining()).isEqualTo(I420Packer.packedSize(width, height))
  }

  @Test
  fun oddDimensionsPackExactBytes() {
    val width = 3
    val height = 3
    val planes = buildPlanes(width, height, strideY = 5, strideUv = 3, seed = 11)
    val dest = ByteBuffer.allocate(I420Packer.packedSize(width, height))
    I420Packer.pack(planes.y, 5, planes.u, 3, planes.v, 3, width, height, dest)
    val packed = bytes(dest)
    assertThat(packed).hasSize(3 * 3 + 2 * 2 * 2)
    // Visible Y is seed + row*width + col; chroma is 2x2 after (3+1)/2 rounding.
    assertThat(packed.copyOfRange(0, 9)).containsExactly(
      11, 12, 13,
      14, 15, 16,
      17, 18, 19,
    )
    assertThat(packed.copyOfRange(9, 13)).containsExactly(31, 32, 33, 34)
    assertThat(packed.copyOfRange(13, 17)).containsExactly(41, 42, 43, 44)
  }

  private fun buildPlanes(
    width: Int,
    height: Int,
    strideY: Int,
    strideUv: Int,
    seed: Int,
  ): Planes {
    val chromaW = (width + 1) / 2
    val chromaH = (height + 1) / 2
    val y = ByteBuffer.allocate(strideY * height)
    val u = ByteBuffer.allocate(strideUv * chromaH)
    val v = ByteBuffer.allocate(strideUv * chromaH)
    for (row in 0 until height) {
      for (col in 0 until width) {
        y.put(row * strideY + col, (seed + row * width + col).toByte())
      }
    }
    for (row in 0 until chromaH) {
      for (col in 0 until chromaW) {
        u.put(row * strideUv + col, (seed + 20 + row * chromaW + col).toByte())
        v.put(row * strideUv + col, (seed + 30 + row * chromaW + col).toByte())
      }
    }
    y.rewind()
    u.rewind()
    v.rewind()
    return Planes(y, u, v)
  }

  private fun bytes(buffer: ByteBuffer): ByteArray {
    val copy = buffer.duplicate()
    val out = ByteArray(copy.remaining())
    copy.get(out)
    return out
  }

  private data class Planes(val y: ByteBuffer, val u: ByteBuffer, val v: ByteBuffer)
}
