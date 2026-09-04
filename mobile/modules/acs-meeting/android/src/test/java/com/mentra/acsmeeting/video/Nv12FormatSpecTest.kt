package com.mentra.acsmeeting.video

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class Nv12FormatSpecTest {
  @Test
  fun hdOffersTightBiplanarStrides() {
    val spec = Nv12FormatSpec.of()
    assertThat(spec.width).isEqualTo(1280)
    assertThat(spec.height).isEqualTo(720)
    assertThat(spec.strideY).isEqualTo(1280)
    assertThat(spec.strideUv).isEqualTo(1280)
    assertThat(spec.namedResolution()).isEqualTo(AcsNamedResolution.P720)
    assertThat(spec.packedSize()).isEqualTo(Nv12Packer.packedSize(1280, 720))
  }

  @Test
  fun oddWidthRoundsUvStrideUp() {
    val spec = Nv12FormatSpec.of(width = 3, height = 3, fps = 15f)
    assertThat(spec.strideY).isEqualTo(3)
    assertThat(spec.strideUv).isEqualTo(4)
    assertThat(spec.packedSize()).isEqualTo(3 * 3 + 4 * 2)
    assertThat(spec.withinAcsBounds()).isFalse()
  }

  @Test
  fun advertisedSizeMatchesPacker() {
    for ((w, h) in listOf(1280 to 720, 960 to 540, 640 to 360, 3 to 3, 641 to 361)) {
      val spec = Nv12FormatSpec.of(width = w, height = h)
      assertThat(spec.packedSize())
        .describedAs("%dx%d", w, h)
        .isEqualTo(Nv12Packer.packedSize(w, h))
    }
  }
}
