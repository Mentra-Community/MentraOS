#!/usr/bin/env node
// TEMPORARY DIAGNOSTIC TOOLING — carries the SOFTAP_TRACE marker so cleanup finds it.
//
// Ranks calls from one or more SOFTAP_TRACE captures by how bad the picture got, over the whole
// call, and reports how much of the call it was actually able to see.
//
// This started as a Start-versus-Join comparison sampled at +10/+30/+60s after `connected`. That
// framing produced a wrong answer twice over. Start and Join both looked healthy at those offsets
// while an 8-minute Join spent 90 seconds at 33 kbps and 320x180 starting at t=150s, and the
// glasses hop held 2 Mbps throughout — so the failure was neither path-specific nor upstream of
// ACS. A fixed-offset sampler cannot find that, and worse, it prints a confident table either way:
// a configuration "passes" by failing after the last offset.
//
// So the headline is now the stability block: dwell-weighted median, p5 and minimum over the
// connected span, time spent under 500k and 250k, the longest low episode, how long the climb back
// to 1 Mbps took, and the glasses-hop rate during those episodes. That last column is the one that
// assigns blame — a low ACS rate while the glasses keep feeding full rate is ACS's rate controller,
// not the source.
//
// Two honesty rules are load-bearing:
//   - Nothing is inferred across a gap. Each observation is credited at most DWELL_CAP_MS, and
//     what is left over is reported as missing coverage rather than smeared over the silence.
//   - A call whose coverage is thin is labelled thin. ACS has been observed emitting 32 empty
//     MEDIA_STATISTICS reports against 12 filled ones across seven minutes; ranking ceilings on
//     that without saying so is how the last wrong conclusion got made.
//
// Usage:
//   node scripts/acs-quality-compare.mjs <capture.log> [more.log ...]
//   node scripts/acs-quality-compare.mjs --json <capture.log>

import {readFileSync} from "node:fs"

import {groupByCall, parseTrace} from "./softap-call-proof.mjs"

/** Offsets after `connected`, in seconds, for the ramp table. Never for a verdict. */
export const SAMPLE_OFFSETS_SEC = [10, 30, 60]

/**
 * "The picture is visibly bad" and "the picture is gone", in bits per second.
 *
 * 500k at 540p15 is a soft, blocky but legible image; 250k is the mush the wearer calls potato.
 * Both are reported because a ceiling that trades time-under-500k for time-under-250k is a worse
 * ceiling, and a single threshold hides that trade.
 */
export const LOW_BITRATE_BPS = 500_000
export const VERY_LOW_BITRATE_BPS = 250_000

/** What counts as recovered. Below this the call is still visibly degraded. */
export const RECOVERED_BITRATE_BPS = 1_000_000

/**
 * The most connected time one observation may be credited with.
 *
 * The sampler runs at 2s, drops to 10s, and MEDIA_STATISTICS can go silent for a minute. Crediting
 * one sample with a 60s gap would let a single healthy reading paper over the entire collapse that
 * followed it. Anything past this is counted as uncovered instead — see {@link coverageRatio}.
 */
export const DWELL_CAP_MS = 12_000

/** Observations closer together than this are the same instant seen twice. */
const DEDUPE_WINDOW_MS = 750

const number = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Reduce one call's events to the numbers the comparison prints.
 *
 * `origin` is read from whichever event carries it rather than from a single stage: the native
 * `acs_bwe_sample`, the native `native_join_options` and the host `acs_join_options` all stamp it,
 * and a capture may be missing any one of them.
 *
 * @param {{traceId: string, events: import("./softap-call-proof.mjs").TraceEvent[]}} call
 */
