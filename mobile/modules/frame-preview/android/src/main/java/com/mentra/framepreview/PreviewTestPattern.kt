package com.mentra.framepreview

/**
 * Synthetic 720p content for the experiment.
 *
 * A flat colour would hide every interesting failure: stride skew, a stale frame being redrawn,
 * planes swapped, chroma dropped. So the pattern carries four independent signals — colour bars
 * (chroma correctness and plane order), a bar that moves every frame (liveness), the frame
 * counter drawn as bits (which exact frame is on screen, readable by eye and assertable in a
 * test), and grain.
 *
 * Mirrors `PreviewTestPattern.swift` so a number measured on one platform means the same thing
 * on the other.
 *
 * ## Why grain
 *
 * Raw YUV is the same number of bytes whatever it contains, so noise cannot change the
 * bandwidth. It is here as a **control**. A frame of flat colour bars is enormously
 * compressible, so if anything in the path were quietly compressing, the measurements would
 * flatter us and nothing in the counters would say so. Noise does not compress. If the send
 * timings hold with grain on, nothing in the path is compressing.
 *
 * ## Why it is built from a cache
 *
 * Generating a megapixel of fresh noise per frame would put the generator back on the critical
 * path, which is the exact problem this file already had once. Instead a small field of
 * pre-composited rows is built once, and each frame copies rows out of it at a rolling offset:
 * every pixel differs from its neighbours, the field drifts by a row per frame, and the
 * per-frame cost stays an `arraycopy`.
 */
