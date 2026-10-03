/**
 * Parsing and single-run summaries for frame-preview NDJSON run logs.
 *
 * Line schema (written by `PreviewRunLog` on both platforms):
 * - `t: "meta"`   once, first line of the file
 * - `t: "status"` one per 1 Hz tick; the same object the panel shows. No timestamp: line index is
 *                 the time axis. Preview counters are cumulative for the run; `tap*` metrics are
 *                 drained on every tick, so each line holds one interval's worth.
 * - `t: "event"`  lifecycle facts with `event` and `atMs` (ms since start); `beforeStart: true` for
 *                 events replayed from before the file opened
 * - `t: "end"`    summary written on stop
 *
 * Keys a platform cannot measure are absent. Absent means "not measured", never zero.
 */

import {readFileSync} from "node:fs"

export type RunRecord = Record<string, unknown>

export interface AnalysisOptions {
  /** Leading status lines to ignore. The first tick drains tap metrics accumulated before start. */
  warmupSeconds: number
  /** Status fields tried in order for the per-second send rate. */
  sendRateFields: readonly string[]
  /** Counters that are drained per tick (summed), rather than cumulative (last value wins). */
  windowedCounters: readonly string[]
  /** Every counter the summary reports, measured or not. */
  counters: readonly string[]
}

export interface ParsedRun {
  path?: string
  meta: RunRecord | null
  status: RunRecord[]
  events: RunRecord[]
  end: RunRecord | null
  malformedLines: number
  warnings: string[]
}

export interface Distribution {
  n: number
  mean: number
  p50: number
  p95: number
  p99: number
  max: number
}

export interface CounterValue {
  /** null when neither the end line nor any status line carries the key. */
  value: number | null
  byReason?: Record<string, number>
  from?: "end" | "status" | "events"
}

export interface QuarterSummary {
  index: number
  seconds: number
  deliveredFps: number | null
  /** Median of the per-second rolling `deliveryGapMsP95` within the quarter. */
  deliveryGapMsP95: number | null
  sendRateFps: number | null
}

export interface ThermalSummary {
  measured: boolean
  counts: Record<string, number>
  worst: string | null
  worstRank: number | null
  transitions: Array<{second: number; from: string; to: string}>
}

export interface MemorySummary {
  startMb: number
  endMb: number
  maxMb: number
  slopeMbPerMin: number | null
  series: number[]
}

export interface RunSummary {
  path?: string
  runId: string | null
  platform: string | null
  mode: string | null
  source: string | null
  targetFps: number | null
  periodMs: number | null
  meta: RunRecord | null
  statusLines: number
  analyzedSeconds: number
  durationSec: number
  malformedLines: number
  warnings: string[]
  geometry: Record<string, unknown>
  quarters: QuarterSummary[]
  metrics: Record<string, Distribution | null>
  sendRate: {field: string | null; meanFps: number | null; buckets: number[]}
  tapOffer: {weightedMeanUs: number | null; perSecond: Distribution | null}
  counters: Record<string, CounterValue>
  events: {counts: Record<string, number>; timeline: RunRecord[]}
  thermal: ThermalSummary
  memory: MemorySummary | null
  endReason: string | null
}

/** Per-second metrics summarised as distributions across status lines. */
export const METRIC_KEYS = [
  "deliveredFps",
  "sourceFps",
  "packMsP95",
  "sendCompleteMsP95",
  "sendEnqueueMsP95",
  "mainQueueWaitMsP95",
  "rttMsP95",
  "deliveryGapMsP50",
  "deliveryGapMsP95",
  "tapOfferMeanUs",
  "tapOfferMaxUs",
  "tapCadenceMeanMs",
  "tapCadenceMaxMs",
  "memoryFootprintMb",
] as const

const GEOMETRY_KEYS = ["width", "height", "outWidth", "outHeight", "srcWidth", "srcHeight", "pixelFormat"]

/** Lower rank is cooler. Unknown or unavailable states are not ranked. */
export const THERMAL_RANKS: Record<string, Record<string, number>> = {
  ios: {nominal: 0, fair: 1, serious: 2, critical: 3},
  android: {none: 0, light: 1, moderate: 2, severe: 3, critical: 4, emergency: 5, shutdown: 6},
}

