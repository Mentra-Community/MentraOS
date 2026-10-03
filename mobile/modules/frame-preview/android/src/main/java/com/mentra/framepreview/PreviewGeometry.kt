package com.mentra.framepreview

import kotlin.math.floor
import kotlin.math.sqrt

/** Why a frame was not packed. Values are on the status wire and in NDJSON; do not rename. */
enum class PackFailureReason(val wire: String) {
  ZERO_SIZE("zero_size"),
  STRIDE_TOO_SMALL("stride_too_small"),
  PLANE_OUT_OF_BOUNDS("plane_out_of_bounds"),
  PAYLOAD_MISMATCH("payload_mismatch"),
  SLOT_TOO_SMALL("slot_too_small"),
  SINK_ERROR("sink_error"),
  WORKER_ERROR("worker_error"),
}

data class PreviewSize(val width: Int, val height: Int)

/**
 * Checks run before any byte is copied.
 *
 * A malformed frame must be refused while it is still just numbers: a copy driven by a bad stride
 * or a short plane reads memory the decoder never lent us.
 */
object PreviewGeometry {
  /**
   * Validate a 4:2:0 planar source against the output it is about to produce. [yBytes], [uBytes]
   * and [vBytes] are the bytes readable from each plane's current position.
   */
  fun validateI420(
    width: Int,
    height: Int,
    yBytes: Int,
    strideY: Int,
    uBytes: Int,
    strideU: Int,
    vBytes: Int,
    strideV: Int,
    output: PreviewSize,
    payloadLength: Int,
  ): PackFailureReason? {
    if (width <= 0 || height <= 0 || output.width <= 0 || output.height <= 0) return PackFailureReason.ZERO_SIZE
    // The header carries u16 dimensions and every reader rejects above this; a frame no reader
    // accepts is a payload that cannot match its header.
    if (output.width > PreviewFrameParser.MAX_DIMENSION || output.height > PreviewFrameParser.MAX_DIMENSION) {
      return PackFailureReason.PAYLOAD_MISMATCH
    }
    val chromaWidth = (width + 1) / 2
    val chromaHeight = (height + 1) / 2
    if (strideY < width || strideU < chromaWidth || strideV < chromaWidth) return PackFailureReason.STRIDE_TOO_SMALL
    if (yBytes < planeMinBytes(strideY, width, height) ||
      uBytes < planeMinBytes(strideU, chromaWidth, chromaHeight) ||
      vBytes < planeMinBytes(strideV, chromaWidth, chromaHeight)
    ) {
      return PackFailureReason.PLANE_OUT_OF_BOUNDS
    }
    if (payloadLength != PreviewPixelFormat.I420.packedSize(output.width, output.height)) {
      return PackFailureReason.PAYLOAD_MISMATCH
    }
    return null
  }

  /** A slot must be exactly one frame: Android's `postMessage(byte[])` sends the whole array. */
  fun validateSlot(slotBytes: Int, frameBytes: Int): PackFailureReason? = when {
    slotBytes < frameBytes -> PackFailureReason.SLOT_TOO_SMALL
    slotBytes > frameBytes -> PackFailureReason.PAYLOAD_MISMATCH
    else -> null
  }

  /** Bytes needed from a plane's start: every row but the last is a full stride. */
  fun planeMinBytes(stride: Int, rowWidth: Int, rows: Int): Long {
    if (rows <= 0 || rowWidth <= 0) return 0
    return stride.toLong() * (rows - 1) + rowWidth
  }
}

/** Output sizing: fit the source inside the host's box, keep its aspect, never upscale. */
object PreviewScalePlan {
  /**
   * The largest even-sized frame with the source's aspect ratio that fits inside
   * [boxWidth]x[boxHeight]. A source already inside the box is returned unchanged.
   */
  fun fit(sourceWidth: Int, sourceHeight: Int, boxWidth: Int, boxHeight: Int): PreviewSize {
    if (sourceWidth <= 0 || sourceHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) {
      return PreviewSize(sourceWidth, sourceHeight)
    }
    if (sourceWidth <= boxWidth && sourceHeight <= boxHeight) return PreviewSize(sourceWidth, sourceHeight)
    val width: Long
    val height: Long
    // Integer cross-multiplication so the limiting side is chosen without float drift.
    if (boxWidth.toLong() * sourceHeight <= boxHeight.toLong() * sourceWidth) {
      width = boxWidth.toLong()
      height = sourceHeight.toLong() * boxWidth / sourceWidth
    } else {
      height = boxHeight.toLong()
      width = sourceWidth.toLong() * boxHeight / sourceHeight
    }
    return PreviewSize(even(width.toInt(), sourceWidth), even(height.toInt(), sourceHeight))
  }

  /** Shrink a box to at most [maxPixels], keeping its shape. The host quantizes; this is a guard. */
  fun clampBox(width: Int, height: Int, maxPixels: Int): PreviewSize {
    if (width <= 0 || height <= 0) return PreviewSize(width.coerceAtLeast(0), height.coerceAtLeast(0))
    val pixels = width.toLong() * height
    if (pixels <= maxPixels) return PreviewSize(width, height)
    val scale = sqrt(maxPixels.toDouble() / pixels)
    return PreviewSize(
      floor(width * scale).toInt().coerceAtLeast(2),
      floor(height * scale).toInt().coerceAtLeast(2),
    )
  }

  // Even sizes keep every chroma sample covering exactly two luma columns and rows.
  private fun even(value: Int, source: Int): Int {
    val rounded = if (value > 2 && value % 2 == 1) value - 1 else value
    return rounded.coerceAtLeast(2).coerceAtMost(source)
  }
}
