package com.mentra.acsmeeting.video

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class FrameGeometryTest {
  @Test
  fun rotationZeroUsesBufferSize() {
    val size = FrameGeometry.packSize(1280, 720, 0)
    assertThat(size.width).isEqualTo(1280)
    assertThat(size.height).isEqualTo(720)
    assertThat(size.rotationNonZero).isFalse()
  }

  @Test
  fun rotation90KeepsBufferCoordinatesNotRotatedDisplaySize() {
    val bufferW = 1280
    val bufferH = 720
    val rotatedWidth = bufferH
    val rotatedHeight = bufferW
    val size = FrameGeometry.packSize(bufferW, bufferH, 90)
    assertThat(size.width).isEqualTo(bufferW)
    assertThat(size.height).isEqualTo(bufferH)
    assertThat(size.rotationNonZero).isTrue()
    assertThat(size.width).isNotEqualTo(rotatedWidth)
    assertThat(size.height).isNotEqualTo(rotatedHeight)
    val overrun = I420Packer.packedSize(rotatedWidth, rotatedHeight)
    val actual = I420Packer.packedSize(size.width, size.height)
    assertThat(overrun).isEqualTo(actual)
    val planeIfRotated = rotatedHeight * 1280
    assertThat(planeIfRotated).isGreaterThan(bufferW * bufferH)
  }
}
