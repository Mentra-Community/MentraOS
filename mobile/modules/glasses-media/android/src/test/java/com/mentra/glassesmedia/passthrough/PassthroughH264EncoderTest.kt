package com.mentra.glassesmedia.passthrough

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import org.webrtc.EncodedImage
import org.webrtc.VideoCodecInfo
import org.webrtc.VideoCodecStatus
import org.webrtc.VideoEncoder
import org.webrtc.VideoFrame

class PassthroughH264EncoderTest {
  private val bridge = PassthroughBridge()
  private val encoder = PassthroughH264Encoder(bridge)
  private val out = CapturedEncoded()
  private val settings = VideoEncoder.Settings(1, 960, 540, 2_000_000, 15, 1, false)

  init {
    encoder.initEncode(settings, out)
  }

  private fun delta() = arrayOf(EncodedImage.FrameType.VideoFrameDelta)

  private fun key() = arrayOf(EncodedImage.FrameType.VideoFrameKey)

  private fun encode(buffer: EncodedFrameBuffer, types: Array<EncodedImage.FrameType> = delta(), ts: Long = 1_000L) =
    encoder.encode(VideoFrame(buffer, 0, ts), VideoEncoder.EncodeInfo(types))

  @Test
  fun aKeyFrameGoesOutAsTheSameBytesMarkedAsAKeyFrame() {
    val bytes = annexB(7)
    assertThat(encode(frameBuffer(bytes, key = true))).isEqualTo(VideoCodecStatus.OK)
    val image = out.images.single()
    assertThat(bytesOf(image.buffer)).isEqualTo(bytes)
    assertThat(image.frameType).isEqualTo(EncodedImage.FrameType.VideoFrameKey)
    assertThat(image.encodedWidth).isEqualTo(960)
    assertThat(image.encodedHeight).isEqualTo(540)
  }

  @Test
  fun theFrameKeepsItsOwnTimestampAndRotationIsZero() {
    encode(frameBuffer(annexB(1), key = true), ts = 5_000_000L)
    val image = out.images.single()
    assertThat(image.captureTimeNs).isEqualTo(5_000_000L)
    assertThat(image.captureTimeMs).isEqualTo(5L)
    assertThat(image.rotation).isEqualTo(0)
  }

  @Test
  fun deltaFramesAfterAKeyFrameGoOutAsDeltas() {
    encode(frameBuffer(annexB(1), key = true))
    encode(frameBuffer(annexB(2), key = false))
    assertThat(out.images.map { it.frameType }).containsExactly(
      EncodedImage.FrameType.VideoFrameKey,
      EncodedImage.FrameType.VideoFrameDelta,
    )
  }

  @Test
  fun aDeltaFrameBeforeAnyKeyFrameIsDroppedAndAKeyFrameIsWanted() {
    assertThat(encode(frameBuffer(annexB(1), key = false))).isEqualTo(VideoCodecStatus.OK)
    assertThat(out.images).isEmpty()
    assertThat(bridge.snapshot().framesDropped).isEqualTo(1)
    assertThat(bridge.isWaitingForKeyFrame()).isTrue()
  }

  @Test
  fun theUplinkAskingForAKeyFrameOnADeltaReachesTheGlasses() {
    encode(frameBuffer(annexB(1), key = true))
    bridge.keyFrameForwarded()
    encode(frameBuffer(annexB(2), key = false), types = key())
    assertThat(bridge.isWaitingForKeyFrame()).isTrue()
    assertThat(bridge.snapshot().keyFrameRequests).isEqualTo(1)
    // The delta still goes out: the uplink may be able to use it.
    assertThat(out.images).hasSize(2)
  }

  @Test
  fun aGapFromLibwebrtcsOwnDropperWithholdsTheDependentDeltasUntilAKeyFrame() {
    // libwebrtc's bitrate dropper can discard a frame between the decoder and encode() without any
    // callback. The sequence stamped by the decoder jumps, so the delta behind the gap is held back.
    encode(frameBuffer(annexB(1), key = true, sequence = 0))
    bridge.keyFrameForwarded() // the decoder opens the stream when the key passes it.
    encode(frameBuffer(annexB(2), key = false, sequence = 1))
    // sequence 2 was dropped by libwebrtc; 3 arrives next and references what went missing.
    assertThat(encode(frameBuffer(annexB(4), key = false, sequence = 3))).isEqualTo(VideoCodecStatus.OK)
    assertThat(bridge.isWaitingForKeyFrame()).isTrue()
    assertThat(bridge.snapshot().keyFrameRequests).isEqualTo(1)
    // Two frames out: the key frame and the one contiguous delta, never the delta behind the gap.
    assertThat(out.images.map { it.frameType }).containsExactly(
      EncodedImage.FrameType.VideoFrameKey,
      EncodedImage.FrameType.VideoFrameDelta,
    )

    // Every further delta stays withheld, even contiguous ones, until the stream re-syncs.
    encode(frameBuffer(annexB(5), key = false, sequence = 4))
    assertThat(out.images).hasSize(2)

    // A fresh key frame re-syncs the stream and deltas flow again.
    encode(frameBuffer(annexB(6), key = true, sequence = 5))
    bridge.keyFrameForwarded()
    encode(frameBuffer(annexB(7), key = false, sequence = 6))
    assertThat(out.images.map { it.frameType }).containsExactly(
      EncodedImage.FrameType.VideoFrameKey,
      EncodedImage.FrameType.VideoFrameDelta,
      EncodedImage.FrameType.VideoFrameKey,
      EncodedImage.FrameType.VideoFrameDelta,
    )
  }

