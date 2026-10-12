import {expect, spyOn, test} from "bun:test"
import {createTestHostStateApi} from '../api/internal/test-host-state.api'
import {TestHostStateModel} from "../models/test-host-state.model"
import {TestRequestModel} from '../models/test-request.model'
import {hostStateSchema, TestHostStateService} from "./test-host-state.service"
import {routineProgressSchema} from '../types/routine-progress.types'

function fixture() {
  let row: Record<string, any> | null = null,
    now = Date.parse("2026-10-03T01:00:00Z"),
    writes = 0,
    reads = 0,
    writeAttempts = 0,
    failedWrites = 0
  let beforeWrite: ((change: Record<string, any>) => void | Promise<void>) | undefined
  const find = spyOn(TestHostStateModel, "findOne").mockImplementation((() => ({
    lean: async () => {
      reads++
      return row && structuredClone(row)
    },
  })) as any)
  const update = spyOn(TestHostStateModel, "findOneAndUpdate").mockImplementation(((
    filter: Record<string, unknown>,
    change: {$set: Record<string, any>},
    options: {upsert: boolean},
  ) => ({
    lean: async () => {
      writeAttempts++
      await beforeWrite?.(change.$set)
      if (failedWrites > 0) {
        failedWrites--
        return null
      }
      if (
        row &&
        Object.entries(filter).some(([key, value]) =>
          typeof value === "object" && value !== null && "$exists" in value
            ? (row![key] !== undefined) !== (value as {$exists: boolean}).$exists
            : row![key] !== value,
        )
      ) {
        if (options.upsert) throw Object.assign(new Error('Duplicate host identity'), {code: 11000})
        return null
      }
      if (!row && !options.upsert) return null
      row = {...row, ...change.$set}
      writes++
      return {...row}
    },
  })) as any)
  return {
    service: new TestHostStateService(() => now),
    advance: (ms: number) => (now += ms),
    writes: () => writes,
    reads: () => reads,
    writeAttempts: () => writeAttempts,
    failWrites: (count: number) => {failedWrites = count},
    beforeWrite: (hook: typeof beforeWrite) => {beforeWrite = hook},
    row: () => row!,
    stop: () => {
      find.mockRestore()
      update.mockRestore()
    },
  }
}
const snapshot = (
  generation: number,
  sequence: number,
  observedAt = "2026-10-03T01:00:00Z",
  incarnation = `boot-${generation}`,
) => ({
  hostId: "mini",
  incarnation,
  incarnationGeneration: generation,
  sequence,
  observedAt,
  lanes: [{id: "mac", platform: "ios-on-mac", dispatchMode: "automatic", state: "idle", resources: []}],
})

const runningSnapshot = (sequence = 1) => {
  const value = snapshot(1, sequence), requestId = 'run-one'
  return {...value, lanes: [{...value.lanes[0], state: 'running', activity: {generation: 7,
    owner: {kind: 'run', id: requestId, requestId}}, progress: {requestId, requestDigest: 'a'.repeat(64),
    ownerGeneration: 7, controllerIncarnation: value.incarnation, sequence, phase: 'test',
    currentStep: {id: 'verify-login', index: 1}, completedSteps: 1, totalSteps: 3,
    startedAt: '2026-10-03T00:58:00Z', lastProgressAt: '2026-10-03T00:59:00Z', observedAt: value.observedAt}}]}
}
function acceptedRequestLookup(found = true) {
  const queries: Record<string, unknown>[] = [], projections: unknown[] = [], settings: unknown[] = []
  const find = spyOn(TestRequestModel, 'findOne').mockImplementation(((query: Record<string, unknown>) => {
    queries.push(query)
    const chain = {select(value: unknown) {projections.push(value); return chain},
      read(value: unknown) {settings.push(value); return chain}, readConcern(value: unknown) {settings.push(value); return chain},
      setOptions(value: unknown) {settings.push(value); return chain}, async lean() {return found ? {requestId: 'run-one'} : null}}
    return chain
  }) as any)
  return {queries, projections, settings, stop() {find.mockRestore()}}
}

test('optional live progress persists only from the exact accepted request and heartbeat never invents advancement', async () => {
  const f = fixture(), lookup = acceptedRequestLookup()
  try {
    const first = runningSnapshot()
    await f.service.report(first, 'mini')
    expect((await f.service.get('mini'))!.lanes[0]!.progress).toEqual(routineProgressSchema.parse(first.lanes[0]!.progress))
    expect(lookup.queries[0]).toEqual({requestId: 'run-one', hostId: 'mini', inputSha256: 'a'.repeat(64), 'input.laneId': 'mac'})
    expect(lookup.projections).toEqual([{requestId: 1}])
    expect(lookup.settings).toEqual(['primary', 'majority', {timeoutMS: 10000}])
    const heartbeat = runningSnapshot(2), observedAt = '2026-10-03T01:00:15Z'
    heartbeat.observedAt = observedAt; heartbeat.lanes[0]!.progress.observedAt = observedAt
    f.advance(15000); await f.service.report(heartbeat, 'mini')
    expect((await f.service.get('mini'))!.lanes[0]!.progress).toMatchObject({observedAt, lastProgressAt: first.lanes[0]!.progress.lastProgressAt})
    await f.service.report({...snapshot(1, 3), observedAt}, 'mini')
    expect((await f.service.get('mini'))!.lanes[0]!.progress).toBeUndefined()
    expect(lookup.queries).toHaveLength(2)
  } finally {lookup.stop(); f.stop()}
})

