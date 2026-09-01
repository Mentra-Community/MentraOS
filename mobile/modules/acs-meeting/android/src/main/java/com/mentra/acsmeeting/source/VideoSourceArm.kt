package com.mentra.acsmeeting.source

enum class VideoSourceArm { WHEP, SYNTHETIC }

enum class SyntheticEntropy { CHEAP, MOTION, NOISE }

enum class DecoderMode { TEXTURE, BYTE_BUFFER }

enum class PixelFormatArm { I420, NV12 }

/**
 * Investigation arm. SYNTHETIC bypasses glasses, Cloudflare, WHEP and decode.
 * Ships as WHEP. Flip locally to run the experiment; do not commit SYNTHETIC.
 *
 * [decoderMode] TEXTURE is the production default (shared EGL, MediaCodec to
 * Surface). BYTE_BUFFER is the A/B: no shared context, CPU planes, no
 * glReadPixels. 720p BYTE_BUFFER on SM_S948U decoded on hardware with
 * i420P95=0, but wire/codec never attached and busy drops climbed. Do not
 * commit BYTE_BUFFER until a same-phone 540p A/B clears the campaign gates.
 *
 * [zeroCopy] hands WebRTC I420 planes straight to ACS when they are tight and
 * retainable. Ships off. Do not commit true.
 *
 * [pixelFormat] I420 is the production default. NV12 is the encoder-flip A/B:
 * advertise and send biplanar NV12 in case ACS picks a hardware H.264
 * encoder. Revert unless `codecName` leaves `h264 sw`. Do not commit NV12
 * on a failed flip.
 */
object AcsInvestigation {
  val videoArm = VideoSourceArm.WHEP
  val syntheticFps = 15
  val syntheticEntropy = SyntheticEntropy.MOTION
  val decoderMode = DecoderMode.TEXTURE
  val zeroCopy = false
  val pixelFormat = PixelFormatArm.I420
}

data class SyntheticConfig(
  val fps: Int = AcsInvestigation.syntheticFps,
  val entropy: SyntheticEntropy = AcsInvestigation.syntheticEntropy,
)