export function parseRunLog(text: string, path?: string): ParsedRun {
  const run: ParsedRun = {path, meta: null, status: [], events: [], end: null, malformedLines: 0, warnings: []}
  let unknown = 0
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      // A truncated last line is expected after a crash or kill; everything before it is valid.
      run.malformedLines++
      continue
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      run.malformedLines++
      continue
    }
    const entry = record as RunRecord
    switch (entry.t) {
      case "meta":
        if (run.meta) run.warnings.push("more than one meta line; using the first")
        else run.meta = entry
        break
      case "status":
        run.status.push(entry)
        break
      case "event":
        run.events.push(entry)
        break
      case "end":
        run.end = entry
        break
      default:
        unknown++
    }
  }
  if (run.malformedLines > 0) run.warnings.push(`${run.malformedLines} malformed line(s) skipped`)
  if (unknown > 0) run.warnings.push(`${unknown} line(s) with unknown "t" skipped`)
  if (!run.meta) run.warnings.push("no meta line")
  if (!run.end) run.warnings.push("no end line (run may have been killed); counters come from the last status line")
  return run
}

export function readRunLog(path: string): ParsedRun {
  return parseRunLog(readFileSync(path, "utf8"), path)
}

export function num(record: RunRecord | null | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function str(record: RunRecord | null | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" ? value : undefined
}

/** Nearest-rank on `(n - 1) * q`, the same rule the native percentile rings use. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const position = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))
  return sorted[position]
}

export function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((total, value) => total + value, 0)
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  }
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length
}

function median(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : quantile(
        [...values].sort((a, b) => a - b),
        0.5,
      )
}

function values(lines: readonly RunRecord[], key: string, keep: (value: number) => boolean = () => true): number[] {
  const out: number[] = []
  for (const line of lines) {
    const value = num(line, key)
    if (value !== undefined && keep(value)) out.push(value)
  }
  return out
}

/** Least-squares slope, x in minutes. */
function slopePerMinute(series: readonly number[]): number | null {
  if (series.length < 2) return null
  const n = series.length
  const xs = series.map((_, index) => index / 60)
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = series.reduce((a, b) => a + b, 0) / n
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < n; index++) {
    numerator += (xs[index] - meanX) * (series[index] - meanY)
    denominator += (xs[index] - meanX) ** 2
  }
  return denominator === 0 ? null : numerator / denominator
}

/**
 * Status lines that describe steady running: drop the warmup and any line written after the
 * pacer stopped (the final tick on stop covers a partial interval).
 */
export function analyzedLines(run: ParsedRun, options: AnalysisOptions): RunRecord[] {
  return run.status.slice(options.warmupSeconds).filter((line) => line.running !== false)
}

function counterValue(run: ParsedRun, key: string, windowed: boolean): CounterValue {
  const readMap = (raw: unknown): CounterValue | null => {
    if (typeof raw === "number" && Number.isFinite(raw)) return {value: raw}
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const byReason: Record<string, number> = {}
      let total = 0
      for (const [reason, count] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof count === "number" && Number.isFinite(count)) {
          byReason[reason] = count
          total += count
        }
      }
      return {value: total, byReason}
    }
    return null
  }
  const fromEnd = run.end ? readMap(run.end[key]) : null
  if (fromEnd) return {...fromEnd, from: "end"}
  if (windowed) {
    let total = 0
    let seen = false
    for (const line of run.status) {
      const value = num(line, key)
      if (value !== undefined) {
        total += value
        seen = true
      }
    }
    return seen ? {value: total, from: "status"} : {value: null}
  }
  for (let index = run.status.length - 1; index >= 0; index--) {
    const found = readMap(run.status[index][key])
    if (found) return {...found, from: "status"}
  }
  return {value: null}
}

function thermalSummary(lines: readonly RunRecord[], platform: string | null): ThermalSummary {
  const ranks = platform ? THERMAL_RANKS[platform] : undefined
  const counts: Record<string, number> = {}
  const transitions: ThermalSummary["transitions"] = []
  let worst: string | null = null
  let worstRank: number | null = null
  let previous: string | null = null
  lines.forEach((line, second) => {
    const state = str(line, "thermalState")
    if (!state) return
    counts[state] = (counts[state] ?? 0) + 1
    if (previous !== null && state !== previous) transitions.push({second, from: previous, to: state})
    previous = state
    const rank = ranks?.[state]
    if (rank !== undefined && (worstRank === null || rank > worstRank)) {
      worstRank = rank
      worst = state
    }
  })
  return {measured: worstRank !== null, counts, worst, worstRank, transitions}
}

const REDACTED_KEY = /token|url/i

export function redact(record: RunRecord): RunRecord {
  const out: RunRecord = {}
  for (const [key, value] of Object.entries(record)) {
    out[key] = typeof value === "string" && REDACTED_KEY.test(key) ? "[redacted]" : value
  }
  return out
}

