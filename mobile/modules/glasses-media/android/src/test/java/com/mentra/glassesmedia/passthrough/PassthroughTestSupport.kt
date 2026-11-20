package com.mentra.glassesmedia.passthrough

import java.nio.ByteBuffer
import org.webrtc.EncodedImage
import org.webrtc.VideoDecoder
import org.webrtc.VideoEncoder
import org.webrtc.VideoFrame

/** Annex B start code plus a recognisable payload, so a test can tell one frame's bytes from another. */
internal fun annexB(tag: Int, size: Int = 32): ByteArray =
  byteArrayOf(0, 0, 0, 1) + ByteArray(size) { (tag + it).toByte() }

internal fun direct(bytes: ByteArray): ByteBuffer =
  ByteBuffer.allocateDirect(bytes.size).apply { put(bytes); flip() }

internal fun encodedImage(
  bytes: ByteArray,
  key: Boolean,
  width: Int = 960,
  height: Int = 540,
  captureNs: Long = 1_000L,
): EncodedImage = EncodedImage.builder()
  .setBuffer(direct(bytes), Runnable {})
  .setEncodedWidth(width)
  .setEncodedHeight(height)
  .setCaptureTimeNs(captureNs)
  .setFrameType(if (key) EncodedImage.FrameType.VideoFrameKey else EncodedImage.FrameType.VideoFrameDelta)
  .setRotation(0)
  .createEncodedImage()

internal fun bytesOf(buffer: ByteBuffer): ByteArray =
  ByteArray(buffer.remaining()).also { buffer.duplicate().get(it) }

internal fun frameBuffer(
  bytes: ByteArray,
  key: Boolean,
  width: Int = 960,
  height: Int = 540,
  sequence: Long = EncodedFrameBuffer.UNSET_SEQUENCE,
) = EncodedFrameBuffer(direct(bytes), width, height, key, sequence)

/** Collects what a decoder hands libwebrtc. */
internal class CapturedDecoded : VideoDecoder.Callback {
  val frames = mutableListOf<VideoFrame>()

  override fun onDecodedFrame(frame: VideoFrame, decodeTimeMs: Int?, qp: Int?) {
    frames += frame
  }
}

/** Collects what an encoder hands libwebrtc. */
internal class CapturedEncoded : VideoEncoder.Callback {
  val images = mutableListOf<EncodedImage>()

  override fun onEncodedFrame(image: EncodedImage, info: VideoEncoder.CodecSpecificInfo) {
    images += image
  }
}
