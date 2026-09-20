import type {MicTuning} from "@mentra/bluetooth-sdk-internal"

/**
 * Firmware defaults, mirrored from center_mic_vad_get_default_config and
 * CODEC_SADC_VOL. A slider has to show something before the glasses answer,
 * and "what the firmware would do" is the honest placeholder.
 *
 * Kept in step by hand with MIC_TUNING_FIRMWARE_DEFAULTS and GAIN_DB in the
 * engine's micPolicy, which derives the voice-call profile from the same
 * numbers. Importing them would pull the engine entry into a pure-math screen
 * helper; micPolicy's tests pin the values on the other side.
 */
export const MIC_TUNING_DEFAULTS: Required<MicTuning> = {
  gain: 15,
  open: 1350,
  close: 945,
  attack: 3,
  hang: 80,
  sp_open: 2900,
  sp_close: 1600,
  sp_hold: 30,
}

/** codec_adc_vol[]: index -> dB. Index 0 is mute and is not offered. */
export const GAIN_DB = [-99, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 32]

/** RMS-valued fields. These move together with gain because RMS is post-gain. */
const LEVEL_FIELDS = ["open", "close", "sp_open", "sp_close"] as const

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Mirror of center_mic_vad_validate_config plus the gain index range, so the
 * screen never sends a set the firmware would silently rewrite. Every clamp
 * the firmware would apply is applied here first and shown to the user.
 */
export function normalizeMicTuning(input: Required<MicTuning>): Required<MicTuning> {
  const gain = clamp(Math.round(input.gain), 1, GAIN_DB.length - 1)
  const open = clamp(Math.round(input.open), 1, 30000)
  let close = clamp(Math.round(input.close), 0, open)
  if (close >= open) close = Math.round(open * 0.5)
  const attack = clamp(Math.round(input.attack), 1, 30)
  const hang = clamp(Math.round(input.hang), 1, 200)
  const sp_hold = clamp(Math.round(input.sp_hold), 0, 200)
  // Speaker-elevated open can never sit below the normal open threshold.
  const sp_open = clamp(Math.round(input.sp_open), open, 30000)
  let sp_close = clamp(Math.round(input.sp_close), 0, sp_open)
  if (sp_close >= sp_open) sp_close = Math.round(sp_open * 0.5)
  return {gain, open, close, attack, hang, sp_open, sp_close, sp_hold}
}

/**
 * Apply one user edit and carry the dependent fields with it, so a single
 * slider move cannot leave a neighbour for the firmware to rewrite:
 *
 * - `gain` scales all four RMS thresholds by the dB change. The gate compares
 *   post-gain RMS, so -6 dB of gain without halving the thresholds means the
 *   gate simply stops opening.
 * - `open` keeps `close` at its current ratio and, if it climbs past
 *   `sp_open`, drags `sp_open` up with `sp_close` at its ratio.
 * - `sp_open` keeps `sp_close` at its current ratio.
 */
export function applyMicTuningPatch(current: Required<MicTuning>, patch: Partial<MicTuning>): Required<MicTuning> {
  let next: Required<MicTuning> = {...current}

  if (patch.gain !== undefined && patch.gain !== current.gain) {
    const from = GAIN_DB[clamp(Math.round(current.gain), 1, GAIN_DB.length - 1)]
    const to = GAIN_DB[clamp(Math.round(patch.gain), 1, GAIN_DB.length - 1)]
    const factor = Math.pow(10, (to - from) / 20)
    for (const field of LEVEL_FIELDS) {
      next[field] = Math.round(current[field] * factor)
    }
    next.gain = patch.gain
  }

  if (patch.open !== undefined) {
    const closeRatio = ratio(current.close, current.open)
    const spCloseRatio = ratio(current.sp_close, current.sp_open)
    next.open = patch.open
    next.close = patch.close !== undefined ? patch.close : Math.round(patch.open * closeRatio)
    if (patch.open > next.sp_open && patch.sp_open === undefined) {
      next.sp_open = patch.open
      next.sp_close = Math.round(patch.open * spCloseRatio)
    }
  } else if (patch.close !== undefined) {
    next.close = patch.close
  }

  if (patch.sp_open !== undefined) {
    const spCloseRatio = ratio(current.sp_close, current.sp_open)
    next.sp_open = patch.sp_open
    next.sp_close = patch.sp_close !== undefined ? patch.sp_close : Math.round(patch.sp_open * spCloseRatio)
  } else if (patch.sp_close !== undefined) {
    next.sp_close = patch.sp_close
  }

  if (patch.attack !== undefined) next.attack = patch.attack
  if (patch.hang !== undefined) next.hang = patch.hang
  if (patch.sp_hold !== undefined) next.sp_hold = patch.sp_hold

  next = normalizeMicTuning(next)
  return next
}

/**
 * What to persist as the desired override: only the fields that differ from
 * firmware defaults. An empty result means "nothing overridden", which the
 * caller stores as null so the glasses receive a reset.
 */
export function micTuningOverrides(full: Required<MicTuning>): MicTuning | null {
  const out: MicTuning = {}
  for (const key of Object.keys(MIC_TUNING_DEFAULTS) as (keyof Required<MicTuning>)[]) {
    if (full[key] !== MIC_TUNING_DEFAULTS[key]) out[key] = full[key]
  }
  return Object.keys(out).length === 0 ? null : out
}

/** Defaults merged with whatever the user has overridden. */
export function resolveMicTuning(desired: MicTuning | null | undefined): Required<MicTuning> {
  const merged: Required<MicTuning> = {...MIC_TUNING_DEFAULTS}
  for (const [key, value] of Object.entries(desired ?? {})) {
    if (typeof value === "number" && Number.isFinite(value) && key in merged) {
      merged[key as keyof Required<MicTuning>] = value
    }
  }
  return merged
}

function ratio(part: number, whole: number): number {
  if (whole <= 0) return 0.5
  return clamp(part / whole, 0.05, 0.99)
}