  @Test
  fun contiguousStampedDeltasAreNotMistakenForAGap() {
    encode(frameBuffer(annexB(1), key = true, sequence = 0))
    bridge.keyFrameForwarded()
    encode(frameBuffer(annexB(2), key = false, sequence = 1))
    encode(frameBuffer(annexB(3), key = false, sequence = 2))
    assertThat(out.images).hasSize(3)
    assertThat(bridge.isWaitingForKeyFrame()).isFalse()
    assertThat(bridge.snapshot().framesDropped).isZero()
  }

  @Test
  fun aKeyFrameIsNotRefusedWhenTheUplinkAsksForOne() {
    assertThat(encode(frameBuffer(annexB(1), key = true), types = key())).isEqualTo(VideoCodecStatus.OK)
    assertThat(out.images).hasSize(1)
  }

  @Test
  fun aFrameThatIsNotAPassthroughFrameIsRefusedNotMisread() {
    val other = object : VideoFrame.Buffer by frameBuffer(annexB(1), key = true) {}
    assertThat(encoder.encode(VideoFrame(other, 0, 1L), VideoEncoder.EncodeInfo(delta())))
      .isEqualTo(VideoCodecStatus.ERR_PARAMETER)
  }

  @Test
  fun theFrameIsHeldWhileLibwebrtcUsesItAndLetGoAfter() {
    val buffer = frameBuffer(annexB(1), key = true)
    encode(buffer)
    assertThat(buffer.referenceCount()).isEqualTo(2)
    out.images.single().release()
    assertThat(buffer.referenceCount()).isEqualTo(1)
  }

  @Test
  fun theUplinkRateIsRecordedAndNothingElseHappens() {
    val allocation = VideoEncoder.BitrateAllocation(arrayOf(intArrayOf(1_200_000)))
    assertThat(encoder.setRates(VideoEncoder.RateControlParameters(allocation, 15.0))).isEqualTo(VideoCodecStatus.OK)
    assertThat(bridge.uplinkTargetBps).isEqualTo(1_200_000)
  }

  @Test
  fun libwebrtcIsToldNeverToShrinkThePicture() {
    assertThat(encoder.scalingSettings.on).isFalse()
  }

  @Test
  fun encodingBeforeInitIsAnError() {
    val fresh = PassthroughH264Encoder(PassthroughBridge())
    assertThat(fresh.encode(VideoFrame(frameBuffer(annexB(1), key = true), 0, 1L), VideoEncoder.EncodeInfo(delta())))
      .isEqualTo(VideoCodecStatus.UNINITIALIZED)
  }

  @Test
  fun theFactoryOffersH264OnlyInBothProfilesWithPacketizationModeOne() {
    val codecs = PassthroughEncoderFactory(bridge).supportedCodecs
    assertThat(codecs.map { it.name }.toSet()).containsExactly("H264")
    assertThat(codecs.map { it.params[VideoCodecInfo.H264_FMTP_PROFILE_LEVEL_ID] }).containsExactlyInAnyOrder(
      VideoCodecInfo.H264_CONSTRAINED_BASELINE_3_1,
      VideoCodecInfo.H264_CONSTRAINED_HIGH_3_1,
    )
    assertThat(codecs.all { it.params[VideoCodecInfo.H264_FMTP_PACKETIZATION_MODE] == "1" }).isTrue()
  }

  @Test
  fun theFactoryMakesNoEncoderForAnyOtherCodec() {
    val factory = PassthroughEncoderFactory(bridge)
    assertThat(factory.createEncoder(VideoCodecInfo("VP8", emptyMap(), emptyList()))).isNull()
    assertThat(factory.createEncoder(VideoCodecInfo("H264", emptyMap(), emptyList()))).isNotNull()
  }
}
