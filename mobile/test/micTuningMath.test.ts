/**
 * Mic tuning edit rules.
 *
 * On device, a single-field write let the firmware validator rewrite a
 * neighbour behind the user's back: `sp_open: 1449` alone halved `sp_close`
 * (1600 -> 724), and `open: 3628` alone lifted `sp_open` (2900 -> 3628).
 * Dropping gain without touching the thresholds leaves a gate that never
 * opens. These pin the coupling so the screen always sends a consistent set.
 */
import {
  applyMicTuningPatch,
  GAIN_DB,
  MIC_TUNING_DEFAULTS,
  micTuningOverrides,
  normalizeMicTuning,
  resolveMicTuning,
} from "@/components/glasses/settings/micTuningMath"

describe("normalizeMicTuning", () => {
  it("passes firmware defaults through unchanged", () => {
    expect(normalizeMicTuning(MIC_TUNING_DEFAULTS)).toEqual(MIC_TUNING_DEFAULTS)
  })

  it("lifts sp_open to open when open climbs past it, as the firmware would", () => {
    const out = normalizeMicTuning({...MIC_TUNING_DEFAULTS, open: 3628, close: 2540})
    expect(out.sp_open).toBe(3628)
  })

  it("halves a close that is not below its open", () => {
    const out = normalizeMicTuning({...MIC_TUNING_DEFAULTS, sp_open: 1449})
    expect(out.sp_close).toBe(Math.round(1449 * 0.5))
  })

  it("clamps the gain index into the usable table", () => {
    expect(normalizeMicTuning({...MIC_TUNING_DEFAULTS, gain: 0}).gain).toBe(1)
    expect(normalizeMicTuning({...MIC_TUNING_DEFAULTS, gain: 40}).gain).toBe(GAIN_DB.length - 1)
  })
})

describe("applyMicTuningPatch", () => {
  it("scales every RMS threshold by the gain change so the gate keeps opening", () => {
    // 15 -> 14 is +32 dB -> +26 dB: -6 dB, x0.501.
    const out = applyMicTuningPatch(MIC_TUNING_DEFAULTS, {gain: 14})
    expect(out.gain).toBe(14)
    expect(out.open).toBe(677)
    expect(out.close).toBe(474)
    expect(out.sp_open).toBe(1453)
    expect(out.sp_close).toBe(802)
    // Frame counts are time, not level.
    expect(out.attack).toBe(MIC_TUNING_DEFAULTS.attack)
    expect(out.hang).toBe(MIC_TUNING_DEFAULTS.hang)
    expect(out.sp_hold).toBe(MIC_TUNING_DEFAULTS.sp_hold)
  })

  it("is reversible: raising gain back restores the thresholds within rounding", () => {
    const down = applyMicTuningPatch(MIC_TUNING_DEFAULTS, {gain: 14})
    const back = applyMicTuningPatch(down, {gain: 15})
    expect(Math.abs(back.open - MIC_TUNING_DEFAULTS.open)).toBeLessThanOrEqual(2)
    expect(Math.abs(back.sp_open - MIC_TUNING_DEFAULTS.sp_open)).toBeLessThanOrEqual(2)
  })

  it("keeps close at its ratio when open moves", () => {
    const out = applyMicTuningPatch(MIC_TUNING_DEFAULTS, {open: 1770})
    expect(out.open).toBe(1770)
    // 945 / 1350 = 0.70
    expect(out.close).toBe(1239)
    expect(out.sp_open).toBe(MIC_TUNING_DEFAULTS.sp_open)
  })

  it("drags sp_open and sp_close up together when open passes sp_open", () => {
    const out = applyMicTuningPatch(MIC_TUNING_DEFAULTS, {open: 3628})
    expect(out.sp_open).toBe(3628)
    // 1600 / 2900 = 0.5517, so sp_close follows instead of staying at 1600.
    expect(out.sp_close).toBe(2002)
    expect(out.sp_close).toBeLessThan(out.sp_open)
  })

  it("keeps sp_close at its ratio when sp_open moves", () => {
    const out = applyMicTuningPatch(MIC_TUNING_DEFAULTS, {sp_open: 1449})
    expect(out.sp_open).toBe(1449)
    // Was 724 on device (firmware halving). Now 1449 * 0.5517.
    expect(out.sp_close).toBe(799)
  })

  it("lets an explicit close override the ratio", () => {
    const out = applyMicTuningPatch(MIC_TUNING_DEFAULTS, {sp_close: 803})
    expect(out.sp_close).toBe(803)
  })
})

describe("micTuningOverrides", () => {
  it("returns null when nothing differs from firmware defaults", () => {
    expect(micTuningOverrides({...MIC_TUNING_DEFAULTS})).toBeNull()
  })

  it("persists only the fields that differ", () => {
    const out = micTuningOverrides({...MIC_TUNING_DEFAULTS, gain: 14, hang: 42})
    expect(out).toEqual({gain: 14, hang: 42})
  })

  it("round-trips through resolveMicTuning", () => {
    const full = applyMicTuningPatch(MIC_TUNING_DEFAULTS, {gain: 14})
    expect(resolveMicTuning(micTuningOverrides(full))).toEqual(full)
  })
})
