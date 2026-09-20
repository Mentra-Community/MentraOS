package com.mentra.framepreview

/**
 * Synthetic 720p content for the experiment.
 *
 * A flat colour would hide every interesting failure: stride skew, a stale frame being redrawn,
 * planes swapped, chroma dropped. So the pattern carries three independent signals — colour bars
 * (chroma correctness and plane order), a bar that moves every frame (liveness), and the frame
 * counter drawn as bits (which exact frame is on screen, readable by eye and assertable in a
 * test).
 *
 * Mirrors `PreviewTestPattern.swift` so a number measured on one platform means the same thing
 * on the other.
 */
object PreviewTestPattern {
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

  /** Fill [destination] with one tightly packed I420 frame. */
  fun writeI420(destination: ByteArray, width: Int, height: Int, frameIndex: Int) {
    require(destination.size >= PreviewPixelFormat.I420.packedSize(width, height)) { "pattern buffer too small" }
    val chromaWidth = (width + 1) / 2
    val chromaHeight = (height + 1) / 2
    val barWidth = maxOf(width / BARS.size, 1)
    // One full sweep every four seconds at 15 fps, so motion is obvious without strobing.
    val sweepX = (frameIndex * maxOf(width / 60, 1)) % width
    val sweepWidth = maxOf(width / 40, 2)

    for (row in 0 until height) {
      val rowBase = row * width
      for (column in 0 until width) {
        val bar = BARS[minOf(column / barWidth, BARS.size - 1)]
        var value = bar[0]
        if (column >= sweepX && column < sweepX + sweepWidth) value = 235
        val marker = markerValue(row, column, frameIndex)
        if (marker != null) value = marker
        destination[rowBase + column] = value.toByte()
      }
    }

    val uOffset = width * height
    val vOffset = uOffset + chromaWidth * chromaHeight
    for (row in 0 until chromaHeight) {
      for (column in 0 until chromaWidth) {
        val bar = BARS[minOf((column * 2) / barWidth, BARS.size - 1)]
        destination[uOffset + row * chromaWidth + column] = bar[1].toByte()
        destination[vOffset + row * chromaWidth + column] = bar[2].toByte()
      }
    }
  }

  /** Luma value for the frame-counter marker, or null when this pixel is not part of it. */
  private fun markerValue(row: Int, column: Int, frameIndex: Int): Int? {
    if (row >= MARKER_HEIGHT || column >= MARKER_BITS * MARKER_CELL) return null
    val bit = column / MARKER_CELL
    return if ((frameIndex shr bit) and 1 == 1) 235 else 16
  }

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
