import {expect, test} from "bun:test"
import {androidJoinProof} from "./android-join-proof"

import {traceFixture, connected, stages, line, nativeJoinLog} from "./android-join-proof.fixture"
const now = 110000

test("native proof requires ordered matching association, readiness and ACS connection", () => {
  const proof = androidJoinProof(nativeJoinLog(), traceFixture, now)
  expect(proof).toEqual({
    pid: 20979,
    traceId: "99bf48e5",
    ssid: "MentraLive_b9a02c",
    localIpv4: "192.168.43.206",
    callId: "4295c0cc-9fd8-4551-b6ff-4351d2d72a0b",
    connectedAtMs: 104000,
  })
  for (const stage of stages) {
    const missing = nativeJoinLog()
      .split("\n")
      .filter((l) => !l.includes("stage=" + stage))
      .join("\n")
    expect(androidJoinProof(missing, traceFixture, now)).toBeNull()
  }
  expect(androidJoinProof(nativeJoinLog().trimEnd(), traceFixture, now)).toBeNull()
})

test("another process, trace, hotspot, stale or future evidence cannot prove this attempt", () => {
  for (const log of [
    nativeJoinLog().replaceAll("20979", "20978"),
    nativeJoinLog().replaceAll("99bf48e5", "123abc"),
    nativeJoinLog().replaceAll("MentraLive_b9a02c", "MentraLive_other"),
    nativeJoinLog(90000),
    nativeJoinLog(120000),
    nativeJoinLog().replace("owner=wlan0", "owner=ABSENT"),
    nativeJoinLog().replace("agrees=true", "agrees=false"),
    nativeJoinLog().replace("capabilitiesSeen=true", "capabilitiesSeen=false"),
    nativeJoinLog().replace("ready localIpv4=192.168.43.206", "ready localIpv4=192.168.43.207"),
    nativeJoinLog().replace("callPhase=connected", "callPhase=connecting"),
    nativeJoinLog().replace("state=connected", "state=connecting"),
  ])
    expect(androidJoinProof(log, traceFixture, now)).toBeNull()
})

test("loss, cleanup, supersession and conflicting ordering invalidate previously connected proof", () => {
  for (const stage of [
    "scoped_network_lost",
    "scoped_network_lost_midcall",
    "scoped_network_released",
    "scoped_network_not_ready",
    "session_hangup",
    "acs_call_state state=disconnected",
    "acs_call_state state=connecting",
    "native_join_scoped_network_begin ssid=MentraLive_b9a02c",
  ])
    expect(androidJoinProof(nativeJoinLog() + line(stage, 105000), traceFixture, now)).toBeNull()
  expect(
    androidJoinProof(nativeJoinLog() + line(stages[0], 105000).replace("99bf48e5", "abcdef"), traceFixture, now),
  ).toBeNull()
  expect(androidJoinProof(nativeJoinLog() + line(connected, 101000), traceFixture, now)).toBeNull()
  // Old cleanup from another process/session does not cancel this attempt.
  expect(androidJoinProof(line("session_hangup", 99000) + nativeJoinLog(), traceFixture, now)).not.toBeNull()
})
