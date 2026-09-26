package com.mentra.framepreview

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class PreviewGeometryTest {
  private fun validate(
    width: Int = 64,
    height: Int = 36,
    strideY: Int = width + 8,
    strideC: Int = (width + 1) / 2 + 8,
    yBytes: Int = strideY * height,
    cBytes: Int = strideC * ((height + 1) / 2),
    output: PreviewSize = PreviewSize(width, height),
    payload: Int = PreviewPixelFormat.I420.packedSize(output.width, output.height),
  ) = PreviewGeometry.validateI420(width, height, yBytes, strideY, cBytes, strideC, cBytes, strideC, output, payload)

  @Test
  fun `a well formed padded frame passes`() {
    assertThat(validate()).isNull()
  }

  @Test
  fun `odd sizes pass with ceil chroma`() {
    assertThat(validate(width = 17, height = 9)).isNull()
    assertThat(validate(width = 1, height = 1)).isNull()
  }

  @Test
  fun `the last row only needs its width, not a full stride`() {
    assertThat(validate(yBytes = 72 * 35 + 64)).isNull()
  }

  @Test
  fun `zero sizes are rejected`() {
    assertThat(validate(width = 0)).isEqualTo(PackFailureReason.ZERO_SIZE)
    assertThat(validate(output = PreviewSize(0, 10), payload = 0)).isEqualTo(PackFailureReason.ZERO_SIZE)
  }

  @Test
  fun `a stride narrower than the row is rejected`() {
    assertThat(validate(strideY = 63)).isEqualTo(PackFailureReason.STRIDE_TOO_SMALL)
    assertThat(validate(strideC = 31)).isEqualTo(PackFailureReason.STRIDE_TOO_SMALL)
  }

  @Test
  fun `a short plane is rejected before any copy`() {
    assertThat(validate(yBytes = 72 * 35 + 63)).isEqualTo(PackFailureReason.PLANE_OUT_OF_BOUNDS)
    assertThat(validate(cBytes = 10)).isEqualTo(PackFailureReason.PLANE_OUT_OF_BOUNDS)
  }

  @Test
  fun `oversize frames that no reader accepts are rejected`() {
    // Dimensions larger than the planes behind them.
    assertThat(validate(width = 128, height = 72, strideY = 136, yBytes = 72 * 36))
      .isEqualTo(PackFailureReason.PLANE_OUT_OF_BOUNDS)
    // An output above the header's and parsers' ceiling.
    assertThat(validate(width = 5000, height = 10, output = PreviewSize(5000, 10))).isEqualTo(PackFailureReason.PAYLOAD_MISMATCH)
  }

  @Test
  fun `a payload length that does not match the output is rejected`() {
    assertThat(validate(payload = 1)).isEqualTo(PackFailureReason.PAYLOAD_MISMATCH)
  }

  @Test
  fun `slots must be exactly one frame`() {
    assertThat(PreviewGeometry.validateSlot(100, 100)).isNull()
    assertThat(PreviewGeometry.validateSlot(99, 100)).isEqualTo(PackFailureReason.SLOT_TOO_SMALL)
    assertThat(PreviewGeometry.validateSlot(101, 100)).isEqualTo(PackFailureReason.PAYLOAD_MISMATCH)
  }
}

class PreviewScalePlanTest {
  @Test
  fun `each tier is produced exactly from a 16 by 9 source`() {
    assertThat(PreviewScalePlan.fit(1280, 720, 640, 360)).isEqualTo(PreviewSize(640, 360))
    assertThat(PreviewScalePlan.fit(1280, 720, 320, 180)).isEqualTo(PreviewSize(320, 180))
    assertThat(PreviewScalePlan.fit(1920, 1080, 640, 360)).isEqualTo(PreviewSize(640, 360))
    assertThat(PreviewScalePlan.fit(960, 540, 640, 360)).isEqualTo(PreviewSize(640, 360))
  }

  @Test
  fun `the source aspect is kept inside the box`() {
    assertThat(PreviewScalePlan.fit(800, 600, 640, 360)).isEqualTo(PreviewSize(480, 360))
    assertThat(PreviewScalePlan.fit(720, 1280, 640, 360)).isEqualTo(PreviewSize(202, 360))
  }

  @Test
  fun `a source inside the box is never upscaled`() {
    assertThat(PreviewScalePlan.fit(480, 270, 640, 360)).isEqualTo(PreviewSize(480, 270))
    assertThat(PreviewScalePlan.fit(17, 9, 640, 360)).isEqualTo(PreviewSize(17, 9))
  }

  @Test
  fun `scaled outputs are even and never exceed the source`() {
    for ((w, h) in listOf(1279 to 719, 1001 to 333, 641 to 361, 3 to 2000)) {
      val out = PreviewScalePlan.fit(w, h, 320, 180)
      assertThat(out.width).isLessThanOrEqualTo(minOf(w, 320))
      assertThat(out.height).isLessThanOrEqualTo(minOf(h, 180))
      if (out.width > 2) assertThat(out.width % 2).isZero()
      if (out.height > 2) assertThat(out.height % 2).isZero()
    }
  }

  @Test
  fun `boxes are clamped to the pixel ceiling`() {
    assertThat(PreviewScalePlan.clampBox(640, 360, 640 * 360)).isEqualTo(PreviewSize(640, 360))
    val clamped = PreviewScalePlan.clampBox(1280, 720, 640 * 360)
    assertThat(clamped.width * clamped.height).isLessThanOrEqualTo(640 * 360)
    assertThat(clamped).isEqualTo(PreviewSize(640, 360))
  }
}
