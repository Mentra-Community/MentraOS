package com.mentra.acsmeeting.source

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import java.nio.ByteBuffer

class BitmapFontTest {
  @Test
  fun drawsOnPixelsForDigitEight() {
    val width = 80
    val height = 40
    val dest = ByteBuffer.allocate(width * height)
    BitmapFont.draw(dest, width, height, "8", 0, 0, 2, 0xEB.toByte())
    var on = 0
    for (i in 0 until dest.capacity()) {
      if (dest.get(i) == 0xEB.toByte()) on += 1
    }
    assertThat(on).isGreaterThan(0)
    assertThat(BitmapFont.textWidth(1, 2)).isEqualTo(5 * 2)
    assertThat(BitmapFont.textHeight(2)).isEqualTo(7 * 2)
  }
}