export function summarizeCall(call) {
  const events = call.events
  const origin =
    events.map((event) => event.fields.origin).find((value) => value === "created" || value === "joined") ??
    "unknown"
  const samples = events
    .filter((event) => event.stage === "acs_bwe_sample")
    .map((event) => ({
      state: event.fields.state ?? "unknown",
      sinceConnectedMs: number(event.fields.sinceConnectedMs),
      lobbyDwellMs: number(event.fields.lobbyDwellMs),
      wireBitrateBps: number(event.fields.wireBitrateBps),
      wireWidth: number(event.fields.wireWidth),
      wireHeight: number(event.fields.wireHeight),
      sentFps: number(event.fields.sentFps),
      /** Present on builds that co-locate both hops; see the fallback in {@link ingestSeries}. */
      inboundBitrateBps: number(event.fields.inboundBitrateBps),
      mediaStatsReports: number(event.fields.mediaStatsReports),
      mediaStatsAttached: event.fields.mediaStatsAttached,
      videoOut: event.fields.videoOut ?? "na",
      sendQuality: event.fields.sendQuality ?? "na",
      budgetBps: number(event.fields.budgetBps),
      elapsedMs: event.elapsedMs,
    }))
  const reports = events
    .filter((event) => event.stage === "acs_media_stats")
    .map((event) => ({
      n: number(event.fields.n),
      wireBitrateBps: number(event.fields.wireBitrateBps),
      wireWidth: number(event.fields.width),
      wireHeight: number(event.fields.height),
      elapsedMs: event.elapsedMs,
    }))
  const ingest = events
    .filter((event) => event.stage === "whip_ingest_sample")
    .map((event) => ({
      inboundBitrateBps: number(event.fields.inboundBitrateBps),
      elapsedMs: event.elapsedMs,
    }))
  // `callPhase`, never `phase`: the shared parser reserves `phase=` for the host's stage names.
  const states = events.filter((event) => event.stage === "acs_call_state")
  const connected = states.find((event) => event.fields.callPhase === "connected")
  const lobby = states.find((event) => event.fields.callPhase === "lobby")
  // Prefer the native timing over the log's own elapsed clock: `sinceJoinMs` is measured from the
  // join inside the session, while `elapsedMs` is measured from whenever the trace id was minted,
  // which for a Join is not the same instant.
  const timeToConnectedMs = connected ? number(connected.fields.sinceJoinMs) : null
  const lobbyDwellMs = connected
    ? number(connected.fields.sinceLobbyMs)
    : lobby
      ? number(lobby.fields.sinceLobbyMs)
      : null
  const format = events.filter((event) => event.stage === "acs_outgoing_format").at(-1)

  const alignedReports = alignIngest(reports, samples)
  const alignedIngest = ingestSeries(samples, ingest)
  const wire = wireTimeline(samples, alignedReports)
  const stability = stabilityStats(wire, alignedIngest, connectedSpanMs(samples))
  const adaptations = events
    .filter((event) => event.stage === "acs_wire_adaptation")
    .map((event) => ({
      width: number(event.fields.width),
      height: number(event.fields.height),
      direction: event.fields.direction ?? "unknown",
      sinceConnectedMs: number(event.fields.sinceConnectedMs),
    }))
  const nativeEpisodes = events
    .filter((event) => event.stage === "acs_wire_episode")
    .map((event) => ({
      phase: event.fields.episode ?? "unknown",
      startedAtMs: number(event.fields.startedAtMs),
      durationMs: number(event.fields.durationMs),
      minBitrateBps: number(event.fields.minBitrateBps),
      recoveryMs: number(event.fields.recoveryMs),
      inboundBitrateBps: number(event.fields.inboundBitrateBps),
    }))

  return {
    traceId: call.traceId,
    origin,
    callId: samples.length > 0 ? events.find((event) => event.fields.callId)?.fields.callId ?? "none" : "none",
    /** The ACS grant. This is the A/B arm; every stability number is read against it. */
    ceilingBps: lastNumber(samples.map((sample) => sample.budgetBps)),
    lobbyDwellMs: lobbyDwellMs !== null && lobbyDwellMs >= 0 ? lobbyDwellMs : null,
    timeToConnectedMs: timeToConnectedMs !== null && timeToConnectedMs >= 0 ? timeToConnectedMs : null,
    negotiated: format ? `${format.fields.width}x${format.fields.height}@${format.fields.fps}` : "unknown",
    firstBitrateBps: firstAfterConnected(samples) ?? firstAfterConnected(alignedReports),
    ...stability,
    adaptations,
    nativeEpisodes,
    bitrateAt: Object.fromEntries(
      SAMPLE_OFFSETS_SEC.map((sec) => [
        sec,
        medianAround(samples, sec * 1000, (s) => s.wireBitrateBps) ??
          medianAround(alignedReports, sec * 1000, (s) => s.wireBitrateBps),
      ]),
    ),
    inboundAt: Object.fromEntries(
      SAMPLE_OFFSETS_SEC.map((sec) => [sec, medianAround(alignedIngest, sec * 1000, (s) => s.inboundBitrateBps)]),
    ),
    sentFpsAt: Object.fromEntries(
      SAMPLE_OFFSETS_SEC.map((sec) => [sec, medianAround(samples, sec * 1000, (s) => s.sentFps)]),
    ),
    sendQuality: qualityTimeline(samples),
    sampleCount: samples.length,
    mediaStatsReports: lastNumber(samples.map((sample) => sample.mediaStatsReports)),
    mediaStatsAttached: lastTruthy(samples.map((sample) => sample.mediaStatsAttached)),
    videoOut: samples.at(-1)?.videoOut ?? "na",
    mediaStatsReportCount: reports.length,
    mediaStatsEmptyCount: reports.filter((report) => (report.wireBitrateBps ?? -1) <= 0).length,
    mediaStatsAttach: events.find((event) => event.stage === "acs_media_stats_attach")?.fields ?? null,
    mediaStatsIntervalOk: events.some(
      (event) => event.stage === "acs_media_stats_interval" && String(event.fields.ok) === "true",
    ),
  }
}

