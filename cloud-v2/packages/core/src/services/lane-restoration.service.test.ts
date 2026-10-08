import {expect, test} from "bun:test";
import {laneRestorationProjectionSchema, type LaneRestorationAttempt} from "../types/lane-restoration.types";
import {hostStateSchema} from "./test-host-state.service";
import {LaneRestorationService} from "./lane-restoration.service";

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
  const result = await new LaneRestorationService({async list(limit) {
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
  const result = await new LaneRestorationService({async list() {return [{snapshot: reported, receivedAt: new Date(at)}]}}).list()
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
  const service = new LaneRestorationService({async list() {return Array.from({length: 33}, (_, index) =>
    ({snapshot: {...snapshot, hostId: `host-${index}`}, receivedAt: new Date(at)}));}}, () => Date.parse(at));
  expect(await service.list()).toMatchObject({truncated: true});
  expect((await service.list()).hosts).toHaveLength(32);
  await expect(new LaneRestorationService({async list() {return [{snapshot: {}, receivedAt: new Date(at)}];}}).list()).rejects.toThrow("unavailable");
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
