/**
 * Microphone use-case policy.
 *
 * Applications say what they are doing ("voice_call"); the engine decides what
 * that requires of the hardware. Nothing above this file knows that a voice
 * call means ADC index 14, and no miniapp can ask for a gain directly.
 *
 * Pure: every function here is a function of the live session set. The lease
 * bookkeeping lives in MicSessionManager, the merge with OS preferences lives
 * in MicStateCoordinator, and the wire write lives below that again.
 */

/** What an application is doing with the microphone. */
export type MicUseCase = "voice_call" | "transcription" | "voice_assistant" | "diagnostic"

/** Which microphone the audio comes from. */
export type MicSource = "glasses" | "phone"

/** Subset of the `mic_tuning` wire payload. Fields left out keep firmware defaults. */
export type MicTuningProfile = {
  /** codec_adc_vol index, 0-15. */
  gain?: number
}

/** A live microphone lease. */
export type MicSessionSpec = {
  useCase: MicUseCase
  source: MicSource
}

/** What the hardware should do, given every live session. */
export type ResolvedMicPolicy = {
  /** Someone needs a continuous raw-PCM timeline, which also forces hardware VAD off. */
  rawPcm: boolean
  /** Pin the Bluetooth SDK to the glasses microphone. Only the glasses can be pinned. */
  pinGlasses: boolean
  /** Tuning override for the glasses, or null to leave the OS value in force. */
  micTuning: MicTuningProfile | null
}

/** Platform facts the policy cannot infer from the sessions alone. */
export type MicPlatformCaps = {
  /**
   * Whether this platform can take the wearer's voice off the glasses as raw
   * PCM over BLE LC3. False on iOS, which has no `setMicSourcePin` and never
   * selects the `ble-lc3` uplink.
   */
  glassesPcmUplink: boolean
}

/**
 * Mentra Live ships CODEC_SADC_VOL = 15, the last entry of codec_adc_vol[] and
 * +32 dB. That table steps 2 dB at a time everywhere except the final step,
 * which jumps 6 dB from +26, so the default sits at the ceiling one oversized
 * step above everything else. It suits a wearer dictating to a transcription
 * miniapp across a room; it clips a wearer talking into a Teams call.
 *
 * Gain is the only knob here on purpose. A call forces hardware VAD off and
 * the Barrier is off by default, which puts the firmware gate in its `pass`
 * branch, so the RMS thresholds cannot affect a call.
 *
 * Index 14 is +26 dB: one step down, and the step that removes the table's
 * anomalous jump. If calls still clip, 13 (+24 dB) is the next move.
 */
export const MIC_USE_CASE_PROFILES: Record<MicUseCase, MicTuningProfile> = {
  voice_call: {gain: 14},
  transcription: {},
  voice_assistant: {},
  diagnostic: {},
}

/**
 * Packages allowed to hold a `voice_call` session.
 *
 * Which app may make a voice call is policy, so it lives beside the profiles
 * rather than in the request handler that enforces it.
 */
export const VOICE_CALL_PACKAGES: readonly string[] = ["com.mentra.call"]

/** Every use case, for validating an inbound request. */
export const MIC_USE_CASES: readonly MicUseCase[] = [
  "voice_call",
  "transcription",
  "voice_assistant",
  "diagnostic",
]

/** Owners of engine-internal sessions. Miniapps cannot claim these use cases. */
export const ENGINE_OWNER_PREFIX = "engine:"

/** Use cases only engine features may acquire. */
export const ENGINE_ONLY_USE_CASES: readonly MicUseCase[] = ["diagnostic"]

/**
 * Resolve every live session into one hardware state.
 *
 * On a platform without a glasses PCM uplink a glasses session is a lease and
 * nothing more: it satisfies ownership checks so an iOS call can still be
 * modelled the same way, but it claims no PCM, pins nothing, and applies no
 * gain, because the wearer's voice does not reach the call through the BES
 * BLE path there.
 */
export function resolveMicPolicy(
  sessions: readonly MicSessionSpec[],
  caps: MicPlatformCaps,
): ResolvedMicPolicy {
  const effective = caps.glassesPcmUplink ? sessions : sessions.filter((s) => s.source !== "glasses")

  let pinGlasses = false
  let gain: number | undefined
  for (const session of effective) {
    if (session.source !== "glasses") continue
    pinGlasses = true
    const profileGain = MIC_USE_CASE_PROFILES[session.useCase]?.gain
    // Lowest index wins: clipping is the irreversible failure, a slightly
    // quiet assistant is not.
    if (typeof profileGain === "number" && (gain === undefined || profileGain < gain)) {
      gain = profileGain
    }
  }

  return {
    rawPcm: effective.length > 0,
    pinGlasses,
    micTuning: gain === undefined ? null : {gain},
  }
}
