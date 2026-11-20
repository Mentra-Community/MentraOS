package com.mentra.glassesmedia.passthrough

import org.webrtc.EncodedImage
import org.webrtc.VideoCodecInfo
import org.webrtc.VideoCodecStatus
import org.webrtc.VideoEncoder
import org.webrtc.VideoEncoderFactory
import org.webrtc.VideoFrame

/**
 * An encoder that does not encode: the frame it is given already carries the glasses' H.264, so it
 * hands those bytes to libwebrtc as the encoded result, with the original key/delta marking.
 *
 * It cannot follow the bitrate libwebrtc asks for, because the glasses decide the rate. [setRates]
 * records what the uplink would allow so a log can show a gap between the two, and nothing more.
 *
 * It cannot make a key frame either. When the uplink asks for one and this frame is a delta, the
 * request goes to the bridge, which has the receiver ask the glasses for one.
 */
class PassthroughH264Encoder(private val bridge: PassthroughBridge) : VideoEncoder {
  @Volatile private var callback: VideoEncoder.Callback? = null
  private var sentKeyFrame = false
  /** The last frame's sequence, to spot one libwebrtc dropped between the decoder and here. */
  private var lastSequence = EncodedFrameBuffer.UNSET_SEQUENCE
  /** Set when a drop or gap is detected; holds deltas back until a fresh key frame re-syncs. */
  private var awaitingResync = false

  override fun initEncode(settings: VideoEncoder.Settings, encodeCallback: VideoEncoder.Callback): VideoCodecStatus {
    callback = encodeCallback
    sentKeyFrame = false
    lastSequence = EncodedFrameBuffer.UNSET_SEQUENCE
    awaitingResync = false
    return VideoCodecStatus.OK
  }

  override fun release(): VideoCodecStatus {
    callback = null
    return VideoCodecStatus.OK
  }

  override fun encode(frame: VideoFrame, info: VideoEncoder.EncodeInfo?): VideoCodecStatus {
    val deliver = callback ?: return VideoCodecStatus.UNINITIALIZED
    val source = frame.buffer as? EncodedFrameBuffer ?: return VideoCodecStatus.ERR_PARAMETER
    val uplinkWantsKey = info?.frameTypes?.any { it == EncodedImage.FrameType.VideoFrameKey } ?: false

    // libwebrtc's VideoStreamEncoder runs its own bitrate frame dropper before encode(), and
    // DegradationPreference.DISABLED does not turn it off. When the uplink target falls below the
    // glasses' fixed bitrate it can discard frames here without telling the bridge, so a gap in the
    // decoder's gap-free sequence means a frame went missing on the way in. Every delta behind that
    // gap references something downstream will never get, so treat it like a loss on the hotspot
    // leg: ask the glasses for a key frame and hold the deltas until one arrives.
    val previous = lastSequence
    lastSequence = source.sequence
    val gapBeforeThisFrame = !source.isKeyFrame &&
      source.sequence != EncodedFrameBuffer.UNSET_SEQUENCE &&
      previous != EncodedFrameBuffer.UNSET_SEQUENCE &&
      source.sequence != previous + 1

    if (source.isKeyFrame) {
      // The key frame re-syncs the stream; whatever was lost before it no longer matters.
      awaitingResync = false
    } else {
      // The first frame out must be a key frame, and one the uplink asked for cannot be made here.
      if (!sentKeyFrame) {
        bridge.noteDropped()
        bridge.wantKeyFrame("no key frame has gone to the uplink yet")
        return VideoCodecStatus.OK
      }
      if (gapBeforeThisFrame) {
        awaitingResync = true
        bridge.wantKeyFrame("frames dropped before the passthrough encoder")
      }
      if (uplinkWantsKey) bridge.wantKeyFrame("the uplink asked for a key frame")
      // Hold deltas while recovering from a gap: forwarding one references frames the receiver
      // never got, which corrupts or freezes the stream rebuilt at the uplink.
      if (awaitingResync) {
        bridge.noteDropped()
        return VideoCodecStatus.OK
      }
    }
    source.retain()
    val image = EncodedImage.builder()
      .setBuffer(source.data.duplicate(), Runnable { source.release() })
      .setEncodedWidth(source.getWidth())
      .setEncodedHeight(source.getHeight())
      .setCaptureTimeNs(frame.timestampNs)
      .setCaptureTimeMs(frame.timestampNs / 1_000_000)
      .setFrameType(if (source.isKeyFrame) EncodedImage.FrameType.VideoFrameKey else EncodedImage.FrameType.VideoFrameDelta)
      .setRotation(0)
      .createEncodedImage()
    if (source.isKeyFrame) sentKeyFrame = true
    bridge.noteOut(source.sizeBytes, source.isKeyFrame)
    deliver.onEncodedFrame(image, VideoEncoder.CodecSpecificInfoH264())
    return VideoCodecStatus.OK
  }

  override fun setRateAllocation(allocation: VideoEncoder.BitrateAllocation, framerate: Int): VideoCodecStatus {
    bridge.uplinkTargetBps = allocation.sum
    return VideoCodecStatus.OK
  }

  override fun setRates(parameters: VideoEncoder.RateControlParameters): VideoCodecStatus {
    bridge.uplinkTargetBps = parameters.bitrate.sum
    return VideoCodecStatus.OK
  }

  /** Never ask libwebrtc to shrink the picture: it cannot be resized here. */
  override fun getScalingSettings(): VideoEncoder.ScalingSettings = VideoEncoder.ScalingSettings.OFF

  override fun getImplementationName(): String = PassthroughH264Decoder.IMPLEMENTATION_NAME
}

/**
 * Offers H.264 only, in the two profiles libwebrtc's own factory offers, because the glasses'
 * hardware encoder is H.264 and Cloudflare already accepts that on the Wi-Fi path. The profile in
 * the offer is a label: what the decoder at the far end reads is the profile inside the stream.
 */
class PassthroughEncoderFactory(private val bridge: PassthroughBridge) : VideoEncoderFactory {
  override fun createEncoder(info: VideoCodecInfo): VideoEncoder? =
    if (info.name.equals("H264", ignoreCase = true)) PassthroughH264Encoder(bridge) else null

  override fun getSupportedCodecs(): Array<VideoCodecInfo> = arrayOf(
    h264(VideoCodecInfo.H264_CONSTRAINED_BASELINE_3_1),
    h264(VideoCodecInfo.H264_CONSTRAINED_HIGH_3_1),
  )

  private fun h264(profileLevelId: String) = VideoCodecInfo(
    "H264",
    mapOf(
      VideoCodecInfo.H264_FMTP_PROFILE_LEVEL_ID to profileLevelId,
      VideoCodecInfo.H264_FMTP_LEVEL_ASYMMETRY_ALLOWED to "1",
      VideoCodecInfo.H264_FMTP_PACKETIZATION_MODE to "1",
    ),
    emptyList(),
  )
}
