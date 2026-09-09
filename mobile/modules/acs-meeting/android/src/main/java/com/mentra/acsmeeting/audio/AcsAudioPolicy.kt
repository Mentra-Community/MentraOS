package com.mentra.acsmeeting.audio

enum class AudioSourceKind { GLASSES, PHONE }

/** Mirrors (AudioStreamType, AudioStreamState). Attached-but-STOPPED reads as NONE. */
enum class ActiveStreamKind { NONE, VIRTUAL, LOCAL }

enum class PhysicalMuteAction { MUTE, UNMUTE, LEAVE_ALONE }

enum class AudioSafety { SAFE, DEGRADED, UNSAFE }

data class AudioPolicyDecision(
  val glassesPcmEnabled: Boolean,
  val phonePcmEnabled: Boolean,
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
    val phonePcmEnabled =
      active == ActiveStreamKind.VIRTUAL &&
        desired == AudioSourceKind.PHONE &&
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
    return AudioPolicyDecision(glassesPcmEnabled, phonePcmEnabled, physicalMute)
  }

  fun planJoin(
    desired: AudioSourceKind,
    userMuted: Boolean,
    glassesRequiresUnmutedTransport: Boolean,
  ): JoinAudioPlan {
    // Phone and glasses both feed RawOutgoingAudioStream. Mute is PCM/capturer
    // gating, never a LocalOutgoingAudioStream (that path makes ACS own the route).
    val armVirtual = true
    val transportMuted =
      if (desired == AudioSourceKind.GLASSES && glassesRequiresUnmutedTransport) {
        false
      } else if (desired == AudioSourceKind.PHONE) {
        false
      } else {
        userMuted
      }
    return JoinAudioPlan(armVirtual = armVirtual, transportMuted = transportMuted)
  }

  @Suppress("UNUSED_PARAMETER")
  fun expectedStream(desired: AudioSourceKind): ActiveStreamKind = ActiveStreamKind.VIRTUAL

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
