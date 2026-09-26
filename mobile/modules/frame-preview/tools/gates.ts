/**
 * Phase 0 screening and release-gate criteria, evaluated against run summaries.
 *
 * Every limit comes from the `Tolerances` object passed in; nothing here hard-codes a number.
 * A criterion whose inputs are absent from the log is NOT MEASURED, which never counts as a pass.
 */

import {quantile, THERMAL_RANKS, type AnalysisOptions, type RunSummary} from "./runlog"

export type Verdict = "PASS" | "FAIL" | "NOT MEASURED"
export type GateName = "soak" | "phase0" | "release" | "retained"

export interface Criterion {
  id: string
  label: string
  verdict: Verdict
  value: string
  limit: string
}

export interface GateResult {
  gate: GateName
  title: string
  verdict: "PASS" | "FAIL" | "INCOMPLETE"
  criteria: Criterion[]
  notes: string[]
}

export interface Tolerances {
  analysis: AnalysisOptions
  /** A run this many seconds short of the required length still counts as full length. */
  durationSlackSec: number
  /** Meta keys that may carry the ACS target send rate; the off run's median is the fallback. */
  sendTargetMetaKeys: readonly string[]
  soak: {
    minDurationMin: number
    fpsWithinPct: number
    gapP95PeriodMultiple: number
    zeroCounters: readonly string[]
  }
  phase0: {
    minDurationMin: number
    sendRateWithinPct: number
    minBucketPctOfTarget: number
    tapOfferMeanMaxUs: number
    tapOfferP99MaxUs: number
    tapCadenceP99GrowthMaxMs: number
  }
  release: {
    minDurationMin: number
    sendRateWithinPct: number
    tapCadenceP99GrowthMaxMs: number
    gapP95PeriodMultiple: number
    thermalCeiling: Record<string, string>
    memorySlopeDeltaMaxMbPerMin: number
    zeroCounters: readonly string[]
  }
  retained: {
    maxRetainedMb: number
    baselineSeconds: number
    tailSeconds: number
  }
}

export interface SendTarget {
  fps: number | null
  source: string
}

const f = (value: number | null | undefined, digits = 1): string =>
  value === null || value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(digits)

