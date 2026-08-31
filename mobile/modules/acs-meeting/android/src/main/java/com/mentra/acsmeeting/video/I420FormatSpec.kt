package com.mentra.acsmeeting.video

/**
 * The I420 format we advertise to ACS, as plain values.
 *
 * Split out from [AcsFrameSender.i420Format] because VideoStreamFormat is a
 * native-backed ACS class that cannot initialize under a JVM unit test. The
 * arithmetic is the part worth asserting; applying it to the SDK object is not.
 *
 * Strides must agree with [I420Packer], or ACS reads the chroma planes at the
 * wrong offsets and the picture greens out.
 */
data class I420FormatSpec(
  val width: Int,
  val height: Int,
  val fps: Float,
  val strideY: Int,
  val strideU: Int,
  val strideV: Int,
) {
  companion object {
    const val MIN_WIDTH = 240
    const val MAX_WIDTH = 1920
    const val MIN_HEIGHT = 180
    const val MAX_HEIGHT = 1080
    const val MIN_FPS = 1f
    const val MAX_FPS = 30f

    fun of(width: Int = 1280, height: Int = 720, fps: Float = 20f): I420FormatSpec {
      val chroma = I420Packer.chromaStride(width)
      return I420FormatSpec(
        width = width,
        height = height,
        fps = fps,
        strideY = width,
        strideU = chroma,
        strideV = chroma,
      )
    }
  }

  fun withinAcsBounds(): Boolean =
    width in MIN_WIDTH..MAX_WIDTH && height in MIN_HEIGHT..MAX_HEIGHT && fps in MIN_FPS..MAX_FPS

  /** Bytes ACS will read given these strides; must equal what [I420Packer] writes. */
  fun packedSize(): Int = strideY * height + 2 * (strideU * I420Packer.chromaStride(height))
}
