package com.mentra.glassesmedia.passthrough

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import org.webrtc.VideoCodecStatus
import org.webrtc.VideoDecoder

class PassthroughH264DecoderTest {
  private val bridge = PassthroughBridge()
  private val decoder = PassthroughH264Decoder(bridge)
  private val out = CapturedDecoded()
  private val settings = VideoDecoder.Settings(1, 960, 540)
  private val intact = VideoDecoder.DecodeInfo(false, 0)
  private val lossy = VideoDecoder.DecodeInfo(true, 0)

  init {
    decoder.initDecode(settings, out)
  }

  @Test
  fun aKeyFrameComesOutAsTheSameBytesWithoutBeingDecoded() {
    val bytes = annexB(1)
    assertThat(decoder.decode(encodedImage(bytes, key = true), intact)).isEqualTo(VideoCodecStatus.OK)
    val buffer = out.frames.single().buffer as EncodedFrameBuffer
    assertThat(bytesOf(buffer.data)).isEqualTo(bytes)
    assertThat(buffer.isKeyFrame).isTrue()
    assertThat(buffer.getWidth()).isEqualTo(960)
    assertThat(buffer.getHeight()).isEqualTo(540)
  }

  @Test
  fun theOutputDoesNotShareMemoryWithLibwebrtcsBuffer() {
    val source = direct(annexB(5))
    val image = org.webrtc.EncodedImage.builder().setBuffer(source, Runnable {}).setEncodedWidth(960)
      .setEncodedHeight(540).setFrameType(org.webrtc.EncodedImage.FrameType.VideoFrameKey).setRotation(0)
      .createEncodedImage()
    decoder.decode(image, intact)
    // libwebrtc reuses its buffer once decode returns.
    source.put(0, 99)
    val buffer = out.frames.single().buffer as EncodedFrameBuffer
    assertThat(buffer.data.get(0)).isEqualTo(0.toByte())
  }

  @Test
  fun theCaptureTimeSurvives() {
    decoder.decode(encodedImage(annexB(1), key = true, captureNs = 123_456L), intact)
    assertThat(out.frames.single().timestampNs).isEqualTo(123_456L)
  }

  @Test
  fun aDeltaFrameBeforeAnyKeyFrameIsRefusedSoTheGlassesAreAskedForOne() {
    assertThat(decoder.decode(encodedImage(annexB(1), key = false), intact)).isEqualTo(VideoCodecStatus.ERROR)
    assertThat(out.frames).isEmpty()
    assertThat(bridge.snapshot().framesDropped).isEqualTo(1)
  }

  @Test
  fun deltaFramesFlowOnceAKeyFrameHasGone() {
    decoder.decode(encodedImage(annexB(1), key = true), intact)
    assertThat(decoder.decode(encodedImage(annexB(2), key = false), intact)).isEqualTo(VideoCodecStatus.OK)
    assertThat(decoder.decode(encodedImage(annexB(3), key = false), intact)).isEqualTo(VideoCodecStatus.OK)
    assertThat(out.frames).hasSize(3)
  }

  @Test
  fun theDeltaFramesRightBehindAKeyFrameAreNotDropped() {
    // The encoder thread has not run yet when they arrive: the wait must already be closed.
    decoder.decode(encodedImage(annexB(1), key = true), intact)
    assertThat(bridge.isWaitingForKeyFrame()).isFalse()
    assertThat(decoder.decode(encodedImage(annexB(2), key = false), intact)).isEqualTo(VideoCodecStatus.OK)
  }

  @Test
  fun aLossOnTheHotspotLegDropsEveryDeltaUntilTheNextKeyFrame() {
    decoder.decode(encodedImage(annexB(1), key = true), intact)
    assertThat(decoder.decode(encodedImage(annexB(2), key = false), lossy)).isEqualTo(VideoCodecStatus.ERROR)
    // Frames behind the gap reference something that never arrived, even though they look intact.
    assertThat(decoder.decode(encodedImage(annexB(3), key = false), intact)).isEqualTo(VideoCodecStatus.ERROR)
    assertThat(out.frames).hasSize(1)

    assertThat(decoder.decode(encodedImage(annexB(4), key = true), intact)).isEqualTo(VideoCodecStatus.OK)
    assertThat(decoder.decode(encodedImage(annexB(5), key = false), intact)).isEqualTo(VideoCodecStatus.OK)
    assertThat(out.frames).hasSize(3)
  }

  @Test
  fun forwardedFramesGetGapFreeSequencesSoTheEncoderCanSeeLibwebrtcsDrops() {
    decoder.decode(encodedImage(annexB(1), key = true), intact)
    decoder.decode(encodedImage(annexB(2), key = false), intact)
    // A delta refused after a loss produces no buffer, so it must not consume a sequence: otherwise
    // the next forwarded frame would look like a gap the encoder never actually suffered.
    decoder.decode(encodedImage(annexB(3), key = false), lossy)
    decoder.decode(encodedImage(annexB(4), key = true), intact)
    val sequences = out.frames.map { (it.buffer as EncodedFrameBuffer).sequence }
    assertThat(sequences).containsExactly(0L, 1L, 2L)
  }

  @Test
  fun aKeyFrameIsNeverRefusedEvenWithFramesMissing() {
    assertThat(decoder.decode(encodedImage(annexB(1), key = true), lossy)).isEqualTo(VideoCodecStatus.OK)
  }

  @Test
  fun decodingBeforeInitIsAnError() {
    val fresh = PassthroughH264Decoder(PassthroughBridge())
    assertThat(fresh.decode(encodedImage(annexB(1), key = true), intact)).isEqualTo(VideoCodecStatus.UNINITIALIZED)
  }

  @Test
  fun releasingStopsDelivery() {
    decoder.release()
    assertThat(decoder.decode(encodedImage(annexB(1), key = true), intact)).isEqualTo(VideoCodecStatus.UNINITIALIZED)
  }

  @Test
  fun itAdmitsToBeingAPassthroughSoALogCanTellTheStreamsApart() {
    assertThat(decoder.implementationName).isEqualTo("MentraH264Passthrough")
  }
}