const pct = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`

function notMeasured(id: string, label: string, limit: string, why: string): Criterion {
  return {id, label, verdict: "NOT MEASURED", value: why, limit}
}

function check(id: string, label: string, ok: boolean, value: string, limit: string): Criterion {
  return {id, label, verdict: ok ? "PASS" : "FAIL", value, limit}
}

function result(gate: GateName, title: string, criteria: Criterion[], notes: string[] = []): GateResult {
  const verdict = criteria.some((c) => c.verdict === "FAIL")
    ? "FAIL"
    : criteria.some((c) => c.verdict === "NOT MEASURED")
      ? "INCOMPLETE"
      : "PASS"
  return {gate, title, verdict, criteria, notes}
}

function durationCriterion(id: string, run: RunSummary, minMin: number, slackSec: number, name: string): Criterion {
  const required = minMin * 60 - slackSec
  return check(
    id,
    `${name} run length`,
    run.durationSec >= required,
    `${f(run.durationSec / 60, 2)} min`,
    `>= ${minMin} min`,
  )
}

function zeroCounterCriteria(prefix: string, run: RunSummary, keys: readonly string[], name: string): Criterion[] {
  return keys.map((key) => {
    const counter = run.counters[key]
    const id = `${prefix}.${key}`
    const label = `${name} ${key} == 0`
    if (!counter || counter.value === null) return notMeasured(id, label, "0", "not in log")
    const reasons = counter.byReason
      ? ` (${Object.entries(counter.byReason)
          .map(([reason, count]) => `${reason}=${count}`)
          .join(", ")})`
      : ""
    return check(id, label, counter.value === 0, `${counter.value}${reasons}`, "0")
  })
}

function gapCriterion(id: string, run: RunSummary, multiple: number, name: string): Criterion {
  const label = `${name} delivery gap p95 <= ${multiple}x period`
  if (!run.periodMs) return notMeasured(id, label, `${multiple}x period`, "no target fps in log")
  const limitMs = run.periodMs * multiple
  const measured = run.quarters.filter((q) => q.deliveryGapMsP95 !== null)
  if (measured.length === 0) return notMeasured(id, label, `<= ${f(limitMs)} ms`, "no deliveryGapMsP95 samples")
  const worst = measured.reduce((a, b) => ((b.deliveryGapMsP95 ?? 0) > (a.deliveryGapMsP95 ?? 0) ? b : a))
  const runMax = run.metrics.deliveryGapMsP95?.max
  return check(
    id,
    label,
    (worst.deliveryGapMsP95 ?? 0) <= limitMs,
    `worst quarter Q${worst.index} ${f(worst.deliveryGapMsP95)} ms (any-second max ${f(runMax)} ms)`,
    `<= ${f(limitMs)} ms`,
  )
}

function sendRateCriterion(id: string, off: RunSummary, on: RunSummary, withinPct: number): Criterion {
  const label = `send rate on within ${withinPct}% of off`
  if (off.sendRate.meanFps === null || on.sendRate.meanFps === null || off.sendRate.meanFps === 0) {
    return notMeasured(id, label, `±${withinPct}%`, "no send-rate field in one of the runs")
  }
  const delta = (on.sendRate.meanFps / off.sendRate.meanFps - 1) * 100
  return check(
    id,
    label,
    Math.abs(delta) <= withinPct,
    `on ${f(on.sendRate.meanFps, 2)} vs off ${f(off.sendRate.meanFps, 2)} fps (${pct(delta)}) [${on.sendRate.field}]`,
    `±${withinPct}%`,
  )
}

function cadenceGrowthCriterion(id: string, off: RunSummary, on: RunSummary, maxGrowthMs: number): Criterion {
  const label = `tapCadenceMaxMs p99 growth <= ${maxGrowthMs} ms`
  const offP99 = off.metrics.tapCadenceMaxMs?.p99
  const onP99 = on.metrics.tapCadenceMaxMs?.p99
  if (offP99 === undefined || onP99 === undefined)
    return notMeasured(id, label, `<= +${maxGrowthMs} ms`, "tap telemetry missing")
  const growth = onP99 - offP99
  return check(
    id,
    label,
    growth <= maxGrowthMs,
    `on ${f(onP99, 2)} vs off ${f(offP99, 2)} ms (${growth >= 0 ? "+" : ""}${f(growth, 2)})`,
    `<= +${maxGrowthMs} ms`,
  )
}

export function resolveSendTarget(
  off: RunSummary,
  on: RunSummary,
  tolerances: Tolerances,
  override?: number,
): SendTarget {
  if (override !== undefined) return {fps: override, source: "--send-fps"}
  for (const run of [on, off]) {
    for (const key of tolerances.sendTargetMetaKeys) {
      const value = run.meta?.[key]
      if (typeof value === "number" && value > 0) return {fps: value, source: `meta.${key}`}
    }
  }
  const offMedian =
    off.sendRate.buckets.length > 0
      ? quantile(
          [...off.sendRate.buckets].sort((a, b) => a - b),
          0.5,
        )
      : 0
  return offMedian > 0 ? {fps: offMedian, source: "off-run median (no target recorded)"} : {fps: null, source: "none"}
}

/** Phase 0 item 1: one synthetic soak run. */
export function evaluateSoak(run: RunSummary, tolerances: Tolerances): GateResult {
  const t = tolerances.soak
  const criteria: Criterion[] = [
    durationCriterion("soak.duration", run, t.minDurationMin, tolerances.durationSlackSec, "soak"),
  ]

  const fpsLabel = `delivered fps within ${t.fpsWithinPct}% of target in every quarter`
  const quarters = run.quarters.filter((q) => q.deliveredFps !== null)
  if (!run.targetFps) {
    criteria.push(notMeasured("soak.fps", fpsLabel, `±${t.fpsWithinPct}%`, "no target fps in log"))
  } else if (quarters.length < 4) {
    criteria.push(notMeasured("soak.fps", fpsLabel, `±${t.fpsWithinPct}%`, `${quarters.length} quarter(s) with data`))
  } else {
    const target = run.targetFps
    const deviations = quarters.map((q) => ((q.deliveredFps ?? 0) / target - 1) * 100)
    criteria.push(
      check(
        "soak.fps",
        fpsLabel,
        deviations.every((d) => Math.abs(d) <= t.fpsWithinPct),
        quarters.map((q, i) => `Q${q.index} ${f(q.deliveredFps, 2)} (${pct(deviations[i])})`).join(", ") +
          ` vs ${target}`,
        `±${t.fpsWithinPct}%`,
      ),
    )
  }
  criteria.push(gapCriterion("soak.gap", run, t.gapP95PeriodMultiple, "soak"))
  criteria.push(...zeroCounterCriteria("soak", run, t.zeroCounters, "soak"))
  const notes: string[] = []
  const queueWait = run.metrics.mainQueueWaitMsP95
  if (queueWait)
    notes.push(
      `mainQueueWaitMsP95 per second: p50 ${f(queueWait.p50, 2)} p95 ${f(queueWait.p95, 2)} max ${f(queueWait.max, 2)} ms`,
    )
  return result("soak", "Phase 0 soak screening", criteria, notes)
}

/** Phase 0 item 2: real call, preview off then on. */
export function evaluatePhase0(
  off: RunSummary,
  on: RunSummary,
  tolerances: Tolerances,
  target: SendTarget,
): GateResult {
  const t = tolerances.phase0
  const slack = tolerances.durationSlackSec
  const criteria: Criterion[] = [
    durationCriterion("phase0.duration.off", off, t.minDurationMin, slack, "off"),
    durationCriterion("phase0.duration.on", on, t.minDurationMin, slack, "on"),
    sendRateCriterion("phase0.sendRate", off, on, t.sendRateWithinPct),
  ]

  const bucketLabel = `no 1 s send bucket below ${t.minBucketPctOfTarget}% of target (on)`
  if (target.fps === null || on.sendRate.buckets.length === 0) {
    criteria.push(
      notMeasured("phase0.minBucket", bucketLabel, `${t.minBucketPctOfTarget}%`, "no send-rate data or target"),
    )
  } else {
    const floor = (target.fps * t.minBucketPctOfTarget) / 100
    const low = on.sendRate.buckets.filter((bucket) => bucket < floor).length
    criteria.push(
      check(
        "phase0.minBucket",
        bucketLabel,
        low === 0,
        `min ${f(Math.min(...on.sendRate.buckets), 1)} fps, ${low} bucket(s) below ${f(floor, 1)} (target ${f(target.fps, 1)} from ${target.source})`,
        `>= ${f(floor, 1)} fps`,
      ),
    )
  }

  const meanLabel = `tapOfferMeanUs <= ${t.tapOfferMeanMaxUs} us (on)`
  const p99Label = `tapOfferMeanUs p99 <= ${t.tapOfferP99MaxUs} us (on)`
  if (on.tapOffer.weightedMeanUs === null || !on.tapOffer.perSecond) {
    criteria.push(
      notMeasured("phase0.tapOfferMean", meanLabel, `<= ${t.tapOfferMeanMaxUs} us`, "no tap offers with a sink"),
    )
    criteria.push(
      notMeasured("phase0.tapOfferP99", p99Label, `<= ${t.tapOfferP99MaxUs} us`, "no tap offers with a sink"),
    )
  } else {
    criteria.push(
      check(
        "phase0.tapOfferMean",
        meanLabel,
        on.tapOffer.weightedMeanUs <= t.tapOfferMeanMaxUs,
        `${f(on.tapOffer.weightedMeanUs, 2)} us`,
        `<= ${t.tapOfferMeanMaxUs} us`,
      ),
    )
    criteria.push(
      check(
        "phase0.tapOfferP99",
        p99Label,
        on.tapOffer.perSecond.p99 <= t.tapOfferP99MaxUs,
        `${f(on.tapOffer.perSecond.p99, 2)} us`,
        `<= ${t.tapOfferP99MaxUs} us`,
      ),
    )
  }
  criteria.push(cadenceGrowthCriterion("phase0.cadence", off, on, t.tapCadenceP99GrowthMaxMs))
  const notes: string[] = []
  const offerMax = on.metrics.tapOfferMaxUs
  if (offerMax) notes.push(`tapOfferMaxUs per second (on): p99 ${f(offerMax.p99, 2)} max ${f(offerMax.max, 2)} us`)
  return result("phase0", "Phase 0 real-call screening (off vs on)", criteria, notes)
}

function thermalRank(platform: string | null, state: string): number | undefined {
  return platform ? THERMAL_RANKS[platform]?.[state] : undefined
}

/** Release gate: sustained real call, preview off then on. */
export function evaluateRelease(off: RunSummary, on: RunSummary, tolerances: Tolerances): GateResult {
  const t = tolerances.release
  const slack = tolerances.durationSlackSec
  const criteria: Criterion[] = [
    durationCriterion("release.duration.off", off, t.minDurationMin, slack, "off"),
    durationCriterion("release.duration.on", on, t.minDurationMin, slack, "on"),
    sendRateCriterion("release.sendRate", off, on, t.sendRateWithinPct),
    cadenceGrowthCriterion("release.cadence", off, on, t.tapCadenceP99GrowthMaxMs),
    gapCriterion("release.gap", on, t.gapP95PeriodMultiple, "on"),
  ]

  const relLabel = "thermal (on) no worse than off"
  if (!on.thermal.measured || !off.thermal.measured) {
    criteria.push(notMeasured("release.thermal.relative", relLabel, "on <= off", "thermal state not reported"))
  } else {
    criteria.push(
      check(
        "release.thermal.relative",
        relLabel,
        (on.thermal.worstRank ?? 0) <= (off.thermal.worstRank ?? 0),
        `on ${on.thermal.worst} vs off ${off.thermal.worst}`,
        "on <= off",
      ),
    )
  }
  const ceiling = on.platform ? t.thermalCeiling[on.platform] : undefined
  const ceilLabel = `thermal (on) never above ${ceiling ?? "platform ceiling"}`
  const ceilingRank = ceiling ? thermalRank(on.platform, ceiling) : undefined
  if (!on.thermal.measured || ceilingRank === undefined) {
    criteria.push(
      notMeasured("release.thermal.ceiling", ceilLabel, ceiling ?? "n/a", "thermal state or platform not reported"),
    )
  } else {
    criteria.push(
      check(
        "release.thermal.ceiling",
        ceilLabel,
        (on.thermal.worstRank ?? 0) <= ceilingRank,
        `worst ${on.thermal.worst}`,
        `<= ${ceiling}`,
      ),
    )
  }

  const memLabel = `memory slope (on - off) <= ${t.memorySlopeDeltaMaxMbPerMin} MB/min`
  const onSlope = on.memory?.slopeMbPerMin
  const offSlope = off.memory?.slopeMbPerMin
  if (onSlope === null || onSlope === undefined || offSlope === null || offSlope === undefined) {
    criteria.push(
      notMeasured("release.memorySlope", memLabel, `<= ${t.memorySlopeDeltaMaxMbPerMin}`, "memoryFootprintMb missing"),
    )
  } else {
    const delta = onSlope - offSlope
    criteria.push(
      check(
        "release.memorySlope",
        memLabel,
        delta <= t.memorySlopeDeltaMaxMbPerMin,
        `on ${f(onSlope, 3)} - off ${f(offSlope, 3)} = ${f(delta, 3)} MB/min`,
        `<= ${t.memorySlopeDeltaMaxMbPerMin}`,
      ),
    )
  }
  criteria.push(...zeroCounterCriteria("release", on, t.zeroCounters, "on"))
  return result("release", "Release gate: sustained real call (off vs on)", criteria, [
    "Audio continuity, retained memory after toggles, and functional acceptance are separate checks (see RUNBOOK.md).",
  ])
}

/**
 * Release memory gate, first half: after the toggle flow, memory returns to within the limit of
 * the baseline taken right after the first show. Runs are in chronological order; the first run
 * provides the baseline (median of its first seconds), the last run the retained value (median
 * of its last seconds).
 */
export function evaluateRetained(runs: readonly RunSummary[], tolerances: Tolerances): GateResult {
  const t = tolerances.retained
  const label = `retained memory within ${t.maxRetainedMb} MB of first-show baseline`
  const first = runs[0]?.memory?.series ?? []
  const last = runs[runs.length - 1]?.memory?.series ?? []
  if (first.length === 0 || last.length === 0) {
    return result("retained", "Release gate: retained memory after toggles", [
      notMeasured("retained.memory", label, `<= ${t.maxRetainedMb} MB`, "memoryFootprintMb missing"),
    ])
  }
  const medianOf = (series: number[]) =>
    quantile(
      [...series].sort((a, b) => a - b),
      0.5,
    )
  const baseline = medianOf(first.slice(0, t.baselineSeconds))
  const retained = medianOf(last.slice(-t.tailSeconds))
  const growth = retained - baseline
  return result(
    "retained",
    "Release gate: retained memory after toggles",
    [
      check(
        "retained.memory",
        label,
        growth <= t.maxRetainedMb,
        `baseline ${f(baseline)} MB, retained ${f(retained)} MB (${growth >= 0 ? "+" : ""}${f(growth, 2)})`,
        `<= +${t.maxRetainedMb} MB`,
      ),
    ],
    [
      `${runs.length} run file(s); platforms report different memory measures (iOS physical footprint, Android JVM heap), so compare within one platform only.`,
    ],
  )
}

/** Things that make an off/on comparison suspect without failing a criterion by themselves. */
export function comparabilityWarnings(off: RunSummary, on: RunSummary): string[] {
  const warnings: string[] = []
  const pairs: Array<[string, unknown, unknown]> = [
    ["platform", off.platform, on.platform],
    ["deviceModel", off.meta?.deviceModel, on.meta?.deviceModel],
    ["osVersion", off.meta?.osVersion, on.meta?.osVersion],
    ["source", off.source, on.source],
  ]
  for (const [key, a, b] of pairs) {
    if (a !== undefined && b !== undefined && a !== b) warnings.push(`${key} differs: off=${String(a)} on=${String(b)}`)
  }
  if (off.mode && off.mode !== "off") warnings.push(`off run mode is "${off.mode}", expected "off"`)
  if (on.mode === "off") warnings.push(`on run mode is "off"`)
  if (off.sendRate.field && on.sendRate.field && off.sendRate.field !== on.sendRate.field) {
    warnings.push(`send-rate field differs: off=${off.sendRate.field} on=${on.sendRate.field}`)
  }
  return warnings
}
