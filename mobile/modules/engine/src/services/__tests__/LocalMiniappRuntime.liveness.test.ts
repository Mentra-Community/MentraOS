/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"

import {shouldHoldMiniappPingLiveness} from "../MiniappLiveness"

// Same approach as LocalMiniappRuntime.softap.test.ts: run the shipped methods against faked I/O
// instead of loading the Expo app singleton and every hardware service behind it.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = ["probeForegroundLiveness", "hasLiveSoftapAttempt", "clearForegroundProbe", "handleMeetingGetState"]
  .map((name) => {
    const start = source.search(new RegExp(`^  (?:public|private) (?:async )?${name}\\(`, "m"))
    if (start < 0) throw new Error(`Missing runtime method ${name}`)
    const rest = source.slice(start)
    const end = rest.search(/^  }$/m)
    if (end < 0) throw new Error(`Missing end of runtime method ${name}`)
    return rest.slice(0, end + 3)
  })
  .join("\n")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${methods} }`)

const CALL = "com.mentra.call"

type Attempt = {packageName: string; cancelled: boolean}

function fixture(opts: {owner?: string | null; attempt?: Attempt | null; nativeState?: string} = {}) {
  const timers = new Map<number, () => void>()
  let timerSeq = 0
  const bgTimer = {
    setTimeout(callback: () => void) {
      const id = ++timerSeq
      timers.set(id, callback)
      return id
    },
    clearTimeout(id: number) {
      timers.delete(id)
    },
  }
  let nativeReads = 0
  const acsMeetingService = {
    ownerPackage: () => opts.owner ?? null,
    async readState() {
      nativeReads++
      return {state: opts.nativeState ?? "idle", muted: false}
    },
  }
  const Host = new Function(
    "BgTimer",
    "acsMeetingService",
    "shouldHoldMiniappPingLiveness",
    "MiniappRequestType",
    "MiniappErrorCode",
    "FOREGROUND_LIVENESS_PROBE_TIMEOUT_MS",
    "LOG_TAG",
    "console",
    `${compiled}; return Host`,
  )(
    bgTimer,
    acsMeetingService,
    shouldHoldMiniappPingLiveness,
    {PING: "ping"},
    {INTERNAL: "INTERNAL"},
    2_500,
    "LOCAL_MINIAPP",
    {log() {}, warn() {}},
  )
  const host = new Host()
  const unregistered: string[] = []
  const respawned: string[] = []
  const results: Array<{packageName: string; ok: boolean; data: unknown}> = []
  host.connectedApps = new Map([[CALL, {lastPongAt: 0}]])
  host.foregroundProbeTimers = new Map()
  host.softapAttempt = opts.attempt ?? null
  host.sendToMiniapp = () => {}
  host.unregisterApp = (packageName: string) => unregistered.push(packageName)
  host.onLivenessTimeout = (packageName: string) => respawned.push(packageName)
  host.sendResult = (packageName: string, _requestId: unknown, ok: boolean, data: unknown) =>
    results.push({packageName, ok, data})
  return {
    host,
    unregistered,
    respawned,
    results,
    nativeReads: () => nativeReads,
    /** Let the probe's timeout fire without a pong having arrived. */
    expireProbe() {
      for (const callback of [...timers.values()]) callback()
      timers.clear()
    },
  }
}

describe("foreground liveness probe", () => {
  test("respawns a miniapp that misses the probe with no call in progress", () => {
    const f = fixture()
    f.host.probeForegroundLiveness(CALL, "app-active", 12_000)
    f.expireProbe()
    expect(f.unregistered).toEqual([CALL])
    expect(f.respawned).toEqual([CALL])
  })

  test("leaves a miniapp alone while its SoftAP join is still before the ACS join", () => {
    // rep_01M3YV13S8CV2T9HAYAZYAWVEM: the probe fired during `scopedJoin`, when no ACS owner exists
    // yet, and the respawn cancelled the join.
    const f = fixture({owner: null, attempt: {packageName: CALL, cancelled: false}})
    f.host.probeForegroundLiveness(CALL, "app-active", 12_000)
    f.expireProbe()
    expect(f.unregistered).toEqual([])
    expect(f.respawned).toEqual([])
  })

  test("leaves the ACS meeting owner alone", () => {
    const f = fixture({owner: CALL})
    f.host.probeForegroundLiveness(CALL, "app-active", 12_000)
    f.expireProbe()
    expect(f.respawned).toEqual([])
  })

  test("still respawns once that SoftAP join has been cancelled", () => {
    const f = fixture({owner: null, attempt: {packageName: CALL, cancelled: true}})
    f.host.probeForegroundLiveness(CALL, "app-active", 12_000)
    f.expireProbe()
    expect(f.respawned).toEqual([CALL])
  })

  test("another miniapp's SoftAP join does not shield this one", () => {
    const f = fixture({owner: null, attempt: {packageName: "com.mentra.other", cancelled: false}})
    f.host.probeForegroundLiveness(CALL, "app-active", 12_000)
    f.expireProbe()
    expect(f.respawned).toEqual([CALL])
  })
})

describe("meeting.getState", () => {
  test("reports idle to a respawned miniapp whose SoftAP join was retired", async () => {
    // Native still reads `connecting` from the retired attempt's prepareAgent; adopting it left
    // Mentra Call on "Starting call…" with nobody to end it.
    const f = fixture({owner: null, attempt: {packageName: CALL, cancelled: true}, nativeState: "connecting"})
    await f.host.handleMeetingGetState(CALL, "req-1")
    expect(f.results).toEqual([{packageName: CALL, ok: true, data: {state: "idle", muted: false}}])
    expect(f.nativeReads()).toBe(0)
  })

  test("reports idle when there is no meeting and no SoftAP attempt at all", async () => {
    const f = fixture({owner: null, attempt: null, nativeState: "connecting"})
    await f.host.handleMeetingGetState(CALL, "req-1")
    expect(f.results[0]?.data).toEqual({state: "idle", muted: false})
    expect(f.nativeReads()).toBe(0)
  })

  test("reads native state for a live SoftAP join before ACS owns it", async () => {
    const f = fixture({owner: null, attempt: {packageName: CALL, cancelled: false}, nativeState: "connecting"})
    await f.host.handleMeetingGetState(CALL, "req-1")
    expect(f.results[0]?.data).toEqual({state: "connecting", muted: false})
    expect(f.nativeReads()).toBe(1)
  })

  test("reads native state for the meeting owner", async () => {
    const f = fixture({owner: CALL, nativeState: "connected"})
    await f.host.handleMeetingGetState(CALL, "req-1")
    expect(f.results[0]?.data).toEqual({state: "connected", muted: false})
    expect(f.nativeReads()).toBe(1)
  })
})
