import {currentHostStateProjection} from './test-host-state.service'
import {mergeHostDebugHistory} from './test-host-history.repository'
import {expect, spyOn, test} from "bun:test"
import {createTestHostStateApi} from '../api/internal/test-host-state.api'
import {TestHostStateModel} from "../models/test-host-state.model"
import {TestRequestModel} from '../models/test-request.model'
import {hostStateSchema, TestHostStateService} from "./test-host-state.service"
import {routineProgressSchema} from '../types/routine-progress.types'
import {compatibleRoutineLane, routineJobRouting} from './routine-job.service'
import {permissionContext} from '../types/resource-permissions.types'
import type {ExclusiveHostReservation} from '../types/resource-reservations.types'
import {isDeepStrictEqual} from 'node:util'
import {randomUUID} from 'node:crypto'
import {LaneControlsService} from './lane-controls.service'
import {LaneRestorationService} from './lane-restoration.service'
import {testFrameworkBinding} from '../testing/framework-fixtures'
import {evaluateRoutineLaneReadiness} from './routine-lane-eligibility'
import type {RoutingTestHostState} from './test-host-state.service'

test('run progress lookup selects only one lane snapshot and uses a bounded consistent read', async () => {
  const selections: unknown[] = [], settings: unknown[] = [], filters: unknown[] = [];
  const snapshot = {incarnation: 'boot-one', sequence: 7, lanes: [{id: 'phone', resources: [{id: 'private'}]}]};
  const find = spyOn(TestHostStateModel, 'findOne').mockImplementation(((filter: unknown) => {
    filters.push(filter);
    const query = {select(value: unknown) {selections.push(value); return query},
      read(value: unknown) {settings.push(value); return query}, readConcern(value: unknown) {settings.push(value); return query},
      setOptions(value: unknown) {settings.push(value); return query}, async lean() {return {snapshot, receivedAt: new Date('2026-10-03T01:00:00Z')}}};
    return query;
  }) as never);
  try {
    expect(await new TestHostStateService().progressObservation('host-one', 'phone')).toEqual({
      incarnation: 'boot-one', sequence: 7, receivedAt: '2026-10-03T01:00:00.000Z', lane: {id: 'phone'},
    });
    expect(filters).toEqual([{hostId: 'host-one'}]);
    expect(selections).toEqual([{'snapshot.incarnation': 1, 'snapshot.sequence': 1, 'snapshot.lanes.id': 1,
      'snapshot.lanes.activity': 1, 'snapshot.lanes.progress': 1, 'snapshot.lanes.waiting': 1, receivedAt: 1, _id: 0}]);
    expect(settings).toEqual(['primary', 'majority', {timeoutMS: 5000}]);
  } finally {find.mockRestore()}
})


test('routing reads only fresh current offers and preserves permission and physical glasses admission', async () => {
  const now = Date.parse('2026-10-14T08:00:00Z'), binding = {version: 952, revision: 'a'.repeat(40),
    installationId: 'accepted', configurationSha256: 'b'.repeat(64), runtimeSha256: 'c'.repeat(64),
    routineApiVersion: 39, publicApiSha256: 'd'.repeat(64)};
  const build = {headSha: 'e'.repeat(40), archive: {sha256: 'f'.repeat(64)}, receipt: {sha256: '1'.repeat(64)}};
  const observation = {permission: 'camera' as const, status: 'granted' as const, rawStatus: 'authorized',
    observedAt: new Date(now).toISOString(), binding, evidence: {sha256: '2'.repeat(64)},
    recipient: {kind: 'app' as const, uid: 501, pid: 50, processStartedAt: 'verified lifetime', launchedAt: now - 1000,
      bundleId: 'com.mentra.mentra' as const, bundlePath: '/Applications/Mentra.app', executablePath: '/Applications/Mentra.app/Mentra',
      version: '3.3.0', build: '912', teamId: 'T5XXXL6N36', codeRequirement: 'verified requirement',
      selectedBuild: {headSha: build.headSha, archiveSha256: build.archive.sha256, receiptSha256: build.receipt.sha256}}};
  const lane = {id: 'mac', descriptorRevision: '3'.repeat(64), platform: 'ios-on-mac' as const,
    dispatchMode: 'automatic' as const, state: 'idle' as const,
    resources: [{id: 'app', kind: 'app' as const, capabilities: ['camera'], permissionObservations: [observation]},
      {id: 'glasses', kind: 'glasses' as const, capabilities: ['display']}],
    glasses: [{resourceId: 'glasses', deviceId: 'physical-one', model: 'mentra-live', capabilities: ['display']}]};
  const current = {hostId: 'mini', observedAt: new Date(now).toISOString(), frameworkBinding: binding, lanes: [lane]};
  const requirements = {platform: 'ios-on-mac' as const, resources: [{kind: 'app' as const, capabilities: ['camera'],
    permissions: [{permission: 'camera' as const, recipient: 'app' as const}]}, {kind: 'glasses' as const, capabilities: ['display']}],
    glasses: {models: ['mentra-live'], capabilities: ['display']}};
  const selections: unknown[] = [], settings: unknown[] = [], filters: unknown[] = [];
  const retained: ExclusiveHostReservation[] = [{kind: 'exclusive', id: 'a1d9b22e-12c1-4f5b-b210-0bca2b0798c6', authorityHostId: 'mini',
    borrowerHostId: 'air1', laneId: 'android', resourceId: 'google-account', operationId: 'run:pending-original',
    owner: {kind: 'run', id: 'pending-original'}, inputSha256: 'a'.repeat(64), intentSha256: 'b'.repeat(64),
    controllerIncarnation: 'one', controllerGeneration: 1, borrowerSequence: 1, reservedAt: new Date(now).toISOString()}];
  let reads = 0;
  const find = spyOn(TestHostStateModel, 'find').mockImplementation(((filter: unknown) => {
    filters.push(filter);
    const query = {select(value: unknown) {selections.push(value); return query},
      limit(value: unknown) {settings.push(value); return query}, read(value: unknown) {settings.push(value); return query},
      readConcern(value: unknown) {settings.push(value); return query}, async lean() {
        reads++; return [{hostId: 'mini', snapshot: structuredClone(current), receivedAt: new Date(now), resourceReservations: retained}];
      }}; return query;
  }) as never);
  const previous = process.env.TEST_HOST_TOKENS;
  process.env.TEST_HOST_TOKENS = JSON.stringify({mini: 't'.repeat(32), invalid: 'short'});
  try {
    const service = new TestHostStateService(), [offered] = await service.list();
    expect(offered).toEqual({...current, receivedAt: new Date(now).toISOString(), authorityReservations: retained});
    expect(selections).toEqual([{hostId: 1, receivedAt: 1, resourceReservations: 1, laneControls: 1,
      'resourceLifecycleCursor.schemaVersion': 1, 'resourceLifecycleCursor.subjects': 1,
      'snapshot.resourceReservations.resourceReadiness': 1, 'snapshot.observedAt': 1, 'snapshot.laneControls': 1, 'snapshot.hostId': 1, 'snapshot.frameworkBinding': 1,
      'snapshot.incarnation': 1, 'snapshot.incarnationGeneration': 1, 'snapshot.resourceLifecycle.schemaVersion': 1, 'snapshot.resourceLifecycle.subjects': 1, 'snapshot.resources': 1,
      'snapshot.lanes.id': 1, 'snapshot.lanes.descriptorRevision': 1, 'snapshot.lanes.platform': 1,
      'snapshot.lanes.dispatchMode': 1, 'snapshot.lanes.state': 1, 'snapshot.lanes.activity': 1, 'snapshot.lanes.resources': 1,
      'snapshot.lanes.glasses': 1, _id: 0}]);
    expect(settings).toEqual([100, 'primary', 'majority']);
    expect(filters).toEqual([{hostId: {$in: ['mini']}}]);
    const full = {...current, incarnation: 'boot', incarnationGeneration: 1, sequence: 1, observedAt: new Date(now).toISOString(),
      frameworkHistory: [], restoration: {diagnostics: 'baggage'.repeat(10000)}, receivedAt: offered.receivedAt};
    expect(routineJobRouting(requirements, [offered], now, undefined, build)).toEqual(routineJobRouting(requirements, [full], now, undefined, build));
    expect(compatibleRoutineLane(requirements, offered.lanes[0], permissionContext(binding, build, now))).toBe(true);
    expect(compatibleRoutineLane(requirements, offered.lanes[0], permissionContext(binding, {...build, headSha: '0'.repeat(40)}, now))).toBe(true);
    observation.observedAt = new Date(now - 120001).toISOString();
    const [fresh] = await service.list();
    expect(reads).toBe(2);
    expect(compatibleRoutineLane(requirements, fresh.lanes[0], permissionContext(binding, build, now))).toBe(true);
    current.lanes[0].glasses[0].resourceId = 'unoffered';
    await expect(service.list()).rejects.toThrow('Glasses inventory must exactly identify declared glasses resources');
    current.lanes[0].glasses[0].resourceId = 'glasses';
    observation.recipient.selectedBuild.headSha = 'invalid';
    await expect(service.list()).rejects.toThrow();
    observation.recipient.selectedBuild.headSha = build.headSha;
    current.hostId = 'different';
    await expect(service.list()).rejects.toThrow('Routing snapshot differs from enrolled host');
  } finally {
    find.mockRestore();
    if (previous === undefined) delete process.env.TEST_HOST_TOKENS; else process.env.TEST_HOST_TOKENS = previous;
  }
})

