import {describe, expect, test} from "bun:test"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {
  evaluatePhase0,
  evaluateRelease,
  evaluateRetained,
  evaluateSoak,
  resolveSendTarget,
  type GateResult,
} from "../gates"
import {formatGate, formatSummary, runCli, TOLERANCES} from "../preview-run"
import {parseRunLog, quantile, readRunLog, summarizeRun} from "../runlog"
import {syntheticRun, type SyntheticRunOptions} from "./synthetic-run"

const fixture = (name: string) => join(import.meta.dir, "fixtures", name)
const load = (name: string) => summarizeRun(readRunLog(fixture(name)), TOLERANCES.analysis)
const synth = (options: SyntheticRunOptions) => summarizeRun(parseRunLog(syntheticRun(options)), TOLERANCES.analysis)
const verdictOf = (gate: GateResult, id: string) => gate.criteria.find((c) => c.id === id)?.verdict

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {io: {log: (s: string) => out.push(s), error: (s: string) => err.push(s)}, out, err}
}

describe("parsing and summary", () => {
  test("nearest-rank quantile matches the native rings", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(quantile(sorted, 0.5)).toBe(6) // round(9 * 0.5) = 5 -> index 5 (0-based) -> 6
    expect(quantile(sorted, 0.95)).toBe(10)
    expect(quantile([7], 0.99)).toBe(7)
  })

  test("android fixture: warmup and post-stop lines are excluded, counters come from the end line", () => {
    const s = load("android-call-render.ndjson")
    expect(s.platform).toBe("android")
    expect(s.targetFps).toBe(15)
    expect(s.statusLines).toBe(13)
    // 13 lines - 2 warmup - 1 running:false
    expect(s.analyzedSeconds).toBe(10)
    expect(s.durationSec).toBeCloseTo(12.9, 1)
    expect(s.quarters).toHaveLength(4)
    for (const q of s.quarters) expect(q.deliveredFps).toBe(15)
    // The pre-start drain (900 frames, 400 ms cadence) never reaches the distributions.
    expect(s.metrics.tapCadenceMaxMs?.max).toBeLessThan(50)
    expect(s.sendRate.field).toBe("tapFramesOffered")
    expect(s.sendRate.meanFps).toBe(30)
    expect(s.counters.delivered).toEqual({value: 183, from: "end"})
    expect(s.counters.staleAcks).toEqual({value: 0, from: "status"})
    expect(s.counters.installReloads.value).toBeNull()
    expect(s.events.counts).toEqual({document: 1, consumer: 1, staleAck: 1})
    expect(s.thermal.worst).toBe("light")
    expect(s.memory?.slopeMbPerMin).toBeCloseTo(6, 5) // 0.1 MB per line = 6 MB/min
    expect(s.endReason).toBe("page_stop")
  })

  test("ios fixture: truncated tail is skipped, absent keys are not measured, urls are redacted", () => {
    const s = load("ios-synthetic-truncated.ndjson")
    expect(s.malformedLines).toBe(1)
    expect(s.warnings.join("\n")).toContain("no end line")
    expect(s.statusLines).toBe(8)
    expect(s.metrics.mainQueueWaitMsP95).toBeNull()
    expect(s.metrics.sendEnqueueMsP95?.p50).toBe(0.4)
    expect(s.counters.tapSinkExceptions.value).toBeNull()
    expect(s.thermal.worst).toBe("fair")
    // No sink attached: tap offer telemetry is absent rather than zero.
    expect(s.tapOffer.weightedMeanUs).toBeNull()
    expect(s.metrics.tapCadenceMaxMs).toBeNull()
    const text = formatSummary(s)
    expect(text).not.toContain("SECRET")
    expect(text).toContain("url=[redacted]")
  })

  test("contract counters: reason maps, geometry, and a missing schema field never throw", () => {
    const s = load("contract-counters.ndjson")
    expect(s.targetFps).toBe(15) // from maxFps
    expect(s.counters.packFailures).toEqual({value: 1, byReason: {stride_too_small: 1, slot_too_small: 0}, from: "end"})
    expect(s.counters.tierChanges.value).toBe(1)
    expect(s.counters.parseRejects.value).toBeNull()
    expect(s.geometry).toMatchObject({outWidth: 640, outHeight: 360, srcWidth: 1280, srcHeight: 720})
    expect(s.sendRate.field).toBe("acsSendFps")
    expect(s.thermal.measured).toBe(false)
    expect(formatSummary(s)).toContain("not measured")
  })

  test("empty and garbage input summarise without throwing", () => {
    const s = summarizeRun(parseRunLog("\n\nnot json\n[1,2]\n"), TOLERANCES.analysis)
    expect(s.malformedLines).toBe(2)
    expect(s.quarters).toHaveLength(0)
    expect(evaluateSoak(s, TOLERANCES).verdict).toBe("FAIL")
  })
})

