import {expect, test} from "bun:test";
import {laneRestorationProjectionSchema, type LaneRestorationAttempt, type LaneRepairStatus} from "../types/lane-restoration.types";
import {hostStateSchema} from "./test-host-state.service";
import {LaneRestorationService, laneOverviewFields, MongoLaneRestorationRepository} from "./lane-restoration.service";
import {TestHostStateModel} from '../models/test-host-state.model';

const at = "2026-10-05T01:00:00Z";
const attempt: LaneRestorationAttempt = {executionId: "fixer:first", interruptionId: "repair:mac:1", laneId: "mac", generation: 1,
  current: true, state: "working", assignedAt: at, handedOffAt: at, startedAt: at, finishedAt: null, report: null,
  resume: {status: "unknown", decisionId: null, calledAt: null, reason: null}, requiredAction: null, actions: [], actionsTruncated: false,
  requestId: null, runId: null, incidentId: null, sessionId: null};
const compact = (value: LaneRestorationAttempt): LaneRepairStatus => ({executionId:value.executionId,
  interruptionId:value.interruptionId,laneId:value.laneId,state:value.state,current:value.current,startedAt:value.startedAt,
  finishedAt:value.finishedAt,...(value.haltDecisionId?{haltDecisionId:value.haltDecisionId}:{})});
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
  expect(result.hosts[1].restoration).toBeNull();
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
          frameworkCurrentInterval: history,
        },
      ]
    },
  }).list()
  expect(result.hosts[0].deployment).toEqual(updater)
  expect(result.hosts[0].frameworkBinding).toEqual(binding)
  expect(result.hosts[0].frameworkCurrentInterval).toEqual(history)
  expect(result.hosts[0]).not.toHaveProperty("frameworkHistory")
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
    frameworkCurrentInterval: interval,
    deploymentObservation: updater, deploymentReceivedAt: new Date(at)};
  const service = new LaneRestorationService({async overview(limit) {expect(limit).toBe(33); return [row]},
    async list() {return []}});
  const current = await service.overview();
  expect(current.hosts[0]).toMatchObject({frameworkBinding: binding, deployment: updater});
  expect(current.hosts[0]).not.toHaveProperty('restoration');
  expect(current.hosts[0]).not.toHaveProperty('frameworkHistory');
  expect(JSON.stringify(current)).not.toContain('repair:mac:1');
  expect(Object.keys(laneOverviewFields)).not.toContain('snapshot');
  for (const field of ['snapshot.restoration', 'snapshot.lanes.routineAvailability', 'snapshot.lanes.resources'])
    expect(Object.keys(laneOverviewFields)).not.toContain(field);
  expect(Object.keys(laneOverviewFields)).not.toContain('frameworkHistory');
  expect(laneOverviewFields).not.toHaveProperty('frameworkCurrentInterval');
});

test('overview joins repair custody to the exact attempt without exposing its report or requiring the pre-halt generation', async () => {
  const halted = {...attempt, current: false, state: 'halted' as const, generation: 79,
    finishedAt: '2026-10-05T01:02:00Z', sessionId: 'private-session', requiredAction: 'Private diagnostic detail',
    report: {reportId: 'report:one', reportedAt: at, decision: 'halt' as const, summary: 'Private repair report', question: null}};
  const reported = {...snapshot, lanes: [{...snapshot.lanes[0], state: 'out-of-service',
    activity: {generation: 80, owner: {id: attempt.executionId, kind: 'fixer' as const}}}],
    repairStatuses: [compact(halted)]};
  const service = new LaneRestorationService({async overview() {return [{snapshot: reported, receivedAt: new Date(at)}]},
    async list() {return [{snapshot: reported, receivedAt: new Date(at)}]}});
  const expected = {executionId: halted.executionId, interruptionId: halted.interruptionId, laneId: 'mac',
    state: 'halted' as const, current: false, startedAt: at, finishedAt: halted.finishedAt};
  const overview = await service.overview();
  expect(overview.hosts[0].lanes[0]).toMatchObject({activity: {generation: 80}, repair: expected});
  expect(overview.hosts[0].lanes[0].repair).toEqual(expected);
  expect((await service.list()).hosts[0].lanes[0].repair).toEqual(expected);
  for (const value of ['Private repair report', 'Private diagnostic detail', 'private-session', 'report:one'])
    expect(JSON.stringify(overview)).not.toContain(value);
  expect(Object.keys(laneOverviewFields)).toContain('snapshot.repairStatuses');
  expect(Object.keys(laneOverviewFields)).not.toContain('snapshot.restoration.attempts.report');
});

