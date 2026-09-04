package com.mentra.acsmeeting.video

/**
 * Pack I420 in the buffer's coordinate system, never [VideoFrame.rotatedWidth].
 * cropAndScale and toI420 planes are un-rotated; mixing them with display size
 * overruns the plane at rotation 90/270.
 */
object FrameGeometry {
  data class PackSize(
    val width: Int,
    val height: Int,
    val rotationNonZero: Boolean,
  )

  fun packSize(bufferWidth: Int, bufferHeight: Int, rotationDegrees: Int): PackSize {
    return PackSize(
      width = bufferWidth,
      height = bufferHeight,
      rotationNonZero = rotationDegrees % 360 != 0,
    )
  }
}
