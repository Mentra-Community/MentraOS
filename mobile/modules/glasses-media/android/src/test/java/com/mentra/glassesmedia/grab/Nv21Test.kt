package com.mentra.glassesmedia.grab

import java.nio.ByteBuffer
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.Test

class Nv21Test {
  private fun bytes(vararg values: Int) = ByteBuffer.wrap(ByteArray(values.size) { values[it].toByte() })

  @Test
  fun `tight planes become Y rows then interleaved V,U`() {
    val y = bytes(1, 2, 3, 4, 5, 6, 7, 8)
    val u = bytes(20, 21)
    val v = bytes(30, 31)
    val out = Nv21.fromI420(y, 4, u, 2, v, 2, width = 4, height = 2)
    assertThat(out.map { it.toInt() }).containsExactly(1, 2, 3, 4, 5, 6, 7, 8, 30, 20, 31, 21)
  }

  @Test
  fun `stride padding is skipped on every plane`() {
    // 2x2 frame, Y stride 4 and chroma stride 3: 99 marks padding that must not appear.
    val y = bytes(1, 2, 99, 99, 3, 4, 99, 99)
    val u = bytes(20, 99, 99)
    val v = bytes(30, 99, 99)
    val out = Nv21.fromI420(y, 4, u, 3, v, 3, width = 2, height = 2)
    assertThat(out.map { it.toInt() }).containsExactly(1, 2, 3, 4, 30, 20)
  }

  @Test
  fun `the last row may end at the row width, short of the stride`() {
    val y = bytes(1, 2, 99, 99, 3, 4)
    val out = Nv21.fromI420(y, 4, bytes(20), 1, bytes(30), 1, width = 2, height = 2)
    assertThat(out.map { it.toInt() }).containsExactly(1, 2, 3, 4, 30, 20)
  }

  @Test
  fun `a buffer positioned past its start is read from its position and left there`() {
    val y = bytes(77, 77, 1, 2, 3, 4)
    y.position(2)
    val out = Nv21.fromI420(y, 2, bytes(20), 1, bytes(30), 1, width = 2, height = 2)
    assertThat(out.map { it.toInt() }).containsExactly(1, 2, 3, 4, 30, 20)
    assertThat(y.position()).isEqualTo(2)
  }

  @Test
  fun `a plane too small for the frame is refused before any read`() {
    assertThatThrownBy { Nv21.fromI420(bytes(1, 2, 3), 2, bytes(20), 1, bytes(30), 1, width = 2, height = 2) }
      .isInstanceOf(IllegalArgumentException::class.java)
    assertThatThrownBy { Nv21.fromI420(bytes(1, 2, 3, 4), 2, ByteBuffer.allocate(0), 1, bytes(30), 1, width = 2, height = 2) }
      .isInstanceOf(IllegalArgumentException::class.java)
  }

  @Test
  fun `odd sizes are refused`() {
    assertThatThrownBy { Nv21.fromI420(bytes(1, 2, 3), 3, bytes(20), 2, bytes(30), 2, width = 3, height = 1) }
      .isInstanceOf(IllegalArgumentException::class.java)
  }
}