test('overview never substitutes another execution or lane for the current repair owner', async () => {
  const lane = {...snapshot.lanes[0], activity: {generation: 1, owner: {id: attempt.executionId, kind: 'fixer' as const}}};
  for (const attempts of [[{...attempt, executionId: 'fixer:foreign'}], [{...attempt, laneId: 'foreign'}], [attempt, attempt], []]) {
    const result = await new LaneRestorationService({async overview() {return [{snapshot: {...snapshot, lanes: [lane],
      repairStatuses: attempts.map(compact)}, receivedAt: new Date(at)}]}, async list() {return []}}).overview();
    expect(result.hosts[0].lanes[0]).not.toHaveProperty('repair');
  }
  const working = await new LaneRestorationService({async overview() {return [{snapshot: {...snapshot, lanes: [lane],
    repairStatuses: [compact(attempt)]}, receivedAt: new Date(at)}]}, async list() {return []}}).overview();
  expect(working.hosts[0].lanes[0].repair).toMatchObject({state: 'working', current: true, startedAt: at, finishedAt: null});
});

test('overview repository fetches only current fields and host detail selects exactly one controller', async () => {
  const original = TestHostStateModel.find;
  const reads: Array<{filter: unknown; projection?: unknown; limit?: number; options?: unknown}> = [];
  TestHostStateModel.find = ((filter: unknown) => {
    const read: typeof reads[number] = {filter}; reads.push(read);
    const query = {select(projection: unknown) {read.projection = projection; return query}, sort() {return query},
      limit(limit: number) {read.limit = limit; return query}, maxTimeMS() {return query}, read() {return query},
      setOptions(options: unknown) {read.options = options; return query},
      readConcern() {return query}, async lean() {return []}};
    return query;
  }) as unknown as typeof TestHostStateModel.find;
  try {
    const repo = new MongoLaneRestorationRepository();
    await repo.overview(33, 321); await repo.list(1, 'selected-host');
    expect(reads[0]).toEqual({filter: {}, projection: laneOverviewFields, limit: 33, options: {timeoutMS: 321, maxTimeMS: 321}});
    expect(reads[1]).toMatchObject({filter: {hostId: 'selected-host'}, limit: 1});
  } finally {TestHostStateModel.find = original}
});

test('overview uses only the remaining caller budget and does not query after expiry', async () => {
  const budgets: (number | undefined)[] = [];
  const service = new LaneRestorationService({async overview(_limit, timeoutMS) {budgets.push(timeoutMS); return []},
    async list() {return []}}, () => 1_000);
  await service.overview(1_321);
  await service.overview(11_000);
  expect(budgets).toEqual([321, 5_000]);
  await expect(service.overview(1_000)).rejects.toThrow('timed out');
  expect(budgets).toHaveLength(2);
});

test('host-filtered history preserves full receipts; malformed current custody never becomes idle', async () => {
  const repo = {async overview() {return [{snapshot: {...snapshot, lanes: [{...snapshot.lanes[0], state: 'idle',
    activity: {generation: 1, owner: {id: 'run', kind: 'run', requestId: 'run'}}}]}, receivedAt: new Date(at)}]},
    async list(limit: number, hostId?: string) {expect(limit).toBe(1); expect(hostId).toBe('mini');
      return [{snapshot: {...snapshot, restoration: {schemaVersion: 1, attempts: [attempt], truncated: false}}, receivedAt: new Date(at)}]}};
  const service = new LaneRestorationService(repo,Date.now,{async debug(){},async detail(hostId){
    expect(hostId).toBe('mini');return {restoration:{schemaVersion:1,attempts:[attempt],truncated:false}}}});
  expect((await service.list('mini')).hosts[0].restoration?.attempts).toEqual([attempt]);
  await expect(service.list('not a valid identity')).rejects.toThrow('Invalid controller');
  await expect(service.overview()).rejects.toThrow('unavailable');
});

test('current repair exposes only its actual halt decision for fenced recovery delivery', async () => {
  const halted = {...attempt, state: 'halted' as const, current: false, haltDecisionId: 'halt:actual'}
  const reported = {...snapshot, lanes: [{...snapshot.lanes[0], state: 'out-of-service',
    activity: {generation: 80, owner: {id: attempt.executionId, kind: 'fixer' as const}}}],
    repairStatuses: [compact(halted)]}
  const service = new LaneRestorationService({async overview() {return [{snapshot: reported, receivedAt: new Date(at)}]},
    async list() {return [{snapshot: reported, receivedAt: new Date(at)}]}})
  expect((await service.overview()).hosts[0]!.lanes[0]!.repair!.haltDecisionId).toBe('halt:actual')
  expect((await service.list()).hosts[0]!.lanes[0]!.repair!.haltDecisionId).toBe('halt:actual')
  expect(Object.keys(laneOverviewFields)).toContain('snapshot.repairStatuses')
})