describe("Phase 0 soak", () => {
  const soak = (options: SyntheticRunOptions = {}) =>
    evaluateSoak(synth({platform: "android", mode: "render", targetFps: 30, seconds: 1200, ...options}), TOLERANCES)

  test("a steady 20-minute 30 fps run passes", () => {
    const gate = soak()
    expect(gate.verdict).toBe("PASS")
  })

  test("one quarter 3% low fails the fps criterion", () => {
    const gate = soak({deliveredFps: (i) => (i >= 600 && i < 900 ? 29.1 : 30)})
    expect(verdictOf(gate, "soak.fps")).toBe("FAIL")
  })

  test("gap p95 above 1.2x period fails", () => {
    const gate = soak({deliveryGapMsP95: () => 41}) // period 33.3 ms, limit 40 ms
    expect(verdictOf(gate, "soak.gap")).toBe("FAIL")
  })

  test("an ack timeout fails, a short run fails on length", () => {
    expect(verdictOf(soak({end: {ackTimeouts: 1}}), "soak.ackTimeouts")).toBe("FAIL")
    expect(verdictOf(soak({seconds: 600}), "soak.duration")).toBe("FAIL")
  })
})

describe("Phase 0 real-call screening", () => {
  const pair = (onOptions: SyntheticRunOptions = {}, offOptions: SyntheticRunOptions = {}) => {
    const off = synth({mode: "off", seconds: 300, ...offOptions})
    const on = synth({mode: "render", seconds: 300, ...onOptions})
    return evaluatePhase0(off, on, TOLERANCES, resolveSendTarget(off, on, TOLERANCES))
  }

  test("identical call behaviour passes", () => {
    const gate = pair()
    expect(gate.verdict).toBe("PASS")
    expect(formatGate(gate)).toContain("[PASS]")
  })

  test("3% lower send rate fails", () => {
    expect(verdictOf(pair({tapFramesOffered: (i) => (i % 100 < 10 ? 20 : 30)}), "phase0.sendRate")).toBe("FAIL")
  })

  test("a single 1 s bucket under 90% of target fails even when the mean holds", () => {
    const gate = pair({tapFramesOffered: (i) => (i === 150 ? 26 : 30)})
    expect(verdictOf(gate, "phase0.sendRate")).toBe("PASS")
    expect(verdictOf(gate, "phase0.minBucket")).toBe("FAIL")
  })

  test("explicit --send-fps target is honoured", () => {
    const off = synth({mode: "off", seconds: 300})
    const on = synth({mode: "render", seconds: 300})
    const gate = evaluatePhase0(off, on, TOLERANCES, resolveSendTarget(off, on, TOLERANCES, 40))
    expect(verdictOf(gate, "phase0.minBucket")).toBe("FAIL") // 30 < 36
  })

  test("tap offer mean and p99 limits", () => {
    expect(verdictOf(pair({tapOfferMeanUs: () => 60}), "phase0.tapOfferMean")).toBe("FAIL")
    const spiky = pair({tapOfferMeanUs: (i) => (i % 50 === 0 ? 900 : 10)})
    expect(verdictOf(spiky, "phase0.tapOfferP99")).toBe("FAIL")
  })

  test("cadence p99 growth over 5 ms fails", () => {
    expect(verdictOf(pair({tapCadenceMaxMs: () => 46}), "phase0.cadence")).toBe("FAIL")
    expect(verdictOf(pair({tapCadenceMaxMs: () => 44}), "phase0.cadence")).toBe("PASS")
  })

  test("missing tap telemetry is NOT MEASURED and makes the gate INCOMPLETE", () => {
    const gate = pair({tapOfferMeanUs: () => undefined, tapCadenceMaxMs: () => undefined})
    expect(verdictOf(gate, "phase0.tapOfferMean")).toBe("NOT MEASURED")
    expect(verdictOf(gate, "phase0.cadence")).toBe("NOT MEASURED")
    expect(gate.verdict).toBe("INCOMPLETE")
  })
})

