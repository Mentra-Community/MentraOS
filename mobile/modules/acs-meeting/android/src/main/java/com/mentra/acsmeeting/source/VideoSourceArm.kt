package com.mentra.acsmeeting.source

enum class VideoSourceArm { WHEP, SYNTHETIC }

enum class SyntheticEntropy { CHEAP, MOTION, NOISE }

/**
 * Investigation arm. SYNTHETIC bypasses glasses, Cloudflare, WHEP and decode.
 * Ships as WHEP. Flip locally to run the experiment; do not commit SYNTHETIC.
 */
object AcsInvestigation {
  val videoArm = VideoSourceArm.SYNTHETIC
  val syntheticFps = 15
  val syntheticEntropy = SyntheticEntropy.MOTION
}

data class SyntheticConfig(
  val fps: Int = AcsInvestigation.syntheticFps,
  val entropy: SyntheticEntropy = AcsInvestigation.syntheticEntropy,
)
