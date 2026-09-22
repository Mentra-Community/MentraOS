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
export type MicUseCase = "voice_call" | "transcription" | "voice_assistant" | "diagnostic" | "livestream"

/** Which microphone the audio comes from. */
export type MicSource = "glasses" | "phone"

/** Subset of the `mic_tuning` wire payload. Fields left out keep firmware defaults. */
export type MicTuningProfile = {
  /** codec_adc_vol index, 0-15. */
  gain?: number
  /** Center-mic RMS to open the gate. */
  open?: number
  /** Center-mic RMS to close it again. */
  close?: number
  /** Open threshold while the speaker is elevated. */
  sp_open?: number
  /** Close threshold while the speaker is elevated. */
  sp_close?: number
}

/** `codec_adc_vol[]`: index to dB. Index 0 is mute and is never offered. */
export const GAIN_DB = [-99, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 32]

/**
 * Mirrored from `center_mic_vad_get_default_config` and `CODEC_SADC_VOL`.
 *
 * The four RMS numbers are measured *after* the ADC gain, so they are only
 * meaningful next to the gain they were calibrated at, which is index 15.
 */
export const MIC_TUNING_FIRMWARE_DEFAULTS = {
  gain: 15,
  open: 1350,
  close: 945,
  sp_open: 2900,
  sp_close: 1600,
} as const

/**
 * Re-express the firmware's thresholds at a different gain.
 *
 * The gate compares post-gain RMS, so moving the gain without moving the
 * thresholds silently changes what the gate means: at -8 dB the wearer has to
 * be 2.5x louder to clear a number that was chosen for +32 dB. Scaling both by
 * the same factor keeps the *acoustic* trip point the profile was tuned for,
 * for the wearer and for speaker leak alike.
 */
export function scaleMicTuningToGain(gain: number): Required<MicTuningProfile> {
  const index = Math.min(GAIN_DB.length - 1, Math.max(1, Math.round(gain)))
  const factor = Math.pow(10, (GAIN_DB[index]! - GAIN_DB[MIC_TUNING_FIRMWARE_DEFAULTS.gain]!) / 20)
  return {
    gain: index,
    open: Math.round(MIC_TUNING_FIRMWARE_DEFAULTS.open * factor),
    close: Math.round(MIC_TUNING_FIRMWARE_DEFAULTS.close * factor),
    sp_open: Math.round(MIC_TUNING_FIRMWARE_DEFAULTS.sp_open * factor),
    sp_close: Math.round(MIC_TUNING_FIRMWARE_DEFAULTS.sp_close * factor),
  }
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
  /** Run the center-mic loudness gate, or null to leave the OS value in force. */
  loudnessGate: boolean | null
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
 * Index 14 is +26 dB: one step down, and the step that removes the table's
 * anomalous jump. A same-voice sweep showed 15 rails hard (2.5–4.2% clip);
 * 14/13/12 still kiss the rail on syllable tips. 13 is +24 dB, the middle
 * of that band, while we listen for loudness vs residual clip.
 *
 * The thresholds ride along with the gain rather than being stated here, so
 * changing the index above cannot leave the gate calibrated for a level the
 * ADC no longer produces.
 */
export const MIC_USE_CASE_PROFILES: Record<MicUseCase, MicTuningProfile> = {
  voice_call: scaleMicTuningToGain(13),
  transcription: {},
  voice_assistant: {},
  diagnostic: {},
  livestream: {}, // Preserve the configured capture gain; there is no call return audio.
}

/**
 * Use cases that run the center-mic loudness gate ("Barrier").
 *
 * A voice call is the one place it earns its keep. There is no echo canceller
 * on the LC3 uplink — `MENTRA_LC3_SPEECH_PROCESSING` is 0 and the capture path
 * ignores the playback reference — so without a gate the far end hears itself
 * through the wearer's speaker. Barrier is the safe half of the firmware's two
 * gates: it zeroes a quiet frame but never stops transmitting, where VAD drops
 * the stream outright. Paired with the speaker-elevated thresholds above, that
 * suppresses leak while the far end is talking and costs the wearer nothing.
 */
export const MIC_USE_CASE_LOUDNESS_GATE: Record<MicUseCase, boolean> = {
  voice_call: true,
  transcription: false,
  voice_assistant: false,
  diagnostic: false,
  livestream: false,
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
  "livestream",
]

/** Owners of engine-internal sessions. Miniapps cannot claim these use cases. */
export const ENGINE_OWNER_PREFIX = "engine:"

/** Use cases only engine features may acquire. */
export const ENGINE_ONLY_USE_CASES: readonly MicUseCase[] = ["diagnostic", "livestream"]

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
  let loudnessGate = false
  let winning: MicTuningProfile | null = null
  for (const session of effective) {
    if (session.source !== "glasses") continue
    pinGlasses = true
    if (MIC_USE_CASE_LOUDNESS_GATE[session.useCase]) loudnessGate = true
    const profile = MIC_USE_CASE_PROFILES[session.useCase]
    if (typeof profile?.gain !== "number") continue
    // Lowest index wins: clipping is the irreversible failure, a slightly
    // quiet assistant is not. The whole profile travels with it, because its
    // thresholds are only meaningful at its own gain.
    if (winning === null || profile.gain < winning.gain!) winning = profile
  }

  return {
    rawPcm: effective.length > 0,
    pinGlasses,
    micTuning: winning,
    loudnessGate: pinGlasses ? loudnessGate : null,
  }
}
