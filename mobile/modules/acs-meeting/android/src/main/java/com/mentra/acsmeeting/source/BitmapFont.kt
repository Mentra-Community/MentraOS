package com.mentra.acsmeeting.source

import java.nio.ByteBuffer

/** 5x7 glyphs for the synthetic stamp. No Android canvas, so this is the font. */
internal object BitmapFont {
  const val GLYPH_W = 5
  const val GLYPH_H = 7

  fun draw(
    dest: ByteBuffer,
    frameWidth: Int,
    frameHeight: Int,
    text: String,
    originX: Int,
    originY: Int,
    scale: Int,
    on: Byte,
  ) {
    var x = originX
    for (ch in text) {
      val glyph = glyph(ch) ?: continue
      blit(dest, frameWidth, frameHeight, glyph, x, originY, scale, on)
      x += (GLYPH_W + 1) * scale
    }
  }

  fun textWidth(length: Int, scale: Int): Int =
    if (length <= 0) 0 else length * (GLYPH_W + 1) * scale - scale

  fun textHeight(scale: Int): Int = GLYPH_H * scale

  private fun blit(
    dest: ByteBuffer,
    frameWidth: Int,
    frameHeight: Int,
    glyph: IntArray,
    originX: Int,
    originY: Int,
    scale: Int,
    on: Byte,
  ) {
    for (row in 0 until GLYPH_H) {
      val bits = glyph[row]
      for (col in 0 until GLYPH_W) {
        if ((bits shr (GLYPH_W - 1 - col)) and 1 == 0) continue
        val x0 = originX + col * scale
        val y0 = originY + row * scale
        val xEnd = (x0 + scale).coerceAtMost(frameWidth)
        val yEnd = (y0 + scale).coerceAtMost(frameHeight)
        val xStart = x0.coerceAtLeast(0)
        val yStart = y0.coerceAtLeast(0)
        if (xStart >= xEnd || yStart >= yEnd) continue
        for (y in yStart until yEnd) {
          val rowOff = y * frameWidth
          for (x in xStart until xEnd) dest.put(rowOff + x, on)
        }
      }
    }
  }

  private fun glyph(ch: Char): IntArray? = when (ch) {
    '0' -> G0
    '1' -> G1
    '2' -> G2
    '3' -> G3
    '4' -> G4
    '5' -> G5
    '6' -> G6
    '7' -> G7
    '8' -> G8
    '9' -> G9
    'F' -> GF
    'P' -> GP
    'S' -> GS
    'X' -> GX
    'x' -> GX
    '.' -> GDOT
    ' ' -> GSPACE
    else -> null
  }

  private val G0 = intArrayOf(0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110)
  private val G1 = intArrayOf(0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110)
  private val G2 = intArrayOf(0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111)
  private val G3 = intArrayOf(0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110)
  private val G4 = intArrayOf(0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010)
  private val G5 = intArrayOf(0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110)
  private val G6 = intArrayOf(0b01110, 0b10000, 0b11110, 0b10001, 0b10001, 0b10001, 0b01110)
  private val G7 = intArrayOf(0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000)
  private val G8 = intArrayOf(0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110)
  private val G9 = intArrayOf(0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110)
  private val GF = intArrayOf(0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000)
  private val GP = intArrayOf(0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000)
  private val GS = intArrayOf(0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110)
  private val GX = intArrayOf(0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001)
  private val GDOT = intArrayOf(0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00100, 0b00100)
  private val GSPACE = intArrayOf(0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000)
}