/**
 * The glasses hop on the connected clock, preferring the reading taken on the same line.
 *
 * Native now stamps `inboundBitrateBps` onto `acs_bwe_sample`, which makes the two hops exactly
 * simultaneous and removes a real source of error: `whip_ingest_sample` had to be dated from the
 * nearest ACS sample by the shared `elapsedMs`, and inside a fast collapse that pairing could be
 * off by a whole sampling interval. The `whip_ingest_sample` path is kept as a fallback so
 * captures taken before the field existed still report both hops.
 */
export function ingestSeries(samples, ingest) {
  const colocated = samples
    .filter(
      (sample) =>
        sample.sinceConnectedMs !== null &&
        sample.sinceConnectedMs >= 0 &&
        (sample.inboundBitrateBps ?? -1) > 0,
    )
    .map((sample) => ({
      sinceConnectedMs: sample.sinceConnectedMs,
      inboundBitrateBps: sample.inboundBitrateBps,
      elapsedMs: sample.elapsedMs,
    }))
  if (colocated.length > 0) return colocated
  return alignIngest(ingest, samples)
}

/** How long this call was connected, by the furthest sample that carried the connected clock. */
function connectedSpanMs(samples) {
  const offsets = samples.map((sample) => sample.sinceConnectedMs).filter((value) => value !== null && value >= 0)
  return offsets.length > 0 ? Math.max(...offsets) : 0
}

/**
 * One bitrate/resolution series for the ACS hop, on the connected clock.
 *
 * Both stages are merged rather than one being preferred. `acs_media_stats` is the raw ACS report
 * and is denser when `updateReportIntervalInSeconds(1)` sticks — which it often does not, hence
 * the retry in the session — while `acs_bwe_sample` is emitted on our own cadence and survives
 * ACS going quiet. Taking the union means a collapse is caught by whichever one was still
 * talking, and a reading present in both is counted once.
 *
 * Only filled observations are kept. A report with `wireBitrateBps=-1` means ACS published a
 * report with nothing in it, which is evidence about ACS and not about the bitrate, so it is
 * counted toward missing coverage instead of toward a rate of zero.
 */
export function wireTimeline(samples, alignedReports) {
  const points = [...samples, ...alignedReports]
    .filter(
      (point) =>
        point.sinceConnectedMs !== null && point.sinceConnectedMs >= 0 && (point.wireBitrateBps ?? -1) > 0,
    )
    .map((point) => ({
      sinceConnectedMs: point.sinceConnectedMs,
      bitrateBps: point.wireBitrateBps,
      width: (point.wireWidth ?? -1) > 0 ? point.wireWidth : null,
      height: (point.wireHeight ?? -1) > 0 ? point.wireHeight : null,
    }))
    .sort((a, b) => a.sinceConnectedMs - b.sinceConnectedMs)
  const merged = []
  for (const point of points) {
    const previous = merged.at(-1)
    if (previous && point.sinceConnectedMs - previous.sinceConnectedMs < DEDUPE_WINDOW_MS) continue
    merged.push(point)
  }
  return merged
}

/**
 * Everything the verdict is made of, over the whole connected span.
 *
 * Each observation is credited with the time until the next one, capped at {@link DWELL_CAP_MS}.
 * The cap is what keeps a sparse stretch from being filled in with the last thing that was seen:
 * uncredited time shows up as a coverage shortfall, which the renderer says out loud.
 */
