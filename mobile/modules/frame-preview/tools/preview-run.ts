#!/usr/bin/env bun
/**
 * Frame-preview run analysis for Phase 0 screening and the release gates.
 *
 *   bun preview-run.ts summarize <run.ndjson> [--json]
 *   bun preview-run.ts soak <run.ndjson> [--json]
 *   bun preview-run.ts diff <off.ndjson> <on.ndjson> [--gate auto|phase0|release] [--send-fps N] [--json]
 *   bun preview-run.ts retained <first.ndjson> [...] <last.ndjson> [--json]
 *
 * Exit codes: 0 PASS (or summarize), 1 FAIL, 2 INCOMPLETE (a criterion was not measured),
 * 64 usage, 66 unreadable input.
 * See RUNBOOK.md for which runs feed which command.
 */

import {
  comparabilityWarnings,
  evaluatePhase0,
  evaluateRelease,
  evaluateRetained,
  evaluateSoak,
  resolveSendTarget,
  type GateResult,
  type Tolerances,
} from "./gates"
import {METRIC_KEYS, readRunLog, summarizeRun, type RunSummary} from "./runlog"

/** Proposed defaults from the plan. Edit here once they are confirmed; nothing else holds a limit. */
export const TOLERANCES: Tolerances = {
  analysis: {
    warmupSeconds: 2,
    // First present wins. `tapFramesOffered` is frames the decoder handed to the ACS sender in
    // that tick, the closest send-rate signal the current log carries.
    sendRateFields: ["acsSendFps", "tapFramesOffered"],
    windowedCounters: ["tapSinkExceptions", "tapFramesOffered", "tapFramesWithSink"],
    counters: [
      "delivered",
      "sourceFrames",
      "skippedBusy",
      "skippedPacing",
      "preDispatchDrops",
      "slotStarved",
      "ackTimeouts",
      "staleAcks",
      "transportErrors",
      "packFailures",
      "unsupportedFormat",
      "tapSinkExceptions",
      "tapFramesOffered",
      "tapFramesWithSink",
      "installReloads",
      "handshakes",
      "reconnects",
      "tierChanges",
      "parseRejects",
      "staleControlOps",
      "contextLosses",
      "pausedBackgroundMs",
    ],
  },
  durationSlackSec: 10,
  sendTargetMetaKeys: ["acsTargetFps", "sendTargetFps"],
  soak: {
    minDurationMin: 20,
    fpsWithinPct: 2,
    gapP95PeriodMultiple: 1.2,
    zeroCounters: ["ackTimeouts", "transportErrors"],
  },
  phase0: {
    minDurationMin: 5,
    sendRateWithinPct: 2,
    minBucketPctOfTarget: 90,
    tapOfferMeanMaxUs: 50,
    tapOfferP99MaxUs: 500,
    tapCadenceP99GrowthMaxMs: 5,
  },
  release: {
    minDurationMin: 20,
    sendRateWithinPct: 2,
    tapCadenceP99GrowthMaxMs: 5,
    gapP95PeriodMultiple: 1.2,
    thermalCeiling: {ios: "fair", android: "moderate"},
    memorySlopeDeltaMaxMbPerMin: 0.2,
    zeroCounters: ["ackTimeouts", "transportErrors", "tapSinkExceptions", "packFailures", "installReloads"],
  },
  retained: {
    maxRetainedMb: 2,
    baselineSeconds: 5,
    tailSeconds: 5,
  },
}

const f = (value: number | null | undefined, digits = 1): string =>
  value === null || value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(digits)

