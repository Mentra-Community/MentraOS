package com.mentra.acsmeeting.source

import com.mentra.acsmeeting.video.I420Packer
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import java.nio.ByteBuffer

class I420PlanesTest {
  @Test
  fun tightWhenStridesMatchWidth() {
    val planes = planes(width = 8, height = 4, strideY = 8, strideUv = 4, direct = false)
    assertThat(planes.isTight()).isTrue()
    assertThat(planes.planesReadable()).isTrue()
  }

  @Test
  fun paddedWhenStrideExceedsWidth() {
    val planes = planes(width = 8, height = 4, strideY = 16, strideUv = 8, direct = false)
    assertThat(planes.isTight()).isFalse()
    assertThat(planes.planesReadable()).isTrue()
  }

  @Test
  fun heapBuffersAreNotDirect() {
    val planes = planes(width = 4, height = 4, strideY = 4, strideUv = 2, direct = false)
    assertThat(planes.isDirect()).isFalse()
  }

  @Test
  fun directBuffersReportDirect() {
    val planes = planes(width = 4, height = 4, strideY = 4, strideUv = 2, direct = true)
    assertThat(planes.isDirect()).isTrue()
  }

  @Test
  fun shortPlaneIsNotReadable() {
    val y = ByteBuffer.allocate(4)
    val u = ByteBuffer.allocate(2)
    val v = ByteBuffer.allocate(2)
    val planes = I420Planes(y, 8, u, 4, v, 4, 8, 4, 0L)
    assertThat(planes.planesReadable()).isFalse()
    assertThat(I420Packer.planeMinBytes(8, 8, 4)).isEqualTo(32)
  }

  private fun planes(
    width: Int,
    height: Int,
    strideY: Int,
    strideUv: Int,
    direct: Boolean,
  ): I420Planes {
    val chromaH = I420Packer.chromaStride(height)
    fun alloc(bytes: Int): ByteBuffer =
      if (direct) ByteBuffer.allocateDirect(bytes) else ByteBuffer.allocate(bytes)
    return I420Planes(
      y = alloc(strideY * height),
      strideY = strideY,
      u = alloc(strideUv * chromaH),
      strideU = strideUv,
      v = alloc(strideUv * chromaH),
      strideV = strideUv,
      width = width,
      height = height,
      timestampNs = 0L,
    )
  }
}