describe("release gates", () => {
  const release = (onOptions: SyntheticRunOptions = {}, offOptions: SyntheticRunOptions = {}) =>
    evaluateRelease(
      synth({mode: "off", seconds: 1200, ...offOptions}),
      synth({mode: "render", seconds: 1200, ...onOptions}),
      TOLERANCES,
    )

  test("matched 20-minute runs pass", () => {
    expect(release().verdict).toBe("PASS")
  })

  test("thermal ceiling and relative thermal", () => {
    const hot = release({thermalState: (i) => (i > 900 ? "severe" : "none")})
    expect(verdictOf(hot, "release.thermal.ceiling")).toBe("FAIL")
    expect(verdictOf(hot, "release.thermal.relative")).toBe("FAIL")
    const warmBoth = release({thermalState: () => "moderate"}, {thermalState: () => "moderate"})
    expect(verdictOf(warmBoth, "release.thermal.ceiling")).toBe("PASS")
    expect(verdictOf(warmBoth, "release.thermal.relative")).toBe("PASS")
    const iosFair = evaluateRelease(
      synth({platform: "ios", mode: "off", seconds: 1200}),
      synth({platform: "ios", mode: "render", seconds: 1200, thermalState: (i) => (i > 10 ? "serious" : "nominal")}),
      TOLERANCES,
    )
    expect(verdictOf(iosFair, "release.thermal.ceiling")).toBe("FAIL")
  })

  test("memory slope delta over 0.2 MB/min fails", () => {
    const leaky = release({memoryFootprintMb: (i) => 100 + (i / 60) * 0.3})
    expect(verdictOf(leaky, "release.memorySlope")).toBe("FAIL")
    const bothGrow = release(
      {memoryFootprintMb: (i) => 100 + (i / 60) * 0.3},
      {memoryFootprintMb: (i) => 100 + (i / 60) * 0.2},
    )
    expect(verdictOf(bothGrow, "release.memorySlope")).toBe("PASS")
  })

  test("preview error counters and install reloads", () => {
    expect(verdictOf(release({end: {packFailures: {sink_error: 2}}}), "release.packFailures")).toBe("FAIL")
    const noReloadCounter = release({end: {installReloads: undefined}})
    expect(verdictOf(noReloadCounter, "release.installReloads")).toBe("NOT MEASURED")
  })

  test("retained memory after toggles", () => {
    const first = synth({seconds: 30, memoryFootprintMb: () => 100})
    const lastOk = synth({seconds: 30, memoryFootprintMb: (i) => (i > 20 ? 101.5 : 104)})
    const lastBad = synth({seconds: 30, memoryFootprintMb: () => 103})
    expect(evaluateRetained([first, lastOk], TOLERANCES).verdict).toBe("PASS")
    expect(evaluateRetained([first, lastBad], TOLERANCES).verdict).toBe("FAIL")
  })
})

describe("cli", () => {
  const dir = mkdtempSync(join(tmpdir(), "preview-run-"))
  const write = (name: string, text: string) => {
    const path = join(dir, name)
    writeFileSync(path, text)
    return path
  }

  test("summarize prints sections and exits 0", () => {
    const {io, out} = capture()
    expect(runCli(["summarize", fixture("android-call-render.ndjson")], io)).toBe(0)
    expect(out[0]).toContain("quarters:")
    expect(out[0]).toContain("counters:")
    expect(out[0]).toContain("thermal:")
  })

  test("diff auto-selects the gate from run length and sets the exit code", () => {
    const off5 = write("off5.ndjson", syntheticRun({mode: "off", seconds: 300}))
    const on5 = write("on5.ndjson", syntheticRun({mode: "render", seconds: 300}))
    const on5bad = write("on5bad.ndjson", syntheticRun({mode: "render", seconds: 300, tapCadenceMaxMs: () => 60}))
    const off20 = write("off20.ndjson", syntheticRun({mode: "off", seconds: 1200}))
    const on20 = write("on20.ndjson", syntheticRun({mode: "render", seconds: 1200}))

    let c = capture()
    expect(runCli(["diff", off5, on5], c.io)).toBe(0)
    expect(c.out[0]).toContain("Phase 0 real-call screening")
    c = capture()
    expect(runCli(["diff", off5, on5bad], c.io)).toBe(1)
    c = capture()
    expect(runCli(["diff", off20, on20], c.io)).toBe(0)
    expect(c.out[0]).toContain("Release gate: sustained real call")
    c = capture()
    expect(runCli(["diff", off5, on5, "--gate", "release"], c.io)).toBe(1) // too short
    c = capture()
    expect(runCli(["diff", off5, on5, "--json"], c.io)).toBe(0)
    expect(JSON.parse(c.out[0]).gates[0].gate).toBe("phase0")
  })

  test("incomplete, usage and missing-file exit codes", () => {
    const off = write("off-notap.ndjson", syntheticRun({mode: "off", seconds: 300, tapCadenceMaxMs: () => undefined}))
    const on = write("on-notap.ndjson", syntheticRun({mode: "render", seconds: 300, tapCadenceMaxMs: () => undefined}))
    expect(runCli(["diff", off, on], capture().io)).toBe(2)
    expect(runCli(["bogus"], capture().io)).toBe(64)
    expect(runCli(["diff", off], capture().io)).toBe(64)
    expect(runCli(["summarize", join(dir, "missing.ndjson")], capture().io)).toBe(66)
  })
})