test('projected routing and the full snapshot use the same current lane custody checklist', async () => {
  const now = Date.parse('2026-10-29T11:22:15Z'), at = new Date(now).toISOString();
  const current: RoutingTestHostState = {hostId: 'air2', receivedAt: at, observedAt: at, frameworkBinding: testFrameworkBinding(),
    lanes: [{id: 'android', platform: 'android', dispatchMode: 'automatic', state: 'out-of-service',
      resources: [{id: 'phone', kind: 'phone', capabilities: []}]}]};
  const requirements = {platform: 'android' as const, resources: [{kind: 'phone' as const, capabilities: []}]};
  const include = (target: any, source: any, keys: string[]): any => {
    if (source === undefined) return target;
    if (!keys.length) return structuredClone(source);
    if (Array.isArray(source)) return source.map((item, index) => include(target?.[index], item, keys));
    const [key, ...rest] = keys, selected = include(target?.[key!], source?.[key!], rest);
    return selected === undefined ? target : {...target, [key!]: selected};
  };
  const find = spyOn(TestHostStateModel, 'find').mockImplementation((() => {
    let projection: Record<string, number> = {};
    const query = {select(value: Record<string, number>) {projection = value; return query}, limit() {return query},
      read() {return query}, readConcern() {return query}, async lean() {
        const {receivedAt: _receivedAt, ...snapshot} = current;
        const document = {hostId: current.hostId, receivedAt: new Date(now), snapshot};
        let projected = {};
        for (const [path, selected] of Object.entries(projection)) if (selected === 1)
          projected = include(projected, document, path.split('.'));
        return [projected];
      }};
    return query;
  }) as never);
  const previous = process.env.TEST_HOST_TOKENS;
  process.env.TEST_HOST_TOKENS = JSON.stringify({air2: 't'.repeat(32)});
  try {
    const service = new TestHostStateService();
    for (const owner of [undefined, {id: 'stopped-fixer', kind: 'fixer' as const},
      {id: 'original-run', kind: 'run' as const, requestId: 'original-run'}, {id: 'authoring-owner', kind: 'authoring' as const}]) {
      if (owner) current.lanes[0]!.activity = {generation: 1294, owner};
      else delete current.lanes[0]!.activity;
      const [offered] = await service.list();
      expect(offered!.lanes[0]!.activity).toEqual(current.lanes[0]!.activity);
      const context = {now, binding: current.frameworkBinding!};
      const full = evaluateRoutineLaneReadiness(requirements, current, current.lanes[0]!, context, now);
      const routing = evaluateRoutineLaneReadiness(requirements, offered!, offered!.lanes[0]!, context, now);
      expect(routing).toEqual(full);
      expect(routing.conditions.find(condition => condition.id === 'idle')?.status).toBe(owner ? 'blocked' : 'match');
      expect(Boolean(routineJobRouting(requirements, [offered!], now, undefined, undefined, true,
        {requestId: 'queued-original', inputSha256: 'a'.repeat(64)}).waitingReason)).toBe(Boolean(owner));
    }
    current.lanes[0]!.activity = {generation: 1294, owner: {id: 'other-owner', kind: 'run', requestId: 'wrong-run'}};
    await expect(service.list()).rejects.toThrow('Lane run reference must identify its actual run owner');
  } finally {
    find.mockRestore();
    if (previous === undefined) delete process.env.TEST_HOST_TOKENS; else process.env.TEST_HOST_TOKENS = previous;
  }
})