export function stabilityStats(wire, alignedIngest, connectedMs) {
  if (wire.length === 0) {
    return {
      connectedMs,
      coverageMs: 0,
      coverageRatio: connectedMs > 0 ? 0 : null,
      medianBitrateBps: null,
      p5BitrateBps: null,
      minBitrateBps: null,
      maxBitrateBps: null,
      minPixels: null,
      minResolution: null,
      downscaleCount: 0,
      lowDwellMs: 0,
      veryLowDwellMs: 0,
      episodes: [],
      longestEpisodeMs: 0,
      worstEpisodeCostMs: 0,
      worstRecoveryMs: null,
      inboundDuringEpisodesBps: null,
    }
  }
  const weighted = wire.map((point, index) => {
    const next = wire[index + 1]
    const gap = next ? next.sinceConnectedMs - point.sinceConnectedMs : DWELL_CAP_MS
    return {...point, dwellMs: Math.max(0, Math.min(gap, DWELL_CAP_MS))}
  })
  const coverageMs = weighted.reduce((total, point) => total + point.dwellMs, 0)
  const bitrates = wire.map((point) => point.bitrateBps)
  const sized = wire.filter((point) => point.width && point.height)
  const minSized = sized.reduce(
    (worst, point) => (worst === null || point.width * point.height < worst.width * worst.height ? point : worst),
    null,
  )
  let downscaleCount = 0
  for (let index = 1; index < sized.length; index += 1) {
    const before = sized[index - 1].width * sized[index - 1].height
    const after = sized[index].width * sized[index].height
    if (after < before) downscaleCount += 1
  }
  const episodes = findEpisodes(weighted, alignedIngest)
  const recoveries = episodes.map((episode) => episode.recoveryMs).filter((value) => value !== null)
  const inboundDuring = episodes
    .map((episode) => episode.inboundBitrateBps)
    .filter((value) => value !== null && value !== undefined)
  return {
    connectedMs,
    coverageMs,
    coverageRatio: connectedMs > 0 ? Math.min(1, coverageMs / connectedMs) : null,
    medianBitrateBps: weightedPercentile(weighted, 0.5),
    p5BitrateBps: weightedPercentile(weighted, 0.05),
    minBitrateBps: Math.min(...bitrates),
    maxBitrateBps: Math.max(...bitrates),
    minPixels: minSized ? minSized.width * minSized.height : null,
    minResolution: minSized ? `${minSized.width}x${minSized.height}` : null,
    downscaleCount,
    lowDwellMs: dwellBelow(weighted, LOW_BITRATE_BPS),
    veryLowDwellMs: dwellBelow(weighted, VERY_LOW_BITRATE_BPS),
    episodes,
    longestEpisodeMs: episodes.reduce((worst, episode) => Math.max(worst, episode.durationMs), 0),
    worstEpisodeCostMs: episodes.reduce(
      (worst, episode) => Math.max(worst, episode.durationMs + (episode.recoveryMs ?? 0)),
      0,
    ),
    worstRecoveryMs: recoveries.length > 0 ? Math.max(...recoveries) : null,
    inboundDuringEpisodesBps: median(inboundDuring),
  }
}

/** Connected time observed below `threshold`, in ms. */
function dwellBelow(weighted, threshold) {
  return weighted
    .filter((point) => point.bitrateBps < threshold)
    .reduce((total, point) => total + point.dwellMs, 0)
}

/**
 * Contiguous runs below {@link LOW_BITRATE_BPS}, each with what it cost.
 *
 * `durationMs` is time under the threshold; `recoveryMs` is the climb from there back to
 * {@link RECOVERED_BITRATE_BPS}. They are separate because they have different causes and
 * different fixes: the dip is whatever ACS reacted to, the climb is ACS's own ramp policy, and on
 * the capture that started this the climb was twice the dip. `inboundBitrateBps` is the glasses
 * hop during the same window, which is what says whether the source was starving too.
 */
