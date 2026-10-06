import {expect, spyOn, test} from "bun:test"
import {TestHostStateModel} from "../models/test-host-state.model"
import {TestHostStateService} from "./test-host-state.service"

function fixture() {
  let row: Record<string, any> | null = null,
    now = Date.parse("2026-10-03T01:00:00Z"),
    writes = 0
  const find = spyOn(TestHostStateModel, "findOne").mockImplementation((() => ({
    lean: async () => row && {...row},
  })) as any)
  const update = spyOn(TestHostStateModel, "findOneAndUpdate").mockImplementation(((
    filter: Record<string, unknown>,
    change: {$set: Record<string, any>},
    options: {upsert: boolean},
  ) => ({
    lean: async () => {
      if (
        row &&
        Object.entries(filter).some(([key, value]) =>
          typeof value === "object" && value !== null && "$exists" in value
            ? (row![key] !== undefined) !== (value as {$exists: boolean}).$exists
            : row![key] !== value,
        )
      )
        return null
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

test("concurrent generation replacement fences the losing snapshot and retry cannot overwrite it", async () => {
  const f = fixture()
  try {
    await f.service.report(snapshot(1, 1), "mini")
    const results = await Promise.allSettled([
      f.service.report(snapshot(3, 1), "mini"),
      f.service.report(snapshot(2, 1), "mini"),
    ])
    expect(results.map((item) => item.status)).toEqual(["fulfilled", "rejected"])
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
    expect(results.map((value) => value.status)).toEqual(["fulfilled", "rejected"])
    expect(f.row().frameworkHistory[0].endReason).toBe("observed-stop")
    await f.service.report(accepted(2, 1), "mini")
    expect(f.row().frameworkHistory).toHaveLength(2)
  } finally {
    f.stop()
  }
})
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