test('live progress rejects stale custody, private fields, inconsistent counts and a different host observation', () => {
  const original = runningSnapshot()
  expect(hostStateSchema.safeParse(original).success).toBe(true)
  const invalid: Array<(value: ReturnType<typeof runningSnapshot>) => void> = [
    value => {value.lanes[0]!.state = 'idle'},
    value => {value.lanes[0]!.activity.owner.id = 'different-run'},
    value => {value.lanes[0]!.activity.generation++},
    value => {value.lanes[0]!.progress.ownerGeneration++},
    value => {value.lanes[0]!.progress.controllerIncarnation = 'previous-controller'},
    value => {value.lanes[0]!.progress.sequence++},
    value => {value.lanes[0]!.progress.observedAt = '2026-10-03T01:00:01Z'},
    value => {value.lanes[0]!.progress.requestDigest = 'bad'},
    value => {value.lanes[0]!.progress.completedSteps = 4},
    value => {value.lanes[0]!.progress.currentStep.index = 3},
    value => {value.lanes[0]!.progress.phase = 'framework-teardown'},
    value => {value.lanes[0]!.progress.lastProgressAt = '2026-10-03T00:57:00Z'},
    value => {value.lanes[0]!.progress.lastProgressAt = '2026-10-03T01:00:01Z'},
    value => {Object.assign(value.lanes[0]!.progress, {privateError: 'private phone data'})},
    value => {Object.assign(value.lanes[0]!.progress.currentStep, {name: 'private step name'})},
    value => {value.lanes[0]!.progress.currentStep.id = '/private/path'},
  ]
  for (const change of invalid) {const value = structuredClone(original); change(value); expect(hostStateSchema.safeParse(value).success).toBe(false)}
  const author = structuredClone(original)
  Object.assign(author.lanes[0]!.activity.owner, {kind: 'authoring'}); delete (author.lanes[0]!.activity.owner as Record<string, unknown>).requestId
  expect(hostStateSchema.safeParse(author).success).toBe(false)
  const preparation = structuredClone(original)
  Object.assign(preparation.lanes[0]!.progress, {phase: 'preparation', completedSteps: 0, totalSteps: 0})
  delete (preparation.lanes[0]!.progress as Record<string, unknown>).currentStep
  expect(hostStateSchema.safeParse(preparation).success).toBe(true)
})

test('unrecognized accepted request or digest cannot update the host or another lane', async () => {
  const f = fixture(), lookup = acceptedRequestLookup(false)
  try {
    await f.service.report(snapshot(1, 1), 'mini')
    for (const requestDigest of ['a'.repeat(64), 'b'.repeat(64)]) {
      const value = runningSnapshot(2); value.lanes[0]!.progress.requestDigest = requestDigest
      await expect(f.service.report(value, 'mini')).rejects.toThrow('authenticated accepted request')
    }
    expect(f.writes()).toBe(1)
    expect((await f.service.get('mini'))!.lanes[0]!.progress).toBeUndefined()
    expect(lookup.queries.map(query => query.inputSha256)).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    await expect(f.service.report(runningSnapshot(2), 'another-host')).rejects.toThrow('authenticated controller')
    expect(lookup.queries).toHaveLength(2)
  } finally {lookup.stop(); f.stop()}
})

