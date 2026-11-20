package com.mentra.glassesmedia.passthrough

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class EncodedFrameBufferTest {
  @Test
  fun itCarriesTheBytesTheSizeAndTheFrameType() {
    val bytes = annexB(3, size = 100)
    val buffer = frameBuffer(bytes, key = true, width = 1280, height = 720)
    assertThat(bytesOf(buffer.data)).isEqualTo(bytes)
    assertThat(buffer.sizeBytes).isEqualTo(bytes.size)
    assertThat(buffer.getWidth()).isEqualTo(1280)
    assertThat(buffer.getHeight()).isEqualTo(720)
    assertThat(buffer.isKeyFrame).isTrue()
  }

  @Test
  fun retainAndReleaseKeepAnHonestCount() {
    val buffer = frameBuffer(annexB(1), key = false)
    assertThat(buffer.referenceCount()).isEqualTo(1)
    buffer.retain()
    buffer.retain()
    buffer.release()
    assertThat(buffer.referenceCount()).isEqualTo(2)
  }

  @Test
  fun cropAndScaleCannotResizeAndHandsTheSameFrameBackRetained() {
    val buffer = frameBuffer(annexB(1), key = false)
    val scaled = buffer.cropAndScale(0, 0, 960, 540, 480, 270)
    assertThat(scaled).isSameAs(buffer)
    assertThat(buffer.referenceCount()).isEqualTo(2)
  }
}
