#!/usr/bin/env node
// TEMPORARY DIAGNOSTIC TOOLING — carries the SOFTAP_TRACE marker so cleanup finds it.
//
// Turns a SOFTAP_TRACE logcat capture into a pass/fail verdict for the SoftAP call proofs, and can
// drive the rejoin soak over adb so the run is a script rather than a checklist.
//
// The proofs are the ones a device can actually settle: that Cloudflare is off the path, that ICE
// selected a local pair, that the sequence ran in the right order, that leaving released everything
// in reverse, and that N cycles left no residue. Audio intelligibility and speaker leakage need
// ears on a Teams call, so those are reported as "needs a human" rather than silently passing.
//
// Usage:
//   node scripts/softap-call-proof.mjs analyze <capture.log>
//   node scripts/softap-call-proof.mjs soak --cycles 10 [--package com.mentra.call]

import {readFileSync} from "node:fs"
import {spawnSync} from "node:child_process"

export const TRACE_MARKER = "SOFTAP_TRACE"

/**
 * One trace line, reduced to what the proofs read.
 *
 * @typedef {{stage: string, traceId: string, elapsedMs: number, fields: Record<string, string>, level: string}} TraceEvent
 */

/**
 * Parse a logcat capture into trace events, ignoring every line that is not ours.
 *
 * Tolerant of logcat's several formats (threadtime, brief, raw) because the capture may come from a
 * bug report rather than from this script. Native `stage=` and host `phase=` are both events;
 * anything else is noise, including our own tooling's output.
 *
 * @param {string} text raw capture
 * @returns {TraceEvent[]} events in capture order
 */
export function parseTrace(text) {
  const events = []
  let continued = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(`[${TRACE_MARKER}]`)) {
      // React Native prints the host's field object across several logcat lines.
      const body = /ReactNativeJS:\s+(.*)$/.exec(line)?.[1]
      if (continued && body && /^(?:[A-Za-z_]+:|})/.test(body)) {
        Object.assign(continued.fields, parseObjectFields(body))
        if (body.includes("}")) continued = null
      } else continued = null
      continue
    }
    continued = null
    const stage = /\b(?:stage|phase)=([A-Za-z0-9_]+)/.exec(line)
    if (!stage) continue
    events.push({
      stage: stage[1],
      traceId: /\btraceId=([A-Za-z0-9]+)/.exec(line)?.[1] ?? "",
      elapsedMs: Number(/\belapsedMs=(\d+)/.exec(line)?.[1] ?? 0),
      fields: {...parseFields(line), ...parseObjectFields(line.slice(line.indexOf("{")))},
      // Logcat puts the level in a lone-letter column; `E` is how SoftApTrace.failure reports.
      level: / E(?:\/|\s)/.test(line) ? "E" : "I",
    })
    if (line.includes("ReactNativeJS:") && line.includes("{") && !line.includes("}")) continued = events.at(-1)
  }
  return events
}