test('actual host-state HTTP admission distinguishes malformed progress, missing accepted request and authenticated observation', async () => {
  const f = fixture(), lookup = acceptedRequestLookup()
  try {
    const token = 'host-test-credential'.repeat(3), api = createTestHostStateApi(f.service, () => JSON.stringify({mini: token}))
    const post = (value: unknown, credential = token) => api.request('/', {method: 'POST',
      headers: {Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json'}, body: JSON.stringify(value)})
    expect((await post(runningSnapshot())).status).toBe(200)
    const malformed = runningSnapshot(2); Object.assign(malformed.lanes[0]!.progress, {rawError: 'private device text'})
    expect((await post(malformed)).status).toBe(400)
    expect((await post({...runningSnapshot(2), hostId: 'other-host'})).status).toBe(409)
    expect((await post(runningSnapshot(2), 'wrong-credential')).status).toBe(401)
    expect(f.writes()).toBe(1); expect(lookup.queries).toHaveLength(1)
  } finally {lookup.stop(); f.stop()}
  const missing = fixture(), refused = acceptedRequestLookup(false)
  try {
    const token = 'host-test-credential'.repeat(3), api = createTestHostStateApi(missing.service, () => JSON.stringify({mini: token}))
    const response = await api.request('/', {method: 'POST', headers: {Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'}, body: JSON.stringify(runningSnapshot())})
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({error: 'host_state_conflict', message: 'Routine progress differs from its authenticated accepted request'})
    expect(missing.writes()).toBe(0)
  } finally {refused.stop(); missing.stop()}
})

test("server receipt freshness is independent of clocks and duplicates cannot extend it", async () => {
  const f = fixture()
  try {
    await f.service.report(snapshot(1, 1, "2026-10-04T01:00:00Z"), "mini")
    const first = (await f.service.get("mini"))!
    expect(first.receivedAt).toBe("2026-10-03T01:00:00.000Z")
    f.advance(180000)
    await f.service.report(snapshot(1, 1, "2026-10-05T01:00:00Z"), "mini")
    expect((await f.service.get("mini"))!.receivedAt).toBe(first.receivedAt)
    expect(f.writes()).toBe(1)
    await f.service.report(snapshot(1, 2, "2026-10-02T01:00:00Z"), "mini")
    expect((await f.service.get("mini"))!.receivedAt).toBe("2026-10-03T01:03:00.000Z")
  } finally {
    f.stop()
  }
})

test("durable generations order restarts and reject delayed unseen old incarnations", async () => {
  const f = fixture()
  try {
    await f.service.report(snapshot(2, 10, "2026-10-04T01:00:00Z"), "mini")
    f.advance(1000)
    await f.service.report(snapshot(3, 1, "2026-10-02T01:00:00Z"), "mini")
    const restarted = (await f.service.get("mini"))!
    expect(restarted.incarnationGeneration).toBe(3)
    expect(restarted.sequence).toBe(1)
    f.advance(10000)
    await f.service.report(snapshot(1, 999, "2026-10-06T01:00:00Z", "previously-unseen-old-boot"), "mini")
    expect(await f.service.get("mini")).toEqual(restarted)
    await expect(
      f.service.report(snapshot(3, 2, "2026-10-03T01:00:00Z", "different-same-generation"), "mini"),
    ).rejects.toThrow("another process")
    expect(f.writes()).toBe(2)
  } finally {
    f.stop()
  }
})

test("concurrent generation replacement rereads the loser without overwriting the winning snapshot", async () => {
  const f = fixture()
  try {
    await f.service.report(snapshot(1, 1), "mini")
    const results = await Promise.allSettled([
      f.service.report(snapshot(3, 1), "mini"),
      f.service.report(snapshot(2, 1), "mini"),
    ])
    expect(results.map((item) => item.status)).toEqual(["fulfilled", "fulfilled"])
    expect((await f.service.get("mini"))!.incarnationGeneration).toBe(3)
    expect((await f.service.report(snapshot(2, 1), "mini")).incarnationGeneration).toBe(3)
    expect(f.writes()).toBe(2)
  } finally {
    f.stop()
  }
})

test("host snapshots persist optional strict per-lane exact-definition availability without changing other lanes", async () => {
  const f = fixture()
  try {
    const source = snapshot(1, 1),
      definitionRevision = "a".repeat(40)
    const availability = {
      routineId: "arbitrary-product",
      definitionRevision,
      available: false,
      reason: "Selected source is unavailable on this lane.",
    }
    const reported = {
      ...source,
      lanes: [
        {...source.lanes[0], routineAvailability: [availability]},
        {...source.lanes[0], id: "other", routineAvailability: [{...availability, available: true, reason: undefined}]},
      ],
    }
    await f.service.report(reported, "mini")
    expect((await f.service.get("mini"))!.lanes.map((lane) => lane.routineAvailability?.[0]?.available)).toEqual([
      false,
      true,
    ])
    for (const bad of [
      {...availability, available: "yes"},
      {...availability, definitionRevision: "bad"},
      {...availability, unsupported: true},
    ])
      await expect(
        f.service.report({...source, sequence: 2, lanes: [{...source.lanes[0], routineAvailability: [bad]}]}, "mini"),
      ).rejects.toThrow()
    await expect(
      f.service.report(
        {...source, sequence: 2, lanes: [{...source.lanes[0], routineAvailability: [availability, availability]}]},
        "mini",
      ),
    ).rejects.toThrow("Duplicate lane")
    expect(f.writes()).toBe(1)
  } finally {
    f.stop()
  }
})

test("authenticated host snapshots persist physical model inventory and reject conflicting updates", async () => {
  const f = fixture()
  try {
    const source = snapshot(1, 1),
      glasses = {resourceId: "live-resource", deviceId: "live-cid", model: "mentra-live", capabilities: ["camera"]}
    const lane = {...source.lanes[0], resources: [{id: "live-resource", kind: "glasses"}], glasses: [glasses]}
    await f.service.report({...source, lanes: [lane]}, "mini")
    expect((await f.service.get("mini"))!.lanes[0]!.glasses).toEqual([glasses])
    await expect(
      f.service.report(
        {...source, sequence: 2, lanes: [{...lane, glasses: [{...glasses, resourceId: "foreign"}]}]},
        "mini",
      ),
    ).rejects.toThrow("declared glasses resources")
    expect(f.writes()).toBe(1)
  } finally {
    f.stop()
  }
})

test("optional restoration history survives controller restart with explicit unknown fields", async () => {
  const f = fixture()
  try {
    const restoration = {schemaVersion: 1 as const, attempts: [], truncated: true}
    await f.service.report({...snapshot(1, 1), restoration}, "mini")
    expect((await f.service.get("mini"))!.restoration).toEqual(restoration)
    await f.service.report({...snapshot(2, 1), restoration}, "mini")
    expect((await f.service.get("mini"))!.restoration).toEqual(restoration)
  } finally {
    f.stop()
  }
})

const binding = (version: number) => ({
  version,
  revision: version.toString(16).padStart(40, "0"),
  installationId: `release-${version}`,
  configurationSha256: "a".repeat(64),
  runtimeSha256: "b".repeat(64),
  routineApiVersion: 7,
  publicApiSha256: "c".repeat(64),
})
const accepted = (generation: number, sequence: number, version: number = generation) => ({
  ...snapshot(generation, sequence),
  frameworkBinding: binding(version),
  frameworkAcceptedAt: `2026-10-03T01:00:${String(generation).padStart(2, "0")}Z`,
  frameworkProcess: {pid: 100 + generation, startedAt: `process-${generation}`},
})
const observation = (sequence: number, extra: Record<string, unknown> = {}) => ({
  hostId: "mini",
  producer: "framework-updater",
  generation: 1,
  sequence,
  deployment: {
    phase: "waiting",
    observedAt: "2026-10-03T01:00:00Z",
    desiredTarget: binding(2),
    consumers: [],
    nextAction: "Wait for active executor",
  },
  ...extra,
})

for (const updaterFirst of [true, false]) {
  test(`independent controller and updater observations survive CAS contention (${updaterFirst ? 'updater' : 'controller'} wins)`, async () => {
    const f = fixture()
    try {
      await f.service.report(accepted(1, 1), 'mini')
      const updater = () => f.service.reportDeployment(observation(1), 'mini')
      const controller = () => f.service.report(accepted(1, 2), 'mini')
      const receipts = await Promise.all(updaterFirst ? [updater(), controller()] : [controller(), updater()])
      expect(receipts).toHaveLength(2)
      expect(f.row()).toMatchObject({sequence: 2, deploymentGeneration: 1, deploymentSequence: 1,
        deploymentObservation: observation(1).deployment, snapshot: accepted(1, 2)})
      expect(f.row().frameworkHistory).toHaveLength(1)
      expect(f.writes()).toBe(3)
      expect(f.writeAttempts()).toBe(4)
    } finally {f.stop()}
  })
}

test('a competing controller cannot claim an enrolled generation after a CAS miss', async () => {
  const f = fixture()
  try {
    await f.service.report(accepted(1, 1), 'mini')
    const results = await Promise.allSettled([
      f.service.report(accepted(2, 1), 'mini'),
      f.service.report({...accepted(2, 1), incarnation: 'competing-process'}, 'mini'),
    ])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
    expect((results[1] as PromiseRejectedResult).reason.message).toContain('another process')
    expect(f.row().incarnation).toBe('boot-2')
    expect(f.row().frameworkHistory.map((value: any) => value.incarnation)).toEqual(['boot-1', 'boot-2'])
    expect(f.writes()).toBe(2)
  } finally {f.stop()}
})

for (const competingGeneration of [2, 3]) {
  test(`initial host creation cannot overwrite the concurrent winner (generation ${competingGeneration})`, async () => {
    const f = fixture()
    try {
      const results = await Promise.allSettled([
        f.service.report(accepted(3, 1), 'mini'),
        f.service.report({...accepted(competingGeneration, 1), incarnation: 'competing-process'}, 'mini'),
      ])
      expect(results[0].status).toBe('fulfilled')
      if (competingGeneration === 3) {
        expect(results[1].status).toBe('rejected')
        expect((results[1] as PromiseRejectedResult).reason.message).toContain('another process')
      } else expect(results[1]).toMatchObject({status: 'fulfilled', value: {incarnation: 'boot-3', incarnationGeneration: 3}})
      expect(f.row().incarnation).toBe('boot-3')
      expect(f.row().frameworkHistory).toHaveLength(1)
      expect(f.writes()).toBe(1)
    } finally {f.stop()}
  })
}

test('a stop that wins against its own controller heartbeat remains a semantic conflict after retry', async () => {
  const f = fixture()
  try {
    await f.service.report(accepted(1, 1), 'mini')
    const stopped = {installationId: 'release-1', process: accepted(1, 1).frameworkProcess,
      observedAt: '2026-10-03T01:00:02Z'}
    const results = await Promise.allSettled([
      f.service.reportDeployment(observation(1, {stopped}), 'mini'),
      f.service.report(accepted(1, 2), 'mini'),
    ])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
    expect((results[1] as PromiseRejectedResult).reason.message).toContain('observed stopped')
    expect(f.row().sequence).toBe(1)
    expect(f.row().frameworkHistory).toHaveLength(1)
    expect(f.row().frameworkHistory[0]).toMatchObject({endedAt: stopped.observedAt, endReason: 'observed-stop'})
    expect(f.row().frameworkStopReceipts).toEqual([stopped])
    expect(f.writes()).toBe(2)
  } finally {f.stop()}
})

for (const producer of ['controller', 'updater'] as const) {
  test(`${producer} atomic collisions exhaust three attempts while unrelated database errors do not retry`, async () => {
    const f = fixture()
    try {
      await f.service.report(accepted(1, 1), 'mini')
      const write = () => producer === 'controller'
        ? f.service.report(accepted(1, 2), 'mini') : f.service.reportDeployment(observation(1), 'mini')
      const reads = f.reads(), attempts = f.writeAttempts()
      f.failWrites(3)
      await expect(write()).rejects.toThrow('advanced concurrently')
      expect(f.reads() - reads).toBe(3)
      expect(f.writeAttempts() - attempts).toBe(3)
      expect(f.writes()).toBe(1)
      for (const code of [50, 11000]) {
        const error = Object.assign(new Error('Unexpected database failure'), {code})
        const before = f.writeAttempts()
        f.beforeWrite(() => {throw error})
        await expect(write()).rejects.toBe(error)
        expect(f.writeAttempts() - before).toBe(1)
      }
    } finally {f.stop()}
  })
}

test('initial unique-host collisions exhaust the same three-attempt bound', async () => {
  const f = fixture()
  try {
    f.beforeWrite(() => {throw Object.assign(new Error('Duplicate host identity'), {code: 11000})})
    await expect(f.service.report(accepted(1, 1), 'mini')).rejects.toThrow('advanced concurrently')
    expect(f.reads()).toBe(3)
    expect(f.writeAttempts()).toBe(3)
    expect(f.writes()).toBe(0)
  } finally {f.stop()}
})

test('history reconciliation on repeated CAS misses preserves the exact reported input', async () => {
  const f = fixture()
  try {
    await f.service.report(accepted(3, 1), 'mini')
    const stopped = {installationId: 'release-1', process: accepted(1, 1).frameworkProcess,
      observedAt: '2026-10-03T01:00:01.500Z'}
    await f.service.reportDeployment(observation(1, {stopped}), 'mini')
    const input = {...accepted(3, 2), frameworkHistory: [{binding: binding(1), incarnation: 'boot-1',
      incarnationGeneration: 1, process: accepted(1, 1).frameworkProcess,
      effectiveAt: accepted(1, 1).frameworkAcceptedAt, observedAt: accepted(1, 1).observedAt,
      endedAt: accepted(3, 1).frameworkAcceptedAt, endReason: 'accepted-replacement'}]}
    const original = structuredClone(input)
    f.failWrites(2)
    await f.service.report(input, 'mini')
    expect(input).toEqual(original)
    expect(f.row().snapshot.frameworkHistory).toEqual(original.frameworkHistory)
    expect(f.row().frameworkHistory).toHaveLength(2)
    expect(f.row().frameworkHistory[0]).toMatchObject({endedAt: stopped.observedAt, endReason: 'observed-stop'})
    expect(f.row().deploymentSequence).toBe(1)
    expect(f.row().frameworkStopReceipts).toEqual([stopped])
  } finally {f.stop()}
})

test('actual HTTP host-state API resolves updater CAS contention but preserves semantic and exhausted conflicts', async () => {
  const f = fixture()
  const token = 'synthetic-cas-test-' + 'x'.repeat(32)
  const api = createTestHostStateApi(f.service, () => JSON.stringify({mini: token}))
  const post = (body: unknown) => api.request('/', {method: 'POST',
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body)})
  try {
    expect((await post(accepted(1, 1))).status).toBe(200)
    f.beforeWrite(async () => {f.beforeWrite(undefined); await f.service.reportDeployment(observation(1), 'mini')})
    expect((await post(accepted(1, 2))).status).toBe(200)
    expect(f.row()).toMatchObject({sequence: 2, deploymentSequence: 1})
    expect(f.row().frameworkHistory).toHaveLength(1)
    const semantic = await post({...accepted(1, 3), incarnation: 'competing-process'})
    expect(semantic.status).toBe(409)
    expect(await semantic.json()).toEqual({error: 'host_state_conflict', message: 'Controller incarnation generation belongs to another process'})
    f.failWrites(3)
    const exhausted = await post(accepted(1, 3))
    expect(exhausted.status).toBe(409)
    expect(await exhausted.json()).toEqual({error: 'host_state_conflict', message: 'Controller snapshot advanced concurrently; retry current observation'})
    f.beforeWrite(() => {throw new Error('Database unavailable')})
    const unavailable = await post(accepted(1, 3))
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({error: 'host_state_unavailable'})
  } finally {f.stop()}
})

test("accepted framework intervals preserve exact source and process across controller observations and replacement", async () => {
  const f = fixture()
  try {
    await f.service.report(accepted(1, 1), "mini")
    await f.service.report(accepted(1, 2), "mini")
    expect(f.row().frameworkHistory).toHaveLength(1)
    await expect(f.service.report({...accepted(1, 3), frameworkBinding: binding(2)}, "mini")).rejects.toThrow(
      "cannot change",
    )
    await expect(
      f.service.report({...accepted(1, 3), frameworkProcess: {pid: 999, startedAt: "foreign"}}, "mini"),
    ).rejects.toThrow("identity changed")
    await f.service.report(accepted(2, 1), "mini")
    expect((await f.service.get("mini"))!.frameworkHistory).toMatchObject([
      {
        binding: binding(1),
        incarnation: "boot-1",
        process: {pid: 101, startedAt: "process-1"},
        endReason: "accepted-replacement",
        endedAt: accepted(2, 1).frameworkAcceptedAt,
      },
      {binding: binding(2), incarnation: "boot-2", effectiveAt: accepted(2, 1).frameworkAcceptedAt},
    ])
  } finally {
    f.stop()
  }
})
test("updater progress has an independent ordered cursor and cannot assert or replace accepted framework", async () => {
  const f = fixture()
  try {
    await f.service.report(accepted(2, 1), "mini")
    const before = (await f.service.get("mini"))!.frameworkBinding
    await f.service.reportDeployment(observation(10), "mini")
    const received = f.row().deploymentReceivedAt
    f.advance(1000)
    await f.service.reportDeployment(
      observation(9, {deployment: {...observation(1).deployment, phase: "failed"}}),
      "mini",
    )
    expect(f.row().deploymentReceivedAt).toEqual(received)
    expect(f.row().deploymentObservation.phase).toBe("waiting")
    await f.service.report(
      {
        ...accepted(2, 2),
        deployment: {...observation(1).deployment, phase: "idle", observedAt: "2027-01-01T00:00:00Z"},
      },
      "mini",
    )
    expect((await f.service.get("mini"))!.frameworkBinding).toEqual(before)
    expect(f.row().deploymentSequence).toBe(10)
    await expect(f.service.reportDeployment(observation(11, {frameworkBinding: binding(3)}), "mini")).rejects.toThrow()
    await expect(f.service.reportDeployment(observation(11, {hostId: "foreign"}), "mini")).rejects.toThrow(
      "authenticated host",
    )
  } finally {
    f.stop()
  }
})
test("only exact observed old process closes its interval and delayed controller cannot revive it", async () => {
  const f = fixture()
  try {
    await f.service.report(accepted(1, 1), "mini")
    const stopped = {
      installationId: "release-1",
      process: {pid: 101, startedAt: "process-1"},
      observedAt: "2026-10-03T01:00:02Z",
    }
    await f.service.reportDeployment(
      observation(1, {stopped: {...stopped, process: {pid: 101, startedAt: "reused-pid"}}}),
      "mini",
    )
    expect(f.row().frameworkHistory[0].endedAt).toBeUndefined()
    await f.service.reportDeployment(observation(2, {stopped}), "mini")
    expect(f.row().frameworkHistory[0]).toMatchObject({endedAt: stopped.observedAt, endReason: "observed-stop"})
    await expect(f.service.report(accepted(1, 2), "mini")).rejects.toThrow("observed stopped")
    await f.service.report(accepted(3, 1), "mini")
    await f.service.reportDeployment(observation(3, {stopped}), "mini")
    expect(f.row().frameworkHistory.at(-1).endedAt).toBeUndefined()
    const delayed = {
      installationId: "release-3",
      process: {pid: 103, startedAt: "process-3"},
      observedAt: "2026-10-03T01:00:03.500Z",
    }
    await f.service.report(accepted(4, 1), "mini")
    await f.service.reportDeployment(observation(4, {stopped: delayed}), "mini")
    expect(f.row().frameworkHistory.find((value: any) => value.binding.version === 3)).toMatchObject({
      endedAt: delayed.observedAt,
      endReason: "observed-stop",
    })
    expect(f.row().frameworkHistory.at(-1).endedAt).toBeUndefined()
  } finally {
    f.stop()
  }
})
test("controller and updater history writes use one row CAS instead of losing observed stop", async () => {
  const f = fixture()
  try {
    await f.service.report(accepted(1, 1), "mini")
    const results = await Promise.allSettled([
      f.service.reportDeployment(
        observation(1, {
          stopped: {
            installationId: "release-1",
            process: {pid: 101, startedAt: "process-1"},
            observedAt: "2026-10-03T01:00:02Z",
          },
        }),
        "mini",
      ),
      f.service.report(accepted(2, 1), "mini"),
    ])
    expect(results.map((value) => value.status)).toEqual(["fulfilled", "fulfilled"])
    expect(f.row().frameworkHistory[0].endReason).toBe("observed-stop")
    expect(f.row().frameworkHistory).toHaveLength(2)
    expect(f.row().frameworkHistory.at(-1).endedAt).toBeUndefined()
    expect(f.row().frameworkStopReceipts).toHaveLength(1)
  } finally {
    f.stop()
  }
})
test('stop received before delayed startup is retained and closes the subsequently accepted exact process', async () => {
  const f = fixture()
  try {
    await f.service.report(snapshot(1, 1), 'mini')
    const stopped = {installationId: 'release-1', process: accepted(1, 1).frameworkProcess, observedAt: '2026-10-03T01:00:02Z'}
    await f.service.reportDeployment(observation(1, {stopped}), 'mini')
    expect(f.row().frameworkHistory).toEqual([])
    expect(f.row().frameworkStopReceipts).toEqual([stopped])
    await f.service.report(accepted(1, 2), 'mini')
    expect((await f.service.get('mini'))!.frameworkHistory).toMatchObject([
      {binding: binding(1), endedAt: stopped.observedAt, endReason: 'observed-stop'},
    ])
    await expect(f.service.report(accepted(1, 3), 'mini')).rejects.toThrow('observed stopped')
    await f.service.reportDeployment(observation(2, {stopped}), 'mini')
    expect(f.row().frameworkStopReceipts).toHaveLength(1)
  } finally {f.stop()}
})
test('unmatched stop receipt reconciles delayed offline history without closing a reused PID or current framework', async () => {
  const f = fixture()
  try {
    await f.service.report(accepted(3, 1), 'mini')
    const stopped = {installationId: 'release-1', process: accepted(1, 1).frameworkProcess, observedAt: '2026-10-03T01:00:01.500Z'}
    await f.service.reportDeployment(observation(1, {stopped}), 'mini')
    await f.service.reportDeployment(observation(2, {stopped: {installationId: 'release-3',
      process: {...accepted(3, 1).frameworkProcess, startedAt: 'reused-pid'}, observedAt: '2026-10-03T01:00:04Z'}}), 'mini')
    const interval = {binding: binding(1), incarnation: 'boot-1', incarnationGeneration: 1,
      process: accepted(1, 1).frameworkProcess, effectiveAt: accepted(1, 1).frameworkAcceptedAt,
      observedAt: accepted(1, 1).frameworkAcceptedAt, endedAt: accepted(3, 1).frameworkAcceptedAt, endReason: 'accepted-replacement'}
    await f.service.report({...accepted(3, 2), frameworkHistory: [interval]}, 'mini')
    expect(f.row().frameworkHistory.find((value: any) => value.incarnation === 'boot-1')).toMatchObject({
      endedAt: stopped.observedAt, endReason: 'observed-stop',
    })
    expect(f.row().frameworkHistory.at(-1).endedAt).toBeUndefined()
  } finally {f.stop()}
})
test('unmatched observed stop receipts retain a bounded recent history', async () => {
  const f = fixture()
  try {
    await f.service.report(snapshot(1, 1), 'mini')
    for (let version = 1; version <= 105; version++)
      await f.service.reportDeployment(observation(version, {stopped: {installationId: `release-${version}`,
        process: {pid: version + 100, startedAt: `process-${version}`}, observedAt: '2026-10-03T01:00:02Z'}}), 'mini')
    expect(f.row().frameworkStopReceipts).toHaveLength(100)
    expect(f.row().frameworkStopReceipts[0].installationId).toBe('release-6')
    expect(f.row().frameworkStopReceipts.at(-1).installationId).toBe('release-105')
  } finally {f.stop()}
})
test('startup winning the shared CAS forces stop retry, which preserves the same exact ending', async () => {
  const f = fixture()
  try {
    await f.service.report(snapshot(1, 1), 'mini')
    const stopped = {installationId: 'release-1', process: accepted(1, 1).frameworkProcess, observedAt: '2026-10-03T01:00:02Z'}
    const results = await Promise.allSettled([
      f.service.report(accepted(1, 2), 'mini'),
      f.service.reportDeployment(observation(1, {stopped}), 'mini'),
    ])
    expect(results.map(value => value.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(f.row().frameworkHistory[0]).toMatchObject({endedAt: stopped.observedAt, endReason: 'observed-stop'})
    expect(f.row().frameworkStopReceipts).toEqual([stopped])
  } finally {f.stop()}
})
for (const stopFirst of [false, true]) for (const withHistory of [false, true]) {
  test(`stop reconciles the latest applicable incarnation of a shared framework process (${stopFirst ? 'stop' : 'startup'} first, history=${withHistory})`, async () => {
    const f = fixture()
    try {
      await f.service.report(accepted(1, 1), 'mini')
      const shared = {...accepted(2, 1), frameworkBinding: binding(1), frameworkProcess: accepted(1, 1).frameworkProcess}
      const stopped = {installationId: 'release-1', process: shared.frameworkProcess, observedAt: '2026-10-03T01:00:03Z'}
      if (stopFirst) await f.service.reportDeployment(observation(1, {stopped}), 'mini')
      await f.service.report({...shared, ...(withHistory ? {frameworkHistory: [
        {binding: binding(1), incarnation: 'boot-1', incarnationGeneration: 1, process: shared.frameworkProcess,
          effectiveAt: accepted(1, 1).frameworkAcceptedAt, observedAt: accepted(1, 1).observedAt,
          endedAt: shared.frameworkAcceptedAt, endReason: 'accepted-replacement'},
        {binding: binding(1), incarnation: 'boot-2', incarnationGeneration: 2, process: shared.frameworkProcess,
          effectiveAt: shared.frameworkAcceptedAt, observedAt: shared.observedAt},
      ]} : {})}, 'mini')
      if (!stopFirst) await f.service.reportDeployment(observation(1, {stopped}), 'mini')
      const history = (await f.service.get('mini'))!.frameworkHistory!
      expect(history[0]).toMatchObject({incarnation: 'boot-1', endedAt: shared.frameworkAcceptedAt, endReason: 'accepted-replacement'})
      expect(history[1]).toMatchObject({incarnation: 'boot-2', endedAt: stopped.observedAt, endReason: 'observed-stop'})
    } finally {f.stop()}
  })
}
test("compact installation history caps accepted intervals without discarding current identity", async () => {
  const f = fixture()
  try {
    for (let generation = 1; generation <= 105; generation++)
      await f.service.report(
        {
          ...accepted(generation, 1),
          frameworkAcceptedAt: new Date(Date.parse("2026-10-03T01:00:00Z") + generation * 1000).toISOString(),
        },
        "mini",
      )
    expect(f.row().frameworkHistory).toHaveLength(100)
    expect(f.row().frameworkHistory[0].binding.version).toBe(6)
    expect(f.row().frameworkHistory.at(-1).binding.version).toBe(105)
  } finally {
    f.stop()
  }
})
test("offline accepted intervals merge idempotently without relabeling current or overriding observed stop", async () => {
  const f = fixture()
  try {
    await f.service.report(accepted(1, 1), "mini")
    const interval = (generation: number) => ({
      binding: binding(generation),
      incarnation: `boot-${generation}`,
      incarnationGeneration: generation,
      process: accepted(generation, 1).frameworkProcess,
      effectiveAt: accepted(generation, 1).frameworkAcceptedAt,
      observedAt: accepted(generation, 1).frameworkAcceptedAt,
      ...(generation < 3
        ? {endedAt: accepted(generation + 1, 1).frameworkAcceptedAt, endReason: "accepted-replacement"}
        : {}),
    })
    const offline = {...accepted(3, 1), frameworkHistory: [interval(1), interval(2), interval(3)]}
    await f.service.report(offline, "mini")
    await f.service.report({...offline, sequence: 2}, "mini")
    expect(f.row().frameworkHistory.map((value: any) => value.binding.version)).toEqual([1, 2, 3])
    expect((await f.service.get("mini"))!.frameworkBinding?.version).toBe(3)
    await expect(
      f.service.report({...offline, sequence: 3, frameworkHistory: [{...interval(2), binding: binding(99)}]}, "mini"),
    ).rejects.toThrow("changed accepted identity")
    await expect(f.service.report({...offline, sequence: 3, frameworkHistory: [interval(4)]}, "mini")).rejects.toThrow(
      "future",
    )
  } finally {
    f.stop()
  }
})