test('admin reservation display follows exact current custody in overview and lane detail', async () => {
  const operationId = '11111111-1111-4111-8111-111111111111', expiresAt = Date.parse(at) + 120000
  const lane = {...snapshot.lanes[0], state: 'reserved',
    activity: {generation: 7, owner: {id: `authoring:local:${expiresAt}:${operationId}`, kind: 'authoring'}}}
  const record = {command: {operationId, expiresAt, hostId: 'mini', laneId: 'mac', action: 'reserve'},
    operatorLabel: 'alice@example.com', receipt: {result: {status: 'accepted',
      reservation: {laneId: 'mac', generation: 7, state: 'granted'}}}}
  const read = async (records: unknown, changed = lane) => {
    const row = {snapshot: {...snapshot, lanes: [changed]}, laneControls: records, receivedAt: new Date(at)}
    const service = new LaneRestorationService({async overview() {return [row]}, async list() {return [row]}})
    return [(await service.overview()).hosts[0].lanes[0], (await service.list()).hosts[0].lanes[0]]
  }
  for (const label of ['alice@example.com', 'credential:operator-key', 'usr_no_email'])
    for (const result of await read([{...record, operatorLabel: label}])) expect(result.reservedBy).toBe(label)
  for (const result of await read([{...record, operatorLabel: undefined}])) expect(result.reservedBy).toBeNull()
  for (const records of [[], [record, record],
    [{...record, command: {...record.command, hostId: 'other'}}],
    [{...record, command: {...record.command, laneId: 'other'}}],
    [{...record, command: {...record.command, action: 'release'}}],
    [{...record, command: {...record.command, operationId: '22222222-2222-4222-8222-222222222222'}}],
    [{...record, receipt: {result: {status: 'refused'}}}],
    ...['waiting', 'returning', 'released', 'cancelled'].map(state => [{...record,
      receipt: {result: {...record.receipt.result, reservation: {...record.receipt.result.reservation, state}}}}]),
    [{...record, receipt: {result: {...record.receipt.result, reservation: {...record.receipt.result.reservation, generation: 8}}}}],
  ]) for (const result of await read(records)) expect(result).not.toHaveProperty('reservedBy')
  for (const result of await read([record], {...lane, activity: {...lane.activity,
    owner: {id: 'local-agent', kind: 'authoring'}}})) expect(result).not.toHaveProperty('reservedBy')
  for (const result of await read([record], {...lane, state: 'running'})) expect(result).not.toHaveProperty('reservedBy')
  expect(laneOverviewFields['laneControls.operatorLabel']).toBe(1)
})

test('failed debug detail cannot gate a valid current lane and exact owned halted repair',async()=>{
 const halted={...attempt,state:'halted' as const,current:false,haltDecisionId:'halt:one'};
 const row={snapshot:{...snapshot,repairStatuses:[compact(halted)],lanes:[{...snapshot.lanes[0],
  activity:{generation:3,owner:{kind:'fixer' as const,id:halted.executionId}}}]},receivedAt:new Date(at)};
 const service=new LaneRestorationService({async overview(){return[row]},async list(){return[row]}},Date.now,
  {async debug(){},async detail(){throw Error('debug unavailable')}});
 expect((await service.list('mini')).hosts[0]).toMatchObject({restoration:null,lanes:[{repair:compact(halted)}]});
 expect((await service.overview()).hosts[0].lanes[0].repair).toEqual(compact(halted));
});

test.each(['current-stop','foreign-birth','malformed-current'] as const)('current framework display uses only accepted tuple and compact stop: %s',async kind=>{
 const binding={version:1,revision:'a'.repeat(40),installationId:'one',configurationSha256:'b'.repeat(64),
  runtimeSha256:'c'.repeat(64),routineApiVersion:111,publicApiSha256:'d'.repeat(64)},process={pid:42,startedAt:'one'}
 const row={snapshot:{...snapshot,frameworkBinding:binding,frameworkAcceptedAt:at,frameworkProcess:process},receivedAt:new Date(at),
  frameworkHistory:[{malformed:'debug'}],frameworkCurrentStop:{installationId:'one',process:kind==='foreign-birth'?{...process,startedAt:'foreign'}:process,
   observedAt:kind==='malformed-current'?'unknown':at}}
 const service=new LaneRestorationService({async overview(){return [row]},async list(){return [row]}},()=>Date.parse(at))
 const current=(await service.overview()).hosts[0]!
 expect(current.frameworkBinding).toEqual(binding);expect(current).not.toHaveProperty('frameworkHistory')
 if(kind==='current-stop')expect(current.frameworkCurrentInterval).toMatchObject({process,endedAt:at,endReason:'observed-stop'})
 else if(kind==='foreign-birth')expect(current.frameworkCurrentInterval).toMatchObject({process,effectiveAt:at})
 else expect(current.frameworkCurrentInterval).toBeUndefined()
 expect(row.frameworkCurrentStop).toEqual({installationId:'one',process:kind==='foreign-birth'?{...process,startedAt:'foreign'}:process,observedAt:kind==='malformed-current'?'unknown':at})
})
