import {expect, test} from "bun:test";
import {laneRestorationProjectionSchema, type LaneRestorationAttempt} from "../types/lane-restoration.types";
import {hostStateSchema} from "./test-host-state.service";
import {LaneRestorationService, laneOverviewFields, MongoLaneRestorationRepository} from "./lane-restoration.service";
import {TestHostStateModel} from '../models/test-host-state.model';

const at = "2026-10-05T01:00:00Z";
const attempt: LaneRestorationAttempt = {executionId: "fixer:first", interruptionId: "repair:mac:1", laneId: "mac", generation: 1,
  current: true, state: "working", assignedAt: at, handedOffAt: at, startedAt: at, finishedAt: null, report: null,
  resume: {status: "unknown", decisionId: null, calledAt: null, reason: null}, requiredAction: null, actions: [], actionsTruncated: false,
  requestId: null, runId: null, incidentId: null, sessionId: null};
const snapshot = {hostId: "mini", incarnation: "boot", incarnationGeneration: 1, sequence: 1, observedAt: at,
  lanes: [{id: "mac", platform: "ios-on-mac", state: "in-repair", dispatchMode: "automatic", resources: []}]};

test("restoration read preserves real receipts and missing history without consulting incident prose", async () => {
  const restored = {...attempt, state: "resumed", current: false, finishedAt: "2026-10-05T01:02:00Z",
    resume: {status: "accepted", decisionId: "resume:one", calledAt: "2026-10-05T01:01:50Z", reason: null}};
  const result = await new LaneRestorationService({async overview() {return []}, async list(limit) {
    expect(limit).toBe(33);
    return [{snapshot, receivedAt: new Date(at)}, {snapshot: {...snapshot, hostId: "second",
      restoration: {schemaVersion: 1, attempts: [restored], truncated: true}}, receivedAt: new Date(at)}];
  }}, () => Date.parse(at)).list();
  expect(result.hosts[0].restoration).toBeNull();
  expect(result.hosts[1].restoration).toMatchObject({truncated: true, attempts: [{resume: {status: "accepted", calledAt: restored.resume.calledAt}}]});
  expect(result.hosts[1].lanes[0]).toEqual({id: "mac", platform: "ios-on-mac", state: "in-repair", dispatchMode: "automatic"});
});

test("strict restoration projection rejects invented success, foreign lane and reordered times", () => {
  expect(laneRestorationProjectionSchema.safeParse({schemaVersion: 1, attempts: [{...attempt, state: "resumed"}], truncated: false}).success).toBe(false);
  expect(laneRestorationProjectionSchema.safeParse({schemaVersion: 1, attempts: [{...attempt,
    resume: {status: "accepted", decisionId: "resume:one", calledAt: null, reason: null}}], truncated: false}).success).toBe(false);
  expect(hostStateSchema.safeParse({...snapshot, restoration: {schemaVersion: 1, attempts: [{...attempt, laneId: "foreign"}], truncated: false}}).success).toBe(false);
  expect(laneRestorationProjectionSchema.safeParse({schemaVersion: 1, attempts: [{...attempt, finishedAt: "2026-10-04T01:00:00Z"}], truncated: false}).success).toBe(false);
  expect(laneRestorationProjectionSchema.safeParse({schemaVersion: 1, attempts: [attempt, attempt], truncated: false}).success).toBe(false);
});

