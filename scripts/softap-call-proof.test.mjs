// TEMPORARY DIAGNOSTIC TOOLING — SOFTAP_TRACE. Delete with the trace layer.
import assert from "node:assert/strict"
import test from "node:test"

import {
  analyze,
  groupByCall,
  isPrivateIpv4,
  parseTrace,
  proveCall,
  REQUIRED_ORDER,
} from "./softap-call-proof.mjs"

/**
 * These tests exist because the analyzer is what decides whether a device run passed. An analyzer
 * that reports PASS on a broken capture is worse than no analyzer: it converts a real failure into
 * recorded evidence that everything worked.
 */

const line = (stage, fields = {}, {traceId = "abc123", level = "I", elapsedMs = 100} = {}) => {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value).includes(" ") ? `"${value}"` : value}`)
    .join(" ")
  return `09-04 17:00:00.000  1234  1234 ${level} SOFTAP-TRACE: [SOFTAP_TRACE] traceId=${traceId} stage=${stage} elapsedMs=${elapsedMs}${rendered ? " " + rendered : ""}`
}

/** A capture of one clean call, which every failure case below mutates. */
function cleanCall(traceId = "abc123") {
  return [
    line("softap_call_start", {}, {traceId}),
    line("hotspot_enabled", {ssid: "MentraLive-1234"}, {traceId}),
    line("scoped_join_requested", {ssid: "MentraLive-1234", avoidsInternetCapability: true}, {traceId}),
    line("scoped_network_available", {localIpv4: "192.168.43.20", defaultNetworkIsCellular: true}, {traceId}),
    line("scoped_network_joined", {bindAddress: "192.168.43.20"}, {traceId}),
    line("whip_listener_bound", {host: "192.168.43.20", port: 8790}, {traceId}),
    line("ingest_host_candidate", {candidate: "candidate:1 1 udp 2122 192.168.43.20 8790 typ host"}, {traceId}),
    line("acs_joined", {ingestUrl: "http://192.168.43.20:8790/whip"}, {traceId}),
    line("ice_configured", {mode: "host", stunServers: 0}, {traceId}),
    line("ice_hotspot_candidate", {candidate: "candidate:1 1 udp 2122 192.168.43.1 5000 typ host"}, {traceId}),
    line("glasses_publishing", {ingestUrl: "http://192.168.43.20:8790/whip"}, {traceId}),
    line("whip_offer_received", {session: "s1"}, {traceId}),
    line("whip_answer_sent", {session: "s1"}, {traceId}),
    line("ingest_first_frame", {}, {traceId}),
    line("first_frame_in_acs", {}, {traceId}),
    line("softap_call_live", {}, {traceId}),
  ].join("\n")
}

function cleanTeardown(traceId = "abc123") {
  return [
    line("softap_call_stop", {steps: "hotspot,scopedJoin,acsJoin,publish,live"}, {traceId}),
    line("softap_step_undone", {step: "live"}, {traceId}),
    line("softap_step_undone", {step: "publish"}, {traceId}),
    line("whip_listener_closed", {accepted: 1}, {traceId}),
    line("softap_step_undone", {step: "acsJoin"}, {traceId}),
    line("scoped_network_released", {}, {traceId}),
    line("softap_step_undone", {step: "scopedJoin"}, {traceId}),
    line("softap_step_undone", {step: "hotspot"}, {traceId}),
    line("softap_call_stopped", {undoFailures: '""'}, {traceId}),
  ].join("\n")
}

const named = (results, name) => results.find((result) => result.name.includes(name))

test("parses only our lines out of a mixed capture", () => {
  const capture = [
    "09-04 17:00:00.000 1 1 I ActivityManager: unrelated noise",
    line("hotspot_enabled", {ssid: "MentraLive-1234"}),
    "09-04 17:00:00.100 1 1 I ACS-SPIKE: also not ours",
  ].join("\n")

  const events = parseTrace(capture)

  assert.equal(events.length, 1)
  assert.equal(events[0].stage, "hotspot_enabled")
  assert.equal(events[0].fields.ssid, "MentraLive-1234")
  assert.equal(events[0].traceId, "abc123")
})

test("reads quoted values that contain spaces", () => {
  const events = parseTrace(line("ingest_host_candidate", {candidate: "candidate:1 1 udp 2122 192.168.43.20 8790 typ host"}))

  assert.match(events[0].fields.candidate, /typ host$/)
})

test("distinguishes failure-level lines from stage lines", () => {
  const events = parseTrace(line("scoped_network_lost", {ssid: "MentraLive-1234"}, {level: "E"}))

  assert.equal(events[0].level, "E")
})

test("groups a multi-call capture by trace id", () => {
  const capture = [cleanCall("aaa"), cleanCall("bbb")].join("\n")

  const calls = groupByCall(parseTrace(capture))

  assert.deepEqual(
    calls.map((call) => call.traceId),
    ["aaa", "bbb"],
  )
})

test("a clean call passes every automated proof", () => {
  const results = proveCall(parseTrace(cleanCall() + "\n" + cleanTeardown()))

  const failed = results.filter((result) => !result.ok)
  assert.deepEqual(failed, [], `unexpected failures: ${JSON.stringify(failed)}`)
})

test("an out-of-order sequence fails even though every stage is present", () => {
  // Publishing before the ACS join means the first frames arrived before the raw outgoing streams
  // existed. Presence checks alone would call this capture clean.
  const swapped = cleanCall()
    .split("\n")
    .filter((entry) => !entry.includes("stage=acs_joined"))
  swapped.splice(
    swapped.findIndex((entry) => entry.includes("stage=softap_call_live")),
    0,
    line("acs_joined", {ingestUrl: "http://192.168.43.20:8790/whip"}),
  )

  const results = proveCall(parseTrace(swapped.join("\n")))

  assert.equal(named(results, "in order").ok, false)
})

test("a call that never reached live fails and names the missing stage", () => {
  const truncated = cleanCall()
    .split("\n")
    .filter((entry) => !entry.includes("stage=softap_call_live"))
    .join("\n")

  const results = proveCall(parseTrace(truncated))

  assert.equal(named(results, "in order").ok, false)
  assert.match(named(results, "in order").detail, /softap_call_live/)
})

test("a Cloudflare URL anywhere in the trace fails the transport proof", () => {
  const leaked =
    cleanCall() + "\n" + line("acs_joined", {ingestUrl: "https://customer.cloudflarestream.com/x/webRTC/play"})

  const results = proveCall(parseTrace(leaked))

  assert.equal(named(results, "no Cloudflare session").ok, false)
})

test("a public host candidate fails the local-pair proof", () => {
  // A candidate on a routable address means ICE could have selected a path that leaves the room,
  // which is the whole thing SoftAP is supposed to make impossible.
  const routable = cleanCall()
    .split("\n")
    .map((entry) => entry.replace("192.168.43.20 8790 typ host", "203.0.113.7 8790 typ host"))
    .join("\n")

  const results = proveCall(parseTrace(routable))

  assert.equal(named(results, "private-subnet host candidate").ok, false)
})

test("a missing phone candidate fails with a detail that says which side", () => {
  const oneSided = cleanCall()
    .split("\n")
    .filter((entry) => !entry.includes("stage=ingest_host_candidate"))
    .join("\n")

  const results = proveCall(parseTrace(oneSided))

  assert.match(named(results, "private-subnet host candidate").detail, /phone/)
})

test("a configured STUN server fails the host-only proof", () => {
  const withStun = cleanCall()
    .split("\n")
    .map((entry) => entry.replace("mode=host stunServers=0", "mode=stun stunServers=1"))
    .join("\n")

  const results = proveCall(parseTrace(withStun))

  assert.equal(named(results, "host-only ICE").ok, false)
})

test("a permission denial fails as a fatal stage", () => {
  const denied = cleanCall() + "\n" + line("scoped_join_permission_denied", {ssid: "MentraLive-1234"}, {level: "E"})

  const results = proveCall(parseTrace(denied))

  assert.equal(named(results, "no fatal stage").ok, false)
  assert.match(named(results, "no fatal stage").detail, /permission_denied/)
})

test("a deferred WHIP post that was never blocked is not fatal", () => {
  // `whip_post_deferred` is the host-only path working as designed: the offer waits for gathering to
  // finish. Only `whip_post_blocked` means it gave up.
  const deferred = cleanCall() + "\n" + line("whip_post_deferred", {trigger: "candidate", mode: "host"})

  const results = proveCall(parseTrace(deferred))

  assert.equal(named(results, "no fatal stage").ok, true)
})

test("a teardown that reported an undo failure fails", () => {
  const failed = cleanCall() + "\n" + cleanTeardown().replace('undoFailures=""', "undoFailures=publish")

  const results = proveCall(parseTrace(failed))

  assert.equal(named(results, "teardown released every step").ok, false)
})

test("a teardown that never released the listener fails", () => {
  const leaked =
    cleanCall() +
    "\n" +
    cleanTeardown()
      .split("\n")
      .filter((entry) => !entry.includes("stage=whip_listener_closed"))
      .join("\n")

  const results = proveCall(parseTrace(leaked))

  assert.equal(named(results, "listener and the scoped network were released").ok, false)
})

test("a call with no teardown is not judged on teardown proofs", () => {
  // Mid-run captures are legitimate; inventing a teardown failure for a call still in progress would
  // make every partial capture look broken.
  const results = proveCall(parseTrace(cleanCall()))

  assert.equal(named(results, "teardown"), undefined)
})

test("a ten-cycle soak passes when every cycle is clean", () => {
  const capture = Array.from({length: 10}, (_, index) => {
    const traceId = `cycle${index}`
    return cleanCall(traceId) + "\n" + cleanTeardown(traceId)
  }).join("\n")

  const verdict = analyze(capture, {cycles: 10})

  assert.equal(verdict.ok, true, JSON.stringify(verdict.failures))
  assert.equal(verdict.calls.length, 10)
})

test("one bad cycle out of ten fails the whole soak and names the cycle", () => {
  // The failure this catches is cumulative: a resource leaked on cycle 7 shows up nowhere in the
  // aggregate, so the verdict has to be per-call.
  const capture = Array.from({length: 10}, (_, index) => {
    const traceId = `cycle${index}`
    const call = index === 6 ? cleanCall(traceId).replace("undoFailures", "x") : cleanCall(traceId)
    const teardown = index === 6 ? cleanTeardown(traceId).replace('undoFailures=""', "undoFailures=hotspot") : cleanTeardown(traceId)
    return call + "\n" + teardown
  }).join("\n")

  const verdict = analyze(capture, {cycles: 10})

  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure) => failure.startsWith("cycle6:")), JSON.stringify(verdict.failures))
})

test("a soak that produced fewer calls than asked for fails", () => {
  const verdict = analyze(cleanCall() + "\n" + cleanTeardown(), {cycles: 10})

  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure) => /expected 10 calls, found 1/.test(failure)))
})

test("an empty capture fails rather than passing vacuously", () => {
  // A run where the app never started produces no trace lines at all. Reporting that as success is
  // the single most dangerous thing this analyzer could do.
  const verdict = analyze("")

  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure) => /no SoftAP call found/.test(failure)))
})

test("a capture of unrelated logcat noise fails the same way", () => {
  const verdict = analyze("09-04 17:00:00.000 1 1 I ActivityManager: nothing to see")

  assert.equal(verdict.ok, false)
  assert.equal(verdict.events, 0)
})

test("private address classification covers the hotspot range and rejects routable ones", () => {
  for (const address of ["192.168.43.20", "192.168.1.5", "10.0.0.3", "172.16.4.9"]) {
    assert.equal(isPrivateIpv4(address), true, address)
  }
  for (const address of ["203.0.113.7", "8.8.8.8", "172.32.0.1", "not-an-address"]) {
    assert.equal(isPrivateIpv4(address), false, address)
  }
})

test("the required order matches the sequence the orchestrator implements", () => {
  // Guards against the analyzer and the transport drifting apart: a renamed stage would otherwise
  // make every capture fail for a reason that has nothing to do with the device.
  assert.deepEqual(REQUIRED_ORDER, [
    "softap_call_start",
    "hotspot_enabled",
    "scoped_network_joined",
    "acs_joined",
    "glasses_publishing",
    "first_frame_in_acs",
    "softap_call_live",
  ])
})
