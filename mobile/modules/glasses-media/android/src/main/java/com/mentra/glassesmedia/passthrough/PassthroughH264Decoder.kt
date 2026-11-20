package com.mentra.glassesmedia.passthrough

import java.nio.ByteBuffer
import org.webrtc.EncodedImage
import org.webrtc.VideoCodecInfo
import org.webrtc.VideoCodecStatus
import org.webrtc.VideoDecoder
import org.webrtc.VideoDecoderFactory
import org.webrtc.VideoFrame

/**
 * A decoder that does not decode. It copies the H.264 bytes libwebrtc hands it into an
 * [EncodedFrameBuffer] and reports that as the decoded frame, so the encoded stream reaches
 * [PassthroughH264Encoder] on the phone's uplink untouched.
 *
 * Two rules keep the forwarded stream decodable downstream:
 *
 * - A frame that follows a loss is dropped. [VideoDecoder.DecodeInfo.isMissingFrames] says the
 *   glasses' frames did not all arrive, and a delta frame after a gap references something that never
 *   made it. Returning [VideoCodecStatus.ERROR] is how libwebrtc is told to stop feeding delta
 *   frames and ask the glasses for a key frame, which is exactly the repair needed.
 * - Frames wait for a key frame while the bridge says so, for the same reason.
 */
class PassthroughH264Decoder(private val bridge: PassthroughBridge) : VideoDecoder {
  @Volatile private var callback: VideoDecoder.Callback? = null

  override fun initDecode(settings: VideoDecoder.Settings, decodeCallback: VideoDecoder.Callback): VideoCodecStatus {
    callback = decodeCallback
    return VideoCodecStatus.OK
  }

  override fun release(): VideoCodecStatus {
    callback = null
    return VideoCodecStatus.OK
  }

  // `info` is nullable on purpose: libwebrtc can hand this callback a null DecodeInfo over JNI, and a
  // non-null Kotlin parameter turns that into an NPE inside the native thread, which aborts the app.
  override fun decode(image: EncodedImage, info: VideoDecoder.DecodeInfo?): VideoCodecStatus {
    val deliver = callback ?: return VideoCodecStatus.UNINITIALIZED
    bridge.noteIn()
    val key = image.frameType == EncodedImage.FrameType.VideoFrameKey
    if (!key) {
      if (info?.isMissingFrames == true) bridge.wantKeyFrame("frames lost on the glasses hotspot leg")
      if (bridge.isWaitingForKeyFrame()) {
        bridge.noteDropped()
        return VideoCodecStatus.ERROR
      }
    }
    val bytes = image.buffer.duplicate()
    val copy = ByteBuffer.allocateDirect(bytes.remaining())
    copy.put(bytes)
    copy.flip()
    // Opened by the key frame itself, here, rather than when it leaves the encoder: the delta frames
    // right behind it arrive before the encoder thread has run, and must not be dropped for waiting.
    if (key) bridge.keyFrameForwarded()
    // Stamped here, before libwebrtc's sender-side bitrate dropper can discard it unannounced, so the
    // encoder sees a gap in the order and can withhold the deltas that depend on what went missing.
    val buffer = EncodedFrameBuffer(copy, image.encodedWidth, image.encodedHeight, key, bridge.nextSequence())
    val frame = VideoFrame(buffer, image.rotation, image.captureTimeNs)
    try {
      deliver.onDecodedFrame(frame, null, null)
    } finally {
      buffer.release()
    }
    return VideoCodecStatus.OK
  }

  override fun getImplementationName(): String = IMPLEMENTATION_NAME

  companion object {
    const val IMPLEMENTATION_NAME = "MentraH264Passthrough"
  }
}

/**
 * Decodes H.264 with [PassthroughH264Decoder] and everything else, which a glasses stream does not
 * contain, with the platform factory it wraps. The supported list is the wrapped factory's, so what
 * the receiver offers the glasses in the SDP is unchanged.
 */
class PassthroughDecoderFactory(
  private val wrapped: VideoDecoderFactory,
  private val bridge: PassthroughBridge,
) : VideoDecoderFactory {
  override fun createDecoder(info: VideoCodecInfo): VideoDecoder? =
    if (info.name.equals("H264", ignoreCase = true)) PassthroughH264Decoder(bridge) else wrapped.createDecoder(info)

  override fun getSupportedCodecs(): Array<VideoCodecInfo> = wrapped.supportedCodecs
}
