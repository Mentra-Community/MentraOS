package com.mentra.framepreview

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * The Kotlin pattern is a hand-written mirror of the Swift one, so it gets the same assertions:
 * a number measured on one platform only means the same thing on the other if the pictures do.
 */
class PreviewTestPatternTest {
  private val width = 1280
  private val height = 720

  private fun render(frameIndex: Int, noise: Int): ByteArray {
    val pattern = PreviewTestPattern(width, height, noiseAmplitude = noise)
    val out = ByteArray(PreviewPixelFormat.I420.packedSize(width, height))
    pattern.writeI420(out, frameIndex)
    return out
  }

  /**
   * Grain exists as a control against silent compression somewhere in the path, so the thing
   * that actually matters about it is that the bytes are genuinely varied rather than a
   * compressible expanse of flat colour.
   */
  @Test
  fun `grain varies within a flat colour bar`() {
    val noisy = render(frameIndex = 5, noise = 10)
    val flat = render(frameIndex = 5, noise = 0)
    // A row below the counter band and away from the moving sweep, inside one bar.
    val row = 400
    val flatValues = (700 until 760).map { flat[row * width + it] }.toSet()
    val noisyValues = (700 until 760).map { noisy[row * width + it] }.toSet()
    assertThat(flatValues).hasSize(1)
    assertThat(noisyValues.size).isGreaterThan(5)
  }

  @Test
  fun `grain stays within its amplitude so the bars stay recognisable`() {
    val noisy = render(frameIndex = 5, noise = 10)
    val flat = render(frameIndex = 5, noise = 0)
    val row = 400
    for (column in 700 until 760) {
      val delta = Math.abs((noisy[row * width + column].toInt() and 0xFF) - (flat[row * width + column].toInt() and 0xFF))
      assertThat(delta).isLessThanOrEqualTo(10)
    }
  }

  /**
   * A still grain field would be a fixed pattern the first frame pays for and every later one
   * reuses. The field has to move, or consecutive frames differ only where the sweep is.
   */
  @Test
  fun `grain moves between frames`() {
    val first = render(frameIndex = 100, noise = 10)
    val second = render(frameIndex = 101, noise = 10)
    val row = 400
    val changed = (0 until width).count { first[row * width + it] != second[row * width + it] }
    assertThat(changed).isGreaterThan(600)
  }

  @Test
  fun `the counter still reads through grain`() {
    for (index in listOf(0, 1, 42, 65_535)) {
      assertThat(PreviewTestPattern.readFrameMarker(render(index, noise = 10), width)).isEqualTo(index)
    }
  }

  @Test
  fun `grain does not change the frame size`() {
    // The point of the control: identical bytes on the wire, very different entropy.
    assertThat(render(7, noise = 10).size).isEqualTo(render(7, noise = 0).size)
    assertThat(render(7, noise = 10).size).isEqualTo(PreviewPixelFormat.I420.packedSize(width, height))
  }

  /** Without grain the picture must be exactly what it was before grain existed. */
  @Test
  fun `zero amplitude leaves the structure untouched`() {
    val flat = render(frameIndex = 3, noise = 0)
    val barWidth = width / 8
    val row = 400
    // Second bar is yellow, luma 210, and row 400 is clear of both the counter and the sweep.
    assertThat(flat[row * width + barWidth + 40].toInt() and 0xFF).isEqualTo(210)
  }
}
