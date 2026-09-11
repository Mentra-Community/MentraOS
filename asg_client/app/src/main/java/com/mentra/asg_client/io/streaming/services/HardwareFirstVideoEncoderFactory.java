package com.mentra.asg_client.io.streaming.services;

import androidx.annotation.Nullable;

import org.webrtc.EglBase;
import org.webrtc.HardwareVideoEncoderFactory;
import org.webrtc.SoftwareVideoEncoderFactory;
import org.webrtc.VideoCodecInfo;
import org.webrtc.VideoEncoder;
import org.webrtc.VideoEncoderFactory;
import org.webrtc.VideoEncoderFallback;

import java.util.Arrays;
import java.util.LinkedHashSet;

/**
 * Combines the WebRTC hardware and software encoder factories like
 * {@link org.webrtc.DefaultVideoEncoderFactory}, but advertises hardware codecs FIRST.
 *
 * DefaultVideoEncoderFactory lists software codecs (VP8/VP9/AV1 — libvpx/libaom on the
 * CPU) ahead of hardware ones, the SDP offer follows that order, and WHIP servers
 * generally answer with the first offered codec they support. On Mentra Live (MediaTek
 * MT6761) the only hardware video encoder is H.264 (OMX.MTK.VIDEO.ENCODER.AVC), so
 * software-first ordering makes streams negotiate VP8 and encode on the CPU.
 * Hardware-first ordering lets H.264 lead the offer so encoding runs on the VPU.
 */
public class HardwareFirstVideoEncoderFactory implements VideoEncoderFactory {

  private final VideoEncoderFactory mHardwareFactory;
  private final VideoEncoderFactory mSoftwareFactory = new SoftwareVideoEncoderFactory();

  public HardwareFirstVideoEncoderFactory(EglBase.Context eglContext) {
    mHardwareFactory = new HardwareVideoEncoderFactory(
        eglContext, /* enableIntelVp8Encoder= */ true, /* enableH264HighProfile= */ false);
  }

  @Nullable
  @Override
  public VideoEncoder createEncoder(VideoCodecInfo info) {
    VideoEncoder hardwareEncoder = mHardwareFactory.createEncoder(info);
    VideoEncoder softwareEncoder = mSoftwareFactory.createEncoder(info);
    if (hardwareEncoder != null && softwareEncoder != null) {
      return new VideoEncoderFallback(
          /* fallback= */ softwareEncoder, /* primary= */ hardwareEncoder);
    }
    return hardwareEncoder != null ? hardwareEncoder : softwareEncoder;
  }

  @Override
  public VideoCodecInfo[] getSupportedCodecs() {
    LinkedHashSet<VideoCodecInfo> codecs = new LinkedHashSet<>();
    codecs.addAll(Arrays.asList(mHardwareFactory.getSupportedCodecs()));
    codecs.addAll(Arrays.asList(mSoftwareFactory.getSupportedCodecs()));
    return codecs.toArray(new VideoCodecInfo[0]);
  }
}
