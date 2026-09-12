// TEMPORARY DIAGNOSTIC TOOLING — SOFTAP_TRACE. Delete with the trace layer.
import assert from "node:assert/strict"
import test from "node:test"

import {
  analyze,
  describeIceFault,
  groupByCall,
  ICE_FAULTS,
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
    line("cellular_validated", {held: true, validated: true, viaCallback: true, waitedMs: 820}, {traceId}),
    line("scoped_join_requested", {ssid: "MentraLive-1234", avoidsInternetCapability: true}, {traceId}),
    line("scoped_network_available", {localIpv4: "192.168.43.20", defaultNetworkIsCellular: true}, {traceId}),
    line("scoped_network_joined", {bindAddress: "192.168.43.20"}, {traceId}),
    line("whip_listener_bound", {host: "192.168.43.20", port: 8790}, {traceId}),
    line("ingest_host_candidate", {candidate: "candidate:1 1 udp 2122 192.168.43.20 8790 typ host"}, {traceId}),
    line("default_network_after_join", {transport: "cellular", validated: true, present: true}, {traceId}),
    line("acs_joined", {ingestUrl: "http://192.168.43.20:8790/whip"}, {traceId}),
    line("ice_configured", {mode: "host", stunServers: 0}, {traceId}),
    line("ice_hotspot_candidate", {candidate: "candidate:1 1 udp 2122 192.168.43.1 5000 typ host"}, {traceId}),
    line("glasses_publishing", {ingestUrl: "http://192.168.43.20:8790/whip"}, {traceId}),
    line("whip_offer_received", {session: "s1"}, {traceId}),
    line("whip_answer_sent", {session: "s1"}, {traceId}),
    line("ingest_first_frame", {}, {traceId}),
    line("first_frame_in_acs", {}, {traceId}),
    line("softap_call_live", {}, {traceId}),
    line(
      "ingest_selected_pair",
      {
        pairId: "RTCIceCandidatePair_A_B",
        local: "192.168.43.20",
        remote: "192.168.43.1",
        bytesReceived: 48000,
        bytesFlowing: true,
        comparable: true,
      },
      {traceId},
    ),
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

test("a selected pair off the hotspot fails even though the call reached live", () => {
  // The failure this exists for: every gathered candidate was private, the SDP guard was happy, the
  // call went live — and ICE still chose the cellular interface. Only the selected pair shows it.
  const offHotspot =
    cleanCall() +
    "\n" +
    line("ingest_selected_pair_off_hotspot", {local: "10.51.2.7", prefix: "192.168.43.0/24"}, {level: "E"})

  const results = proveCall(parseTrace(offHotspot))

  assert.equal(named(results, "selected ICE pair").ok, false)
  assert.match(named(results, "selected ICE pair").detail, /10\.51\.2\.7.*192\.168\.43\.0\/24/)
})

test("a call that never sampled a selected pair does not pass the ICE-path proof", () => {
  // An older build logs no sample at all. Treating silence as success would let exactly the
  // regression this proof was added for ship unnoticed.
  const noSample = cleanCall()
    .split("\n")
    .filter((entry) => !entry.includes("stage=ingest_selected_pair"))
    .join("\n")

  const results = proveCall(parseTrace(noSample))

  assert.equal(named(results, "selected ICE pair").ok, false)
  assert.match(named(results, "selected ICE pair").detail, /no selected-pair sample/)
})

test("a selected pair carrying no bytes fails the flow proof but not the path proof", () => {
  const idle = cleanCall().replace("bytesReceived=48000 bytesFlowing=true", "bytesReceived=0 bytesFlowing=false")

  const results = proveCall(parseTrace(idle))

  assert.equal(named(results, "selected ICE pair").ok, true)
  assert.equal(named(results, "bytes increased").ok, false)
})

/**
 * Growth measured across a pair change is not evidence of media, and the previous verifier compared
 * two numbers with no pair identity at all. A capture whose samples were never comparable has to
 * fail rather than inherit a pass from a number that went up.
 */
test("samples that were never comparable fail the flow proof and say why", () => {
  const incomparable = cleanCall().replace(
    "bytesFlowing=true comparable=true",
    "bytesFlowing=false comparable=false notComparable=pair_changed",
  )

  const results = proveCall(parseTrace(incomparable))

  const proof = named(results, "bytes increased")
  assert.equal(proof.ok, false)
  assert.match(proof.detail, /no comparable sample pair \(pair_changed\)/)
})

test("the path proof names the pair it followed, so two runs can be told apart", () => {
  const detail = named(proveCall(parseTrace(cleanCall())), "selected ICE pair").detail

  assert.match(detail, /pair=RTCIceCandidatePair_A_B/)
})

test("an unresolved pair reports why rather than claiming the path is proven", () => {
  const unknown =
    cleanCall()
      .split("\n")
      .filter((entry) => !entry.includes("stage=ingest_selected_pair"))
      .join("\n") + "\n" + line("ingest_selected_pair_unknown", {reason: "no_scoped_prefix"})

  const results = proveCall(parseTrace(unknown))

  assert.equal(named(results, "selected ICE pair").ok, false)
  assert.match(named(results, "selected ICE pair").detail, /no_scoped_prefix/)
})

test("a hotspot loss logged during teardown fails as a false positive", () => {
  // `ScopedNetworkState.release()` suppresses the expected loss, so one that still reaches the trace
  // after the stop began is the bug that makes a clean Leave look like a hotspot failure.
  const noisy =
    cleanCall() +
    "\n" +
    cleanTeardown()
      .split("\n")
      .flatMap((entry) =>
        entry.includes("stage=scoped_network_released")
          ? [entry, line("scoped_network_lost", {ssid: "MentraLive-1234"}, {level: "E"})]
          : [entry],
      )
      .join("\n")

  const results = proveCall(parseTrace(noisy))

  assert.equal(named(results, "teardown did not report a hotspot loss").ok, false)
})

test("a genuine mid-call drop is not counted against teardown", () => {
  // The soak deliberately kills the hotspot mid-call. That loss is real, is judged by the mid-call
  // drop case, and must not also be reported as a teardown suppression bug.
  const dropped =
    cleanCall() + "\n" + line("scoped_network_lost", {ssid: "MentraLive-1234"}, {level: "E"}) + "\n" + cleanTeardown()

  const results = proveCall(parseTrace(dropped))

  assert.equal(named(results, "teardown did not report a hotspot loss").ok, true)
})

/**
 * The four faults below all produced the same symptom on device. The analyzer has to name which one
 * a capture shows, because "no hotspot candidate" is what made two of them indistinguishable.
 */
const rejection = (fields) =>
  line(
    "ingest_answer_rejected",
    {
      code: "no_candidates_gathered",
      scopedAddress: "192.168.43.79",
      scopedOwner: "wlan0",
      scopedInTable: true,
      scopedPrefix: "192.168.43.79/24",
      publishedInventory: "wlan0[CONNECTION_WIFI]#0(192.168.43.79)",
      publishedHotspot: true,
      handleCollision: false,
      gathered: 0,
      hotspotCandidates: 0,
      offHotspot: "none",
      ...fields,
    },
    {level: "E"},
  )

test("a rejected answer fails and names the narrowed fault", () => {
  const capture = cleanCall() + "\n" + rejection({fault: "FAILED_BINDING"})

  const results = proveCall(parseTrace(capture))

  const proof = named(results, "the answer carried a hotspot candidate")
  assert.equal(proof.ok, false)
  assert.match(proof.detail, /FAILED_BINDING/)
  assert.match(proof.detail, /socket bind failed/)
})

test("each fault reports a distinct explanation rather than the shared symptom", () => {
  const details = Object.keys(ICE_FAULTS).map((fault) =>
    named(proveCall(parseTrace(rejection({fault}))), "the answer carried a hotspot candidate").detail,
  )

  assert.equal(new Set(details).size, Object.keys(ICE_FAULTS).length)
})

test("a handle collision is visible in the detail, not just the fault name", () => {
  const detail = describeIceFault(
    parseTrace(
      rejection({
        fault: "ERASED_ENTRY",
        handleCollision: true,
        publishedInventory: "wlan0[CONNECTION_WIFI]#0(192.168.43.79),rmnet_data0[CONNECTION_4G]#0(10.48.51.7)",
      }),
    )[0],
  )

  assert.match(detail, /collision=true/)
  assert.match(detail, /rmnet_data0\[CONNECTION_4G\]#0/)
})

test("a capture from a build without the diagnosis falls back to the code", () => {
  const legacy = line("ingest_answer_rejected", {code: "no_softap_host_candidate"}, {level: "E"})

  const proof = named(proveCall(parseTrace(legacy)), "the answer carried a hotspot candidate")

  assert.equal(proof.ok, false)
  assert.equal(proof.detail, "no_softap_host_candidate")
})

test("a clean call passes the answer proof", () => {
  const proof = named(proveCall(parseTrace(cleanCall())), "the answer carried a hotspot candidate")

  assert.equal(proof.ok, true)
  assert.equal(proof.detail, "accepted")
})

test("cellular that never validated fails, and says how long it waited", () => {
  // The run that cost 30s of stall plus the whole join timeout. Proceeding onto the hotspot with
  // no working cellular strands ACS, and the resulting capture blames the hotspot.
  const stranded = cleanCall().replace(
    "held=true validated=true viaCallback=true waitedMs=820",
    "held=true validated=false viaCallback=false waitedMs=15000",
  )

  const proof = named(proveCall(parseTrace(stranded)), "cellular validated")

  assert.equal(proof.ok, false)
  assert.match(proof.detail, /validated=false/)
  assert.match(proof.detail, /waitedMs=15000/)
})

test("an unvalidated default network after the join fails and names the transport", () => {
  // Distinct from the cellular check: that one asks whether the radio works, this one asks which
  // route the app actually got afterwards. Only the second explains an ACS join failing on a
  // hotspot that was itself fine.
  const unvalidated = cleanCall().replace(
    "transport=cellular validated=true present=true",
    "transport=cellular validated=false present=true",
  )

  const proof = named(proveCall(parseTrace(unvalidated)), "validated default network")

  assert.equal(proof.ok, false)
  assert.match(proof.detail, /transport=cellular/)
})

test("no default network at all fails even when the field says validated", () => {
  // A stale capability snapshot must not read as a live route.
  const absent = cleanCall().replace(
    "transport=cellular validated=true present=true",
    "transport=none validated=true present=false",
  )

  assert.equal(named(proveCall(parseTrace(absent)), "validated default network").ok, false)
})

test("a host that predates the internet checks is not judged on them", () => {
  // Absent stages mean an older build, not a failure. Inventing one would fail every capture taken
  // before this pass, including the ones we still compare against.
  const older = cleanCall()
    .split("\n")
    .filter((entry) => !entry.includes("stage=cellular_validated") && !entry.includes("stage=default_network_after_join"))
    .join("\n")

  const results = proveCall(parseTrace(older))

  assert.equal(named(results, "cellular validated"), undefined)
  assert.equal(named(results, "validated default network"), undefined)
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

test("reads host phase events and multiline RN fields, including failed cleanup", () => {
  const capture = [
    "09-10 18:00:00.000 100 101 I ReactNativeJS: '[SOFTAP_TRACE] traceId=abc123 phase=softap_call_start elapsedMs=0', { traceId: 'abc123' }",
    "09-10 18:01:00.000 100 101 I ReactNativeJS: '[SOFTAP_TRACE] traceId=abc123 phase=softap_call_stopped elapsedMs=60000', { undoFailures: 'hotspot',",
    "09-10 18:01:00.000 100 101 I ReactNativeJS:   stopped: true }",
    "09-10 18:01:00.000 100 101 I ReactNativeJS: unrelated: 'noise'",
  ].join("\n")
  const events = parseTrace(capture)
  assert.equal(events.length, 2)
  assert.equal(events[0].stage, "softap_call_start")
  assert.equal(events[1].elapsedMs, 60000)
  assert.equal(events[1].fields.undoFailures, "hotspot")
  assert.equal(events[1].fields.stopped, "true")
  assert.equal(events[1].fields.unrelated, undefined)
  assert.equal(analyze(capture).calls.length, 1)
  const withStop = [...events.slice(0, 1), {stage: "softap_call_stop", traceId: "abc123", fields: {}}, ...events.slice(1)]
  assert.equal(named(proveCall(withStop), "teardown released every step").ok, false)
})
