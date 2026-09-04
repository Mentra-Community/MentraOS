package com.mentra.acsmeeting.source

import com.mentra.acsmeeting.telemetry.ChromaProbe
import com.mentra.acsmeeting.video.I420Packer
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import java.nio.ByteBuffer

class SyntheticFrameFactoryTest {
  @Test
  fun packedLengthMatchesI420() {
    val dest = buffer(WIDTH, HEIGHT)
    SyntheticFrameFactory().write(dest, WIDTH, HEIGHT, 0)
    assertThat(dest.remaining()).isEqualTo(I420Packer.packedSize(WIDTH, HEIGHT))
  }

  /**
   * Regression for the 1.4 fps wire collapse: a noisy CHEAP background is
   * incompressible and starves the ACS encoder. CHEAP must stay flat.
   */
  @Test
  fun cheapBackgroundStaysCompressible() {
    val dest = buffer(WIDTH, HEIGHT)
    SyntheticFrameFactory(SyntheticEntropy.CHEAP).write(dest, WIDTH, HEIGHT, 0)
    val y = yBytes(dest)
    var background = 0
    for (row in HEIGHT - 40 until HEIGHT) {
      val rowOff = row * WIDTH
      for (col in 0 until WIDTH) {
        if (y[rowOff + col] == SyntheticFrameFactory.BG_Y) background += 1
      }
    }
    assertThat(background).isGreaterThan(30 * WIDTH)
  }

  @Test
  fun consecutiveCheapFramesDifferInY() {
    val a = buffer(WIDTH, HEIGHT)
    val b = buffer(WIDTH, HEIGHT)
    val factory = SyntheticFrameFactory(SyntheticEntropy.CHEAP)
    factory.write(a, WIDTH, HEIGHT, 0)
    factory.write(b, WIDTH, HEIGHT, 1)
    assertThat(yBytes(a)).isNotEqualTo(yBytes(b))
  }

  @Test
  fun cheapIsDeterministicForAGivenIndex() {
    val a = buffer(WIDTH, HEIGHT)
    val b = buffer(WIDTH, HEIGHT)
    SyntheticFrameFactory(SyntheticEntropy.CHEAP).write(a, WIDTH, HEIGHT, 7)
    SyntheticFrameFactory(SyntheticEntropy.CHEAP).write(b, WIDTH, HEIGHT, 7)
    assertThat(copy(a)).isEqualTo(copy(b))
  }

  @Test
  fun incrementalCheapMatchesFreshWrite() {
    val stepped = buffer(WIDTH, HEIGHT)
    val fresh = buffer(WIDTH, HEIGHT)
    val factory = SyntheticFrameFactory(SyntheticEntropy.CHEAP)
    factory.write(stepped, WIDTH, HEIGHT, 0)
    factory.write(stepped, WIDTH, HEIGHT, 1)
    SyntheticFrameFactory(SyntheticEntropy.CHEAP).write(fresh, WIDTH, HEIGHT, 1)
    assertThat(copy(stepped)).isEqualTo(copy(fresh))
  }

  @Test
  fun chromaAveragesLandAt128() {
    for (entropy in SyntheticEntropy.entries) {
      val dest = buffer(WIDTH, HEIGHT)
      SyntheticFrameFactory(entropy).write(dest, WIDTH, HEIGHT, 3)
      val sample = ChromaProbe.samplePacked(dest, WIDTH, HEIGHT)
      assertThat(sample.u).isEqualTo(128)
      assertThat(sample.v).isEqualTo(128)
    }
  }

  @Test
  fun motionPansAlmostEveryPixel() {
    val a = buffer(WIDTH, HEIGHT)
    val b = buffer(WIDTH, HEIGHT)
    val factory = SyntheticFrameFactory(SyntheticEntropy.MOTION)
    factory.write(a, WIDTH, HEIGHT, 0)
    factory.write(b, WIDTH, HEIGHT, 1)
    val ya = yBytes(a)
    val yb = yBytes(b)
    var differ = 0
    for (i in ya.indices) if (ya[i] != yb[i]) differ += 1
    assertThat(differ).isGreaterThan(ya.size / 2)
  }

