package com.mentra.acsmeeting.video

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * Asserts the advertised format arithmetic via [I420FormatSpec]. The ACS
 * VideoStreamFormat object itself is not constructed here: it is native-backed
 * and throws ExceptionInInitializerError outside an Android runtime.
 */
class AcsFrameSenderFormatTest {
  @Test
  fun i420FormatOffersTight720p20() {
    val spec = I420FormatSpec.of()
    assertThat(spec.width).isEqualTo(1280)
    assertThat(spec.height).isEqualTo(720)
    assertThat(spec.fps).isEqualTo(20f)
    assertThat(spec.strideY).isEqualTo(1280)
    assertThat(spec.strideU).isEqualTo(640)
    assertThat(spec.strideV).isEqualTo(640)
  }

  @Test
  fun i420FormatRoundsOddChromaStrides() {
    val spec = I420FormatSpec.of(width = 3, height = 3, fps = 15f)
    assertThat(spec.strideY).isEqualTo(3)
    assertThat(spec.strideU).isEqualTo(2)
    assertThat(spec.strideV).isEqualTo(2)
  }

  @Test
  fun advertisedStridesMatchPacker() {
    assertThat(I420Packer.chromaStride(1280)).isEqualTo(640)
    assertThat(I420Packer.packedSize(1280, 720)).isEqualTo(1_382_400)
  }

  /** A disagreement here means ACS reads chroma at the wrong offset: green frames. */
  @Test
  fun advertisedSizeMatchesWhatThePackerWrites() {
    for ((w, h) in listOf(1280 to 720, 960 to 540, 640 to 360, 3 to 3, 641 to 361)) {
      val spec = I420FormatSpec.of(width = w, height = h)
      assertThat(spec.packedSize())
        .describedAs("%dx%d", w, h)
        .isEqualTo(I420Packer.packedSize(w, h))
    }
  }

  @Test
  fun i420FormatStaysInsideAcsBounds() {
    assertThat(I420FormatSpec.of().withinAcsBounds()).isTrue()
  }

  @Test
  fun parseOrNullAllowsDocumentedVirtualCameraSizesOnly() {
    assertThat(I420FormatSpec.parseOrNull(1280, 720, 15f)).isNotNull()
    assertThat(I420FormatSpec.parseOrNull(960, 540, 30f)).isNotNull()
    assertThat(I420FormatSpec.parseOrNull(540, 960, 30f)).isNull()
    assertThat(I420FormatSpec.parseOrNull(854, 480, 15f)).isNull()
  }

  @Test
  fun namedResolutionMapsAcsEnumsAndRejectsNearMatches() {
    assertThat(I420FormatSpec.of(1280, 720).namedResolution()).isEqualTo(AcsNamedResolution.P720)
    assertThat(I420FormatSpec.of(960, 540).namedResolution()).isEqualTo(AcsNamedResolution.P540)
    assertThat(I420FormatSpec.of(858, 480).namedResolution()).isEqualTo(AcsNamedResolution.P480)
    assertThat(I420FormatSpec.of(640, 360).namedResolution()).isEqualTo(AcsNamedResolution.P360)
    assertThat(I420FormatSpec.of(854, 480).namedResolution()).isNull()
    assertThat(I420FormatSpec.of(540, 960).namedResolution()).isNull()
  }

  @Test
  fun outOfRangeGeometryIsReportedNotSilentlyClamped() {
    assertThat(I420FormatSpec.of(width = 3, height = 3).withinAcsBounds()).isFalse()
    assertThat(I420FormatSpec.of(width = 4096, height = 2160).withinAcsBounds()).isFalse()
    assertThat(I420FormatSpec.of(fps = 60f).withinAcsBounds()).isFalse()
  }
}