export function summarizeRun(run: ParsedRun, options: AnalysisOptions): RunSummary {
  const lines = analyzedLines(run, options)
  const last = run.status[run.status.length - 1]
  const platform = str(run.meta, "platform") ?? str(last, "platform") ?? null
  const targetFps = num(run.meta, "targetFps") ?? num(last, "targetFps") ?? num(run.meta, "maxFps") ?? null
  const endDurationMs = num(run.end, "durationMs")

  const sendField = options.sendRateFields.find((field) => lines.some((line) => num(line, field) !== undefined)) ?? null
  const sendBuckets = sendField ? values(lines, sendField) : []

  const quarters: QuarterSummary[] = []
  const quarterCount = Math.min(4, lines.length)
  for (let index = 0; index < quarterCount; index++) {
    const chunk = lines.slice(Math.floor((index * lines.length) / 4), Math.floor(((index + 1) * lines.length) / 4))
    quarters.push({
      index: index + 1,
      seconds: chunk.length,
      deliveredFps: mean(values(chunk, "deliveredFps")),
      // Zero means the ring had no samples yet, not a zero-length gap.
      deliveryGapMsP95: median(values(chunk, "deliveryGapMsP95", (value) => value > 0)),
      sendRateFps: sendField ? mean(values(chunk, sendField)) : null,
    })
  }

  const metrics: Record<string, Distribution | null> = {}
  for (const key of METRIC_KEYS) {
    // The tap and gap metrics are 0 when nothing was sampled in that interval.
    const positiveOnly = key.startsWith("tap") || key.startsWith("deliveryGap")
    metrics[key] = distribution(values(lines, key, positiveOnly ? (value) => value > 0 : undefined))
  }

  const offerLines = lines.filter(
    (line) => (num(line, "tapFramesWithSink") ?? 1) > 0 && num(line, "tapOfferMeanUs") !== undefined,
  )
  let weightedMeanUs: number | null = null
  if (offerLines.length > 0) {
    let weight = 0
    let total = 0
    for (const line of offerLines) {
      const frames = num(line, "tapFramesWithSink") ?? 1
      weight += frames
      total += (num(line, "tapOfferMeanUs") ?? 0) * frames
    }
    weightedMeanUs = weight > 0 ? total / weight : null
  }

  const counters: Record<string, CounterValue> = {}
  for (const key of options.counters) counters[key] = counterValue(run, key, options.windowedCounters.includes(key))
  const eventCounts: Record<string, number> = {}
  for (const event of run.events) {
    const name = str(event, "event") ?? "unknown"
    eventCounts[name] = (eventCounts[name] ?? 0) + 1
  }
  // Older logs that lack a counter still record the matching event.
  const eventFallbacks: Record<string, string> = {
    ackTimeouts: "ackTimeout",
    transportErrors: "transport",
    staleAcks: "staleAck",
  }
  for (const [counter, event] of Object.entries(eventFallbacks)) {
    if (counters[counter] && counters[counter].value === null && run.events.length > 0) {
      counters[counter] = {value: eventCounts[event] ?? 0, from: "events"}
    }
  }

  const memorySeries = values(lines, "memoryFootprintMb")
  const memory: MemorySummary | null =
    memorySeries.length > 0
      ? {
          startMb: memorySeries[0],
          endMb: memorySeries[memorySeries.length - 1],
          maxMb: Math.max(...memorySeries),
          slopeMbPerMin: slopePerMinute(memorySeries),
          series: memorySeries,
        }
      : null

  const geometry: Record<string, unknown> = {}
  for (const key of GEOMETRY_KEYS) {
    const value = last?.[key] ?? run.meta?.[key]
    if (value !== undefined) geometry[key] = value
  }

  return {
    path: run.path,
    runId: str(run.meta, "runId") ?? str(last, "runId") ?? null,
    platform,
    mode: str(run.meta, "mode") ?? str(last, "mode") ?? null,
    source: str(run.meta, "source") ?? str(last, "source") ?? null,
    targetFps,
    periodMs: targetFps ? 1000 / targetFps : null,
    meta: run.meta,
    statusLines: run.status.length,
    analyzedSeconds: lines.length,
    durationSec: endDurationMs !== undefined ? endDurationMs / 1000 : run.status.length,
    malformedLines: run.malformedLines,
    warnings: run.warnings,
    geometry,
    quarters,
    metrics,
    sendRate: {field: sendField, meanFps: mean(sendBuckets), buckets: sendBuckets},
    tapOffer: {weightedMeanUs, perSecond: distribution(values(offerLines, "tapOfferMeanUs"))},
    counters,
    events: {counts: eventCounts, timeline: run.events.map(redact)},
    // Every tick counts here, warmup and stop included: the worst state of the run is the claim.
    thermal: thermalSummary(run.status, platform),
    memory,
    endReason: str(run.end, "reason") ?? null,
  }
}