  /**
   * Glasses motion still has neighbors that look alike. A 32×32 patch in the
   * corner must stay a gradient, not snow — that is what lets an I-frame fit
   * the bitrate budget.
   */
  @Test
  fun motionKeepsSpatialStructure() {
    val dest = buffer(WIDTH, HEIGHT)
    SyntheticFrameFactory(SyntheticEntropy.MOTION).write(dest, WIDTH, HEIGHT, 0)
    val y = yBytes(dest)
    val unique = mutableSetOf<Byte>()
    for (row in HEIGHT - 80 until HEIGHT - 48) {
      val rowOff = row * WIDTH
      for (col in 0 until 32) unique.add(y[rowOff + col])
    }
    assertThat(unique.size).isLessThan(40)
  }

  @Test
  fun motionIsDeterministicForAGivenIndex() {
    val a = buffer(WIDTH, HEIGHT)
    val b = buffer(WIDTH, HEIGHT)
    SyntheticFrameFactory(SyntheticEntropy.MOTION).write(a, WIDTH, HEIGHT, 11)
    SyntheticFrameFactory(SyntheticEntropy.MOTION).write(b, WIDTH, HEIGHT, 11)
    assertThat(copy(a)).isEqualTo(copy(b))
  }

  @Test
  fun noiseRewritesTheFullYPlane() {
    val a = buffer(WIDTH, HEIGHT)
    val b = buffer(WIDTH, HEIGHT)
    val factory = SyntheticFrameFactory(SyntheticEntropy.NOISE)
    factory.write(a, WIDTH, HEIGHT, 0)
    factory.write(b, WIDTH, HEIGHT, 1)
    val ya = yBytes(a)
    val yb = yBytes(b)
    var differ = 0
    for (i in ya.indices) if (ya[i] != yb[i]) differ += 1
    assertThat(differ).isGreaterThan(ya.size / 2)
  }

  @Test
  fun stampPaintsFrameIdAndFpsOnADarkBox() {
    val dest = buffer(WIDTH, HEIGHT)
    SyntheticFrameFactory(SyntheticEntropy.CHEAP).write(dest, WIDTH, HEIGHT, 42, 15.0)
    val y = yBytes(dest)
    val boxX = WIDTH / 16
    val boxY = HEIGHT / 2 - 80
    var dark = 0
    var bright = 0
    for (row in boxY until boxY + 160) {
      val rowOff = row * WIDTH
      for (col in boxX until boxX + 400) {
        val value = y[rowOff + col].toInt() and 0xFF
        if (value <= 20) dark += 1
        if (value >= 220) bright += 1
      }
    }
    assertThat(dark).isGreaterThan(1_000)
    assertThat(bright).isGreaterThan(200)
  }

  @Test
  fun stampFrameIndexChangesTheOverlay() {
    val a = buffer(WIDTH, HEIGHT)
    val b = buffer(WIDTH, HEIGHT)
    SyntheticFrameFactory(SyntheticEntropy.CHEAP).write(a, WIDTH, HEIGHT, 1, 15.0)
    SyntheticFrameFactory(SyntheticEntropy.CHEAP).write(b, WIDTH, HEIGHT, 2, 15.0)
    assertThat(copy(a)).isNotEqualTo(copy(b))
  }

  @Test
  fun noiseIsDeterministicForAGivenIndex() {
    val a = buffer(WIDTH, HEIGHT)
    val b = buffer(WIDTH, HEIGHT)
    SyntheticFrameFactory(SyntheticEntropy.NOISE).write(a, WIDTH, HEIGHT, 11)
    SyntheticFrameFactory(SyntheticEntropy.NOISE).write(b, WIDTH, HEIGHT, 11)
    assertThat(copy(a)).isEqualTo(copy(b))
  }

  private fun buffer(width: Int, height: Int): ByteBuffer =
    ByteBuffer.allocate(I420Packer.packedSize(width, height))

  private fun yBytes(src: ByteBuffer): ByteArray {
    val view = src.duplicate()
    view.position(0)
    val y = ByteArray(WIDTH * HEIGHT)
    view.get(y)
    return y
  }

  private fun copy(src: ByteBuffer): ByteArray {
    val view = src.duplicate()
    val out = ByteArray(view.remaining())
    view.get(out)
    return out
  }

  companion object {
    private const val WIDTH = 1280
    private const val HEIGHT = 720
  }
}