/** Read primitive diagnostic fields only. Never evaluate a logged JavaScript object. */
function parseObjectFields(text) {
  const fields = {}
  const pattern = /(?:^|[,{]\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(?:'([^']*)'|"([^"]*)"|(true|false|null|-?\d+(?:\.\d+)?))/g
  for (const match of text.matchAll(pattern)) fields[match[1]] = match[2] ?? match[3] ?? match[4]
  return fields
}

/** Trailing `key=value` pairs, honouring the quoting `SoftApTrace.sanitize` applies to spaces. */
function parseFields(line) {
  const fields = {}
  const pattern = /\b([A-Za-z0-9_]+)=("[^"]*"|\S+)/g
  let match
  while ((match = pattern.exec(line)) !== null) {
    const [, key, raw] = match
    if (key === "stage" || key === "phase" || key === "traceId" || key === "elapsedMs") continue
    fields[key] = raw.startsWith('"') ? raw.slice(1, -1) : raw
  }
  return fields
}

/**
 * The sequence one successful SoftAP call must log, in order.
 *
 * Ordering is the point, not mere presence: an ACS join that lands after the glasses started
 * publishing means the first frames arrived before the raw outgoing streams existed, which is
 * exactly the race the orchestrator is built to prevent.
 */
export const REQUIRED_ORDER = [
  "softap_call_start",
  "hotspot_enabled",
  "scoped_network_joined",
  "acs_joined",
  "glasses_publishing",
  "first_frame_in_acs",
  "softap_call_live",
]

/** Reverse-order teardown, as `SoftapCallTransport` unwinds it. */
export const REQUIRED_TEARDOWN_ORDER = ["softap_call_stop", "softap_call_stopped"]

/** Stages that are always a failure, whatever else the capture contains. */
export const FATAL_STAGES = [
  "scoped_join_permission_denied",
  "scoped_join_security_exception",
  "scoped_join_request_failed",
  "scoped_network_unavailable",
  "start_stream_rejected",
  "whip_post_blocked",
  "ingest_no_first_frame",
  "ingest_negotiation_failed",
  "whip_negotiation_failed",
]

/** RFC 1918 plus the 192.168.43.x hotspot range Android hands out. */
export function isPrivateIpv4(text) {
  const match = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/.exec(String(text))
  if (!match) return false
  const [a, b] = [Number(match[1]), Number(match[2])]
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

/**
 * Split a capture into one group per call, keyed by trace id.
 *
 * A soak produces N calls in one capture, and every proof below is per-call: a capture where cycle 1
 * was clean and cycle 7 leaked has to fail, which a whole-capture check would miss.
 */
export function groupByCall(events) {
  const calls = new Map()
  for (const event of events) {
    const key = event.traceId || "unknown"
    if (!calls.has(key)) calls.set(key, [])
    calls.get(key).push(event)
  }
  return [...calls.entries()].map(([traceId, group]) => ({traceId, events: group}))
}

/** Positions of `stages` within `events`, or -1 where a stage never appeared. */
function positions(events, stages) {
  return stages.map((stage) => events.findIndex((event) => event.stage === stage))
}

/**
 * Evaluate one call's events against every proof this capture can settle.
 *
 * @param {TraceEvent[]} events one call's trace, in order
 * @returns {{name: string, ok: boolean, detail: string}[]}
 */
export function proveCall(events) {
  const results = []
  const stages = events.map((event) => event.stage)
  const has = (stage) => stages.includes(stage)

  const order = positions(events, REQUIRED_ORDER)
  const missing = REQUIRED_ORDER.filter((_, index) => order[index] < 0)
  const ascending = order.every((value, index) => index === 0 || (value > order[index - 1] && value >= 0))
  results.push({
    name: "sequence ran in order and reached live",
    ok: missing.length === 0 && ascending,
    detail: missing.length ? `missing ${missing.join(", ")}` : ascending ? "in order" : "out of order",
  })

  // The whole point of the transport: if Cloudflare appears, the media took the old path.
  const cloudflare = events.filter((event) =>
    Object.values(event.fields).some((value) => /cloudflare/i.test(value)),
  )
  results.push({
    name: "no Cloudflare session on the path",
    ok: cloudflare.length === 0,
    detail: cloudflare.length ? `saw ${cloudflare.map((event) => event.stage).join(", ")}` : "clean",
  })

  const glassesCandidate = events.find((event) => event.stage === "ice_hotspot_candidate")
  const phoneCandidate = events.find((event) => event.stage === "ingest_host_candidate")
  results.push({
    name: "both sides gathered a private-subnet host candidate",
    ok: Boolean(
      glassesCandidate &&
        phoneCandidate &&
        isPrivateIpv4(glassesCandidate.fields.candidate) &&
        isPrivateIpv4(phoneCandidate.fields.candidate),
    ),
    detail: describeCandidates(glassesCandidate, phoneCandidate),
  })

  // The real SoftAP invariant: selected media interface == the scoped network we joined. The
  // candidate proof above only shows a private-subnet candidate was *gathered*, and the SDP guard
  // only inspects what was offered; neither says which pair ICE actually chose. A cellular 10.x
  // host candidate is private too, so this is the proof that separates a hotspot call from a call
  // that quietly went out over LTE.
  const offHotspot = events.find((event) => event.stage === "ingest_selected_pair_off_hotspot")
  const selected = events.filter((event) => event.stage === "ingest_selected_pair")
  const unknownPair = events.filter((event) => event.stage === "ingest_selected_pair_unknown")
  results.push({
    name: "selected ICE pair is on the scoped hotspot prefix",
    ok: !offHotspot && selected.length > 0,
    detail: describeSelectedPair(offHotspot, selected, unknownPair),
  })

  // Two samples of *the same* pair, so "connected" is distinguished from "carrying media". Growth
  // measured across a pair change or a session restart is not evidence, so the source reports
  // whether the comparison was possible and this proof refuses to pass without it.
  if (selected.length > 0) {
    const last = selected.at(-1)
    const flowing = selected.some(
      (event) => event.fields.bytesFlowing === "true" && event.fields.comparable !== "false",
    )
    const comparable = selected.some((event) => event.fields.comparable !== "false")
    results.push({
      name: "bytes increased across two samples of the same selected pair",
      ok: flowing,
      detail: flowing
        ? `pair=${last.fields.pairId} bytesReceived=${last.fields.bytesReceived}`
        : comparable
          ? `never increased (last bytesReceived=${last.fields.bytesReceived})`
          : `no comparable sample pair (${last.fields.notComparable ?? "unknown"})`,
    })
  }

  // Host-only ICE is what keeps the media off cellular. A configured STUN server on this path means
  // the glasses spent gathering time on a server the hotspot cannot reach.
  const ice = events.find((event) => event.stage === "ice_configured")
  results.push({
    name: "glasses used host-only ICE",
    ok: Boolean(ice && ice.fields.mode === "host" && Number(ice.fields.stunServers ?? 1) === 0),
    detail: ice ? `mode=${ice.fields.mode} stunServers=${ice.fields.stunServers}` : "never configured ICE",
  })

  // A rejected answer used to be one code for four different faults, which is how a run that had
  // regressed from one to another looked unchanged. The native side now narrows it before logging,
  // so the verdict names the fault instead of repeating the symptom.
  const rejected = events.filter((event) => event.stage === "ingest_answer_rejected")
  results.push({
    name: "the answer carried a hotspot candidate",
    ok: rejected.length === 0,
    detail: rejected.length ? describeIceFault(rejected.at(-1)) : "accepted",
  })

  // Joining the hotspot takes the phone off Wi-Fi, so cellular becomes the route ACS signs in
  // over. A run where that route had not validated yet spent 30s stalled and then blew the join
  // step's timeout, with device-wide DNS failures — a capture that looked like a hotspot fault and
  // was not one. Absent stages mean a host that predates the check, not a failure.
  const cellular = events.find((event) => event.stage === "cellular_validated")
  if (cellular) {
    results.push({
      name: "cellular validated before the hotspot join",
      ok: cellular.fields.validated === "true",
      detail: `held=${cellular.fields.held} validated=${cellular.fields.validated} waitedMs=${cellular.fields.waitedMs}`,
    })
  }

  const defaultNetwork = events.find((event) => event.stage === "default_network_after_join")
  if (defaultNetwork) {
    // The route the app actually got, not the one it asked for. Holding a cellular request brings
    // the radio up; it does not say when this app's default switched to it or that it validated.
    const usable = defaultNetwork.fields.present === "true" && defaultNetwork.fields.validated === "true"
    results.push({
      name: "the phone had a validated default network for the ACS join",
      ok: usable,
      detail: `transport=${defaultNetwork.fields.transport} validated=${defaultNetwork.fields.validated} present=${defaultNetwork.fields.present}`,
    })
  }

  const fatal = events.filter((event) => FATAL_STAGES.includes(event.stage))
  results.push({
    name: "no fatal stage",
    ok: fatal.length === 0,
    detail: fatal.length ? fatal.map((event) => event.stage).join(", ") : "none",
  })

  if (has("softap_call_stop")) {
    const undone = events.filter((event) => event.stage === "softap_step_undone").length
    const stopped = events.find((event) => event.stage === "softap_call_stopped")
    const failures = (stopped?.fields.undoFailures ?? "").replace(/^""$/, "")
    results.push({
      name: "teardown released every step with no failures",
      ok: Boolean(stopped) && failures.length === 0 && undone > 0,
      detail: stopped ? `undone=${undone} failures=${failures || "none"}` : "never finished stopping",
    })
    // A step that completed after the leave and was not released is the leak this stage exists to
    // surface; the orchestrator releases it immediately, so seeing the stage is fine, but only if
    // the teardown that follows accounts for it.
    results.push({
      name: "the listener and the scoped network were released",
      ok: has("whip_listener_closed") && has("scoped_network_released"),
      detail: `listener=${has("whip_listener_closed")} network=${has("scoped_network_released")}`,
    })
    // Android reports the scoped network as lost while we are deliberately releasing it, and
    // `ScopedNetworkState.release()` is what suppresses it: an expected loss never reaches this
    // stage. So a loss logged *after* the teardown started is the false positive the terminal-intent
    // flag exists to prevent, and it would make a clean Leave look like a hotspot failure. A loss
    // before the stop is a genuine mid-call drop, which the soak deliberately provokes, so it is
    // judged by the mid-call-drop case rather than counted against teardown here.
    const stopAt = stages.indexOf("softap_call_stop")
    const lateLost = events.filter(
      (event, index) => event.stage === "scoped_network_lost" && index > stopAt,
    )
    results.push({
      name: "teardown did not report a hotspot loss it caused",
      ok: lateLost.length === 0,
      detail: lateLost.length
        ? `${lateLost.length} unsuppressed onLost after softap_call_stop`
        : "clean",
    })
  }

  return results
}

/**
 * What each fault means for whoever is reading the run, plus the observations that narrowed it.
 *
 * Keys match `SoftApIceDiagnosis.fields()`; an older capture without them falls back to the code so
 * this never throws on a log from a previous build.
 */
export const ICE_FAULTS = {
  MISSING_INTERFACE: "the hotspot address was not in the kernel interface table, so ICE had nothing to gather",
  ERASED_ENTRY: "libwebrtc's inventory had no usable hotspot entry (absent, or a handle collision dropped it)",
  FAILED_BINDING: "the address was present and published, yet no candidate was gathered: the socket bind failed",
  WRONG_ADDRESS: "candidates were gathered off the hotspot, so a hotspot port advertised the wrong address",
  INDETERMINATE: "the observations do not narrow to one cause",
}

export function describeIceFault(event) {
  const fields = event?.fields ?? {}
  const fault = fields.fault
  if (!fault) return fields.code ?? "rejected without a diagnosis"
  const narrowed = ICE_FAULTS[fault] ?? "unrecognised fault"
  return (
    `${fault}: ${narrowed}` +
    ` [scoped=${fields.scopedAddress}@${fields.scopedOwner}` +
    ` inTable=${fields.scopedInTable} published=${fields.publishedInventory}` +
    ` hotspotEntry=${fields.publishedHotspot} collision=${fields.handleCollision}` +
    ` gathered=${fields.gathered} onHotspot=${fields.hotspotCandidates} off=${fields.offHotspot}]`
  )
}

function describeSelectedPair(offHotspot, selected, unknown) {
  if (offHotspot) {
    return `selected ${offHotspot.fields.local} which is outside ${offHotspot.fields.prefix}`
  }
  if (selected.length > 0) {
    const last = selected.at(-1)
    return `pair=${last.fields.pairId ?? "?"} local=${last.fields.local}`
  }
  // Insufficient evidence, not a pass: the transport never named a selected pair, so nothing here
  // identifies which path carried the call.
  if (unknown.length > 0) return `never resolved a selected pair (${unknown.at(-1).fields.reason})`
  return "no selected-pair sample; ICE never connected or this is an older build"
}

function describeCandidates(glasses, phone) {
  if (!glasses) return "glasses logged no hotspot candidate"
  if (!phone) return "phone logged no host candidate"
  return `glasses=${glasses.fields.candidate ?? "?"} phone=${phone.fields.candidate ?? "?"}`
}

/**
 * Proofs no log line can settle. Reported so a green run is not mistaken for a complete one.
 */
export const MANUAL_PROOFS = [
  "outgoing glasses audio is intelligible in Teams",
  "the wearer does not hear themselves",
  "remote audio does not leak to the phone speaker",
  "the Teams receiver shows 1280x720 at >= 14.5 fps",
]

/**
 * Full verdict for a capture.
 *
 * @param {string} text raw capture
 * @param {{cycles?: number}} [expected] how many complete calls the run should contain
 */
export function analyze(text, expected = {}) {
  const events = parseTrace(text)
  const calls = groupByCall(events).filter((call) => call.events.some((event) => event.stage === "softap_call_start"))
  const perCall = calls.map((call) => ({traceId: call.traceId, results: proveCall(call.events)}))
  const cycles = expected.cycles ?? calls.length
  const failures = perCall.flatMap((call) =>
    call.results.filter((result) => !result.ok).map((result) => `${call.traceId}: ${result.name} (${result.detail})`),
  )
  if (calls.length === 0) {
    failures.push("no SoftAP call found in the capture")
  } else if (calls.length !== cycles) {
    failures.push(`expected ${cycles} calls, found ${calls.length}`)
  }
  return {events: events.length, calls: perCall, failures, ok: failures.length === 0}
}

function adb(args) {
  const result = spawnSync("adb", args, {encoding: "utf8"})
  if (result.status !== 0) {
    throw new Error(`adb ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Drive N join/leave cycles over adb and analyze the trace they produce.
 *
 * The taps go through the miniapp UI rather than a debug intent on purpose: the point of the soak is
 * that the path a wearer takes is clean, including the parts of it that only the UI triggers.
 */
async function soak({cycles, packageName, joinMs, callMs}) {
  adb(["logcat", "-c"])
  const logcat = spawnSync("sh", ["-c", `adb logcat -s SOFTAP-TRACE -v threadtime > /tmp/softap-soak.log &  echo $!`], {
    encoding: "utf8",
  })
  if (logcat.status !== 0) throw new Error("could not start logcat")

  for (let cycle = 1; cycle <= cycles; cycle++) {
    console.log(`[cycle ${cycle}/${cycles}] joining`)
    adb(["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"])
    await sleep(joinMs)
    console.log(`[cycle ${cycle}/${cycles}] in call; holding`)
    await sleep(callMs)
    console.log(`[cycle ${cycle}/${cycles}] leaving`)
    adb(["shell", "input", "keyevent", "KEYCODE_BACK"])
    await sleep(joinMs)
  }

  await sleep(2_000)
  spawnSync("sh", ["-c", "pkill -f 'adb logcat -s SOFTAP-TRACE'"])
  return analyze(readFileSync("/tmp/softap-soak.log", "utf8"), {cycles})
}

function report(verdict) {
  for (const call of verdict.calls) {
    console.log(`\ncall ${call.traceId}`)
    for (const result of call.results) {
      console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${result.name} — ${result.detail}`)
    }
  }
  console.log("\nneeds a human (no log line can settle these):")
  for (const proof of MANUAL_PROOFS) console.log(`  ????  ${proof}`)
  if (verdict.ok) {
    console.log(`\nAll automated proofs passed across ${verdict.calls.length} call(s).`)
    return 0
  }
  console.log(`\n${verdict.failures.length} failure(s):`)
  for (const failure of verdict.failures) console.log(`  - ${failure}`)
  return 1
}

function flag(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

async function main(argv) {
  const [command, ...rest] = argv
  if (command === "analyze") {
    const path = rest.find((arg) => !arg.startsWith("--"))
    if (!path) throw new Error("usage: analyze <capture.log> [--cycles N]")
    const cycles = flag(rest, "cycles", null)
    return report(analyze(readFileSync(path, "utf8"), cycles ? {cycles: Number(cycles)} : {}))
  }
  if (command === "soak") {
    return report(
      await soak({
        cycles: Number(flag(rest, "cycles", "10")),
        packageName: flag(rest, "package", "com.mentra.mentra"),
        joinMs: Number(flag(rest, "join-ms", "25000")),
        callMs: Number(flag(rest, "call-ms", "10000")),
      }),
    )
  }
  console.log("usage: softap-call-proof.mjs analyze <capture.log> | soak [--cycles N]")
  return 1
}

// Only run as a CLI; importing this file for tests must not touch adb or the filesystem.
if (process.argv[1] && process.argv[1].endsWith("softap-call-proof.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message)
      process.exit(1)
    },
  )
}