test('lane health projects every enrolled lane, physical models and exact current custody without private device details', async () => {
  const reported = {
    ...snapshot,
    lanes: [{...snapshot.lanes[0], id: 'lane:new-mac', state: 'running',
      resources: [{id: 'glasses-resource', kind: 'glasses'}],
      glasses: [{resourceId: 'glasses-resource', deviceId: 'private-device-serial', model: 'mentra-live', capabilities: ['camera']}],
      activity: {generation: 7, owner: {id: 'request:actual', kind: 'run', requestId: 'request:actual'}}},
      {...snapshot.lanes[0], id: 'lane:new-android', platform: 'android', state: 'reserved', glasses: [],
        activity: {generation: 8, owner: {id: 'reservation:held', kind: 'authoring'}}}],
  }
  const result = await new LaneRestorationService({async overview() {return []}, async list() {return [{snapshot: reported, receivedAt: new Date(at)}]}}).list()
  expect(result.hosts[0].lanes.map(lane => lane.id)).toEqual(['lane:new-mac', 'lane:new-android'])
  expect(result.hosts[0].lanes[0]).toMatchObject({glassesModels: ['mentra-live'],
    activity: {generation: 7, owner: {id: 'request:actual', kind: 'run', requestId: 'request:actual'}}})
  expect(result.hosts[0].lanes[1]).toMatchObject({glassesModels: [], activity: {owner: {kind: 'authoring'}}})
  expect(JSON.stringify(result)).not.toContain('private-device-serial')
  expect(JSON.stringify(result)).not.toContain('glasses-resource')
  for (const changed of [
    {...reported.lanes[0], activity: {generation: 7, owner: {id: 'request:actual', kind: 'run', requestId: 'foreign'}}},
    {...reported.lanes[0], state: 'idle'},
    {...reported.lanes[1], activity: {generation: 8, owner: {id: 'reservation:held', kind: 'authoring', requestId: 'request:actual'}}},
  ]) expect(hostStateSchema.safeParse({...reported, lanes: [changed]}).success).toBe(false)
})

test("bounded restoration hosts disclose truncation and malformed stored evidence fails closed", async () => {
  const service = new LaneRestorationService({async overview() {return []}, async list() {return Array.from({length: 33}, (_, index) =>
    ({snapshot: {...snapshot, hostId: `host-${index}`}, receivedAt: new Date(at)}));}}, () => Date.parse(at));
  expect(await service.list()).toMatchObject({truncated: true});
  expect((await service.list()).hosts).toHaveLength(32);
  await expect(new LaneRestorationService({async overview() {return []}, async list() {return [{snapshot: {}, receivedAt: new Date(at)}];}}).list()).rejects.toThrow("unavailable");
});

test("updater projection wins over delayed controller clocks while accepted binding and history remain controller observations", async () => {
  const binding = {
    version: 40,
    revision: "a".repeat(40),
    installationId: "release-40",
    configurationSha256: "b".repeat(64),
    runtimeSha256: "c".repeat(64),
    routineApiVersion: 7,
    publicApiSha256: "d".repeat(64),
  }
  const updater = {
    phase: "waiting" as const,
    observedAt: at,
    desiredTarget: {...binding, version: 41, revision: "e".repeat(40), installationId: "release-41"},
    consumers: [{id: "executor", kind: "executor", reason: "Actual allocated execution remains active"}],
    nextAction: "Wait for safe boundary",
  }
  const history = {
    binding,
    incarnation: "boot",
    incarnationGeneration: 1,
    process: {pid: 1, startedAt: "one"},
    effectiveAt: at,
    observedAt: at,
  }
  const result = await new LaneRestorationService({
    async overview() {return []},
    async list() {
      return [
        {
          snapshot: {
            ...snapshot,
            frameworkBinding: binding,
            frameworkAcceptedAt: at,
            frameworkProcess: history.process,
            deployment: {phase: "idle", observedAt: "2027-01-01T00:00:00Z", consumers: [], nextAction: "Discover"},
          },
          receivedAt: new Date(at),
          deploymentObservation: updater,
          deploymentReceivedAt: new Date(at),
          frameworkHistory: [history],
        },
      ]
    },
  }).list()
  expect(result.hosts[0].deployment).toEqual(updater)
  expect(result.hosts[0].frameworkBinding).toEqual(binding)
  expect(result.hosts[0].frameworkHistory).toEqual([history])
  expect(result.hosts[0].deploymentReceivedAt).toBe(new Date(at).toISOString())
})

