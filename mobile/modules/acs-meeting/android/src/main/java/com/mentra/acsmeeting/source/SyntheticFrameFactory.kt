package com.mentra.acsmeeting.source

import com.mentra.acsmeeting.video.I420Packer
import java.nio.ByteBuffer
import kotlin.math.max

/**
 * Packed I420 generator. No Android / ACS / WebRTC types so JVM tests stay cheap.
 *
 * CHEAP paints a flat field, a moving bar, and a Recall-style stamp (6-digit
 * frame id + 1s FPS). Low motion: enough change that ACS cannot skip, still
 * trivially compressible.
 *
 * MOTION pans a tiled scene across the frame. That is the glasses-turn proxy:
 * temporal prediction dies (almost every pixel changes) but spatial structure
 * stays, so an I-frame still compresses. Use this to ask whether ACS holds
 * 15 fps under high motion.
 *
 * NOISE rewrites the whole Y plane from an LCG. That is not camera motion.
 * Neighbors are uncorrelated, so even I-frames stay huge. Measured on ACS at
 * 720p it pinned ~1.9 Mbps and collapsed the wire rate to 1.4 fps while we
 * submitted 15. Use it to stress the encoder, never to model glasses movement.
 *
 * Chroma stays at 128 in every mode.
 */
class SyntheticFrameFactory(
  private val entropy: SyntheticEntropy = SyntheticEntropy.CHEAP,
) {
  private var lastDest: ByteBuffer? = null
  private var lastWidth = 0
  private var lastHeight = 0
  private var background: ByteArray? = null
  private var scene: ByteArray? = null
  private var sceneWidth = 0
  private var sceneHeight = 0

  fun write(dest: ByteBuffer, width: Int, height: Int, frameIndex: Int, emitFps: Double? = null) {
    require(width > 0 && height > 0) { "size must be positive" }
    val needed = I420Packer.packedSize(width, height)
    require(dest.capacity() >= needed) { "dest capacity ${dest.capacity()} < $needed" }
    when (entropy) {
      SyntheticEntropy.NOISE -> writeNoise(dest, width, height, frameIndex)
      SyntheticEntropy.MOTION -> writeMotion(dest, width, height, frameIndex)
      SyntheticEntropy.CHEAP -> writeCheap(dest, width, height, frameIndex)
    }
    writeStamp(dest, width, height, frameIndex, emitFps)
    dest.position(0)
    dest.limit(needed)
  }

  private fun writeCheap(dest: ByteBuffer, width: Int, height: Int, frameIndex: Int) {
    // Bulk-restore the field instead of a per-pixel loop: this runs on the emit
    // thread every frame, and 921600 single-byte puts is exactly the Kotlin
    // per-pixel cost the rest of this module exists to avoid.
    val ySize = width * height
    val template = background.takeIf { it != null && it.size == ySize }
      ?: ByteArray(ySize) { BG_Y }.also { background = it }
    dest.clear()
    dest.put(template, 0, ySize)
    if (dest !== lastDest || width != lastWidth || height != lastHeight) {
      fillChroma(dest, width, height)
      lastDest = dest
      lastWidth = width
      lastHeight = height
    }
    val barWidth = max(8, width / 80)
    val travel = max(1, width - barWidth)
    val barX = ((frameIndex.toLong() * barWidth) % travel).toInt()
    fillYRect(dest, width, height, barX, 0, barWidth, height, BAR_Y)
  }

  /**
   * Copy a pre-painted tiled scene with a wrap-safe offset. One bulk put per
   * row, not one put per pixel — the scene is the glasses-turn stand-in, and
   * generating it in Kotlin every frame would be the cost we are trying to
   * isolate out of this measurement.
   */
  private fun writeMotion(dest: ByteBuffer, width: Int, height: Int, frameIndex: Int) {
    val field = ensureScene(width, height)
    val ox = ((frameIndex.toLong() * PAN_X) % TILE).toInt()
    val oy = ((frameIndex.toLong() * PAN_Y) % TILE).toInt()
    for (row in 0 until height) {
      dest.position(row * width)
      dest.put(field, (row + oy) * sceneWidth + ox, width)
    }
    if (dest !== lastDest || width != lastWidth || height != lastHeight) {
      fillChroma(dest, width, height)
      lastDest = dest
      lastWidth = width
      lastHeight = height
    }
  }

  private fun ensureScene(width: Int, height: Int): ByteArray {
    val sw = width + TILE
    val sh = height + TILE
    val existing = scene
    if (existing != null && sceneWidth == sw && sceneHeight == sh) return existing
    val field = ByteArray(sw * sh)
    for (y in 0 until sh) {
      val rowOff = y * sw
      val tileY = y / TILE
      val gy = y % TILE
      for (x in 0 until sw) {
        val tile = (x / TILE + tileY) and 1
        val gx = x % TILE
        val base = if (tile == 0) DARK_TILE else LIGHT_TILE
        field[rowOff + x] = (base + gx - TILE / 2 + gy / 4).toByte()
      }
    }
    scene = field
    sceneWidth = sw
    sceneHeight = sh
    return field
  }

  private fun writeNoise(dest: ByteBuffer, width: Int, height: Int, frameIndex: Int) {
    writeNoiseY(dest, width, height, frameIndex)
    fillChroma(dest, width, height)
    lastDest = dest
    lastWidth = width
    lastHeight = height
  }

  private fun writeNoiseY(dest: ByteBuffer, width: Int, height: Int, frameIndex: Int) {
    val ySize = width * height
    var seed = (frameIndex + 1) * LCG_SEED
    for (i in 0 until ySize) {
      seed = seed * LCG_MUL + LCG_ADD
      dest.put(i, ((seed ushr 24) and 0xFF).toByte())
    }
  }

  /**
   * Recall burns `F 000123` plus live rates into the captured page. Same idea here:
   * a 6-digit unique-frame id and the last 1s emit rate, readable on the Teams tile.
   */
  private fun writeStamp(
    dest: ByteBuffer,
    width: Int,
    height: Int,
    frameIndex: Int,
    emitFps: Double?,
  ) {
    val scale = (height / 60).coerceIn(8, 16)
    val line1 = "F ${frameIndex.coerceAtLeast(0).toString().padStart(6, '0')}"
    val fpsLabel = emitFps?.let { ((it * 10).toInt() / 10.0).toString() } ?: "--"
    val line2 = "FPS $fpsLabel"
    val pad = scale * 2
    val lineH = BitmapFont.textHeight(scale)
    val gap = scale
    val boxW = max(BitmapFont.textWidth(line1.length, scale), BitmapFont.textWidth(line2.length, scale)) + pad * 2
    val boxH = lineH * 2 + gap + pad * 2
    val boxX = (width / 16).coerceAtLeast(16)
    val boxY = (height / 2 - boxH / 2).coerceAtLeast(0)
    fillYRect(dest, width, height, boxX, boxY, boxW, boxH, OFF_Y)
    BitmapFont.draw(dest, width, height, line1, boxX + pad, boxY + pad, scale, BAR_Y)
    BitmapFont.draw(dest, width, height, line2, boxX + pad, boxY + pad + lineH + gap, scale, BAR_Y)
  }

  private fun fillChroma(dest: ByteBuffer, width: Int, height: Int) {
    val ySize = width * height
    val uvSize = I420Packer.chromaStride(width) * I420Packer.chromaStride(height)
    val end = ySize + 2 * uvSize
    for (i in ySize until end) dest.put(i, CHROMA)
  }

  private fun fillYRect(
    dest: ByteBuffer,
    width: Int,
    height: Int,
    x0: Int,
    y0: Int,
    rectW: Int,
    rectH: Int,
    value: Byte,
  ) {
    val xStart = x0.coerceIn(0, width)
    val yStart = y0.coerceIn(0, height)
    val xEnd = (x0 + rectW).coerceIn(0, width)
    val yEnd = (y0 + rectH).coerceIn(0, height)
    if (xStart >= xEnd || yStart >= yEnd) return
    for (row in yStart until yEnd) {
      val rowOff = row * width
      for (col in xStart until xEnd) {
        dest.put(rowOff + col, value)
      }
    }
  }

  companion object {
    const val BG_Y: Byte = 40
    const val OFF_Y: Byte = 16
    const val BAR_Y: Byte = 235.toByte()
    const val CHROMA: Byte = 128.toByte()
    const val TILE = 32
    const val PAN_X = 8
    const val PAN_Y = 4
    private const val DARK_TILE = 70
    private const val LIGHT_TILE = 170
    private const val LCG_SEED = -1640531527
    private const val LCG_MUL = 1664525
    private const val LCG_ADD = 1013904223
  }
}