export function formatSummary(s: RunSummary): string {
  const out: string[] = []
  out.push(`== ${s.runId ?? "(no runId)"}  ${s.path ?? ""}`.trimEnd())
  if (s.meta) {
    const meta = Object.entries(s.meta)
      .filter(([key]) => key !== "t" && key !== "runId")
      .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    out.push(`meta: ${meta.join(" ")}`)
  }
  out.push(
    `duration ${f(s.durationSec / 60, 2)} min, ${s.statusLines} status lines, ${s.analyzedSeconds} analysed ` +
      `(end reason: ${s.endReason ?? "none"})`,
  )
  if (Object.keys(s.geometry).length > 0) {
    out.push(
      `geometry: ${Object.entries(s.geometry)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(" ")}`,
    )
  }
  for (const warning of s.warnings) out.push(`warning: ${warning}`)

  out.push("", "quarters:")
  for (const q of s.quarters) {
    out.push(
      `  Q${q.index} ${String(q.seconds).padStart(4)} s  deliveredFps ${f(q.deliveredFps, 2).padStart(6)}` +
        `  gapP95 ${f(q.deliveryGapMsP95).padStart(6)} ms  sendRate ${f(q.sendRateFps, 2).padStart(6)} fps`,
    )
  }
  if (s.quarters.length === 0) out.push("  (no analysed status lines)")

  out.push("", "per-second distributions:            n     mean      p50      p95      p99      max")
  for (const key of METRIC_KEYS) {
    const d = s.metrics[key]
    if (!d) {
      out.push(`  ${key.padEnd(22)} not measured`)
      continue
    }
    const cols = [d.mean, d.p50, d.p95, d.p99, d.max].map((v) => f(v, 2).padStart(8))
    out.push(`  ${key.padEnd(22)} ${String(d.n).padStart(8)} ${cols.join(" ")}`)
  }
  out.push(
    `  send rate: ${s.sendRate.field ?? "not measured"}${s.sendRate.field ? `, mean ${f(s.sendRate.meanFps, 2)} fps` : ""}` +
      `; tap offer weighted mean ${f(s.tapOffer.weightedMeanUs, 2)} us`,
  )

  out.push("", "counters:")
  for (const [key, counter] of Object.entries(s.counters)) {
    const value = counter.value === null ? "not measured" : String(counter.value)
    const reasons = counter.byReason
      ? `  ${Object.entries(counter.byReason)
          .map(([r, n]) => `${r}=${n}`)
          .join(" ")}`
      : ""
    const from = counter.from && counter.from !== "end" ? `  (from ${counter.from})` : ""
    out.push(`  ${key.padEnd(20)} ${value}${reasons}${from}`)
  }

  out.push("", "events:")
  const counts = Object.entries(s.events.counts)
  out.push(counts.length ? `  ${counts.map(([e, n]) => `${e}=${n}`).join(" ")}` : "  none")
  const shown = s.events.timeline.slice(0, 40)
  for (const event of shown) {
    const {t: _t, runId: _runId, event: name, atMs, ...rest} = event
    const extra = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    out.push(
      `  ${f(typeof atMs === "number" ? atMs / 1000 : null, 1).padStart(7)} s  ${String(name)} ${extra.join(" ")}`.trimEnd(),
    )
  }
  if (s.events.timeline.length > shown.length) out.push(`  ... ${s.events.timeline.length - shown.length} more`)

  out.push("", "thermal:")
  if (Object.keys(s.thermal.counts).length === 0) out.push("  not measured")
  else {
    out.push(
      `  ${Object.entries(s.thermal.counts)
        .map(([state, n]) => `${state}=${n}s`)
        .join(" ")}  worst=${s.thermal.worst ?? "unranked"}`,
    )
    for (const tr of s.thermal.transitions.slice(0, 20)) out.push(`  at line ${tr.second}: ${tr.from} -> ${tr.to}`)
  }
  if (s.memory) {
    out.push(
      "",
      `memory: start ${f(s.memory.startMb)} MB, end ${f(s.memory.endMb)} MB, max ${f(s.memory.maxMb)} MB, ` +
        `slope ${f(s.memory.slopeMbPerMin, 3)} MB/min`,
    )
  }
  return out.join("\n")
}

export function formatGate(gate: GateResult): string {
  const out = [`## ${gate.title}: ${gate.verdict}`]
  const width = Math.max(...gate.criteria.map((c) => c.label.length))
  for (const c of gate.criteria) {
    const tag = c.verdict === "NOT MEASURED" ? "[N/M] " : `[${c.verdict}] `
    out.push(`${tag.padEnd(7)}${c.label.padEnd(width)}  ${c.value}   (limit ${c.limit})`)
  }
  for (const note of gate.notes) out.push(`note: ${note}`)
  return out.join("\n")
}