test('current lane overview excludes retained repairs, inventory and full installation history', async () => {
  const binding = {version: 1, revision: 'a'.repeat(40), installationId: 'one', configurationSha256: 'b'.repeat(64),
    runtimeSha256: 'c'.repeat(64), routineApiVersion: 14, publicApiSha256: 'd'.repeat(64)};
  const interval = {binding, incarnation: 'boot', incarnationGeneration: 1, process: {pid: 42, startedAt: 'one'},
    effectiveAt: at, observedAt: at, endedAt: at, endReason: 'observed-stop' as const};
  const updater = {phase: 'waiting' as const, observedAt: at, consumers: [], nextAction: 'Wait for idle boundary'};
  const row = {snapshot: {...snapshot, frameworkBinding: binding, frameworkAcceptedAt: at,
    restoration: {schemaVersion: 1, attempts: [attempt], truncated: false}}, receivedAt: new Date(at),
    frameworkHistory: [{...interval, binding: {...binding, installationId: 'older'}}, interval],
    deploymentObservation: updater, deploymentReceivedAt: new Date(at)};
  const service = new LaneRestorationService({async overview(limit) {expect(limit).toBe(33); return [row]},
    async list() {return []}});
  const current = await service.overview();
  expect(current.hosts[0]).toMatchObject({frameworkBinding: binding, frameworkCurrentInterval: interval, deployment: updater});
  expect(current.hosts[0]).not.toHaveProperty('restoration');
  expect(current.hosts[0]).not.toHaveProperty('frameworkHistory');
  expect(JSON.stringify(current)).not.toContain('repair:mac:1');
  expect(Object.keys(laneOverviewFields)).not.toContain('snapshot');
  for (const field of ['snapshot.restoration', 'snapshot.lanes.routineAvailability', 'snapshot.lanes.resources'])
    expect(Object.keys(laneOverviewFields)).not.toContain(field);
  expect(laneOverviewFields.frameworkHistory).toEqual({$slice: -1});
});

test('overview repository fetches only current fields and host detail selects exactly one controller', async () => {
  const original = TestHostStateModel.find;
  const reads: Array<{filter: unknown; projection?: unknown; limit?: number}> = [];
  TestHostStateModel.find = ((filter: unknown) => {
    const read: typeof reads[number] = {filter}; reads.push(read);
    const query = {select(projection: unknown) {read.projection = projection; return query}, sort() {return query},
      limit(limit: number) {read.limit = limit; return query}, maxTimeMS() {return query}, read() {return query},
      readConcern() {return query}, async lean() {return []}};
    return query;
  }) as unknown as typeof TestHostStateModel.find;
  try {
    const repo = new MongoLaneRestorationRepository();
    await repo.overview(33); await repo.list(1, 'selected-host');
    expect(reads[0]).toEqual({filter: {}, projection: laneOverviewFields, limit: 33});
    expect(reads[1]).toMatchObject({filter: {hostId: 'selected-host'}, limit: 1});
  } finally {TestHostStateModel.find = original}
});

test('host-filtered history preserves full receipts; malformed current custody never becomes idle', async () => {
  const repo = {async overview() {return [{snapshot: {...snapshot, lanes: [{...snapshot.lanes[0], state: 'idle',
    activity: {generation: 1, owner: {id: 'run', kind: 'run', requestId: 'run'}}}]}, receivedAt: new Date(at)}]},
    async list(limit: number, hostId?: string) {expect(limit).toBe(1); expect(hostId).toBe('mini');
      return [{snapshot: {...snapshot, restoration: {schemaVersion: 1, attempts: [attempt], truncated: false}}, receivedAt: new Date(at)}]}};
  const service = new LaneRestorationService(repo);
  expect((await service.list('mini')).hosts[0].restoration?.attempts).toEqual([attempt]);
  await expect(service.list('not a valid identity')).rejects.toThrow('Invalid controller');
  await expect(service.overview()).rejects.toThrow('unavailable');
});
