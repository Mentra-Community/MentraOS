package com.mentra.acsmeeting.video

/**
 * The NV12 format we advertise to ACS, as plain values.
 *
 * Same split as [I420FormatSpec]: VideoStreamFormat is native-backed and
 * cannot initialize under a JVM unit test. Stride2 is the interleaved UV
 * row (`chromaW * 2`), not a third plane.
 */
data class Nv12FormatSpec(
  val width: Int,
  val height: Int,
  val fps: Float,
  val strideY: Int,
  val strideUv: Int,
) {
  companion object {
    fun of(width: Int = 1280, height: Int = 720, fps: Float = 15f): Nv12FormatSpec =
      Nv12FormatSpec(
        width = width,
        height = height,
        fps = fps,
        strideY = width,
        strideUv = Nv12Packer.strideUv(width),
      )
  }

  fun withinAcsBounds(): Boolean {
    val probe = I420FormatSpec.of(width, height, fps)
    return probe.withinAcsBounds()
  }

  fun namedResolution(): AcsNamedResolution? = I420FormatSpec.of(width, height, fps).namedResolution()

  fun packedSize(): Int = strideY * height + strideUv * Nv12Packer.chromaHeight(height)
}
