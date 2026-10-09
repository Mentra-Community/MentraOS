import {expect, test} from "bun:test"
import {finishRecordedNightlySuite, type RecordedSuiteRow} from "./finish-recorded-nightly-suites"
import {nightlySuiteId} from "../packages/core/src/services/nightly-routine.service"
import {requestInputDigest} from "../packages/core/src/services/test-request.service"
import {TestRunError} from "../packages/core/src/services/test-result-error"
const start = "2026-10-07T20:00:00.000Z",
  cancel = "2026-10-08T06:26:39.582Z",
  now = Date.parse("2026-10-09T03:00:00Z")
function fixture(count = 3) {
  const occurrenceId = "recorded-input-occurrence",
    suiteId = nightlySuiteId(occurrenceId),
    headSha = "a".repeat(40),
    revision = "b".repeat(40)
  const build = {repository: "Mentra-Community/MentraOS", channel: "dev", headSha, releaseIdentity: "3.3.0-dev.614"}
  const members = Array.from({length: count}, (_, i) => ({
    memberId: `member-${i}`,
    requestId: `${suiteId}-member-${i}`,
    routineId: `routine-${i}`,
    platform: "android",
    definitionRevision: revision,
    definitionSha256: "c".repeat(64),
    hostId: "original-host",
    build,
    input: {
      routineId: `routine-${i}`,
      definitionRevision: revision,
      platform: "android",
      laneId: "original-lane",
      build,
      resources: [],
    },
  }))
  const suite = {
    suiteId,
    channel: "dev",
    trigger: "manual",
    startedAt: start,
    build: {headSha, release: "3.3.0-dev.614"},
    members: members.map((m) => ({
      memberId: m.memberId,
      requestId: m.requestId,
      headSha,
      routineId: m.routineId,
      platform: m.platform,
      definitionRevision: revision,
    })),
  }
  const row: RecordedSuiteRow = {
    suiteId,
    payload: suite,
    payloadSha256: requestInputDigest(suite),
    nightlyPlan: {occurrenceId, suiteId, startedAt: start, trigger: "manual", suite, members, publication: {headSha}},
    nightlyCancellation: {requestedAt: cancel, reason: "Recorded cancellation"},
  }
  const requests = new Map(
    members.map((m) => [
      m.requestId,
      {
        requestId: m.requestId,
        input: m.input,
        inputSha256: requestInputDigest(m.input),
        hostId: m.hostId,
        state: "accepted",
      },
    ]),
  )
  const runs = new Map(
    members.slice(0, 2).map((m, i) => [
      m.requestId,
      {
        requestId: m.requestId,
        runId: `original-run-${i}`,
        routineId: m.routineId,
        platform: m.platform,
        definitionRevision: revision,
        hostId: m.hostId,
        laneId: m.input.laneId,
        build,
        startedAt: start,
        finishedAt: "2026-10-08T07:00:00.000Z",
        outcome: i ? "failed" : "pass",
        uploadsComplete: true,
        evidenceStatus: "complete",
      },
    ]),
  )
  const writes: string[] = []
  let failCancel = "",
    lostAck = false,
    casLost = false
  const deps = {
    async getSuite() {
      return structuredClone(row)
    },
    async getRequest(id: string) {
      return structuredClone(requests.get(id) ?? null) as any
    },
    async summary(id: string) {
      const r = runs.get(id)
      if (!r) throw new TestRunError(404, "No original result")
      return structuredClone(r) as any
    },
    async cancel(id: string, requestedAt: string, reason: string) {
      writes.push(`cancel:${id}`)
      if (id === failCancel) return null
      const r = requests.get(id)!
      Object.assign(r, {
        hostCancellation: {requestId: id, inputSha256: r.inputSha256, hostId: r.hostId, requestedAt, reason},
      })
      return structuredClone(r) as any
    },
    async finish(_original: RecordedSuiteRow, result: unknown) {
      writes.push("finish")
      if (!casLost && row.nightlyResult === undefined) row.nightlyResult = structuredClone(result)
      if (lostAck) throw new Error("Lost write acknowledgement")
    },
  }
  return {
    row,
    members,
    requests,
    runs,
    deps,
    writes,
    suiteId,
    set failCancel(v: string) {
      failCancel = v
    },
    set lostAck(v: boolean) {
      lostAck = v
    },
    set casLost(v: boolean) {
      casLost = v
    },
  }
}
test("dry-run preserves original plan/run bytes and reports actual outcomes", async () => {
  const f = fixture(),
    before = JSON.stringify(f.row),
    runs = JSON.stringify([...f.runs])
  expect(await finishRecordedNightlySuite(f.suiteId, false, f.deps, now)).toMatchObject({
    passed: 1,
    failed: 1,
    incomplete: 1,
    status: "incomplete",
    finishedAt: "2026-10-08T07:00:00.000Z",
  })
  expect(f.writes).toEqual([])
  expect(JSON.stringify(f.row)).toBe(before)
  expect(JSON.stringify([...f.runs])).toBe(runs)
})
test("complete glasses inputs retain their manifest while the earlier app selection stays exact", async () => {
  const f = fixture()
  const manifest = {url: "https://artifacts.example.com/firmware.json", sha256: "d".repeat(64), size: 3472}
  for (const member of f.members.slice(0, 2)) {
    Object.assign(member.input, {
      build: {...member.build, manifest, manifestSha256: manifest.sha256},
      resources: [{id: "original-glasses", kind: "glasses"}],
      glassesStart: {model: "mentra-live", manifest},
      glassesReturn: {model: "mentra-live", manifest},
    })
    f.requests.get(member.requestId)!.inputSha256 = requestInputDigest(member.input)
    f.runs.get(member.requestId)!.build = member.input.build
  }
  const original = JSON.stringify(f.row)
  expect(await finishRecordedNightlySuite(f.suiteId, false, f.deps, now)).toMatchObject({
    passed: 1,
    failed: 1,
    incomplete: 1,
  })
  expect(JSON.stringify(f.row)).toBe(original)
  expect(f.writes).toEqual([])
  const first = f.members[0]!
  f.runs.get(first.requestId)!.build = {...first.input.build, manifestSha256: "e".repeat(64)} as typeof first.build
  await expect(finishRecordedNightlySuite(f.suiteId, true, f.deps, now)).rejects.toThrow(
    "native result identity differs",
  )
  expect(f.writes).toEqual([])
  f.runs.get(first.requestId)!.build = first.input.build
  first.build.releaseIdentity = "3.3.0-dev.615"
  await expect(finishRecordedNightlySuite(f.suiteId, true, f.deps, now)).rejects.toThrow("member input differs")
  expect(f.writes).toEqual([])
})
test("apply cancels only existing unresolved requests and records original-field result once", async () => {
  const f = fixture(),
    plan = JSON.stringify(f.row.nightlyPlan),
    payload = JSON.stringify(f.row.payload)
  await finishRecordedNightlySuite(f.suiteId, true, f.deps, now)
  expect(f.writes).toEqual([`cancel:${f.members[2]!.requestId}`, "finish"])
  expect(JSON.stringify(f.row.nightlyPlan)).toBe(plan)
  expect(JSON.stringify(f.row.payload)).toBe(payload)
  const result = f.row.nightlyResult as any
  expect(result.members[0]).toMatchObject({...f.members[0], status: "pass", runId: "original-run-0"})
  expect(result.members[2]).toMatchObject({
    ...f.members[2],
    status: "incomplete",
    unavailableReason: "Cancelled: Recorded cancellation; no original run result was recorded.",
  })
  expect(result.members.some((m: any) => "routineRevision" in m || "dispatchIntent" in m)).toBe(false)
  expect(await finishRecordedNightlySuite(f.suiteId, true, f.deps, now)).toMatchObject({alreadyFinished: true})
  expect(f.writes).toHaveLength(2)
})
test("a run completing during cancellation keeps its authoritative outcome and actual finish", async () => {
  const f = fixture(),
    member = f.members[2]!,
    original = JSON.stringify(f.row.nightlyPlan)
  const cancelRequest = f.deps.cancel
  f.deps.cancel = async (id, at, reason) => {
    await cancelRequest(id, at, reason)
    const run = {
      ...f.runs.get(f.members[0]!.requestId)!,
      requestId: id,
      runId: "raced-original-run",
      routineId: member.routineId,
      finishedAt: "2026-10-08T08:00:00.000Z",
    }
    f.runs.set(id, run)
    Object.assign(f.requests.get(id)!, {state: "terminal", runId: run.runId, terminalStatus: run.outcome})
    return structuredClone(f.requests.get(id)) as any
  }
  expect(await finishRecordedNightlySuite(f.suiteId, true, f.deps, now)).toMatchObject({
    passed: 2,
    failed: 1,
    incomplete: 0,
    status: "failed",
    finishedAt: "2026-10-08T08:00:00.000Z",
  })
  expect((f.row.nightlyResult as any).members[2]).toMatchObject({
    status: "pass",
    runId: "raced-original-run",
    runFinishedAt: "2026-10-08T08:00:00.000Z",
    publicationComplete: true,
  })
  expect(JSON.stringify(f.row.nightlyPlan)).toBe(original)
  expect(f.writes).toEqual([`cancel:${member.requestId}`, "finish"])
})
test("missing, foreign or unsettled raced results prevent archival completion", async () => {
  for (const failure of ["missing", "foreign", "unsettled", "wrong-run"]) {
    const f = fixture(),
      member = f.members[2]!,
      cancelRequest = f.deps.cancel
    f.deps.cancel = async (id, at, reason) => {
      await cancelRequest(id, at, reason)
      const run = {
        ...f.runs.get(f.members[0]!.requestId)!,
        requestId: id,
        runId: "raced-original-run",
        routineId: member.routineId,
      }
      if (failure === "foreign") run.hostId = "different-host"
      if (failure === "unsettled") run.uploadsComplete = false
      if (failure !== "missing") f.runs.set(id, run)
      Object.assign(f.requests.get(id)!, {
        state: "terminal",
        runId: failure === "wrong-run" ? "different-run" : run.runId,
        terminalStatus: run.outcome,
      })
      return structuredClone(f.requests.get(id)) as any
    }
    await expect(finishRecordedNightlySuite(f.suiteId, true, f.deps, now)).rejects.toThrow()
    expect(f.row.nightlyResult).toBeUndefined()
    expect(f.writes).toEqual([`cancel:${member.requestId}`])
  }
})
test("corrupt suite/request/result identities, current plans and unsettled evidence make no writes", async () => {
  const corruptions = [
    (f: ReturnType<typeof fixture>) => {
      f.row.payloadSha256 = "d".repeat(64)
    },
    (f: ReturnType<typeof fixture>) => {
      f.requests.get(f.members[2]!.requestId)!.inputSha256 = "d".repeat(64)
    },
    (f: ReturnType<typeof fixture>) => {
      f.runs.get(f.members[0]!.requestId)!.hostId = "wrong"
    },
    (f: ReturnType<typeof fixture>) => {
      f.runs.get(f.members[0]!.requestId)!.build = {
        ...f.runs.get(f.members[0]!.requestId)!.build,
        headSha: "d".repeat(40),
      }
    },
    (f: ReturnType<typeof fixture>) => {
      f.runs.get(f.members[0]!.requestId)!.uploadsComplete = false
    },
    (f: ReturnType<typeof fixture>) => {
      ;(f.row.nightlyPlan as any).members[0].selection = {}
    },
  ]
  for (const mutate of corruptions) {
    const f = fixture()
    mutate(f)
    await expect(finishRecordedNightlySuite(f.suiteId, true, f.deps, now)).rejects.toThrow()
    expect(f.writes).toEqual([])
  }
})
test("lost write acknowledgement reconciles identical receipt; lost CAS does not overwrite", async () => {
  const f = fixture()
  f.lostAck = true
  await expect(finishRecordedNightlySuite(f.suiteId, true, f.deps, now)).resolves.toMatchObject({status: "incomplete"})
  const lost = fixture()
  lost.casLost = true
  await expect(finishRecordedNightlySuite(lost.suiteId, true, lost.deps, now)).rejects.toThrow("compare-and-set")
  expect(lost.row.nightlyResult).toBeUndefined()
})
test("partial cancellation leaves no final result and retry uses original rows", async () => {
  const f = fixture(4)
  f.failCancel = f.members[3]!.requestId
  await expect(finishRecordedNightlySuite(f.suiteId, true, f.deps, now)).rejects.toThrow(
    "cancellation was not retained",
  )
  expect(f.row.nightlyResult).toBeUndefined()
  expect(f.writes.includes("finish")).toBe(false)
  f.failCancel = ""
  await finishRecordedNightlySuite(f.suiteId, true, f.deps, now)
  expect(f.row.nightlyResult).toBeDefined()
})
test("expired plans use recorded deadline and missing requests remain incomplete without admission", async () => {
  const f = fixture()
  delete f.row.nightlyCancellation
  f.runs.clear()
  f.requests.delete(f.members[2]!.requestId)
  expect(await finishRecordedNightlySuite(f.suiteId, false, f.deps, now)).toMatchObject({
    finishedAt: "2026-10-07T23:00:00.000Z",
    passed: 0,
    incomplete: 3,
  })
  await expect(finishRecordedNightlySuite(f.suiteId, true, f.deps, Date.parse(start) + 1)).rejects.toThrow(
    "cancelled or expired",
  )
  expect(f.writes).toEqual([])
})
