package com.mentra.glassesmedia.source

enum class VideoSourceArm { WHEP, SYNTHETIC }

enum class SyntheticEntropy { CHEAP, MOTION, NOISE }

enum class DecoderMode { TEXTURE, BYTE_BUFFER }

enum class PixelFormatArm { I420, NV12 }

enum class OutgoingRateArm { ADVERTISE_REQUESTED, CLAMP_TO_SOFTWARE_CEILING }

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
object MediaDiagnostics {
  val videoArm = VideoSourceArm.WHEP
  val syntheticFps = 15
  val syntheticEntropy = SyntheticEntropy.MOTION
  val decoderMode = DecoderMode.TEXTURE
  val zeroCopy = false
  val pixelFormat = PixelFormatArm.I420

  /**
   * The rate we declare to ACS.
   *
   * CLAMP_TO_SOFTWARE_CEILING pins it to [VideoProfile.SOFTWARE_ENCODER_FPS]
   * whenever the profile asks for more. It was the default on the strength of
   * soaks that reported `codecName: "h264 sw"` alongside wire ≈ 8.8 fps, read as
   * an encoder ceiling. Two things in the device logs say it was never the
   * encoder.
   *
   * 720p15 and 540p15 both reported ~8.8 fps. 540p is 52% of the pixels of 720p,
   * so a CPU-bound encoder would have been close to twice as fast at the smaller
   * size; a limit that does not move with pixel count is not a pixel cost. And
   * once [FramePacer] delivered a steady cadence, `wire` tracked what we handed
   * ACS — 6.9 against 7.1 admitted — which is an encoder keeping up, not one
   * saturating. Both of those soaks ran through a send path that could not hold a
   * rate, so what they measured was our delivery.
   *
   * ADVERTISE_REQUESTED runs the configuration that was never actually tried:
   * declare the profile's own fps and let the corrected pacer deliver it. Read
   * the `P7 rate` verdict for what binds; it distinguishes an encoder that cannot
   * keep up from a rate controller starving one that can, and those two want
   * opposite fixes.
   */
  val outgoingRate = OutgoingRateArm.ADVERTISE_REQUESTED

  /**
   * libwebrtc's own `LS_INFO` stream during a SoftAP call.
   *
   * The one place that says which interfaces `BasicNetworkManager` kept, what adapter type it gave
   * each one, and every `BindSocketToNetwork` result — the evidence that separated a hotspot the
   * kernel had from one libwebrtc had erased. It is also loud, and it is the native stack's whole
   * log, not ours.
   *
   * Flip to false once the SoftAP path is green on device. Keep the `NetworkFacts` stages either
   * way: they are ours, bounded, and the thing that makes the next regression readable.
   */
  const val LIBWEBRTC_VERBOSE = true

  /**
   * How long to hold outgoing microphone PCM before the resampler, to align the wearer's voice
   * with their video at the far end.
   *
   * Ships at 0, and 0 is not a placeholder: the audio and the video reach ACS over different
   * transports (BLE LC3 versus SoftAP WebRTC) with different latencies, but *how* different is a
   * receiver-side measurement, not something either side can infer. Deriving it from first-frame
   * arrival times measures startup skew and would be wrong by however long the camera took to boot.
   *
   * Calibrate the ingest path with a clap in frame and read `AVSYNC clap audioLeadMs`. That is
   * the offset the delay line can cancel. ACS/Teams jitter after ingest still needs a Teams
   * recording. It is logged as `configuredDelayMs` and deliberately never reported as a measured
   * offset.
   */
  const val acsAudioDelayMs = 0

  /**
   * Whether outgoing audio buffers carry a presentation timestamp.
   *
   * Whether ACS honours these for lip-sync on *raw* audio is unanswered — the SDK exposes the
   * setter and documents nothing about the receiver. The only way to find out is to record the
   * Teams receiver with this on and with it off and compare, so it has to be switchable; a constant
   * true would leave two of the four measurement configurations unreachable.
   *
   * Defaults to true because the fallback is worse for an unrelated reason: a run of zero
   * timestamps is what makes the Teams jitter buffer hold.
   */
  const val acsAudioTimestamps = true
}

data class SyntheticConfig(
  val fps: Int = MediaDiagnostics.syntheticFps,
  val entropy: SyntheticEntropy = MediaDiagnostics.syntheticEntropy,
)
