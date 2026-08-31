package com.mentra.acsmeeting.audio

enum class AudioSourceKind { GLASSES, PHONE }

/** Mirrors (AudioStreamType, AudioStreamState). Attached-but-STOPPED reads as NONE. */
enum class ActiveStreamKind { NONE, VIRTUAL, LOCAL }

enum class PhysicalMuteAction { MUTE, UNMUTE, LEAVE_ALONE }

enum class AudioSafety { SAFE, DEGRADED, UNSAFE }

data class AudioPolicyDecision(
  val glassesPcmEnabled: Boolean,
  val physicalMute: PhysicalMuteAction,
)

/** Transport mute is an ACS join concern, distinct from user intent. */
data class JoinAudioPlan(
  val armVirtual: Boolean,
  val transportMuted: Boolean,
)

object AcsAudioPolicy {
  fun decide(
    desired: AudioSourceKind,
    active: ActiveStreamKind,
    userMuted: Boolean,
  ): AudioPolicyDecision {
    val glassesPcmEnabled =
      active == ActiveStreamKind.VIRTUAL &&
        desired == AudioSourceKind.GLASSES &&
        !userMuted
    val physicalMute = when (active) {
      ActiveStreamKind.VIRTUAL, ActiveStreamKind.NONE -> PhysicalMuteAction.LEAVE_ALONE
      ActiveStreamKind.LOCAL ->
        if (desired == AudioSourceKind.PHONE && !userMuted) {
          PhysicalMuteAction.UNMUTE
        } else {
          PhysicalMuteAction.MUTE
        }
    }
    return AudioPolicyDecision(glassesPcmEnabled, physicalMute)
  }

  fun planJoin(
    desired: AudioSourceKind,
    userMuted: Boolean,
    glassesRequiresUnmutedTransport: Boolean,
  ): JoinAudioPlan {
    val armVirtual = desired == AudioSourceKind.GLASSES
    val transportMuted =
      if (armVirtual) {
        if (glassesRequiresUnmutedTransport) false else userMuted
      } else {
        userMuted
      }
    return JoinAudioPlan(armVirtual = armVirtual, transportMuted = transportMuted)
  }

  fun expectedStream(desired: AudioSourceKind): ActiveStreamKind =
    if (desired == AudioSourceKind.GLASSES) ActiveStreamKind.VIRTUAL else ActiveStreamKind.LOCAL

  fun parseSource(raw: String?): AudioSourceKind? =
    when (raw) {
      "glasses" -> AudioSourceKind.GLASSES
      "phone" -> AudioSourceKind.PHONE
      else -> null
    }
}

/** Layer 1: what the glasses encoder captures for this WHIP session. Independent of ACS. */
object CapturePolicy {
  fun captureGlassesMic(source: AudioSourceKind): Boolean = source == AudioSourceKind.GLASSES
}

/** Null ACS call handles must fail, never report success via `call?.mute(); Unit`. */
object CallGuard {
  fun <T : Any> require(value: T?): Result<T> =
    if (value == null) Result.failure(IllegalStateException("no call"))
    else Result.success(value)
}