export function findEpisodes(weighted, alignedIngest) {
  const episodes = []
  let current = null
  for (const point of weighted) {
    const low = point.bitrateBps < LOW_BITRATE_BPS
    if (low && !current) {
      current = {startedAtMs: point.sinceConnectedMs, endedAtMs: point.sinceConnectedMs, minBitrateBps: point.bitrateBps}
    } else if (low && current) {
      current.endedAtMs = point.sinceConnectedMs + point.dwellMs
      current.minBitrateBps = Math.min(current.minBitrateBps, point.bitrateBps)
    } else if (!low && current) {
      episodes.push(current)
      current = null
    }
  }
  if (current) episodes.push(current)
  return episodes.map((episode) => {
    const recoveredAt = weighted.find(
      (point) => point.sinceConnectedMs >= episode.endedAtMs && point.bitrateBps >= RECOVERED_BITRATE_BPS,
    )
    return {
      ...episode,
      durationMs: Math.max(0, episode.endedAtMs - episode.startedAtMs),
      recoveryMs: recoveredAt ? recoveredAt.sinceConnectedMs - episode.endedAtMs : null,
      inboundBitrateBps: medianBetween(alignedIngest, episode.startedAtMs, episode.endedAtMs),
    }
  })
}

/** Median glasses-hop rate inside a window, or null if the capture has none there. */
function medianBetween(alignedIngest, fromMs, toMs) {
  return median(
    alignedIngest
      .filter(
        (sample) =>
          sample.sinceConnectedMs !== null &&
          sample.sinceConnectedMs >= fromMs - DWELL_CAP_MS &&
          sample.sinceConnectedMs <= toMs + DWELL_CAP_MS &&
          (sample.inboundBitrateBps ?? -1) > 0,
      )
      .map((sample) => sample.inboundBitrateBps),
  )
}

/**
 * Percentile by time spent, not by sample count.
 *
 * An unweighted percentile over a series that is 2s-dense early and 10s-sparse later weights the
 * settling period five times as heavily as the rest of the call, which is exactly the bias this
 * whole rewrite exists to remove.
 */
export function weightedPercentile(weighted, fraction) {
  const sorted = [...weighted].sort((a, b) => a.bitrateBps - b.bitrateBps)
  const total = sorted.reduce((sum, point) => sum + point.dwellMs, 0)
  if (total <= 0) return sorted.length > 0 ? sorted[Math.floor(sorted.length * fraction)].bitrateBps : null
  const target = total * fraction
  let seen = 0
  for (const point of sorted) {
    seen += point.dwellMs
    if (seen >= target) return point.bitrateBps
  }
  return sorted.at(-1).bitrateBps
}

function lastNumber(values) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== null && values[i] !== undefined) return values[i]
  }
  return null
}

function lastTruthy(values) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] === true || values[i] === "true") return true
    if (values[i] === false || values[i] === "false") return false
  }
  return null
}

/** The first real outgoing bitrate ACS reported once the call was up. */
function firstAfterConnected(samples) {
  const first = samples.find(
    (sample) => sample.sinceConnectedMs !== null && sample.sinceConnectedMs >= 0 && (sample.wireBitrateBps ?? -1) > 0,
  )
  return first?.wireBitrateBps ?? null
}

/**
 * Put events with no connected clock of their own onto the ACS one.
 *
 * `whip_ingest_sample` is emitted by the ingest source, which knows nothing about the Teams call,
 * and `acs_media_stats` fires from the ACS callback rather than the sampler. Both are dated from
 * the nearest ACS sample by the shared trace `elapsedMs`.
 */
function alignIngest(ingest, samples) {
  const anchor = samples.find((sample) => sample.sinceConnectedMs !== null && sample.sinceConnectedMs >= 0)
  if (!anchor) return []
  const connectedAtElapsedMs = anchor.elapsedMs - anchor.sinceConnectedMs
  return ingest.map((sample) => ({
    ...sample,
    sinceConnectedMs: sample.elapsedMs - connectedAtElapsedMs,
  }))
}

/**
 * Median of the samples within one sampling window of `offsetMs`.
 *
 * A median rather than the nearest single sample: one 2 s tick can land inside a keyframe or a
 * momentary stall, and a comparison decided by one such tick would be noise.
 */
export function medianAround(samples, offsetMs, pick, windowMs = 6_000) {
  const values = samples
    .filter(
      (sample) =>
        sample.sinceConnectedMs !== null &&
        Math.abs(sample.sinceConnectedMs - offsetMs) <= windowMs &&
        (pick(sample) ?? -1) >= 0,
    )
    .map(pick)
    .sort((a, b) => a - b)
  if (values.length === 0) return null
  const middle = Math.floor(values.length / 2)
  return values.length % 2 === 1 ? values[middle] : Math.round((values[middle - 1] + values[middle]) / 2)
}

