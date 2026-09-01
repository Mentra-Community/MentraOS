package com.mentra.acsmeeting.video

/**
 * ACS Android [com.azure.android.communication.calling.VideoStreamResolution]
 * names. The virtual outgoing stream wants these exact sizes. Near-matches
 * fail even when WHEP preview works: P480 is 858×480, not 854×480. Portrait
 * 540×960 is not a named size; ACS P540 is 960×540.
 */
enum class AcsNamedResolution {
  P1080,
  P720,
  P540,
  P480,
  P360,
  P270,
  P240,
  P180,
  VGA,
  QVGA,
}

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

    /** VirtualOutgoingVideoStream join allowlist. P540 is 960×540, never 540×960. */
    private val ALLOWED_SIZES = setOf(1280 to 720, 960 to 540)

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

    fun parseOrNull(width: Int, height: Int, fps: Float): I420FormatSpec? {
      if (width to height !in ALLOWED_SIZES) return null
      val spec = of(width, height, fps)
      return if (spec.withinAcsBounds()) spec else null
    }
  }

  fun withinAcsBounds(): Boolean =
    width in MIN_WIDTH..MAX_WIDTH && height in MIN_HEIGHT..MAX_HEIGHT && fps in MIN_FPS..MAX_FPS

  /** Named ACS resolution for this geometry, or null if we must advertise raw size. */
  fun namedResolution(): AcsNamedResolution? = when (width to height) {
    1920 to 1080 -> AcsNamedResolution.P1080
    1280 to 720 -> AcsNamedResolution.P720
    960 to 540 -> AcsNamedResolution.P540
    858 to 480 -> AcsNamedResolution.P480
    640 to 360 -> AcsNamedResolution.P360
    480 to 270 -> AcsNamedResolution.P270
    352 to 240 -> AcsNamedResolution.P240
    320 to 180 -> AcsNamedResolution.P180
    640 to 480 -> AcsNamedResolution.VGA
    320 to 240 -> AcsNamedResolution.QVGA
    else -> null
  }

  /** Bytes ACS will read given these strides; must equal what [I420Packer] writes. */
  fun packedSize(): Int = strideY * height + 2 * (strideU * I420Packer.chromaStride(height))
}