function exitCodeFor(gates: GateResult[]): number {
  if (gates.some((g) => g.verdict === "FAIL")) return 1
  if (gates.some((g) => g.verdict === "INCOMPLETE")) return 2
  return 0
}

const USAGE = `usage:
  preview-run.ts summarize <run.ndjson> [--json]
  preview-run.ts soak <run.ndjson> [--json]
  preview-run.ts diff <off.ndjson> <on.ndjson> [--gate auto|phase0|release] [--send-fps N] [--json]
  preview-run.ts retained <first.ndjson> [...] <last.ndjson> [--json]`

interface CliIo {
  log: (text: string) => void
  error: (text: string) => void
}

/** Returns the process exit code. Split from `main` so tests can drive it. */
export function runCli(argv: string[], io: CliIo = {log: console.log, error: console.error}): number {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--json") flags.set("json", true)
    else if (arg === "--gate" || arg === "--send-fps") flags.set(arg.slice(2), argv[++index] ?? "")
    else if (arg.startsWith("--")) {
      io.error(`unknown flag ${arg}\n${USAGE}`)
      return 64
    } else positional.push(arg)
  }
  const [command, ...files] = positional
  const json = flags.has("json")
  const load = (path: string) => summarizeRun(readRunLog(path), TOLERANCES.analysis)

  try {
    switch (command) {
      case "summarize": {
        if (files.length !== 1) break
        const summary = load(files[0])
        io.log(json ? JSON.stringify(summary, null, 2) : formatSummary(summary))
        return 0
      }
      case "soak": {
        if (files.length !== 1) break
        const summary = load(files[0])
        const gate = evaluateSoak(summary, TOLERANCES)
        io.log(
          json ? JSON.stringify({summary, gates: [gate]}, null, 2) : `${formatSummary(summary)}\n\n${formatGate(gate)}`,
        )
        return exitCodeFor([gate])
      }
      case "diff": {
        if (files.length !== 2) break
        const off = load(files[0])
        const on = load(files[1])
        const sendFpsFlag = flags.get("send-fps")
        const sendFps = typeof sendFpsFlag === "string" ? Number(sendFpsFlag) : undefined
        if (sendFps !== undefined && !(sendFps > 0)) {
          io.error("--send-fps must be a positive number")
          return 64
        }
        let gateName = flags.get("gate") ?? "auto"
        if (gateName === "auto") {
          const releaseSec = TOLERANCES.release.minDurationMin * 60 - TOLERANCES.durationSlackSec
          gateName = off.durationSec >= releaseSec && on.durationSec >= releaseSec ? "release" : "phase0"
        }
        if (gateName !== "phase0" && gateName !== "release") {
          io.error(`--gate must be auto, phase0 or release\n${USAGE}`)
          return 64
        }
        const gate =
          gateName === "release"
            ? evaluateRelease(off, on, TOLERANCES)
            : evaluatePhase0(off, on, TOLERANCES, resolveSendTarget(off, on, TOLERANCES, sendFps))
        const warnings = comparabilityWarnings(off, on)
        if (json) io.log(JSON.stringify({off, on, warnings, gates: [gate]}, null, 2))
        else {
          const lines = [formatSummary(off), "", formatSummary(on), ""]
          for (const warning of warnings) lines.push(`comparability warning: ${warning}`)
          lines.push(formatGate(gate))
          io.log(lines.join("\n"))
        }
        return exitCodeFor([gate])
      }
      case "retained": {
        if (files.length < 1) break
        const runs = files.map(load)
        const gate = evaluateRetained(runs, TOLERANCES)
        io.log(json ? JSON.stringify({gates: [gate]}, null, 2) : formatGate(gate))
        return exitCodeFor([gate])
      }
    }
  } catch (error) {
    io.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 66
  }
  io.error(USAGE)
  return 64
}

if (import.meta.main) process.exit(runCli(process.argv.slice(2)))