class PreviewTestPattern(
  private val width: Int,
  private val height: Int,
  noiseAmplitude: Int = DEFAULT_NOISE_AMPLITUDE,
) {
  private val chromaWidth = (width + 1) / 2
  private val chromaHeight = (height + 1) / 2
  private val sweepWidth = maxOf(width / 40, 2)

  /** [VARIANT_COUNT] rows of colour bars plus one grain pattern each, flattened. */
  private val lumaField = ByteArray(if (width > 0) VARIANT_COUNT * width else 0)
  private val chromaFieldU = ByteArray(if (width > 0) VARIANT_COUNT * chromaWidth else 0)
  private val chromaFieldV = ByteArray(if (width > 0) VARIANT_COUNT * chromaWidth else 0)

  init {
    if (width > 0 && height > 0) buildFields(maxOf(noiseAmplitude, 0))
  }

  /** Fill [destination] with one tightly packed I420 frame. */
  fun writeI420(destination: ByteArray, frameIndex: Int) {
    require(destination.size >= PreviewPixelFormat.I420.packedSize(width, height)) { "pattern buffer too small" }
    if (width <= 0 || height <= 0) return

    for (row in 0 until height) {
      val variant = Math.floorMod(row + frameIndex, VARIANT_COUNT)
      System.arraycopy(lumaField, variant * width, destination, row * width, width)
    }

    // The sweep and the counter move every frame, so they are stamped over the grain rather
    // than baked into it. Both are written flat: they are read by eye and by test, and grain
    // on top of them would only make that harder.
    val sweepX = (frameIndex * maxOf(width / 60, 1)) % width
    val sweepEnd = minOf(sweepX + sweepWidth, width)
    if (sweepEnd > sweepX) {
      for (row in 0 until height) {
        destination.fill(235.toByte(), row * width + sweepX, row * width + sweepEnd)
      }
    }

    val markerRows = minOf(MARKER_HEIGHT, height)
    val markerColumns = minOf(MARKER_BITS * MARKER_CELL, width)
    for (bit in 0 until MARKER_BITS) {
      val start = bit * MARKER_CELL
      if (start >= markerColumns) break
      val end = minOf(start + MARKER_CELL, markerColumns)
      val value = (if ((frameIndex shr bit) and 1 == 1) 235 else 16).toByte()
      for (row in 0 until markerRows) {
        destination.fill(value, row * width + start, row * width + end)
      }
    }

    val uOffset = width * height
    val vOffset = uOffset + chromaWidth * chromaHeight
    for (row in 0 until chromaHeight) {
      val variant = Math.floorMod(row + frameIndex, VARIANT_COUNT)
      System.arraycopy(chromaFieldU, variant * chromaWidth, destination, uOffset + row * chromaWidth, chromaWidth)
      System.arraycopy(chromaFieldV, variant * chromaWidth, destination, vOffset + row * chromaWidth, chromaWidth)
    }
  }

  private fun buildFields(noiseAmplitude: Int) {
    val barWidth = maxOf(width / BARS.size, 1)
    var state = 0x9E3779B9.toInt()

    fun next(): Int {
      state = state xor (state shl 13)
      state = state xor (state ushr 17)
      state = state xor (state shl 5)
      return state
    }

    /**
     * [value] displaced by up to ±[noiseAmplitude], clamped into range. Amplitude 0 returns the
     * value untouched and consumes no randomness, which is what keeps the noise-free path exact.
     */
    fun jitter(value: Int): Byte {
      if (noiseAmplitude <= 0) return value.toByte()
      val span = noiseAmplitude * 2 + 1
      val offset = Math.floorMod(next(), span) - noiseAmplitude
      return (value + offset).coerceIn(0, 255).toByte()
    }

    for (variant in 0 until VARIANT_COUNT) {
      for (column in 0 until width) {
        val bar = BARS[minOf(column / barWidth, BARS.size - 1)]
        lumaField[variant * width + column] = jitter(bar[0])
      }
    }
    for (variant in 0 until VARIANT_COUNT) {
      for (column in 0 until chromaWidth) {
        val bar = BARS[minOf((column * 2) / barWidth, BARS.size - 1)]
        chromaFieldU[variant * chromaWidth + column] = jitter(bar[1])
        chromaFieldV[variant * chromaWidth + column] = jitter(bar[2])
      }
    }
  }

  companion object {
    /** BT.601 limited-range colour bars: white, yellow, cyan, green, magenta, red, blue, black. */
    private val BARS = arrayOf(
      intArrayOf(235, 128, 128),
      intArrayOf(210, 16, 146),
      intArrayOf(170, 166, 16),
      intArrayOf(145, 54, 34),
      intArrayOf(106, 202, 222),
      intArrayOf(81, 90, 240),
      intArrayOf(41, 240, 110),
      intArrayOf(16, 128, 128),
    )

    private const val MARKER_BITS = 16
    private const val MARKER_CELL = 24
    private const val MARKER_HEIGHT = 32

    /**
     * Enough rows that the grain does not visibly repeat down a 720-row frame, small enough that
     * the field stays cheap to build and friendly to cache.
     */
    private const val VARIANT_COUNT = 64

    /**
     * ±40 around the bar value.
     *
     * Deliberately heavier than real sensor grain. A preview is drawn into a canvas a few hundred
     * pixels wide, so four or more source pixels average into every screen pixel and halve the
     * grain you can actually see — a realistic ±10 renders as an almost imperceptible shimmer.
     * This is a diagnostic picture, and the grain has a job: it must be visibly present, and it
     * must not compress. The bars stay readable because chroma separates them even when the luma
     * ranges overlap, and the frame counter is stamped flat on top.
     */
    const val DEFAULT_NOISE_AMPLITUDE = 40

    /**
     * Read the frame counter back out of a packed frame. Used by tests to prove a buffer was not
     * overwritten while a worker still held it.
     */
    fun readFrameMarker(source: ByteArray, width: Int): Int {
      var value = 0
      for (bit in 0 until MARKER_BITS) {
        val column = bit * MARKER_CELL + MARKER_CELL / 2
        if (column >= width) break
        // Sample the middle of the cell so a one-pixel rounding difference cannot flip a bit.
        val sample = source[(MARKER_HEIGHT / 2) * width + column].toInt() and 0xFF
        if (sample > 128) value = value or (1 shl bit)
      }
      return value
    }
  }
}