/** Distinct send-quality verdicts in order, with the offset each first appeared at. */
function qualityTimeline(samples) {
  const timeline = []
  for (const sample of samples) {
    if (sample.sendQuality === "na") continue
    if (timeline.at(-1)?.quality === sample.sendQuality) continue
    timeline.push({quality: sample.sendQuality, sinceConnectedMs: sample.sinceConnectedMs})
  }
  return timeline
}

/**
 * Every call in the given captures, in capture order.
 *
 * A call is anything that produced at least one `acs_bwe_sample`: a join that failed before the
 * outgoing stream existed has nothing to compare and would only pad the table.
 */
export function summarize(texts) {
  const calls = []
  for (const text of texts) {
    for (const call of groupByCall(parseTrace(text))) {
      if (!call.events.some((event) => event.stage === "acs_bwe_sample")) continue
      calls.push(summarizeCall(call))
    }
  }
  return calls
}

const kbps = (value) => (value === null || value === undefined ? "—" : `${Math.round(value / 1000)}k`)
const mbps = (value) => (value === null || value === undefined ? "—" : `${(value / 1_000_000).toFixed(1)}M`)
const fps = (value) => (value === null || value === undefined ? "—" : `${Number(value).toFixed(1)}`)
const secs = (value) => (value === null || value === undefined ? "—" : `${(value / 1000).toFixed(1)}s`)
const dwell = (value) => (!value ? "0" : `${(value / 1000).toFixed(0)}s`)
const percent = (value) => (value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`)

function pad(text, width) {
  return String(text).padEnd(width)
}

function table(header, rows) {
  const line = header.join(" ")
  return [line, "-".repeat(line.length), ...rows.map((row) => row.join(" "))]
}

/**
 * Stability first, ramp second, ceiling comparison third.
 *
 * The order is the argument. Whichever block is printed at the top is the one that gets quoted,
 * and the fixed-offset ramp is the block that has already produced two wrong verdicts — so it
 * keeps its place in the output but loses its place at the top, and carries a label saying what
 * it cannot answer.
 */
export function render(calls) {
  if (calls.length === 0) {
    return "No calls with ACS samples found. Was the capture taken with SOFTAP_TRACE on a build that emits acs_bwe_sample?"
  }
  const ordered = [...calls].sort(
    (a, b) => (a.ceilingBps ?? 0) - (b.ceilingBps ?? 0) || a.origin.localeCompare(b.origin),
  )
  const lines = []

  lines.push("WHOLE-CALL STABILITY — the verdict. Lower min / p5 and more time under 500k is worse.")
  lines.push(
    ...table(
      [
        pad("origin", 8),
        pad("trace", 10),
        pad("ceil", 6),
        pad("conn", 8),
        pad("seen", 6),
        pad("med", 7),
        pad("p5", 7),
        pad("min", 7),
        pad("minRes", 9),
        pad("down", 5),
        pad("<500k", 7),
        pad("<250k", 7),
        pad("worst", 7),
        pad("recov", 7),
        pad("in@low", 7),
      ],
      ordered.map((call) => [
        pad(call.origin, 8),
        pad(call.traceId.slice(0, 9), 10),
        pad(mbps(call.ceilingBps), 6),
        pad(secs(call.connectedMs), 8),
        pad(percent(call.coverageRatio), 6),
        pad(kbps(call.medianBitrateBps), 7),
        pad(kbps(call.p5BitrateBps), 7),
        pad(kbps(call.minBitrateBps), 7),
        pad(call.minResolution ?? "—", 9),
        pad(call.downscaleCount, 5),
        pad(dwell(call.lowDwellMs), 7),
        pad(dwell(call.veryLowDwellMs), 7),
        pad(dwell(call.longestEpisodeMs), 7),
        pad(call.worstRecoveryMs === null ? "—" : dwell(call.worstRecoveryMs), 7),
        pad(kbps(call.inboundDuringEpisodesBps), 7),
      ]),
    ),
  )
  lines.push("")
  lines.push(
    "conn=connected span, seen=share of it with a filled ACS reading, worst=longest run under 500k,",
  )
  lines.push(
    "recov=slowest climb from an episode back to 1 Mbps, in@low=glasses hop during those episodes.",
  )
  lines.push("in@low at full rate means the source was fine and ACS chose the low rate.")
  lines.push("")

  lines.push(...ceilingComparison(ordered))

  lines.push("RAMP — first 60s only. Cannot see a collapse that starts later; not a verdict.")
  lines.push(
    ...table(
      [
        pad("origin", 8),
        pad("trace", 10),
        pad("lobby", 8),
        pad("to conn", 8),
        pad("format", 12),
        pad("first", 7),
        ...SAMPLE_OFFSETS_SEC.map((sec) => pad(`out+${sec}s`, 8)),
        ...SAMPLE_OFFSETS_SEC.map((sec) => pad(`sent+${sec}s`, 8)),
        ...SAMPLE_OFFSETS_SEC.map((sec) => pad(`in+${sec}s`, 8)),
        pad("stats", 7),
      ],
      ordered.map((call) => [
        pad(call.origin, 8),
        pad(call.traceId.slice(0, 9), 10),
        pad(secs(call.lobbyDwellMs), 8),
        pad(secs(call.timeToConnectedMs), 8),
        pad(call.negotiated, 12),
        pad(kbps(call.firstBitrateBps), 7),
        ...SAMPLE_OFFSETS_SEC.map((sec) => pad(kbps(call.bitrateAt[sec]), 8)),
        ...SAMPLE_OFFSETS_SEC.map((sec) => pad(fps(call.sentFpsAt[sec]), 8)),
        ...SAMPLE_OFFSETS_SEC.map((sec) => pad(kbps(call.inboundAt[sec]), 8)),
        pad(call.mediaStatsReports ?? call.mediaStatsReportCount ?? "—", 7),
      ]),
    ),
  )
  lines.push("")

  lines.push(...episodeDetail(ordered))
  lines.push(...coverageWarnings(ordered))

  for (const call of ordered) {
    if (call.sendQuality.length === 0) continue
    lines.push(
      `${call.origin} ${call.traceId.slice(0, 9)} sendQuality: ` +
        call.sendQuality.map((entry) => `${entry.quality}@${secs(entry.sinceConnectedMs)}`).join(" -> "),
    )
  }
  return lines.join("\n")
}

/**
 * The A/B block: stability grouped by the ACS grant.
 *
 * Printed only for captures that actually contain more than one ceiling, because a single-arm
 * "comparison" invites exactly the conclusion it cannot support. The ranking metric is time under
 * 500k per minute of call rather than the mean bitrate — a ceiling that spends longer in the mud
 * is worse even when its good periods are better, which is the whole hypothesis under test.
 */
export function ceilingComparison(calls) {
  const ceilings = [...new Set(calls.map((call) => call.ceilingBps).filter((value) => value !== null))].sort(
    (a, b) => a - b,
  )
  if (ceilings.length < 2) {
    return [
      ceilings.length === 1
        ? `Single ACS ceiling in this capture (${mbps(ceilings[0])}). Run the other arms before ranking ceilings.`
        : "No ACS ceiling recorded; this capture predates budgetBps and cannot be used for the ceiling A/B.",
      "",
    ]
  }
  const lines = ["ACS CEILING A/B — ranked by time under 500k per minute of call. Lower is better."]
  const rows = ceilings.map((ceiling) => {
    const group = calls.filter((call) => call.ceilingBps === ceiling)
    const connectedMs = group.reduce((total, call) => total + call.connectedMs, 0)
    const lowMs = group.reduce((total, call) => total + call.lowDwellMs, 0)
    const minutes = connectedMs / 60_000
    return {
      ceiling,
      group,
      connectedMs,
      lowPerMinMs: minutes > 0 ? lowMs / minutes : null,
      medianOfMins: median(group.map((call) => call.minBitrateBps)),
      medianMedian: median(group.map((call) => call.medianBitrateBps)),
      worstRes: group
        .map((call) => call.minResolution)
        .filter(Boolean)
        .sort((a, b) => pixelsOf(a) - pixelsOf(b))[0],
      downscales: group.reduce((total, call) => total + call.downscaleCount, 0),
    }
  })
  lines.push(
    ...table(
      [
        pad("ceiling", 8),
        pad("calls", 6),
        pad("conn", 8),
        pad("med", 7),
        pad("medMin", 7),
        pad("worstRes", 9),
        pad("down", 5),
        pad("<500k/min", 10),
      ],
      [...rows]
        .sort((a, b) => (a.lowPerMinMs ?? Infinity) - (b.lowPerMinMs ?? Infinity))
        .map((row) => [
          pad(mbps(row.ceiling), 8),
          pad(row.group.length, 6),
          pad(secs(row.connectedMs), 8),
          pad(kbps(row.medianMedian), 7),
          pad(kbps(row.medianOfMins), 7),
          pad(row.worstRes ?? "—", 9),
          pad(row.downscales, 5),
          pad(row.lowPerMinMs === null ? "—" : `${(row.lowPerMinMs / 1000).toFixed(1)}s`, 10),
        ]),
    ),
  )
  const thin = rows.filter((row) => row.connectedMs < 600_000)
  if (thin.length > 0) {
    lines.push(
      `Under 10 min of call at ${thin.map((row) => mbps(row.ceiling)).join(", ")}. ` +
        "The failure has been observed starting at t=150s and recurring; short arms can miss it entirely.",
    )
  }
  lines.push("")
  return lines
}

function pixelsOf(resolution) {
  const [width, height] = String(resolution).split("x").map(Number)
  return (width || 0) * (height || 0)
}

/** Every low episode spelled out, because the shape of one is more persuasive than a column. */
function episodeDetail(calls) {
  const lines = []
  for (const call of calls) {
    if (call.episodes.length === 0) continue
    lines.push(`${call.origin} ${call.traceId.slice(0, 9)} @ ${mbps(call.ceilingBps)} — ${call.episodes.length} episode(s) under 500k:`)
    for (const episode of call.episodes) {
      lines.push(
        `  ${secs(episode.startedAtMs)}-${secs(episode.endedAtMs)} ` +
          `(${dwell(episode.durationMs)}) floor ${kbps(episode.minBitrateBps)}, ` +
          `recovery ${episode.recoveryMs === null ? "never within the call" : dwell(episode.recoveryMs)}, ` +
          `glasses hop ${kbps(episode.inboundBitrateBps)}`,
      )
    }
  }
  if (lines.length > 0) lines.push("")
  return lines
}

/**
 * Say what could not be seen, per call.
 *
 * Separated from the table because a thin call is not a data point with an asterisk, it is a call
 * that has to be rerun. `mediaStatsEmptyCount` is the reason it is usually thin: ACS publishes the
 * report and leaves the fields unset, which is a fact about ACS rather than about the bitrate.
 */
function coverageWarnings(calls) {
  const lines = []
  for (const call of calls) {
    const blind = call.coverageRatio !== null && call.coverageRatio < 0.75
    const noWire = call.minBitrateBps === null
    if (!blind && !noWire) continue
    const attach = call.mediaStatsAttach
    const attachLabel = attach
      ? `attach=${attach.ok === true || attach.ok === "true" ? "ok" : `fail:${attach.error ?? "unknown"}`}`
      : "attach=missing"
    lines.push(
      `${call.origin} ${call.traceId.slice(0, 9)} ${noWire ? "NO ACS WIRE DATA" : `THIN COVERAGE ${percent(call.coverageRatio)}`} ` +
        `(reports=${call.mediaStatsReportCount ?? 0}, of which empty=${call.mediaStatsEmptyCount ?? 0}, ` +
        `${attachLabel}, interval=${call.mediaStatsIntervalOk ? "ok" : "no"}, videoOut=${call.videoOut}, ` +
        `sent fps ${SAMPLE_OFFSETS_SEC.map((sec) => fps(call.sentFpsAt[sec])).join("/")}). ` +
        (noWire
          ? "ACS never published a filled MEDIA_STATISTICS report, so this call cannot be ranked."
          : "Treat its stability numbers as a floor, not a measurement — the unseen time may be worse."),
    )
  }
  if (lines.length > 0) lines.push("")
  return lines
}

export function median(values) {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function main(argv) {
  const json = argv.includes("--json")
  const paths = argv.filter((arg) => !arg.startsWith("--"))
  if (paths.length === 0) {
    console.log("usage: acs-quality-compare.mjs [--json] <capture.log> [more.log ...]")
    return 1
  }
  const calls = summarize(paths.map((path) => readFileSync(path, "utf8")))
  console.log(json ? JSON.stringify(calls, null, 2) : render(calls))
  return 0
}

if (process.argv[1] && process.argv[1].endsWith("acs-quality-compare.mjs")) {
  process.exit(main(process.argv.slice(2)))
}