function fixture(onAccepted?: (host: unknown) => Promise<unknown>, castLegacyUnsets = false) {
  let debug: Record<string, any> = {}
  let row: Record<string, any> | null = null,
    now = Date.parse("2026-10-03T01:00:00Z"),
    writes = 0,
    reads = 0,
    writeAttempts = 0,
    failedWrites = 0
  const readProjections: Array<Record<string, any> | undefined> = [], writeProjections: Array<Record<string, any> | undefined> = []
  const project = (value: Record<string, any> | null, fields?: Record<string, any>) => {
    if(!value || !fields) return structuredClone(value)
    const include = (target: any, source: any, keys: string[]): any => {
      if (source === undefined) return target
      if (!keys.length) return structuredClone(source)
      if (Array.isArray(source)) return source.map((item, index) => include(target?.[index], item, keys))
      const [key, ...rest] = keys, selected = include(target?.[key!], source?.[key!], rest)
      return selected === undefined ? target : {...target, [key!]: selected}
    }
    const evaluate = (expression:any,variables:Record<string,any>={}):any => {
      if(typeof expression==='string'&&expression.startsWith('$')) {
        const [root,...keys]=expression.slice(expression.startsWith('$$')?2:1).split('.')
        return expression.startsWith('$$')?keys.reduce((v,key)=>v?.[key],variables[root!]):[root!,...keys].reduce((v,key)=>v?.[key],value)
      }
      if(Array.isArray(expression))return expression.map(part=>evaluate(part,variables))
      if(!expression||typeof expression!=='object')return expression
      if('$literal' in expression)return expression.$literal
      if('$isArray' in expression)return Array.isArray(evaluate(expression.$isArray,variables))
      if('$cond' in expression)return evaluate(expression.$cond[evaluate(expression.$cond[0],variables)?1:2],variables)
      if('$ifNull' in expression)return evaluate(expression.$ifNull[0],variables)??evaluate(expression.$ifNull[1],variables)
      if('$eq' in expression)return Object.is(evaluate(expression.$eq[0],variables),evaluate(expression.$eq[1],variables))
      if('$ne' in expression)return !Object.is(evaluate(expression.$ne[0],variables),evaluate(expression.$ne[1],variables))
      if('$gte' in expression)return evaluate(expression.$gte[0],variables)>=evaluate(expression.$gte[1],variables)
      if('$gt' in expression)return evaluate(expression.$gt[0],variables)>evaluate(expression.$gt[1],variables)
      if('$lte' in expression)return evaluate(expression.$lte[0],variables)<=evaluate(expression.$lte[1],variables)
      if('$not' in expression)return !evaluate(expression.$not[0],variables)
      if('$or' in expression)return expression.$or.some((part:any)=>evaluate(part,variables))
      if('$convert' in expression) {const parsed=Date.parse(evaluate(expression.$convert.input,variables));return Number.isFinite(parsed)?new Date(parsed):null}
      if('$and' in expression)return expression.$and.every((part:any)=>evaluate(part,variables))
      if('$filter' in expression) {const filter=expression.$filter;return evaluate(filter.input,variables).filter((item:any)=>evaluate(filter.cond,{...variables,[filter.as]:item}))}
      if('$map' in expression) {const map=expression.$map;return evaluate(map.input,variables).map((item:any)=>evaluate(map.in,{...variables,[map.as]:item}))}
      if('$reduce' in expression) {const reduce=expression.$reduce;return evaluate(reduce.input,variables).reduce((value:any,item:any)=>
        evaluate(reduce.in,{...variables,value,this:item}),evaluate(reduce.initialValue,variables))}
      if('$let' in expression)return evaluate(expression.$let.in,{...variables,...Object.fromEntries(
        Object.entries(expression.$let.vars).map(([key,part])=>[key,evaluate(part,variables)]))})
      if('$in' in expression)return evaluate(expression.$in[1],variables).some((item:any)=>isDeepStrictEqual(item,evaluate(expression.$in[0],variables)))
      if('$concatArrays' in expression)return expression.$concatArrays.flatMap((part:any)=>evaluate(part,variables))
      if('$arrayElemAt' in expression)return evaluate(expression.$arrayElemAt[0],variables)?.[expression.$arrayElemAt[1]]
      if(Object.keys(expression).some(key=>key.startsWith('$')))throw Error('Unsupported test projection expression')
      return Object.fromEntries(Object.entries(expression).map(([key,part])=>[key,evaluate(part,variables)]).filter(([,part])=>part!==undefined))
    }
    let result: Record<string, any> = {}
    for(const [path,included] of Object.entries(fields)) {
      if(included===1)result=include(result,value,path.split('.'))
      else if(included&&typeof included==='object') {const selected=evaluate(included),keys=path.split('.');
        if(selected!==undefined)result=include(result,keys.reduceRight((value,key)=>({[key]:value}),selected),keys)}
    }
    return result
  }

  let beforeWrite: ((change: Record<string, any>) => void | Promise<void>) | undefined
  const originalUpdate=TestHostStateModel.findOneAndUpdate,castUpdates:Record<string,any>[]=[]
  const find = spyOn(TestHostStateModel, "findOne").mockImplementation((() => {
    let fields: Record<string, number> | undefined
    const query = {
      select(value: Record<string, number>) {fields = value; return query},
      read(){return query},readConcern(){return query},setOptions(){return query},
      lean: async () => {
        reads++
        readProjections.push(fields)
        return project(row, fields)
      },
    }; return query}) as any)
  const applyUpdate = (
    filter: Record<string, unknown>,
    change: {$set: Record<string, any>; $unset?: Record<string,unknown>; $setOnInsert?:Record<string,unknown>; $inc?:Record<string,number>},
    options: {upsert: boolean},
  ) => {
    let fields: Record<string, number> | undefined
    const query = {
      select(value: Record<string, number>) {fields = value; return query},
      read(){return query},readConcern(){return query},setOptions(){return query},
      lean: async () => {
        writeAttempts++
        await beforeWrite?.(change.$set)
        if (failedWrites > 0) {
          failedWrites--
          return null
        }
        const matches=(part:Record<string,unknown>):boolean=>Object.entries(part).every(([key,value])=>
          key==='$or'?(value as Record<string,unknown>[]).some(matches):
          typeof value==='object'&&value!==null&&'$exists' in value?
            (row?.[key]!==undefined)===(value as {$exists:boolean}).$exists:isDeepStrictEqual(row?.[key],value))
        if (row && !matches(filter)) {
          if (options.upsert) throw Object.assign(new Error('Duplicate host identity'), {code: 11000})
          return null
        }
        if (!row && !options.upsert) return null
        row = {...(!row?change.$setOnInsert:{}),...row, ...change.$set}
        for(const key of Object.keys(change.$unset??{})) delete row[key]
        for(const [key,value] of Object.entries(change.$inc??{})) row[key]=(row[key]??0)+value
        writes++
        writeProjections.push(fields)
        return project(row, fields)
      },
    }; return query
  }
  const update = spyOn(TestHostStateModel, "findOneAndUpdate").mockImplementation(((filter:any,change:any,options:any)=>
    castLegacyUnsets?originalUpdate.call(TestHostStateModel,filter,change,options):applyUpdate(filter,change,options)) as any)
  // Execute the actual Mongoose query, including option forwarding, casting
  // and BSON serialization. Only the driver I/O is replaced with the CAS above.
  const collectionUpdate=castLegacyUnsets?spyOn(TestHostStateModel.collection,'findOneAndUpdate').mockImplementation((async(filter:any,change:any,options:any)=>{
    const {BSON}=TestHostStateModel.base.mongo
    const wire=BSON.deserialize(BSON.serialize(change));castUpdates.push(wire)
    const query=applyUpdate(filter,wire as any,{upsert:Boolean(options.upsert)})
    if(options.projection)query.select(options.projection)
    return query.lean()
  }) as any):undefined
  return {
    service: new TestHostStateService(() => now, onAccepted as never, {async debug(value) {debug = mergeHostDebugHistory(debug, value.payload)}, async detail() {return structuredClone(debug)}}),
    debug: () => debug,
    advance: (ms: number) => (now += ms),
    writes: () => writes,
    reads: () => reads,
    writeAttempts: () => writeAttempts,
    failWrites: (count: number) => {failedWrites = count},
    beforeWrite: (hook: typeof beforeWrite) => {beforeWrite = hook},
    row: () => row!,
    readProjections, writeProjections,
    castUpdates,
    stop: () => {
      find.mockRestore()
      update.mockRestore()
      collectionUpdate?.mockRestore()
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

for(const writer of ['controller','updater'] as const) test(`ordinary ${writer} extraction preserves legacy unsets through real Mongoose casting`,async()=>{
 const f=fixture(undefined,true);try{
  await f.service.report(accepted(1,1),'mini')
  const stopped={installationId:'release-1',process:accepted(1,1).frameworkProcess,observedAt:'2026-10-03T01:00:01.500Z'}
  f.row().frameworkHistory=[{unrelated:'debug'}];f.row().frameworkStopReceipts=[stopped]
  const claims=[{current:'foreign custody'}];f.row().resourceReservations=claims
  if(writer==='controller') await f.service.report(accepted(2,1),'mini')
  else await f.service.reportDeployment(observation(1,{stopped}),'mini')
  expect(f.castUpdates.at(-1)?.$unset).toMatchObject({frameworkHistory:'',frameworkStopReceipts:''})
  expect(f.row()).not.toHaveProperty('frameworkHistory');expect(f.row()).not.toHaveProperty('frameworkStopReceipts')
  expect(f.row().resourceReservations).toEqual(claims)
  expect(TestHostStateModel.schema.path('frameworkHistory')).toBeUndefined()
  expect(TestHostStateModel.schema.path('frameworkStopReceipts')).toBeUndefined()
  expect(TestHostStateModel.schema.options.strict).toBe(true)
  const before=structuredClone(f.row())
  if(writer==='controller') await expect(f.service.report({...accepted(3,1),untrustedWrite:'forbidden'},'mini')).rejects.toThrow()
  else await expect(f.service.reportDeployment({...observation(2),untrustedWrite:'forbidden'},'mini')).rejects.toThrow()
  expect(f.row()).toEqual(before)
 }finally{f.stop()}
})

const runningSnapshot = (sequence = 1) => {
  const value = snapshot(1, sequence), requestId = 'run-one'
  return {...value, lanes: [{...value.lanes[0], state: 'running', activity: {generation: 7,
    owner: {kind: 'run', id: requestId, requestId}}, progress: {requestId, requestDigest: 'a'.repeat(64),
    ownerGeneration: 7, controllerIncarnation: value.incarnation, sequence, phase: 'test',
    currentStep: {id: 'verify-login', index: 1}, completedSteps: 1, totalSteps: 3,
    startedAt: '2026-10-03T00:58:00Z', lastProgressAt: '2026-10-03T00:59:00Z', observedAt: value.observedAt}}]}
}
function acceptedRequestLookup(found: boolean | Record<string, unknown> = true) {
  const queries: Record<string, unknown>[] = [], projections: unknown[] = [], settings: unknown[] = []
  const find = spyOn(TestRequestModel, 'findOne').mockImplementation(((query: Record<string, unknown>) => {
    queries.push(query)
    const chain = {select(value: unknown) {projections.push(value); return chain},
      read(value: unknown) {settings.push(value); return chain}, readConcern(value: unknown) {settings.push(value); return chain},
      setOptions(value: unknown) {settings.push(value); return chain}, async lean() {
        if (typeof found === 'boolean') return found ? {requestId: 'run-one'} : null
        const field = (path: string) => path.split('.').reduce<unknown>((value, key) =>
          value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, found)
        return Object.entries(query).every(([path, value]) => field(path) === value) ? {requestId: found.requestId} : null
      }}
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
    expect(lookup.queries[0]).toEqual({requestId: 'run-one', hostId: 'mini', inputSha256: 'a'.repeat(64), 'input.laneId': 'mac',
      'hostReceipt.requestId': 'run-one', 'hostReceipt.hostId': 'mini', 'hostReceipt.inputSha256': 'a'.repeat(64)})
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

test('routed queued, rejected and cancelled requests need a matching acceptance receipt while accepted terminal publication remains valid', async () => {
  const routed = {requestId: 'run-one', hostId: 'mini', inputSha256: 'a'.repeat(64), input: {laneId: 'mac'}}
  const receipt = {requestId: 'run-one', hostId: 'mini', inputSha256: 'a'.repeat(64), acceptedAt: '2026-10-03T00:58:00Z'}
  const cases = [{...routed, state: 'queued'}, {...routed, state: 'terminal', terminalStatus: 'not-run', hostRejection: receipt},
    {...routed, state: 'terminal', terminalStatus: 'cancelled', hostCancellation: receipt},
    {...routed, state: 'accepted', hostReceipt: {...receipt, requestId: 'other-run'}},
    {...routed, state: 'accepted', hostReceipt: {...receipt, hostId: 'other-host'}},
    {...routed, state: 'accepted', hostReceipt: {...receipt, inputSha256: 'b'.repeat(64)}},
    {...routed, state: 'accepted', hostReceipt: receipt}, {...routed, state: 'running', hostReceipt: receipt},
    {...routed, state: 'terminal', terminalStatus: 'fail', hostReceipt: receipt}]
  for (const row of cases) {
    const f = fixture(), lookup = acceptedRequestLookup(row), allowed = 'hostReceipt' in row && row.hostReceipt === receipt
    try {
      const value = runningSnapshot()
      if (row.state === 'terminal') {value.lanes[0]!.progress.phase = 'publication'; delete (value.lanes[0]!.progress as Record<string, unknown>).currentStep}
      const token = 'acceptance-test-credential'.repeat(2), api = createTestHostStateApi(f.service, () => JSON.stringify({mini: token}))
      const response = await api.request('/', {method: 'POST', headers: {Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'}, body: JSON.stringify(value)})
      expect(response.status).toBe(allowed ? 200 : 409)
      expect(f.writes()).toBe(allowed ? 1 : 0)
      if (allowed) expect((await f.service.get('mini'))!.lanes[0]!.progress?.requestId).toBe('run-one')
    } finally {lookup.stop(); f.stop()}
  }
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
    expect(await f.service.get("mini")).not.toHaveProperty("restoration")
    await f.service.report({...snapshot(2, 1), restoration}, "mini")
    expect(await f.service.get("mini")).not.toHaveProperty("restoration")
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

for(const oldDocument of [false,true]) for(const changed of ['binding','process','accepted-time'] as const) test(`framework metadata omission retains the accepted identity fence: ${changed}, old=${oldDocument}`,async()=>{
 const f=fixture();try{
  f.advance(10_000)
  await f.service.report(accepted(1,1),'mini')
  if(oldDocument) delete f.row().frameworkAcceptedIdentity
  await f.service.report(snapshot(1,2),'mini')
  expect(await f.service.frameworkObservation('mini')).toBeNull()
  await expect(f.service.admitPreparationFramework('mini','omitted-request','a'.repeat(64),'b'.repeat(64),1,
    {kind:'reject',rejectionSha256:'c'.repeat(64)})).rejects.toThrow()
  const altered={...accepted(1,3),...(changed==='binding'?{frameworkBinding:binding(2)}:
    changed==='process'?{frameworkProcess:{pid:999,startedAt:'foreign-birth'}}:{frameworkAcceptedAt:'2026-10-03T01:00:03Z'})}
  await expect(f.service.report(altered,'mini')).rejects.toThrow('identity changed')
  expect(f.row().frameworkAcceptedIdentity).toEqual({frameworkBinding:binding(1),frameworkProcess:accepted(1,1).frameworkProcess,
    frameworkAcceptedAt:accepted(1,1).frameworkAcceptedAt,incarnation:'boot-1',incarnationGeneration:1})
  expect(f.row().sequence).toBe(2)
  expect(await f.service.frameworkObservation('mini')).toBeNull()
  await f.service.report(accepted(1,3),'mini')
  expect(await f.service.frameworkObservation('mini')).toMatchObject({binding:binding(1)})
 }finally{f.stop()}
})

for(const oldDocument of [false,true]) for(const stoppedBeforeOmission of [false,true]) test(`framework metadata omission cannot revive the exact stopped process: stop-before=${stoppedBeforeOmission}, old=${oldDocument}`,async()=>{
 const f=fixture();try{
  f.advance(10_000)
  await f.service.report(accepted(1,1),'mini')
  if(oldDocument) delete f.row().frameworkAcceptedIdentity
  const stopped={installationId:'release-1',process:accepted(1,1).frameworkProcess,observedAt:'2026-10-03T01:00:01.500Z'}
  if(stoppedBeforeOmission) await f.service.reportDeployment(observation(1,{stopped}),'mini')
  await f.service.report(snapshot(1,2),'mini')
  if(!stoppedBeforeOmission) await f.service.reportDeployment(observation(1,{stopped}),'mini')
  const claims=[{current:'foreign owner retained'}];f.row().resourceReservations=claims
  expect(await f.service.frameworkObservation('mini')).toBeNull()
  await expect(f.service.report(accepted(1,3),'mini')).rejects.toThrow('stopped')
  expect(f.row().frameworkAcceptedIdentity).toEqual({frameworkBinding:binding(1),frameworkProcess:accepted(1,1).frameworkProcess,
    frameworkAcceptedAt:accepted(1,1).frameworkAcceptedAt,incarnation:'boot-1',incarnationGeneration:1})
  expect(f.row().sequence).toBe(2);expect(f.row().frameworkCurrentStop).toEqual(stopped)
  await expect(f.service.admitPreparationFramework('mini','stopped-request','a'.repeat(64),'b'.repeat(64),1,
    {kind:'reject',rejectionSha256:'c'.repeat(64)})).rejects.toThrow()
  expect(f.row().resourceReservations).toEqual(claims)
  await f.service.report(accepted(2,1),'mini')
  expect(await f.service.frameworkObservation('mini')).toMatchObject({binding:binding(2)})
  const admission=await f.service.admitPreparationFramework('mini','successor-request','a'.repeat(64),'b'.repeat(64),1,
    {kind:'reject',rejectionSha256:'c'.repeat(64)})
  expect(admission.binding).toEqual(binding(2));expect(f.row().resourceReservations).toEqual(claims)
 }finally{f.stop()}
})

test('untouched legacy stopped row retains cessation through a metadata-omitting report',async()=>{
 const f=fixture();try{
  f.advance(10_000);await f.service.report(accepted(1,1),'mini')
  const stopped={installationId:'release-1',process:accepted(1,1).frameworkProcess,observedAt:'2026-10-03T01:00:01.500Z'}
  delete f.row().frameworkAcceptedIdentity;delete f.row().frameworkCurrentStop
  f.row().frameworkStopReceipts=[{unrelated:'debug'},stopped]
  await f.service.report(snapshot(1,2),'mini')
  expect(f.row().frameworkCurrentStop).toEqual(stopped)
  expect(f.row()).not.toHaveProperty('frameworkStopReceipts')
  await expect(f.service.report(accepted(1,3),'mini')).rejects.toThrow('stopped')
  expect(await f.service.frameworkObservation('mini')).toBeNull()
  await expect(f.service.admitPreparationFramework('mini','legacy-stop-request','a'.repeat(64),'b'.repeat(64),1,
    {kind:'reject',rejectionSha256:'c'.repeat(64)})).rejects.toThrow()
 }finally{f.stop()}
})

for(const writer of ['controller','updater']) for(const kind of ['binding','process','stopped'])
 test(`already-omitted legacy snapshot retains its original authority at ${writer}: ${kind}`,async()=>{
  const f=fixture();try{
   f.advance(10_000);await f.service.report(accepted(1,1),'mini')
   const old={binding:binding(1),process:accepted(1,1).frameworkProcess,incarnation:'boot-1',incarnationGeneration:1,
    effectiveAt:accepted(1,1).frameworkAcceptedAt,observedAt:accepted(1,1).observedAt,
    ...(kind==='stopped'?{endedAt:'2026-10-03T01:00:01.500Z',endReason:'observed-stop'}:{})}
   delete f.row().frameworkAcceptedIdentity;delete f.row().frameworkCurrentStop
   Object.assign(f.row(),{sequence:2,snapshot:snapshot(1,2),frameworkHistory:[{unrelated:'debug'},old]})
   if(writer==='controller') await f.service.report(snapshot(1,3),'mini')
   else await f.service.reportDeployment(observation(1),'mini')
   const altered={...accepted(1,4),...(kind==='binding'?{frameworkBinding:binding(2)}:
    kind==='process'?{frameworkProcess:{pid:999,startedAt:'foreign'}}:{})}
   await expect(f.service.report(altered,'mini')).rejects.toThrow(kind==='stopped'?'stopped':'identity changed')
   expect(f.row().frameworkAcceptedIdentity.frameworkBinding).toEqual(binding(1))
   expect(f.row()).not.toHaveProperty('frameworkHistory')
   if(kind==='stopped') expect(f.row().frameworkCurrentStop).toEqual({installationId:'release-1',process:old.process,observedAt:old.endedAt})
   expect(await f.service.frameworkObservation('mini')).toBeNull()
   await expect(f.service.admitPreparationFramework('mini','old-omitted-request','a'.repeat(64),'b'.repeat(64),1,
    {kind:'reject',rejectionSha256:'c'.repeat(64)})).rejects.toThrow()
  }finally{f.stop()}
 })

test('old writer successor omission cannot fall back to an older extracted identity',async()=>{
 const f=fixture();try{
  f.advance(10_000);await f.service.report(accepted(1,1),'mini')
  const next=accepted(2,1)
  Object.assign(f.row(),{incarnation:'boot-2',incarnationGeneration:2,sequence:2,snapshot:snapshot(2,2),
   frameworkHistory:[{binding:next.frameworkBinding,process:next.frameworkProcess,incarnation:'boot-2',incarnationGeneration:2,
    effectiveAt:next.frameworkAcceptedAt,observedAt:next.observedAt}]})
  await f.service.report(snapshot(2,3),'mini')
  await expect(f.service.report({...accepted(2,4),frameworkProcess:{pid:999,startedAt:'foreign'}},'mini')).rejects.toThrow('identity changed')
  expect(f.row().frameworkAcceptedIdentity.frameworkBinding).toEqual(binding(2))
 }finally{f.stop()}
})

test('legacy accepted predecessor remains a chronology fence before a successor first reports framework metadata',async()=>{
 const f=fixture();try{
  f.advance(10_000);await f.service.report(accepted(1,1),'mini')
  delete f.row().frameworkAcceptedIdentity
  Object.assign(f.row(),{incarnation:'boot-2',incarnationGeneration:2,sequence:1,snapshot:snapshot(2,1),
   frameworkHistory:[{binding:binding(1),process:accepted(1,1).frameworkProcess,incarnation:'boot-1',incarnationGeneration:1,
    effectiveAt:'2026-10-03T01:00:02Z',observedAt:accepted(1,1).observedAt}]})
  await expect(f.service.report({...accepted(2,2),frameworkAcceptedAt:'2026-10-03T01:00:01Z'},'mini')).rejects.toThrow('precedes')
  await f.service.report(accepted(2,2),'mini')
  expect(await f.service.frameworkObservation('mini')).toMatchObject({binding:binding(2)})
 }finally{f.stop()}
})

for(const kind of ['unknown-selected','unrelated-future','same-generation-debug','unrelated-debug-payload'])
 test(`legacy identity extraction keeps operational facts separate from debug: ${kind}`,async()=>{
  const f=fixture();try{
   f.advance(10_000);await f.service.report(accepted(1,1),'mini')
   if(kind!=='same-generation-debug') delete f.row().frameworkAcceptedIdentity
   const old:any={binding:kind==='same-generation-debug'?binding(2):binding(1),process:accepted(1,1).frameworkProcess,
    incarnation:'boot-1',incarnationGeneration:1,effectiveAt:accepted(1,1).frameworkAcceptedAt,observedAt:'discarded diagnostic timestamp'}
   if(kind==='unknown-selected') delete old.process.startedAt
   if(kind==='unrelated-debug-payload') old.diagnostics={invalid:'unrelated debug'}
   Object.assign(f.row(),{sequence:2,snapshot:snapshot(1,2),frameworkHistory:[old,
    ...(kind==='unrelated-future'?[{incarnationGeneration:999,invalid:'future debug'}]:[])]})
   if(kind==='unknown-selected') {
    await expect(f.service.report(snapshot(1,3),'mini')).rejects.toThrow()
    expect(f.row().frameworkHistory).toEqual([old]);expect(f.row().sequence).toBe(2)
   } else {
    await f.service.report(snapshot(1,3),'mini')
    expect(f.row().frameworkAcceptedIdentity.frameworkBinding).toEqual(binding(1))
    await expect(f.service.report({...accepted(1,4),frameworkBinding:binding(2)},'mini')).rejects.toThrow('identity changed')
   }
  }finally{f.stop()}
 })

async function legacyRepairFixture(kind='valid') {
 const f=fixture();f.advance(10_000);await f.service.report(snapshot(1,1),'mini')
 const repair={executionId:'fixer:original',interruptionId:'repair:mac:98',laneId:'mac',state:'halted',
  current:false,startedAt:'2026-10-03T01:00:00Z',finishedAt:'2026-10-03T01:00:01Z',haltDecisionId:'halt:original'}
 const original={...repair,report:{debug:'ignored'.repeat(1000)},actions:[{invalid:'debug'}]}
 if(kind==='foreign-owner') original.executionId='fixer:foreign'
 if(kind==='foreign-lane') original.laneId='other'
 if(kind==='working') original.state='working'
 if(kind==='unknown-halt') original.haltDecisionId='halt:foreign'
 f.row().snapshot.laneControls={schemaVersion:1,receipts:[],reopenRepair:true}
 f.row().snapshot.lanes=[{id:'mac',platform:'ios-on-mac',state:'out-of-service',dispatchMode:'automatic',resources:[],
   activity:{generation:99,owner:{id:repair.executionId,kind:'fixer'}}}]
 f.row().snapshot.restoration={schemaVersion:1,attempts:[{invalid:'unrelated debug'},original,
   ...(kind==='duplicate'?[original]:[])],truncated:false}
 if(kind==='new-current-empty') f.row().snapshot.repairStatuses=[]
 const claims=[{current:'foreign custody'}];f.row().resourceReservations=claims
 const find=spyOn(TestHostStateModel,'find').mockImplementation((()=>{
  const q=TestHostStateModel.findOne({hostId:'mini'}) as any,lean=q.lean.bind(q)
  q.sort=q.limit=q.maxTimeMS=()=>q;q.lean=async()=>[await lean()];return q
 }) as any)
 const controls=new LaneControlsService(undefined,()=>Date.parse('2026-10-03T01:00:10Z'))
 const restoration=new LaneRestorationService(undefined,()=>Date.parse('2026-10-03T01:00:10Z'))
 const input={operationId:randomUUID(),expiresAt:Date.parse('2026-10-03T01:02:10Z'),hostId:'mini',laneId:'mac',
  action:'reopen-repair' as const,repair:{interruptionId:repair.interruptionId,expectedHaltDecisionId:repair.haltDecisionId,
   changedConditions:'Operator completed the requested setting.'}}
 return {...f,repair,claims,controls,restoration,input,stop(){find.mockRestore();f.stop()}}
}
test('untouched legacy halted repair retains current overview and list controls without fetching debug arrays',async()=>{
 const f=await legacyRepairFixture();try{
  for(const result of [await f.restoration.overview(),await f.restoration.list()])
   expect(result.hosts[0]!.lanes[0]!.repair).toMatchObject(f.repair)
  expect(f.readProjections.every(fields=>!fields||!Object.keys(fields).some(key=>key.includes('restoration')))).toBe(true)
  expect(f.row().resourceReservations).toEqual(f.claims)
 }finally{f.stop()}
})
test('untouched legacy halted repair permits only its exact supported reopening command',async()=>{
 const f=await legacyRepairFixture();try{
  expect(await f.controls.submit(f.input,'operator')).toMatchObject({action:'reopen-repair'})
  expect(f.row().laneControls).toHaveLength(1)
  expect(f.row().snapshot.lanes[0].activity.owner.id).toBe(f.repair.executionId)
  expect(f.row().resourceReservations).toEqual(f.claims)
 }finally{f.stop()}
})
test('explicit current repair state wins over old restoration diagnostics at report ingress',async()=>{
 const f=await legacyRepairFixture();try{
  await f.service.report({...f.row().snapshot,sequence:2,repairStatuses:[]},'mini')
  expect(f.row().snapshot.repairStatuses).toEqual([])
  await expect(f.controls.submit(f.input,'operator')).rejects.toThrow('Recovery changed')
  expect(f.row().snapshot.lanes[0].activity.owner.id).toBe(f.repair.executionId)
 }finally{f.stop()}
})
for(const kind of ['foreign-owner','foreign-lane','working','unknown-halt','duplicate','new-current-empty'])
 test(`legacy repair projection keeps current recovery fences: ${kind}`,async()=>{
  const f=await legacyRepairFixture(kind);try{
   await expect(f.controls.submit(f.input,'operator')).rejects.toThrow('Recovery changed')
   expect(f.row().laneControls).toBeUndefined()
   expect(f.row().resourceReservations).toEqual(f.claims)
  }finally{f.stop()}
 })

test('heartbeat and updater acknowledgements preserve large diagnostics without returning them from Mongo', async () => {
  const f = fixture()
  try {
    await f.service.report(accepted(1, 1), 'mini')
    const diagnostics = {retained: 'x'.repeat(180_000)}
    Object.assign(f.row(), {unrelatedDiagnostics: diagnostics})
    f.readProjections.length = 0; f.writeProjections.length = 0
    expect(await f.service.report(accepted(1, 2), 'mini')).toEqual({hostId: 'mini', incarnation: 'boot-1',
      incarnationGeneration: 1, sequence: 2})
    expect(await f.service.reportDeployment(observation(1), 'mini')).toEqual({hostId: 'mini', generation: 1, sequence: 1})
    expect(f.readProjections).toHaveLength(2); expect(f.writeProjections).toHaveLength(2)
    for (const fields of [...f.readProjections, ...f.writeProjections]) {
      expect(fields).toBeDefined()
      expect(fields).not.toHaveProperty('snapshot')
      expect(fields).not.toHaveProperty('unrelatedDiagnostics')
      const selected = Object.fromEntries(Object.entries(f.row()).filter(([key]) => fields?.[key]))
      expect(JSON.stringify(selected).length).toBeLessThan(2048)
    }
    expect(f.row().unrelatedDiagnostics).toEqual(diagnostics)
    expect(f.debug().frameworkHistory).toHaveLength(1)
    expect((await f.service.get('mini'))!.frameworkBinding).toEqual(binding(1))
  } finally {f.stop()}
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
      expect(f.debug().frameworkHistory).toHaveLength(1)
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
    expect(f.debug().frameworkHistory.map((value: any) => value.incarnation)).toEqual(['boot-1', 'boot-2'])
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
      expect(f.debug().frameworkHistory).toHaveLength(1)
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
    expect((results[1] as PromiseRejectedResult).reason.message).toContain('stopped')
    expect(f.row().sequence).toBe(1)
    expect(f.debug().frameworkHistory).toHaveLength(1)
    expect(f.debug().frameworkHistory[0]).toMatchObject({endedAt: stopped.observedAt, endReason: 'observed-stop'})
    expect(f.debug().frameworkStopReceipts).toEqual([stopped])
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
    expect(f.row().snapshot).not.toHaveProperty('frameworkHistory'); expect(f.debug().frameworkHistory).toEqual(expect.arrayContaining(original.frameworkHistory))
    expect(f.debug().frameworkHistory).toHaveLength(2)
    expect(f.debug().frameworkHistory.find((value: any) => value.incarnation === 'boot-1')).toMatchObject(original.frameworkHistory[0])
    expect(f.row()).not.toHaveProperty('frameworkCurrentStop')
    expect(f.row().deploymentSequence).toBe(1)
    expect(f.debug().frameworkStopReceipts).toEqual([stopped])
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
    expect(f.debug().frameworkHistory).toHaveLength(1)
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
    expect(f.debug().frameworkHistory).toHaveLength(1)
    await expect(f.service.report({...accepted(1, 3), frameworkBinding: binding(2)}, "mini")).rejects.toThrow(
      "identity changed",
    )
    await expect(
      f.service.report({...accepted(1, 3), frameworkProcess: {pid: 999, startedAt: "foreign"}}, "mini"),
    ).rejects.toThrow("identity changed")
    await f.service.report(accepted(2, 1), "mini")
    expect(f.debug().frameworkHistory).toMatchObject([
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
    expect(f.debug().frameworkHistory[0].endedAt).toBeUndefined()
    await f.service.reportDeployment(observation(2, {stopped}), "mini")
    expect(f.debug().frameworkHistory[0]).toMatchObject({endedAt: stopped.observedAt, endReason: "observed-stop"})
    await expect(f.service.report(accepted(1, 2), "mini")).rejects.toThrow("stopped")
    await f.service.report(accepted(3, 1), "mini")
    await f.service.reportDeployment(observation(3, {stopped}), "mini")
    expect(f.debug().frameworkHistory.at(-1).endedAt).toBeUndefined()
    const delayed = {
      installationId: "release-3",
      process: {pid: 103, startedAt: "process-3"},
      observedAt: "2026-10-03T01:00:03.500Z",
    }
    await f.service.report(accepted(4, 1), "mini")
    await f.service.reportDeployment(observation(4, {stopped: delayed}), "mini")
    expect(f.debug().frameworkHistory.find((value:any)=>value.binding.version===3)).toMatchObject({
      endedAt:accepted(4,1).frameworkAcceptedAt,endReason:'accepted-replacement',
    })
    expect(f.debug().frameworkStopReceipts).toContainEqual(delayed)
    expect(await f.service.frameworkObservation('mini')).toMatchObject({binding:binding(4)})
    expect(f.row()).not.toHaveProperty('frameworkCurrentStop')
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
    expect(f.debug().frameworkHistory[0].endReason).toBe("observed-stop")
    expect(f.debug().frameworkHistory).toHaveLength(2)
    expect(f.debug().frameworkHistory.at(-1).endedAt).toBeUndefined()
    expect(f.debug().frameworkStopReceipts).toHaveLength(1)
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
    expect(f.debug().frameworkHistory ?? []).toEqual([])
    expect(f.debug().frameworkStopReceipts).toEqual([stopped])
    await f.service.report(accepted(1, 2), 'mini')
    expect(f.debug().frameworkHistory).toMatchObject([
      {binding: binding(1), endedAt: stopped.observedAt, endReason: 'observed-stop'},
    ])
    await expect(f.service.report(accepted(1, 3), 'mini')).rejects.toThrow('stopped')
    await f.service.reportDeployment(observation(2, {stopped}), 'mini')
    expect(f.debug().frameworkStopReceipts).toHaveLength(1)
  } finally {f.stop()}
})
test('unmatched stop and offline debug remain separate without closing a reused PID or current framework', async () => {
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
    expect(f.debug().frameworkHistory.find((value: any) => value.incarnation === 'boot-1')).toEqual(interval)
    expect(f.debug().frameworkStopReceipts).toContainEqual(stopped)
    expect(f.row()).not.toHaveProperty('frameworkCurrentStop')
    expect(await f.service.frameworkObservation('mini')).toMatchObject({binding: binding(3)})
  } finally {f.stop()}
})
test('late foreign supervisor observations stay debug and cannot close the current accepted process', async () => {
  const f=fixture()
  try {
    await f.service.report(accepted(3,1),'mini')
    const interval={binding:binding(1),incarnation:'boot-1',incarnationGeneration:1,
      process:accepted(1,1).frameworkProcess,effectiveAt:accepted(1,1).frameworkAcceptedAt,
      observedAt:accepted(1,1).frameworkAcceptedAt,endedAt:'2026-10-03T01:00:02.500Z',endReason:'observed-stop'}
    const stopped={installationId:'release-1',process:interval.process,observedAt:'2026-10-03T01:00:01.500Z'}
    await f.service.report({...accepted(3,2),frameworkHistory:[interval]},'mini')
    await f.service.reportDeployment(observation(1,{stopped}),'mini')
    await f.service.report({...accepted(3,3),frameworkHistory:[interval]},'mini')
    await f.service.reportDeployment(observation(2,{stopped:{...stopped,observedAt:'2026-10-03T01:00:02Z'}}),'mini')
    expect(f.debug().frameworkHistory.find((value:any)=>value.incarnation==='boot-1')).toEqual(interval)
    expect(f.debug().frameworkStopReceipts).toHaveLength(2)
    expect(f.row()).not.toHaveProperty('frameworkCurrentStop')
    expect(await f.service.frameworkObservation('mini')).toMatchObject({binding:binding(3)})
  } finally {f.stop()}
})

test('unaccepted stop capacity refuses a new delivery without discarding unresolved process points', async () => {
  const f = fixture()
  try {
    await f.service.report(snapshot(1, 1), 'mini')
    for (let version = 1; version <= 100; version++)
      await f.service.reportDeployment(observation(version, {stopped: {installationId: `release-${version}`,
        process: {pid: version + 100, startedAt: `process-${version}`}, observedAt: '2026-10-03T01:00:02Z'}}), 'mini')
    expect(f.debug().frameworkStopReceipts).toHaveLength(100)
    expect(f.debug().frameworkStopReceipts[0].installationId).toBe('release-1')
    expect(f.row().frameworkUnacceptedStops).toHaveLength(100)
    const next=observation(101,{stopped:{installationId:'release-101',process:{pid:201,startedAt:'process-101'},observedAt:'2026-10-03T01:00:02Z'}})
    await expect(f.service.reportDeployment(next,'mini')).rejects.toThrow()
    expect(f.row().deploymentSequence).toBe(100)
    expect(f.row().frameworkUnacceptedStops).toHaveLength(100)
    await f.service.report({...accepted(3,1),frameworkBinding:binding(200),frameworkProcess:{pid:999,startedAt:'replacement'}},'mini')
    expect(f.row().frameworkUnacceptedStops).toEqual([])
    await f.service.reportDeployment(next,'mini')
    expect(f.row().deploymentSequence).toBe(101)
  } finally {f.stop()}
})

for(const legacy of [false,true]) test(`multiple delayed successors retain exact unfinished stops until authentic replacement, legacy=${legacy}`,async()=>{
 const f=fixture();try{
  await f.service.report(accepted(1,1),'mini')
  const stops=[2,3].map(version=>({installationId:`release-${version}`,process:accepted(version,1).frameworkProcess,observedAt:`2026-10-03T01:00:0${version}.500Z`}))
  if(legacy) {delete f.row().frameworkUnacceptedStops;f.row().frameworkStopReceipts=[{invalid:'debug'},...stops]}
  else for(const [index,stopped] of stops.entries()) await f.service.reportDeployment(observation(index+1,{stopped}),'mini')
  await f.service.report(accepted(1,2),'mini')
  expect(f.row().frameworkUnacceptedStops).toEqual(stops)
  expect(f.row()).not.toHaveProperty('frameworkStopReceipts')
  for(const [index,stopped] of stops.entries()) {
   await f.service.report(accepted(index+2,1),'mini')
   expect(f.row().frameworkCurrentStop).toEqual(stopped)
   expect(await f.service.frameworkObservation('mini')).toBeNull()
   await expect(f.service.report(accepted(index+2,2),'mini')).rejects.toThrow('stopped')
  }
  await f.service.report(accepted(4,1),'mini')
  expect(await f.service.frameworkObservation('mini')).toMatchObject({binding:binding(4)})
  expect(f.row().frameworkUnacceptedStops).toEqual([])
 }finally{f.stop()}
})

test('unknown legacy successor stop is preserved without invalidating an unrelated current process',async()=>{
 const f=fixture();try{
  await f.service.report(accepted(1,1),'mini')
  const stop={installationId:'release-2',process:accepted(2,1).frameworkProcess,observedAt:'unknown'}
  delete f.row().frameworkUnacceptedStops;f.row().frameworkStopReceipts=[{invalid:'debug'},stop]
  await f.service.report(accepted(1,2),'mini')
  expect(await f.service.frameworkObservation('mini')).toMatchObject({binding:binding(1)})
  expect(f.row().frameworkUnacceptedStops).toEqual([stop])
  await expect(f.service.report(accepted(2,1),'mini')).rejects.toThrow()
  expect(f.row().incarnation).toBe('boot-1')
  expect(f.row().frameworkUnacceptedStops).toEqual([stop])
 }finally{f.stop()}
})

test('an old writer stop after extraction still fences its current tuple and retains later successors',async()=>{
 const f=fixture();try{
  await f.service.report(accepted(1,1),'mini')
  await f.service.reportDeployment(observation(1,{stopped:{installationId:'release-1',process:accepted(1,1).frameworkProcess,observedAt:'2026-10-03T01:00:01.500Z'}}),'mini')
  const stops=[2,3].map(version=>({installationId:`release-${version}`,process:accepted(version,1).frameworkProcess,observedAt:`2026-10-03T01:00:0${version}.500Z`}))
  f.row().frameworkStopReceipts=stops
  Object.assign(f.row(),{snapshot:accepted(2,1),incarnation:'boot-2',incarnationGeneration:2,sequence:1})
  expect(await f.service.frameworkObservation('mini')).toBeNull()
  await expect(f.service.report(accepted(2,2),'mini')).rejects.toThrow('stopped')
  await f.service.report(accepted(3,1),'mini')
  expect(f.row().frameworkCurrentStop).toEqual(stops[1])
  expect(await f.service.frameworkObservation('mini')).toBeNull()
  expect(f.row().frameworkUnacceptedStops).toEqual([])
  expect(f.row()).not.toHaveProperty('frameworkStopReceipts')
 }finally{f.stop()}
})

for(const exact of [false,true]) test(`only fresh exact supervisor cessation can answer unknown current stop metadata, exact=${exact}`,async()=>{
 const f=fixture();try{
  await f.service.report(accepted(1,1),'mini')
  const original={installationId:'release-1',process:accepted(1,1).frameworkProcess,observedAt:'unknown'}
  f.row().frameworkCurrentStop=original
  const claims=[{current:'foreign authority'}];f.row().resourceReservations=claims
  expect(await f.service.frameworkObservation('mini').catch(()=>null)).toBeNull()
  const stopped={...original,process:exact?original.process:{...original.process,startedAt:'foreign'},observedAt:'2026-10-03T01:00:02Z'}
  await f.service.reportDeployment(observation(1,{stopped}),'mini')
  expect(f.row().frameworkCurrentStop).toEqual(exact?stopped:original)
  expect(await f.service.frameworkObservation('mini').catch(()=>null)).toBeNull()
  expect(f.row().resourceReservations).toEqual(claims)
 }finally{f.stop()}
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
    expect(f.debug().frameworkHistory[0]).toMatchObject({endedAt: stopped.observedAt, endReason: 'observed-stop'})
    expect(f.debug().frameworkStopReceipts).toEqual([stopped])
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
      const input=({...shared, ...(withHistory ? {frameworkHistory: [
        {binding: binding(1), incarnation: 'boot-1', incarnationGeneration: 1, process: shared.frameworkProcess,
          effectiveAt: accepted(1, 1).frameworkAcceptedAt, observedAt: accepted(1, 1).observedAt,
          endedAt: shared.frameworkAcceptedAt, endReason: 'accepted-replacement'},
        {binding: binding(1), incarnation: 'boot-2', incarnationGeneration: 2, process: shared.frameworkProcess,
          effectiveAt: shared.frameworkAcceptedAt, observedAt: shared.observedAt},
      ]} : {})})
      if(stopFirst) {
        await expect(f.service.report(input,'mini')).rejects.toThrow('stopped')
        expect(f.row().incarnation).toBe('boot-1')
        expect(f.row().frameworkCurrentStop).toEqual(stopped)
        return
      }
      await f.service.report(input,'mini')
      if (!stopFirst) await f.service.reportDeployment(observation(1, {stopped}), 'mini')
      const history = f.debug().frameworkHistory
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
    expect(f.debug().frameworkHistory).toHaveLength(100)
    expect(f.debug().frameworkHistory[0].binding.version).toBe(6)
    expect(f.debug().frameworkHistory.at(-1).binding.version).toBe(105)
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
    expect(f.debug().frameworkHistory.map((value: any) => value.binding.version).sort((a:number,b:number)=>a-b)).toEqual([1, 2, 3])
    expect((await f.service.get("mini"))!.frameworkBinding?.version).toBe(3)
    await expect(f.service.report({...offline,sequence:3,frameworkHistory:[{...interval(2),binding:binding(99)}]},'mini')).resolves.toMatchObject({sequence:3})
    await expect(f.service.report({...offline,sequence:4,frameworkHistory:[interval(4)]},'mini')).resolves.toMatchObject({sequence:4})
    expect((await f.service.get('mini'))!.frameworkBinding).toEqual(binding(3))
    expect(f.row().snapshot).not.toHaveProperty('frameworkHistory')
  } finally {
    f.stop()
  }
})

test('lifecycle comparison survives omitted envelope and omitted subject without renewing observation', async () => {
  const {projectResourceLifecycle} = await import('./resource-lifecycle.service')
  for (const omission of [undefined, {schemaVersion: 1, subjects: [], history: []}]) {
    const f = fixture()
    const at = '2026-10-03T01:00:00Z'
    const subject = {subject: {kind: 'resource', id: 'resource-one', authorityHostId: 'mini'}, generation: 10,
      status: 'unknown', observedAt: at, receivedAt: null, current: true, reason: null, owner: null,
      idle: {contractVersion: 'v1', outcome: 'not-checked', checkedAt: null, acceptedCheck: null, qualifiedScope: {kind: 'unqualified'}, evidenceRefs: []},
      repair: {configured: false, state: 'none'}, supportedActions: [], resource: {kind: 'account', capabilities: [], memberships: [], dependencies: [], placement: 'fleet'}}
    const lifecycle = {schemaVersion: 1, subjects: [subject], history: [{id: 'original-event', resourceId: 'resource-one', subjectGeneration: 10, at, event: 'checking'}]}
    try {
      await f.service.report({...snapshot(1, 1), resourceLifecycle: lifecycle}, 'mini')
      await f.service.report({...snapshot(1, 2), ...(omission ? {resourceLifecycle: omission} : {})}, 'mini')
      expect(f.row().resourceLifecycleCursor.subjects[0].generation).toBe(10)
      const stored=f.row()
      const projected = projectResourceLifecycle([{hostId:'mini',receivedAt:stored.receivedAt,snapshot:stored.snapshot,resourceLifecycleCursor:stored.resourceLifecycleCursor}], Date.parse(at)).subjects[0]!
      expect(projected.status).toBe('unknown'); expect(projected.current).toBe(false)
      expect(projected.supportedActions).toEqual([])
      await expect(f.service.report({...snapshot(1, 3), resourceLifecycle: {...lifecycle,
        subjects: [{...subject, generation: 1}], history: []}}, 'mini')).rejects.toThrow('generation regressed')
      await expect(f.service.report({...snapshot(1, 3), resourceLifecycle: {...lifecycle,
        history: [{...lifecycle.history[0], event: 'active'}]}}, 'mini')).resolves.toMatchObject({sequence:3})
      expect(f.row().sequence).toBe(3)
    } finally {f.stop()}
  }
})

test('routing carries only the installed whole-resource producer flag, keeping historical observation payloads out of matching', async () => {
  const current = {hostId: 'host', observedAt: '2026-10-24T16:00:00.000Z',
    resourceReservations: {resourceReadiness: true}, lanes: [{id: 'android', platform: 'android',
      dispatchMode: 'automatic', state: 'idle', resources: []}]}
  const selections: Record<string, number>[] = []
  const find = spyOn(TestHostStateModel, 'find').mockImplementation((() => {
    const query = {select(value: Record<string, number>) {selections.push(value); return query},
      limit() {return query}, read() {return query}, readConcern() {return query},
      async lean() {return [{hostId: 'host', snapshot: structuredClone(current), receivedAt: new Date(current.observedAt)}]}}
    return query
  }) as never)
  const previous = process.env.TEST_HOST_TOKENS
  process.env.TEST_HOST_TOKENS = JSON.stringify({host: 'synthetic-host-token-'.repeat(3)})
  try {
    const [offered] = await new TestHostStateService().list()
    expect(offered?.resourceReservations?.resourceReadiness).toBe(true)
    expect(selections[0]?.['snapshot.resourceReservations.resourceReadiness']).toBe(1)
    expect(selections[0]?.['snapshot.resourceReservations']).toBeUndefined()
    expect(Object.keys(offered?.resourceReservations ?? {})).toEqual(['resourceReadiness'])
  } finally {find.mockRestore(); if (previous === undefined) delete process.env.TEST_HOST_TOKENS; else process.env.TEST_HOST_TOKENS = previous}
})

for (const includeHistory of [false,true]) test(`selected host read remains current-only when an old caller asks for history=${includeHistory}`,async()=>{
 const selections:Record<string,unknown>[]=[],consistency:unknown[]=[],row={snapshot:snapshot(1,1),receivedAt:new Date('2026-10-03T01:00:00Z'),
   resourceReservations:[],laneControls:[],frameworkHistory:[{invalid:true}],repairDiagnostics:'unrelated'.repeat(19000)}
 const find=spyOn(TestHostStateModel,'findOne').mockImplementation(((filter:unknown)=>{
  expect(filter).toEqual({hostId:'mini'});const query={select(value:Record<string,unknown>){selections.push(value);return query},
   read(value:unknown){consistency.push(value);return query},readConcern(value:unknown){consistency.push(value);return query},setOptions(){return query},async lean(){return row}}
  return query
 }) as never)
 try {
  const result=await new TestHostStateService().get('mini')
  expect(result?.incarnation).toBe('boot-1');expect(result?.authorityReservations).toEqual([])
  expect(result).not.toHaveProperty('frameworkHistory');expect(result).not.toHaveProperty('repairDiagnostics')
  expect(consistency).toEqual(['primary','majority'])
  expect(selections).toEqual([currentHostStateProjection])
  for(const fields of selections)for(const key of ['snapshot','snapshot.lanes','snapshot.resourceLifecycle','frameworkHistory','frameworkStopReceipts'])expect(fields).not.toHaveProperty(key)
 } finally {find.mockRestore()}
})

for (const unavailable of [false, true]) test(`accepted idle report schedules current recorder cleanup without another host read (unavailable=${unavailable})`, async () => {
  const hosts: any[] = [], f = fixture(async host => {hosts.push(host); if (unavailable) throw Error('cleanup unavailable')});
  try {
    await f.service.report(snapshot(1, 1), 'mini');
    expect(hosts).toHaveLength(0);
    const claim = {id: 'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab', requestId: 'original', fleetInputSha256: 'c'.repeat(64),
      hostId: 'mini', laneId: 'mac', poolId: 'mini:disk:1', minimumAvailableBytes: 3 * 1024 ** 3, reservedAt: '2026-10-03T01:00:00Z'};
    Object.assign(f.row(), {resourceReservations: [claim], resourceReservationVersion: 7, laneControlVersion: 4});
    f.advance(1000); const newer = snapshot(1, 2, '2026-10-03T01:00:01Z'), reads = f.reads();
    expect(await f.service.report(newer, 'mini')).toEqual({hostId: 'mini', incarnation: 'boot-1', incarnationGeneration: 1, sequence: 2});
    await Promise.resolve();
    expect(f.reads() - reads).toBe(1); expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({hostId: 'mini', incarnationGeneration: 1, sequence: 2,
      resourceReservations: [claim], resourceReservationVersion: 7, laneControlVersion: 4, snapshot: newer});
    expect(hosts[0]).not.toHaveProperty('frameworkHistory');
    await expect(f.service.report(newer, 'foreign')).rejects.toThrow('authenticated controller');
    expect(hosts).toHaveLength(1);
  } finally {f.stop()}
});

test('current stop before delayed acceptance cannot make the exact ceased process available',async()=>{
 const f=fixture();try{
  await f.service.report(snapshot(1,1),'mini');
  const stopped={installationId:'release-1',process:accepted(1,1).frameworkProcess,observedAt:'2026-10-03T01:00:02Z'};
  await f.service.reportDeployment(observation(1,{stopped}),'mini');
  await f.service.report(accepted(1,2),'mini');
  expect(f.row().frameworkCurrentStop).toEqual(stopped);
  expect(f.row()).not.toHaveProperty('frameworkCurrentInterval');
  expect(await f.service.frameworkObservation('mini')).toBeNull();
  await expect(f.service.report(accepted(1,3),'mini')).rejects.toThrow('stopped');
  await f.service.report(accepted(2,1),'mini');
  expect(f.row()).not.toHaveProperty('frameworkCurrentInterval');
  expect(f.row()).not.toHaveProperty('frameworkCurrentStop');
 }finally{f.stop()}
});
test('old writer current snapshot replaces only a stale different interval and never revives its exact stopped process',async()=>{
 const f=fixture();try{
  await f.service.report(accepted(1,1),'mini');
  const old={invalid:'retired WIP field must not define current source'};
  Object.assign(f.row(),{snapshot:accepted(2,1),incarnation:'boot-2',incarnationGeneration:2,sequence:1,frameworkCurrentInterval:old});
  expect(await f.service.frameworkObservation('mini')).toMatchObject({binding:binding(2)});
  const stopped={installationId:'release-2',process:accepted(2,1).frameworkProcess,observedAt:'2026-10-03T01:00:03Z'};
  await f.service.reportDeployment(observation(1,{stopped}),'mini');
  expect(f.row().frameworkCurrentStop).toEqual(stopped);
  expect(await f.service.frameworkObservation('mini')).toBeNull();
  await expect(f.service.report(accepted(2,2),'mini')).rejects.toThrow('stopped');
 }finally{f.stop()}
});

test('old host document preserves its exact still-current stopped process at the writer boundary', async () => {
  const f=fixture()
  try {
    await f.service.report(accepted(1,1),'mini')
    const stop={installationId:'release-1',process:accepted(1,1).frameworkProcess,observedAt:'2026-10-03T01:00:02Z'}
    f.row().frameworkStopReceipts=[{...stop,process:{...stop.process,startedAt:'foreign birth'}},stop]
    delete f.row().frameworkCurrentStop
    await expect(f.service.report(accepted(1,2),'mini')).rejects.toThrow('stopped')
    expect(f.row().sequence).toBe(1)
  } finally {f.stop()}
})

for (const ceasedCurrent of [false,true]) test(`successor cessation survives delayed acceptance while current ceased=${ceasedCurrent}`, async()=>{
 const f=fixture()
 try {
  await f.service.report(accepted(1,1),'mini')
  if(ceasedCurrent) await f.service.reportDeployment(observation(1,{stopped:{installationId:'release-1',process:accepted(1,1).frameworkProcess,observedAt:'2026-10-03T01:00:01.500Z'}}),'mini')
  const stopped={installationId:'release-2',process:accepted(2,1).frameworkProcess,observedAt:'2026-10-03T01:00:02.500Z'}
  await f.service.reportDeployment(observation(2,{stopped}),'mini')
  expect((await f.service.frameworkObservation('mini'))===null).toBe(ceasedCurrent)
  await f.service.report(accepted(2,1),'mini')
  expect(f.row().frameworkCurrentStop).toEqual(stopped)
  expect(await f.service.frameworkObservation('mini')).toBeNull()
  await expect(f.service.admitPreparationFramework('mini','new-request','a'.repeat(64),'b'.repeat(64),1,{kind:'reject',rejectionSha256:'c'.repeat(64)})).rejects.toThrow()
  await expect(f.service.report(accepted(2,2),'mini')).rejects.toThrow('stopped')
  await f.service.report(accepted(3,1),'mini')
  expect(await f.service.frameworkObservation('mini')).toMatchObject({binding:binding(3)})
 }finally{f.stop()}
})

for(const kind of ['known-stop','malformed-stop','foreign-birth'] as const) test(`legacy current reads never admit a stopped process before writer extraction: ${kind}`,async()=>{
 const f=fixture()
 try {
  await f.service.report(accepted(1,1),'mini')
  f.row().frameworkStopReceipts=[{invalid:'unrelated debug'}, {installationId:'release-1',process:{...accepted(1,1).frameworkProcess,...(kind==='foreign-birth'?{startedAt:'foreign'}:{})},observedAt:kind==='malformed-stop'?'unknown':'2026-10-03T01:00:02Z'}]
  if(kind==='foreign-birth') expect(await f.service.frameworkObservation('mini')).toMatchObject({binding:binding(1)})
  else {
   expect(await f.service.frameworkObservation('mini').catch(()=>null)).toBeNull()
   await expect(f.service.admitPreparationFramework('mini','new-request','a'.repeat(64),'b'.repeat(64),1,{kind:'complete',inputSha256:'c'.repeat(64)})).rejects.toThrow()
  }
  expect(f.row()).not.toHaveProperty('frameworkCurrentStop')
  expect(f.readProjections.every(fields=>!fields||!('frameworkStopReceipts' in fields))).toBe(true)
 }finally{f.stop()}
})

for(const kind of ['current-stop','early-stop','foreign-birth','malformed-current','new-process'] as const) test(`old writer boundary retains only relevant stopped authority: ${kind}`,async()=>{
 const f=fixture()
 try {
  await f.service.report(kind==='early-stop'?snapshot(1,1):accepted(1,1),'mini')
  const stop={installationId:'release-1',process:accepted(1,1).frameworkProcess,observedAt:'2026-10-03T01:00:02Z'}
  f.row().frameworkStopReceipts=[{invalid:true},kind==='foreign-birth'?{...stop,process:{...stop.process,startedAt:'foreign'}}:
    kind==='malformed-current'?{...stop,observedAt:'unknown'}:stop,{...stop,process:kind==='foreign-birth'?{...stop.process,startedAt:'foreign'}:stop.process,observedAt:'2026-10-03T01:00:03Z'}]
  const claims=[{current:'foreign authority remains unchanged'}];f.row().resourceReservations=claims
  delete f.row().frameworkCurrentStop
  if(kind==='current-stop'||kind==='malformed-current') {
   await expect(f.service.report(accepted(1,2),'mini')).rejects.toThrow()
   expect(f.row().sequence).toBe(1)
  } else if(kind==='early-stop') {
   await f.service.report(accepted(1,2),'mini')
   expect(f.row().frameworkCurrentStop).toEqual(stop)
   await f.service.reportDeployment(observation(2,{stopped:{...stop,observedAt:'2026-10-03T01:00:03Z'}}),'mini')
   expect(f.row().frameworkCurrentStop).toEqual(stop)
   expect(await f.service.frameworkObservation('mini')).toBeNull()
   await expect(f.service.report(accepted(1,3),'mini')).rejects.toThrow('stopped')
  } else if(kind==='foreign-birth') {
   await f.service.report(accepted(1,2),'mini')
   expect(f.row()).not.toHaveProperty('frameworkCurrentStop')
   expect(await f.service.frameworkObservation('mini')).toMatchObject({binding:binding(1)})
  } else {
   await f.service.report(accepted(2,1),'mini')
   expect(f.row()).not.toHaveProperty('frameworkCurrentStop')
   expect(await f.service.frameworkObservation('mini')).toMatchObject({binding:binding(2)})
  }
  expect(f.row().resourceReservations).toEqual(claims)
  if(kind!=='current-stop'&&kind!=='malformed-current')expect(f.row()).not.toHaveProperty('frameworkStopReceipts')
  expect(f.readProjections.every(fields=>!fields||!('frameworkStopReceipts' in fields))).toBe(true)
 }finally{f.stop()}
})
