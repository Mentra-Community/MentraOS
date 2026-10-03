// TEMPORARY DIAGNOSTIC TOOLING — SOFTAP_TRACE. Delete with the trace layer.
import assert from "node:assert/strict"
import test from "node:test"

import {
  DWELL_CAP_MS,
  ceilingComparison,
  findEpisodes,
  median,
  medianAround,
  render,
  stabilityStats,
  summarize,
  weightedPercentile,
} from "./acs-quality-compare.mjs"

/**
 * The analyzer is what a device session is judged by, and the failure that costs the most is the
 * quiet one. There have been two of those. First a field renamed on the native side, nothing
 * parsed, and a table of dashes that read like "the two paths are identical". Then a sampler that
 * only looked at +10/+30/+60s and pronounced an 8-minute call healthy when it spent 90 seconds at
 * 33 kbps starting at t=150s.
 *
 * So the tests below are mostly about the second kind: a configuration must not be able to pass by
 * failing late, and a call the analyzer could not see must not be reported as a call that was fine.
 */

const line = (stage, fields = {}, {traceId = "aaa111", elapsedMs = 0} = {}) => {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value).includes(" ") ? `"${value}"` : value}`)
    .join(" ")
  return `09-12 11:00:00.000  1234  1234 I SOFTAP-TRACE: [SOFTAP_TRACE] traceId=${traceId} stage=${stage} elapsedMs=${elapsedMs}${rendered ? " " + rendered : ""}`
}

/**
 * One synthetic call.
 *
 * `bitrate` may be a number or a function of the offset since `connected`, which is what lets a
 * test build the failure that started all this: healthy through the window the old analyzer
 * looked at, then a collapse. `inbound` is the glasses hop, so a test can make the two disagree —
 * the disagreement is the whole reason both are reported.
 */
function call({
  traceId,
  origin,
  lobbyMs = 0,
  connectedAtMs = 5_000,
  bitrate,
  inbound,
  sentFps = 15,
  mediaStatsReports = 12,
  durationMs = 62_000,
  stepMs = 2_000,
  ceilingBps = 3_000_000,
  size = () => ({width: 960, height: 540}),
}) {
  const rateAt = typeof bitrate === "function" ? bitrate : () => bitrate
  const inboundAt = typeof inbound === "function" ? inbound : () => inbound
  const lines = [
    line("acs_join_options", {origin, transport: "softap"}, {traceId}),
    line(
      "acs_outgoing_format",
      {origin, callId: `c-${traceId}`, width: 960, height: 540, fps: 15},
      {traceId, elapsedMs: 1_000},
    ),
  ]
  if (lobbyMs > 0) {
    lines.push(
      line(
        "acs_call_state",
        {origin, callId: `c-${traceId}`, callPhase: "lobby", sinceJoinMs: connectedAtMs - lobbyMs, sinceLobbyMs: 0},
        {traceId, elapsedMs: connectedAtMs - lobbyMs},
      ),
    )
  }
  lines.push(
    line(
      "acs_call_state",
      {
        origin,
        callId: `c-${traceId}`,
        callPhase: "connected",
        sinceJoinMs: connectedAtMs,
        // -1 is how native reports "this call never sat in the lobby", which is a different fact
        // from a dwell of zero and has to stay distinguishable in the table.
        sinceLobbyMs: lobbyMs > 0 ? lobbyMs : -1,
      },
      {traceId, elapsedMs: connectedAtMs},
    ),
  )
  for (let offset = 0; offset <= durationMs; offset += stepMs) {
    const {width, height} = size(offset)
    lines.push(
      line(
        "acs_bwe_sample",
        {
          origin,
          callId: `c-${traceId}`,
          state: "connected",
          sinceConnectedMs: offset,
          lobbyDwellMs: lobbyMs,
          sendQuality: offset < 12_000 ? "GOOD" : "POOR",
          wireBitrateBps: rateAt(offset),
          wireWidth: rateAt(offset) > 0 ? width : -1,
          wireHeight: rateAt(offset) > 0 ? height : -1,
          sentFps,
          mediaStatsReports,
          mediaStatsAttached: true,
          videoOut: "started",
          budgetBps: ceilingBps,
        },
        {traceId, elapsedMs: connectedAtMs + offset},
      ),
      line(
        "whip_ingest_sample",
        {iceState: "connected", inboundBitrateBps: inboundAt(offset)},
        {traceId, elapsedMs: connectedAtMs + offset},
      ),
    )
  }
  return lines.join("\n")
}

/** The capture that motivated the rewrite: fine for two minutes, then 90s in the mud. */
const lateCollapse = (offset) => (offset >= 120_000 && offset < 210_000 ? 33_000 : 1_300_000)

test("two captures are grouped by the path the wearer took", () => {
  const calls = summarize([
    call({traceId: "aaa111", origin: "created", bitrate: 2_200_000, inbound: 2_400_000}),
    call({traceId: "bbb222", origin: "joined", lobbyMs: 9_000, bitrate: 900_000, inbound: 2_400_000}),
  ])

  assert.equal(calls.length, 2)
  const created = calls.find((entry) => entry.origin === "created")
  const joined = calls.find((entry) => entry.origin === "joined")
  assert.equal(created.bitrateAt[30], 2_200_000)
  assert.equal(joined.bitrateAt[30], 900_000)
  assert.equal(joined.lobbyDwellMs, 9_000)
  assert.equal(created.lobbyDwellMs, null)
  // Both hops, because a joined call that is starved on the ACS side while the glasses keep
  // feeding it full rate is a different finding from one where the glasses are the limit.
  assert.equal(joined.inboundAt[30], 2_400_000)
  assert.equal(joined.negotiated, "960x540@15")
})

test("a collapse after the ramp window is the headline, not a footnote", () => {
  const [entry] = summarize([
    call({
      traceId: "late111",
      origin: "joined",
      bitrate: lateCollapse,
      inbound: 2_000_000,
      durationMs: 300_000,
    }),
  ])

  // The old verdict: all three ramp offsets healthy. This is exactly the trap.
  assert.equal(entry.bitrateAt[10], 1_300_000)
  assert.equal(entry.bitrateAt[60], 1_300_000)
  // The new verdict disagrees, and does so on the numbers that describe the whole call.
  assert.equal(entry.minBitrateBps, 33_000)
  assert.equal(entry.p5BitrateBps, 33_000)
  assert.equal(entry.lowDwellMs, 90_000)
  assert.equal(entry.veryLowDwellMs, 90_000)
  assert.equal(entry.longestEpisodeMs, 90_000)
  // And it names the hop that stayed healthy, which is what assigns the blame.
  assert.equal(entry.inboundDuringEpisodesBps, 2_000_000)
})

test("a healthy call reports no episodes and a full-rate floor", () => {
  const [entry] = summarize([
    call({traceId: "ok11111", origin: "created", bitrate: 1_400_000, inbound: 2_000_000, durationMs: 300_000}),
  ])

  assert.equal(entry.lowDwellMs, 0)
  assert.equal(entry.veryLowDwellMs, 0)
  assert.deepEqual(entry.episodes, [])
  assert.equal(entry.minBitrateBps, 1_400_000)
  assert.equal(entry.worstRecoveryMs, null)
  assert.equal(entry.downscaleCount, 0)
})

test("recovery is timed separately from the dip, because the climb is the longer half", () => {
  // Down at 60s, back over the low threshold at 90s, but not over 1 Mbps until 150s.
  const rate = (offset) => {
    if (offset < 60_000) return 1_300_000
    if (offset < 90_000) return 40_000
    if (offset < 150_000) return 700_000
    return 1_300_000
  }
  const [entry] = summarize([
    call({traceId: "rec1111", origin: "joined", bitrate: rate, inbound: 2_000_000, durationMs: 200_000}),
  ])

  assert.equal(entry.episodes.length, 1)
  const [episode] = entry.episodes
  assert.equal(episode.durationMs, 30_000)
  assert.equal(episode.minBitrateBps, 40_000)
  // The dip cost 30s; getting the picture back cost twice that. Reporting only the dip would
  // understate the wearer's experience by a factor of three.
  assert.equal(episode.recoveryMs, 60_000)
  assert.equal(entry.worstEpisodeCostMs, 90_000)
})

test("the minimum resolution and every downscale are reported", () => {
  const ladder = (offset) => {
    if (offset < 40_000) return {width: 960, height: 540}
    if (offset < 60_000) return {width: 640, height: 360}
    if (offset < 80_000) return {width: 320, height: 180}
    return {width: 960, height: 540}
  }
  const [entry] = summarize([
    call({
      traceId: "res1111",
      origin: "joined",
      bitrate: 900_000,
      inbound: 2_000_000,
      durationMs: 120_000,
      size: ladder,
    }),
  ])

  assert.equal(entry.minResolution, "320x180")
  assert.equal(entry.minPixels, 320 * 180)
  assert.equal(entry.downscaleCount, 2)
})

test("an unobserved stretch is missing coverage, not the last thing that was seen", () => {
  // One filled reading, then silence for the rest of a five-minute call.
  const capture = [
    line("acs_join_options", {origin: "created", transport: "softap"}, {traceId: "thin111"}),
    line(
      "acs_call_state",
      {origin: "created", callId: "c-thin", callPhase: "connected", sinceJoinMs: 4_000, sinceLobbyMs: -1},
      {traceId: "thin111", elapsedMs: 4_000},
    ),
    line(
      "acs_bwe_sample",
      {
        origin: "created",
        callId: "c-thin",
        state: "connected",
        sinceConnectedMs: 0,
        wireBitrateBps: 1_300_000,
        wireWidth: 960,
        wireHeight: 540,
        sentFps: 15,
        budgetBps: 3_000_000,
      },
      {traceId: "thin111", elapsedMs: 4_000},
    ),
    line(
      "acs_bwe_sample",
      {
        origin: "created",
        callId: "c-thin",
        state: "connected",
        sinceConnectedMs: 300_000,
        wireBitrateBps: -1,
        sentFps: 15,
        budgetBps: 3_000_000,
      },
      {traceId: "thin111", elapsedMs: 304_000},
    ),
  ].join("\n")

  const [entry] = summarize([capture])

  assert.equal(entry.connectedMs, 300_000)
  // One observation may speak for DWELL_CAP_MS and not a second longer, so a five-minute call
  // seen once is 4% covered rather than "1.3 Mbps throughout".
  assert.equal(entry.coverageMs, DWELL_CAP_MS)
  assert.ok(entry.coverageRatio < 0.05)
  assert.match(render([entry]), /THIN COVERAGE/)
})

test("a call ACS never reported on is refused rather than ranked", () => {
  const [entry] = summarize([
    call({traceId: "fff666", origin: "created", bitrate: -1, inbound: 1_800_000, mediaStatsReports: 0}),
  ])

  assert.equal(entry.minBitrateBps, null)
  assert.equal(entry.medianBitrateBps, null)
  assert.equal(entry.firstBitrateBps, null)
  // The fps columns still work, so the capture is not useless — it just cannot rank a ceiling.
  assert.equal(entry.sentFpsAt[30], 15)
  const text = render([entry])
  assert.match(text, /NO ACS WIRE DATA/)
  assert.match(text, /cannot be ranked/)
})

test("ceilings are ranked by time in the mud, not by their good periods", () => {
  // The hypothesis under test: the higher ceiling has the better peak and the worse call.
  const highCeiling = (offset) => (offset >= 60_000 && offset < 180_000 ? 35_000 : 2_400_000)
  const calls = summarize([
    call({
      traceId: "hi11111",
      origin: "joined",
      bitrate: highCeiling,
      inbound: 2_000_000,
      durationMs: 600_000,
      ceilingBps: 3_000_000,
    }),
    call({
      traceId: "lo11111",
      origin: "joined",
      bitrate: 1_450_000,
      inbound: 2_000_000,
      durationMs: 600_000,
      ceilingBps: 1_500_000,
    }),
  ])

  const text = render(calls)
  assert.match(text, /ACS CEILING A\/B/)
  const lines = ceilingComparison(calls).filter((entry) => /^\d/.test(entry.trim()))
  // 1.5M first: it never went under 500k, so its time-in-the-mud is zero.
  assert.match(lines[0], /^1\.5M/)
  assert.match(lines[1], /^3\.0M/)
})

test("a single-arm capture refuses to rank ceilings", () => {
  const calls = summarize([
    call({traceId: "one1111", origin: "created", bitrate: 1_300_000, inbound: 2_000_000, ceilingBps: 3_000_000}),
  ])

  assert.match(render(calls), /Single ACS ceiling/)
  assert.doesNotMatch(render(calls), /ACS CEILING A\/B/)
})

test("the ramp table is labelled as unable to deliver a verdict", () => {
  const text = render(
    summarize([call({traceId: "aaa111", origin: "created", bitrate: 2_200_000, inbound: 2_400_000})]),
  )

  assert.match(text, /RAMP — first 60s only/)
  assert.match(text, /not a verdict/)
  // Stability is printed first, because whichever block is on top is the one that gets quoted.
  assert.ok(text.indexOf("WHOLE-CALL STABILITY") < text.indexOf("RAMP"))
})

test("percentiles weight time, not sample count", () => {
  // Two dense healthy readings and one sparse bad one covering five times as long. By count the
  // median is healthy; by time it is not, and time is what the wearer experienced.
  const weighted = [
    {bitrateBps: 1_300_000, dwellMs: 2_000},
    {bitrateBps: 1_300_000, dwellMs: 2_000},
    {bitrateBps: 40_000, dwellMs: 10_000},
  ]

  assert.equal(weightedPercentile(weighted, 0.5), 40_000)
  assert.equal(weightedPercentile(weighted, 0.95), 1_300_000)
})

test("episodes carry the glasses-hop rate that was measured alongside them", () => {
  const weighted = [
    {sinceConnectedMs: 0, bitrateBps: 1_300_000, dwellMs: 2_000},
    {sinceConnectedMs: 2_000, bitrateBps: 40_000, dwellMs: 2_000},
    {sinceConnectedMs: 4_000, bitrateBps: 1_300_000, dwellMs: 2_000},
  ]
  const ingest = [
    {sinceConnectedMs: 2_000, inboundBitrateBps: 2_100_000},
    {sinceConnectedMs: 3_000, inboundBitrateBps: 2_300_000},
  ]

  const [episode] = findEpisodes(weighted, ingest)
  assert.equal(episode.minBitrateBps, 40_000)
  assert.equal(episode.inboundBitrateBps, 2_200_000)
})

test("stability on an empty series is empty rather than zero", () => {
  const stats = stabilityStats([], [], 120_000)

  // Zeroes here would read as "the call ran at 0 bps", which is a claim the capture cannot make.
  assert.equal(stats.minBitrateBps, null)
  assert.equal(stats.medianBitrateBps, null)
  assert.equal(stats.coverageRatio, 0)
  assert.equal(stats.connectedMs, 120_000)
})

test("native episode and adaptation traces are carried through when present", () => {
  const capture = [
    line("acs_join_options", {origin: "joined"}, {traceId: "nat1111"}),
    line(
      "acs_call_state",
      {origin: "joined", callId: "c-nat", callPhase: "connected", sinceJoinMs: 4_000, sinceLobbyMs: -1},
      {traceId: "nat1111", elapsedMs: 4_000},
    ),
    line(
      "acs_bwe_sample",
      {
        origin: "joined",
        callId: "c-nat",
        state: "connected",
        sinceConnectedMs: 10_000,
        wireBitrateBps: 1_300_000,
        wireWidth: 960,
        wireHeight: 540,
        budgetBps: 2_000_000,
      },
      {traceId: "nat1111", elapsedMs: 14_000},
    ),
    line(
      "acs_wire_adaptation",
      {origin: "joined", callId: "c-nat", width: 320, height: 180, direction: "down", sinceConnectedMs: 20_000},
      {traceId: "nat1111", elapsedMs: 24_000},
    ),
    line(
      "acs_wire_episode",
      {
        origin: "joined",
        callId: "c-nat",
        episode: "end",
        startedAtMs: 20_000,
        durationMs: 90_000,
        minBitrateBps: 33_000,
        recoveryMs: 170_000,
        inboundBitrateBps: 2_100_000,
      },
      {traceId: "nat1111", elapsedMs: 114_000},
    ),
  ].join("\n")

  const [entry] = summarize([capture])
  assert.equal(entry.ceilingBps, 2_000_000)
  assert.deepEqual(entry.adaptations, [
    {width: 320, height: 180, direction: "down", sinceConnectedMs: 20_000},
  ])
  assert.equal(entry.nativeEpisodes.length, 1)
  assert.equal(entry.nativeEpisodes[0].recoveryMs, 170_000)
  assert.equal(entry.nativeEpisodes[0].minBitrateBps, 33_000)
})

test("a capture from a build with no origin is reported as unknown rather than dropped", () => {
  const calls = summarize([call({traceId: "ccc333", origin: undefined, bitrate: 1_000_000, inbound: 1_000_000})])

  assert.equal(calls.length, 1)
  assert.equal(calls[0].origin, "unknown")
})

test("a join that failed before any sample is left out of the comparison", () => {
  const capture = [
    line("acs_join_options", {origin: "joined"}, {traceId: "ddd444"}),
    line("session_join_failed", {reason: "ACS_TOKEN_EXPIRED"}, {traceId: "ddd444"}),
  ].join("\n")

  assert.deepEqual(summarize([capture]), [])
})

test("the send-quality timeline keeps transitions and drops repeats", () => {
  const [entry] = summarize([call({traceId: "eee555", origin: "created", bitrate: 2_000_000, inbound: 2_000_000})])

  assert.deepEqual(
    entry.sendQuality.map((point) => point.quality),
    ["GOOD", "POOR"],
  )
})

test("an empty capture says so instead of printing an empty table", () => {
  assert.match(render([]), /No calls with ACS samples/)
})

test("the table shows one row per call", () => {
  const text = render(
    summarize([
      call({traceId: "aaa111", origin: "created", bitrate: 2_200_000, inbound: 2_400_000}),
      call({traceId: "bbb222", origin: "joined", lobbyMs: 9_000, bitrate: 900_000, inbound: 2_400_000}),
    ]),
  )

  assert.match(text, /created\s+aaa111/)
  assert.match(text, /joined\s+bbb222/)
})

test("a missing sample window reports nothing rather than borrowing a distant one", () => {
  const samples = [
    {sinceConnectedMs: 0, wireBitrateBps: 1_000_000},
    {sinceConnectedMs: 60_000, wireBitrateBps: 2_000_000},
  ]

  assert.equal(medianAround(samples, 30_000, (sample) => sample.wireBitrateBps), null)
  assert.equal(medianAround(samples, 60_000, (sample) => sample.wireBitrateBps), 2_000_000)
})

test("median ignores the gaps rather than treating them as zero", () => {
  assert.equal(median([null, 1_000, null, 3_000]), 2_000)
  assert.equal(median([]), null)
})

test("a late media-stats report fills the outgoing column when bwe samples stayed blind", () => {
  const capture = [
    line("acs_join_options", {origin: "created", transport: "softap"}, {traceId: "ggg777"}),
    line(
      "acs_call_state",
      {origin: "created", callId: "c-ggg777", callPhase: "connected", sinceJoinMs: 4_000, sinceLobbyMs: -1},
      {traceId: "ggg777", elapsedMs: 4_000},
    ),
    line(
      "acs_bwe_sample",
      {
        origin: "created",
        callId: "c-ggg777",
        state: "connected",
        sinceConnectedMs: 30_000,
        wireBitrateBps: -1,
        sentFps: 15,
        mediaStatsReports: 0,
      },
      {traceId: "ggg777", elapsedMs: 34_000},
    ),
    line(
      "acs_media_stats",
      {origin: "created", callId: "c-ggg777", n: 1, wireBitrateBps: 1_320_000, width: 960, height: 540},
      {traceId: "ggg777", elapsedMs: 35_000},
    ),
  ].join("\n")

  const [entry] = summarize([capture])
  assert.equal(entry.bitrateAt[30], 1_320_000)
  assert.equal(entry.mediaStatsReportCount, 1)
  // The report also feeds the stability series, so a call seen only through MEDIA_STATISTICS is
  // still rankable rather than being reported as having no wire data at all.
  assert.equal(entry.minBitrateBps, 1_320_000)
})
