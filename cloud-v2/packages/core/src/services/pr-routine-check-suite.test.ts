import {afterEach, expect, spyOn, test} from 'bun:test'
import {TestSuiteModel} from '../models/test-suite.model'
import {createRecordedFrameworkRunSummaryProjection} from './framework-run-summary.service'
import {TestRunModel} from '../models/test-run.model'
import {TestRequestModel} from '../models/test-request.model'
import {PrRoutineCheckService, prRoutineGateId} from './pr-routine-check.service'
import {TestSuiteService} from './test-suite.service'
import {TestRerunService, type RerunRecord, type RerunRepository} from './test-rerun.service'
import {LaneRestorationService} from './lane-restoration.service'
import {TestRunError} from './test-result-error'
import {requestInputDigest} from './test-request.service'
import {testRoutineSource} from '../testing/framework-fixtures'
import type {PrRoutineCheckRepository} from './pr-routine-check.repository'
import type {PrRoutineCheckRow, PrRoutineContext} from '../types/pr-routine-check.types'
import {PrRerunReferenceService} from './pr-rerun-reference.service'
import {matchesLabelReference} from '../types/pr-rerun-label.types'

const mocks: Array<{mockRestore(): void}> = []
afterEach(() => {for (const mock of mocks.splice(0)) mock.mockRestore()})
const query = (read: () => unknown) => ({select() {return this}, limit() {return this}, read() {return this}, readConcern() {return this}, setOptions() {return this}, async lean() {return structuredClone(read())}})

function fixture() {
  let labelActor = "operator", labelEvent = 1, mayWrite = true
  let now = Date.parse('2026-10-12T00:00:00Z'), lease = 0, available = true, lostRerunCommit = false, lostPreviewCheckpoint = false, failedAdmission: string | undefined
  const gates = new Map<string, PrRoutineCheckRow>(), suites = new Map<string, any>(), requests = new Map<string, any>(), runs = new Map<string, any>(), reruns = new Map<string, RerunRecord>(), claims = new Set<string>()
  const submitted: string[] = [], cancelled: string[] = [], followUpCalls: Array<{requestId:string;actor:string;pr:unknown}> = []
  let failFollowUp=false
  const context: PrRoutineContext = {number: 12, headSha: 'b'.repeat(40), headRef: 'feature', baseRef: 'dev', open: true, sameRepository: true, labels: ['routine:one', 'routine:two'], peers: [12], labelActors: {}}
  const ids = (filter: any) => filter.requestId?.$in ?? []
  mocks.push(spyOn(TestSuiteModel, 'findOne').mockImplementation((filter: any) => query(() => suites.get(filter.suiteId) ?? null) as any))
  mocks.push(spyOn(TestSuiteModel, 'create').mockImplementation((async (rows: any[]) => {const row = rows[0]; if (suites.has(row.suiteId)) throw Object.assign(Error('duplicate'), {code: 11000}); suites.set(row.suiteId, structuredClone(row)); return rows}) as any))
  mocks.push(spyOn(TestSuiteModel, 'updateOne').mockImplementation((async (filter: any, update: any) => {
    const row = suites.get(filter.suiteId); if (!row || filter.finishedAt && row.finishedAt || filter.finalizingAt && row.finalizingAt) return {modifiedCount: 0}
    if (update.$set?.['payload.members.$.requestId']) {const member = row.payload.members.find((member: any) => member.memberId === filter['payload.members'].$elemMatch.memberId); if (member.requestId) return {modifiedCount: 0}; member.requestId = update.$set['payload.members.$.requestId']}
    else Object.assign(row, structuredClone(update.$set)); return {modifiedCount: 1}
  }) as any))
  mocks.push(spyOn(TestSuiteModel, 'aggregate').mockImplementation(((pipeline: any[]) => ({read() {return this}, readConcern() {return this}, option() {return this}, async exec() {return pipeline[0].$match.suiteId.$in.flatMap((id: string) => suites.has(id) ? [structuredClone(suites.get(id))] : [])}})) as any))
  mocks.push(spyOn(TestRequestModel, 'find').mockImplementation(((filter: any) => query(() => ids(filter).flatMap((id: string) => requests.has(id) ? [requests.get(id)] : []))) as any))
  mocks.push(spyOn(TestRunModel, 'find').mockImplementation(((filter: any) => query(() => ids(filter).flatMap((id: string) => runs.has(id) ? [runs.get(id)] : []))) as any))
  mocks.push(spyOn(LaneRestorationService.prototype, 'overview').mockResolvedValue({generatedAt: new Date(now).toISOString(), freshForMs: 120000, hosts: [], truncated: false}))
  const rows: PrRoutineCheckRepository = {
    async get(id) {return structuredClone(gates.get(id) ?? null)}, async insert(payload, nextAt) {if (!gates.has(payload.gateId)) gates.set(payload.gateId, {gateId: payload.gateId, revision: 0, payload: structuredClone(payload), nextAt})},
    async claim(id) {const row = gates.get(id); if (!row || row.lease) return null; row.lease = {id: String(++lease), expiresAt: new Date(now + 120000)}; return structuredClone(row)},
    async save(row, payload, nextAt) {const old = gates.get(row.gateId)!; if (old.revision !== row.revision || old.lease?.id !== row.lease?.id) return false; if (lostRerunCommit && payload.attempt.members.some(member => member.requestId?.startsWith('rerun-') && member.status === 'running')) {lostRerunCommit=false; delete old.lease; return false}; if (lostPreviewCheckpoint && payload.attempt.members.some(member => member.requestId?.startsWith('rerun-') && !requests.has(member.requestId))) {lostPreviewCheckpoint=false; delete old.lease; return false}; gates.set(row.gateId, {gateId: row.gateId, revision: row.revision + 1, payload: structuredClone(payload), ...(nextAt ? {nextAt} : {})}); return true},
    async wake(id,date) {const row=gates.get(id); if(row && (!row.nextAt||row.nextAt>date)) row.nextAt=date},
    async due(date) {return [...gates.values()].filter(row => row.nextAt && row.nextAt <= date).map(row => row.gateId)}, async predecessors() {return []}, async eventsDue() {return []}, async event() {}, async eventSettled() {},
  }
  mocks.push(spyOn(TestSuiteModel, 'find').mockImplementation(((filter: any) => query(() => [...suites.values()].filter(row => row.payload.members.some((member: any) => member.requestId === filter['payload.members.requestId'])))) as any))
  const store: RerunRepository = {
    async get(id) {return structuredClone(reruns.get(id) ?? null)}, async insert(row) {if (reruns.has(row.rerunId)) throw Object.assign(Error('duplicate'), {code: 11000}); reruns.set(row.rerunId, structuredClone(row))},
    async accept(id, digest, keys, acceptedAt) {const row = reruns.get(id)!; if (row.state === 'accepted') return null; if (keys.some(key => claims.has(key))) throw Object.assign(Error('claimed'), {code: 11000}); keys.forEach(key => claims.add(key)); row.state = 'accepted'; row.acceptedAt = acceptedAt; return structuredClone(row)},
    async latest(roots:string[]){return [...reruns.values()].filter(row=>row.state==='accepted'&&row.plan.members.some(member=>roots.includes(member.rootKey))).map(row=>structuredClone(row))},async history(root, before, limit) {return [...reruns.values()].filter(row => row.state === 'accepted' && row.plan.members.some(member => member.rootKey === root && member.attemptNumber < before)).sort((a,b) => b.plan.members.find(member => member.rootKey === root)!.attemptNumber - a.plan.members.find(member => member.rootKey === root)!.attemptNumber).slice(0,limit).map(row => structuredClone(row))},
    async children() {return []}, async byRequest(id) {return [...reruns.values()].find(row => row.state === 'accepted' && row.plan.members.some(member => member.requestId === id)) ?? null},
  }
  const jobs = {
    async freezeSelection(input: any, inherited?: any) {return {...input, routineSource: input.routineSource ?? testRoutineSource(), build: inherited ?? {repository: 'Mentra-Community/MentraOS', kind: 'android-apk', channel: 'pr', prNumber: 12, headSha: context.headSha, source: input.source, archive: {name: 'app.apk', url: 'https://artifactscdn.mentraglass.com/app.apk', size: 10, sha256: 'd'.repeat(64)}, receipt: {url: 'https://artifactscdn.mentraglass.com/receipt', size: 1, sha256: 'e'.repeat(64)}}}},
    async submitFrozen(selection: any, deadline: string) {submitted.push(selection.requestId); if (failedAdmission === selection.requestId) throw Error('Admission temporarily unavailable'); if (!requests.has(selection.requestId)) {const intent = {...selection, laneId: 'android'}; requests.set(selection.requestId, {requestId: selection.requestId, hostId: 'test-host', fleetSelection: selection, fleetSelectionSha256: requestInputDigest(selection), fleetDeadline: new Date(deadline), fleetBinding: {hostId: 'test-host', laneId: 'android'}, dispatchIntent: intent, dispatchIntentSha256: requestInputDigest(intent), state: 'running'})} return requests.get(selection.requestId)},
    async cancelFrozen(selection: any, deadline: string, value: {reason:string}) {const row=requests.get(selection.requestId)??{requestId:selection.requestId,fleetSelection:selection,fleetSelectionSha256:requestInputDigest(selection),fleetDeadline:new Date(deadline)}; if (requestInputDigest(row.fleetSelection)!==requestInputDigest(selection) || row.fleetDeadline && new Date(row.fleetDeadline).toISOString()!==new Date(deadline).toISOString()) throw new TestRunError(409,'Frozen cancellation mismatch'); row.fleetCancellation??={...value,requestedAt:new Date(now).toISOString()}; cancelled.push(selection.requestId); if (!row.fleetBinding) {row.state='terminal';row.terminalStatus='not-run'}; requests.set(selection.requestId,row)},
    async cancel(id: string) {cancelled.push(id); if(!requests.has(id)) throw new TestRunError(404,'Missing ordinary request'); return {} as any},
  }
  const suite = new TestSuiteService(), results = {async summary(id: string) {const run=runs.get(id)?.payload; if(!run) throw new TestRunError(404, 'no published result'); return {...run,runId:id,outcome:run.result.test==='passed'?'pass':'failed',uploadsComplete:true,evidenceStatus:'complete'}}}, requestReader = {async get(id: string) {return requests.get(id) ?? null}}
  const rerun = new TestRerunService(store, suite, jobs as any, requestReader as any, results as any, () => now)
  const references = new PrRerunReferenceService({async suites(ref) {return [...suites.keys()].filter(id => matchesLabelReference(ref, id))},
    async requests(ref) {return [...requests.keys()].filter(id => matchesLabelReference(ref, id))}}, rerun)
  const createService = () => new PrRoutineCheckService(rows, {async context() {return {...structuredClone(context),labelActors:Object.fromEntries(context.labels.filter(label=>label.startsWith('rerun:')).map(label=>[label,labelActor])),labelEvents:Object.fromEntries(context.labels.filter(label=>label.startsWith('rerun:')).map(label=>[label,labelEvent]))}}, async permission() {return mayWrite}, async ownedCheck() {return true}, async findCheck() {return 99}, async deliver() {return 99}, async producer() {return undefined}, async requestBuild() {}}, jobs as any,
    {async catalog(revision) {return {routineRevision: revision!, routines: ['one','two'].map(routineId => ({routineId, platforms: ['android']}))}}},
    {async getExact(id: string) {const definition = {id, title: id, steps: [{id: 'observe', instruction: 'Observe'}], platforms: ['android']}; return {definition, definitionSha256: requestInputDigest(definition)} as any}},
    {async inventory() {return available ? [{headSha: context.headSha, availability: 'available', source: {channel: 'pr', prNumber: 12, buildRunId: 44, publicationAttempt: 1}}] as any : []}}, requestReader as any, results as any, suite, rerun, {async get() {return null}}, () => now, {async resolve() {return 'a'.repeat(40)}}, references,{async attach(requestId,pr,actor){followUpCalls.push({requestId,pr,actor});if(failFollowUp)throw Error('case archive unavailable');return{caseId:'mfc_'+'1'.repeat(64)}}})
  let service = createService()
  const gateId = prRoutineGateId(context.headSha)
  return {followUpCalls,failFollowUp(value:boolean){failFollowUp=value},authority(actor: string, event: number, write: boolean) {labelActor=actor;labelEvent=event;mayWrite=write}, get service() {return service}, restart() {service=createService()}, references, loseRerunCommit() {lostRerunCommit=true}, losePreviewCheckpoint() {lostPreviewCheckpoint=true}, failedAdmission(value?: string) {failedAdmission=value}, reruns, suite, rerun, requests, submitted, cancelled, suites, context, gate: () => gates.get(gateId)!.payload, advance(ms: number) {now += ms}, available(value: boolean) {available = value},
    async start() {await service.intake(12,'event','c'.repeat(64)); for (let i=0;i<6;i++) {now+=30000; await service.tick()}},
    async drain(count=3) {for (let i=0;i<count;i++) {now+=30000; await service.tick()}},
    control(deliveryId: string) {const gate = gates.get(gateId)!.payload; return {deliveryId, digest: 'c'.repeat(64), gateId, checkId: 99, externalId: gate.checkExternalId, headSha: context.headSha, kind: 'rerun' as const, actor: 'operator'}},
    publishPass(id: string) {const request=requests.get(id), selection=request.fleetSelection, timestamp=new Date(now).toISOString(); runs.set(id,{uploadsComplete:true,payload:{schemaVersion:1,hostId:request.hostId,requestId:id,routineId:selection.routineId,routineSource:selection.routineSource,definitionRevision:selection.routineRevision,platform:selection.platform,laneId:'android',build:selection.build,startedAt:timestamp,finishedAt:timestamp,assets:[],result:{runId:id,finishedAt:timestamp,setup:{status:'passed'},test:'passed',steps:[{id:'observe',status:'passed',durationMs:1}],teardown:{ready:true,outcomes:[],errors:[],unavailableResources:[]},failures:[],evidence:[],timing:{startedAt:timestamp,setupMs:0,testMs:1,teardownMs:0}}}}); const row=runs.get(id),payload=row.payload,payloadSha256=requestInputDigest(payload); Object.assign(row,{runId:id,requestId:id,build:payload.build,payloadSha256,summaryProjection:createRecordedFrameworkRunSummaryProjection(payload,payloadSha256)}); request.state='terminal';request.terminalStatus='pass';request.dispatchCompletion={disposition:'clean'}},
    publishFailed(id: string) {this.publishPass(id); const run=runs.get(id)!.payload; run.result.test='failed'; run.result.steps[0].status='failed'; run.result.failures=[{phase:'test',actionId:'observe',message:'Expected test observation absent'}]; const row=runs.get(id),payloadSha256=requestInputDigest(run);Object.assign(row,{payloadSha256,summaryProjection:createRecordedFrameworkRunSummaryProjection(run,payloadSha256)});requests.get(id)!.terminalStatus='failed'},
    settle() {for (const request of requests.values()) {request.state='terminal'; request.terminalStatus='cancelled'; request.dispatchCompletion={disposition:'clean'}}},
  }
}

test('real suite completion makes cancelled and timed-out multi-member originals eligible for normal linked preview/submit only after custody settles', async () => {
  for (const mode of ['cancel','timeout'] as const) {
    const f=fixture(); await f.start(); const suiteId=f.gate().attempt.suiteId!;
    expect((await f.suite.detail(suiteId)).members.map(member => member.status)).toEqual(['waiting','waiting']);
    if (mode==='cancel') await f.service.cancelFromAdmin(f.gate().gateId,{operationId:'00000000-0000-4000-8000-000000000001',coverageGeneration:1,attemptGeneration:1},'admin:operator'); else f.advance(3*3600000);
    await f.drain(1); expect((await f.suite.detail(suiteId)).finishedAt).toBeUndefined();
    if (mode==='timeout') expect(f.gate().attempt.conclusion).toBe('timed_out');
    if (mode==='timeout') await expect(f.service.control(f.control(`early-${mode}`))).rejects.toThrow('ownership is still settling');
    else {await f.service.control(f.control('early-cancel')); expect(f.gate().attempt.generation).toBe(1)}
    f.settle(); await f.drain(); const completed=await f.suite.detail(suiteId);
    expect(completed.finishedAt).toBeDefined(); expect(completed.members.map(member=>member.status)).toEqual(['not-run','not-run']);
    await f.service.control(f.control(`settled-${mode}`)); await f.drain();
    expect(f.gate().attempt.generation).toBe(2); expect(f.gate().attempt.rerun!.groups![0]!.previewDigest).toBeDefined();
    expect(f.gate().attempt.members.every(member=>member.requestId!.startsWith('rerun-'))).toBe(true);
    expect(new Set(f.submitted.filter(id=>id.startsWith('rerun-'))).size).toBe(2);
    expect((await f.suite.detail(suiteId)).finishedAt).toBe(completed.finishedAt);
  }
})

test('partial binding completes the original suite but a first admission in its rerun retains an ordinary original identity', async () => {
  const f=fixture(); await f.start(); const suiteId=f.gate().attempt.suiteId!;
  const waiting=f.gate().attempt.members[1]!; f.requests.delete(waiting.requestId!); delete waiting.requestId; delete waiting.originalRequestId; delete waiting.suiteBound; delete waiting.selection; waiting.status='waiting for app build'; waiting.settled=false;
  const row=f.suites.get(suiteId)!; delete row.payload.members[1].requestId;
  f.available(false); await f.service.cancelFromAdmin(f.gate().gateId,{operationId:'00000000-0000-4000-8000-000000000001',coverageGeneration:1,attemptGeneration:1},'admin:operator');
  f.settle(); await f.drain(); expect((await f.suite.detail(suiteId)).members.map(member=>member.status)).toEqual(['not-run','not-run']);
  await f.service.control(f.control('partial-rerun')); f.available(true); await f.drain(4);
  expect(f.gate().attempt.members[0]!.requestId).toMatch(/^rerun-/);
  expect(f.gate().attempt.members[1]!.requestId).toMatch(/^pr-routine-/);
  expect(f.gate().attempt.members[1]!.originalRequestId).toBe(f.gate().attempt.members[1]!.requestId);
  expect(f.gate().attempt.members[1]!.status).toBe('running');
})

test('a first admission after partial-suite completion can itself be rerun through its actual original request', async () => {
  const f=fixture(); await f.start(); const suiteId=f.gate().attempt.suiteId!, waiting=f.gate().attempt.members[1]!;
  f.requests.delete(waiting.requestId!); delete waiting.requestId; delete waiting.originalRequestId; delete waiting.suiteBound; delete waiting.selection; waiting.status='waiting for app build'; waiting.settled=false; delete f.suites.get(suiteId)!.payload.members[1].requestId;
  f.available(false); await f.service.cancelFromAdmin(f.gate().gateId,{operationId:'00000000-0000-4000-8000-000000000001',coverageGeneration:1,attemptGeneration:1},'admin:operator'); f.settle(); await f.drain();
  await f.service.control(f.control('first-partial-rerun')); f.available(true); await f.drain(4); f.settle(); await f.drain(3);
  await f.service.control(f.control('second-partial-rerun')); await f.drain(3);
  expect(f.gate().attempt.generation).toBe(3);
  expect(f.gate().attempt.members.every(member=>member.requestId!.startsWith('rerun-'))).toBe(true);
  expect(f.gate().attempt.members.every(member=>member.status==='running')).toBe(true);
})

test('ordinary completed suite retains a qualified pass while native rerun selects only the latest unsuccessful member', async () => {
  const f=fixture(); await f.start(); const passed=f.gate().attempt.members[0]!.requestId!, failed=f.gate().attempt.members[1]!.requestId!;
  f.publishPass(passed); f.publishFailed(failed); await f.drain(); const suiteId=f.gate().attempt.suiteId!, original=await f.suite.detail(suiteId);
  expect(original.members.map(member=>member.status)).toEqual(['pass','failed']); expect(original.passed).toBe(1);
  await f.service.control(f.control('mixed-rerun')); await f.drain();
  expect(f.gate().attempt.members[0]!.requestId).toBe(passed); expect(f.gate().attempt.members[0]!.status).toBe('pass');
  expect(f.gate().attempt.members[1]!.requestId).not.toBe(failed); expect(f.gate().attempt.members[1]!.requestId).toMatch(/^rerun-/);
  expect((await f.suite.detail(suiteId)).passed).toBe(1); expect(new Set(f.submitted.filter(id=>id.startsWith('rerun-'))).size).toBe(1);
})

test('same-head coverage retirement completes its settled original suite and admits the new coverage independently', async () => {
  const f=fixture(); await f.start(); const previous=f.gate().attempt.suiteId!;
  f.context.labels=['routine:one']; await f.drain(2); expect((await f.suite.detail(previous)).finishedAt).toBeUndefined();
  f.settle(); await f.drain(5); expect((await f.suite.detail(previous)).finishedAt).toBeDefined();
  expect(f.gate().coverageGeneration).toBe(2); expect(f.gate().attempt.members).toHaveLength(1);
  expect(f.gate().attempt.members[0]!.status).toBe('running'); expect(f.gate().attempt.suiteId).toBeUndefined();
})

test('cancelled waiting-build coverage uses ordinary completed suite records without inventing accepted request bindings', async () => {
  const f=fixture(); f.available(false); await f.start(); const suiteId=f.gate().attempt.suiteId!;
  expect(f.requests.size).toBe(0); await f.service.cancelFromAdmin(f.gate().gateId,{operationId:'00000000-0000-4000-8000-000000000001',coverageGeneration:1,attemptGeneration:1},'admin:operator'); await f.drain();
  const completed=await f.suite.detail(suiteId); expect(completed.finishedAt).toBeDefined(); expect(completed.members.every(member=>!member.requestId&&member.status==='not-run')).toBe(true);
  await f.service.control(f.control('waiting-source-rerun')); f.available(true); await f.drain(4);
  expect(f.gate().attempt.members.every(member=>member.originalRequestId&&member.requestId!.startsWith('pr-routine-'))).toBe(true);
  expect(f.gate().attempt.rerun!.groups).toBeUndefined();
})


test('restart after actual linked acceptance reuses the accepted plan and exact child IDs when the gate commit was lost', async () => {
  const f=fixture(); await f.start(); f.settle(); await f.drain();
  await f.service.control(f.control('restart-rerun')); f.loseRerunCommit(); await f.drain(3);
  const accepted=[...f.reruns.values()].find(row=>row.state==='accepted')!; const children=accepted.plan.members.map(member=>member.requestId);
  expect(children.every(id=>f.requests.has(id))).toBe(true); expect(f.gate().attempt.rerun!.groups![0]!.previewDigest).toBeDefined();
  f.restart(); await f.drain(3);
  expect(f.reruns.size).toBe(1); expect(f.gate().attempt.members.map(member=>member.requestId).sort()).toEqual(children.sort());
  expect(new Set(f.submitted.filter(id=>id.startsWith('rerun-'))).size).toBe(2);
  const view=await f.service.adminDetail(f.gate().gateId);
  expect(view.members.every(member=>member.resultsUrl?.endsWith(encodeURIComponent(f.gate().attempt.members.find(value=>value.memberId===member.id)!.requestId!)))).toBe(true);
})

test('a positively expired unaccepted ordinary preview renews after restart with the same check deadline', async () => {
  for (const lostCommit of [false,true]) {
    const f=fixture(); await f.start(); f.settle(); await f.drain(); await f.service.control(f.control(`preview-crash-${lostCommit}`));
    const deadline=f.gate().attempt.deadline; const submit=spyOn(f.rerun,'submit').mockRejectedValue(new TestRunError(503,'Process stopped before submit')); mocks.push(submit);
    await f.drain(1); if (lostCommit) f.losePreviewCheckpoint(); await f.drain(1); submit.mockRestore();
    const original=[...f.reruns.values()][0]!; expect(original.state).toBe('preview'); expect(f.requests.size).toBe(2);
    f.advance(11*60000); f.restart(); await f.drain(5);
    expect(f.reruns.get(original.rerunId)!.state).toBe('preview'); expect([...f.reruns.values()].filter(row=>row.state==='accepted')).toHaveLength(1);
    expect(f.gate().attempt.deadline).toBe(deadline); expect(f.gate().attempt.members.every(member=>member.status==='running')).toBe(true);
    expect(new Set(f.submitted.filter(id=>id.startsWith('rerun-'))).size).toBe(2);
  }
})

test('partial ordinary linked admission resumes the failed member without replacing its accepted plan', async () => {
  const f=fixture(); await f.start(); f.settle(); await f.drain(); await f.service.control(f.control('partial-linked-admission'));
  const submit=spyOn(f.rerun,'submit'); submit.mockImplementation(async input=>{
    const row=f.reruns.get((input as {rerunId:string}).rerunId)!; f.failedAdmission(row.plan.members[1]!.requestId);
    submit.mockRestore(); return f.rerun.submit(input);
  }); mocks.push(submit); await f.drain(3);
  const accepted=[...f.reruns.values()][0]!; expect(accepted.state).toBe('accepted'); expect(f.gate().attempt.members.filter(member=>member.status==='running')).toHaveLength(1);
  f.failedAdmission(); f.restart(); await f.drain(3);
  expect(f.reruns.size).toBe(1); expect(f.gate().attempt.members.every(member=>member.status==='running')).toBe(true);
  expect(f.gate().attempt.members.map(member=>member.requestId).sort()).toEqual(accepted.plan.members.map(member=>member.requestId).sort());
})

test('a new head retires the original suite only after physical settlement', async () => {
  const f=fixture(); await f.start(); const suiteId=f.gate().attempt.suiteId!;
  f.context.headSha='f'.repeat(40); await f.drain(2); expect(f.gate().attempt.cancellation?.kind).toBe('superseded'); expect((await f.suite.detail(suiteId)).finishedAt).toBeUndefined();
  f.settle(); await f.drain(); expect(f.gate().attempt.conclusion).toBe('cancelled'); expect((await f.suite.detail(suiteId)).finishedAt).toBeDefined();
  expect(f.submitted.every(id=>id.startsWith('pr-routine-'))).toBe(true);
})


test('unavailable suite-group preview does not suppress an independent request-parent admission', async () => {
  const f=fixture(); await f.start(); const suiteId=f.gate().attempt.suiteId!, waiting=f.gate().attempt.members[1]!;
  f.requests.delete(waiting.requestId!); delete waiting.requestId; delete waiting.originalRequestId; delete waiting.suiteBound; delete waiting.selection; waiting.status='waiting for app build'; waiting.settled=false; delete f.suites.get(suiteId)!.payload.members[1].requestId;
  f.available(false); await f.service.cancelFromAdmin(f.gate().gateId,{operationId:'00000000-0000-4000-8000-000000000001',coverageGeneration:1,attemptGeneration:1},'admin:operator'); f.settle(); await f.drain();
  await f.service.control(f.control('first-independent-rerun')); f.available(true); await f.drain(4); f.settle(); await f.drain(3);
  await f.service.control(f.control('second-independent-rerun'));
  const originalPreview=f.rerun.preview.bind(f.rerun), preview=spyOn(f.rerun,'preview').mockImplementation(async(input,actor)=>{
    if ('suiteId' in (input as {parent:object}).parent) throw new TestRunError(503,'Suite history temporarily unavailable');
    return originalPreview(input,actor);
  }); mocks.push(preview); await f.drain(3);
  expect(f.gate().attempt.members[1]!.requestId).toMatch(/^rerun-/); expect(f.gate().attempt.members[1]!.status).toBe('running');
  expect(f.gate().attempt.conclusion).toBeUndefined(); expect(f.gate().attempt.rerun!.groups).toHaveLength(2);
  preview.mockRestore(); await f.drain(3); expect(f.gate().attempt.members.every(member=>member.status==='running')).toBe(true);
})


test('cancelled accepted rerun fences a child whose ordinary admission failed before a later identical submit', async () => {
  const f=fixture(); await f.start(); f.settle(); await f.drain(); await f.service.control(f.control('cancel-partial-linked'));
  const submit=spyOn(f.rerun,'submit').mockImplementation(async input=>{
    const row=f.reruns.get((input as {rerunId:string}).rerunId)!; f.failedAdmission(row.plan.members[1]!.requestId);
    submit.mockRestore(); return f.rerun.submit(input);
  }); mocks.push(submit); await f.drain(3);
  const accepted=[...f.reruns.values()][0]!, absent=accepted.plan.members[1]!.requestId;
  expect(f.requests.has(absent)).toBe(false);
  await f.service.cancelFromAdmin(f.gate().gateId,{operationId:'00000000-0000-4000-8000-000000000002',coverageGeneration:1,attemptGeneration:2},'admin:operator');
  f.settle(); await f.drain();
  expect(f.requests.get(absent)?.fleetCancellation).toBeDefined();
  f.failedAdmission(); await f.rerun.submit({rerunId:accepted.rerunId,previewDigest:accepted.previewDigest});
  expect(f.requests.get(absent)?.state).toBe('terminal');
})


test('cancellation fences a retained unaccepted preview before its later submit can claim and admit jobs', async () => {
  const f=fixture(); await f.start(); f.settle(); await f.drain(); await f.service.control(f.control('cancel-retained-preview'));
  const submit=spyOn(f.rerun,'submit').mockRejectedValue(new TestRunError(503,'Stopped before acceptance')); mocks.push(submit); await f.drain(2); submit.mockRestore();
  const preview=[...f.reruns.values()][0]!; expect(preview.state).toBe('preview'); expect(f.gate().attempt.members.every(member=>!f.requests.has(member.requestId!))).toBe(true);
  await f.service.cancelFromAdmin(f.gate().gateId,{operationId:'00000000-0000-4000-8000-000000000002',coverageGeneration:1,attemptGeneration:2},'admin:operator'); await f.drain();
  expect(f.gate().attempt.conclusion).toBe('cancelled'); expect(preview.plan.members.every(member=>f.requests.get(member.requestId)?.fleetCancellation)).toBe(true);
  await f.rerun.submit({rerunId:preview.rerunId,previewDigest:preview.previewDigest});
  expect(preview.plan.members.every(member=>f.requests.get(member.requestId)?.state==='terminal')).toBe(true);
})


test('cancel immediately after native rerun acceptance retains the predecessor original deadline before any preview', async () => {
 const f=fixture(); await f.start(); f.settle(); await f.drain(); const originalIds=f.gate().attempt.members.map(member=>member.requestId!);
 await f.service.control(f.control('cancel-before-preview'));
 expect(f.gate().attempt.deadline).not.toBe(f.requests.get(originalIds[0]!)!.fleetDeadline.toISOString());
 await f.service.cancelFromAdmin(f.gate().gateId,{operationId:'00000000-0000-4000-8000-000000000002',coverageGeneration:1,attemptGeneration:2},'admin:operator'); await f.drain();
 expect(f.gate().attempt.conclusion).toBe('cancelled'); expect(f.reruns.size).toBe(0); expect(f.requests.size).toBe(2);
})

test('tagged suite rerun becomes the existing check and preserves original source and verdict across restart', async () => {
 const f=fixture();await f.start();const originalIds=f.gate().attempt.members.map(member=>member.requestId!);
 for (const id of originalIds) f.publishFailed(id);await f.drain();const originalSuite=f.gate().attempt.suiteId!;
 const label=(await f.references.copy('one','s',originalSuite)).label;
 f.context.labels=[label];await f.service.intake(12,'tagged-suite','d'.repeat(64),structuredClone(f.context));await f.service.reconcile(f.gate().gateId, structuredClone(f.context));await f.drain(5);
 const member=f.gate().attempt.members[0]!;
 expect(member.followUp).toEqual({caseId:'mfc_'+'1'.repeat(64)});expect(f.followUpCalls[0]).toEqual({requestId:originalIds[0],pr:{repository:'Mentra-Community/MentraOS',number:12},actor:'operator'});
 expect(member.linkedTarget).toMatchObject({parent:{suiteId:originalSuite},memberId:'one.android'});
 expect(member.selection!.routineRevision).toBe('a'.repeat(40));expect(member.selection!.source.channel).toBe('pr');
 expect(member.requestId).toMatch(/^rerun-/);expect(f.gate().attempt.suiteId).toBeUndefined();
 const accepted=member.requestId!;f.restart();await f.drain(2);expect(f.gate().attempt.members[0]!.requestId).toBe(accepted);
 expect(new Set(f.submitted.filter(id=>id===accepted)).size).toBe(1);
 f.publishPass(accepted);await f.drain();expect(f.gate().attempt.conclusion).toBe('success');
 expect((await f.suite.detail(originalSuite)).members.map(member=>member.status)).toEqual(['failed','failed']);
 await f.service.control(f.control('tagged-rerun-control'));await f.drain();
 const next=f.gate().attempt.members[0]!.requestId!;expect(next).not.toBe(accepted);expect(f.gate().attempt.members[0]!.selection!.build).toEqual(member.selection!.build);
})

test('individual successor label stays in its original suite and outside reruns cannot qualify or be cancelled', async () => {
 const f=fixture();await f.start();for(const member of f.gate().attempt.members)f.publishFailed(member.requestId!);await f.drain();
 const originalSuite=f.gate().attempt.suiteId!;const first=await f.rerun.preview({rerunId:'outside-initial',parent:{suiteId:originalSuite},selection:{memberIds:['one.android']},reason:'Manual verification'},'employee');
 await f.rerun.submit({rerunId:first.rerunId,previewDigest:first.previewDigest});const earlier=first.plan.members[0]!.requestId;f.publishFailed(earlier);
 f.context.labels=[(await f.references.copy('one','r',earlier)).label];await f.service.intake(12,'tagged-individual','d'.repeat(64),structuredClone(f.context));await f.service.reconcile(f.gate().gateId, structuredClone(f.context));await f.drain(5);
 const owned=f.gate().attempt.members[0]!.requestId!;expect(f.gate().attempt.members[0]!.linkedTarget!.parent).toEqual({suiteId:originalSuite});
 f.publishFailed(owned);await f.drain();const outside=await f.rerun.preview({rerunId:'outside-later',parent:{suiteId:originalSuite},selection:{memberIds:['one.android']},reason:'Other employee'},'employee');
 await f.rerun.submit({rerunId:outside.rerunId,previewDigest:outside.previewDigest});const foreign=outside.plan.members[0]!.requestId;f.publishPass(foreign);
 await f.drain();expect(f.gate().attempt.conclusion).toBe('failure');expect(f.gate().attempt.members[0]!.requestId).toBe(owned);
 f.gate().attempt.conclusion=undefined;await f.service.cancelFromAdmin(f.gate().gateId,{operationId:'00000000-0000-4000-8000-000000000003',coverageGeneration:2,attemptGeneration:1},'admin:operator');await f.drain();
 expect(f.cancelled).not.toContain(foreign);expect(f.cancelled).not.toContain(earlier);
})


test('native rerun of mixed tagged results preserves the passing request and admits only the failed member', async () => {
 const f=fixture(); await f.start(); for (const member of f.gate().attempt.members) f.publishFailed(member.requestId!); await f.drain();
 const originalSuite=f.gate().attempt.suiteId!;
 f.context.labels=await Promise.all(['one','two'].map(async routineId=>(await f.references.copy(routineId,'s',originalSuite)).label));
 await f.service.intake(12,'mixed-tags','d'.repeat(64),structuredClone(f.context)); await f.service.reconcile(f.gate().gateId); await f.drain(6);
 const passed=f.gate().attempt.members.find(member=>member.routineId==='one')!.requestId!, failed=f.gate().attempt.members.find(member=>member.routineId==='two')!.requestId!;
 f.publishPass(passed); f.publishFailed(failed); await f.drain();
 const originalDeadline=f.requests.get(passed).fleetDeadline.toISOString(), before=f.submitted.filter(id=>id===passed).length;
 await f.service.control(f.control('mixed-tagged-retry')); await f.drain(5);
 expect(f.gate().attempt.members.find(member=>member.routineId==='one')!.requestId).toBe(passed);
 expect(f.submitted.filter(id=>id===passed)).toHaveLength(before);
 expect(f.requests.get(passed).fleetDeadline.toISOString()).toBe(originalDeadline);
 const retry=f.gate().attempt.members.find(member=>member.routineId==='two')!.requestId!;
 expect(retry).not.toBe(failed); f.publishPass(retry); await f.drain(); expect(f.gate().attempt.conclusion).toBe('success');
});

test('lost tagged preview checkpoint admits no job and immediate cancellation leaves no running child', async () => {
 const f=fixture(); await f.start(); for (const member of f.gate().attempt.members) f.publishFailed(member.requestId!); await f.drain();
 f.context.labels=[(await f.references.copy('one','s',f.gate().attempt.suiteId!)).label];
 await f.service.intake(12,'lost-tagged-preview','d'.repeat(64),structuredClone(f.context)); await f.service.reconcile(f.gate().gateId); await f.drain(2);
 f.losePreviewCheckpoint(); await f.drain(1);
 const preview=[...f.reruns.values()].find(row=>row.plan.rerunId.startsWith('pr-linked-'))!;
 expect(preview.state).toBe('preview'); expect(preview.plan.members.every(member=>!f.requests.has(member.requestId))).toBe(true);
 await f.service.cancelFromAdmin(f.gate().gateId,{operationId:'00000000-0000-4000-8000-000000000004',coverageGeneration:2,attemptGeneration:1},'admin:operator');
 f.restart(); await f.drain(); expect(f.gate().attempt.conclusion).toBe('cancelled');
 expect(preview.plan.members.every(member=>f.requests.get(member.requestId)?.fleetCancellation)).toBe(true);
 await f.rerun.submit({rerunId:preview.rerunId,previewDigest:preview.previewDigest});
 expect(preview.plan.members.every(member=>f.requests.get(member.requestId)?.state==='terminal')).toBe(true);
});

test('tagged submit retains durable request identity if the following check commit is lost and cancellation contains it', async () => {
 const f=fixture(); await f.start(); for (const member of f.gate().attempt.members) f.publishFailed(member.requestId!); await f.drain();
 f.context.labels=[(await f.references.copy('one','s',f.gate().attempt.suiteId!)).label];
 await f.service.intake(12,'lost-tagged-submit','d'.repeat(64),structuredClone(f.context)); await f.service.reconcile(f.gate().gateId); await f.drain(3);
 const retained=f.gate().attempt.members[0]!.requestId!; expect(retained).toMatch(/^rerun-/); expect(f.requests.has(retained)).toBe(false);
 f.loseRerunCommit(); await f.drain(1); expect(f.requests.has(retained)).toBe(true); expect(f.gate().attempt.members[0]!.requestId).toBe(retained);
 await f.service.cancelFromAdmin(f.gate().gateId,{operationId:'00000000-0000-4000-8000-000000000005',coverageGeneration:2,attemptGeneration:1},'admin:operator');
 f.restart(); await f.drain(1); expect(f.cancelled).toContain(retained); expect(f.gate().attempt.conclusion).toBeUndefined();
 f.settle(); await f.drain(); expect(f.gate().attempt.conclusion).toBe('cancelled');
});


test('same-label reapplication changes authority generation and cannot retain another employee approval',async()=>{
 const f=fixture();await f.start();for(const member of f.gate().attempt.members)f.publishFailed(member.requestId!);await f.drain();
 f.context.labels=[(await f.references.copy('one','s',f.gate().attempt.suiteId!)).label];await f.service.intake(12,'authority-start','d'.repeat(64),structuredClone(f.context));await f.service.reconcile(f.gate().gateId);await f.drain(6);
 const accepted=f.gate().attempt.members[0]!.requestId!;f.publishPass(accepted);await f.drain();expect(f.gate().attempt.conclusion).toBe('success');
 f.authority('triage-user',2,false);await f.service.reconcile(f.gate().gateId);await f.drain(3);
 expect(f.gate().coverageGeneration).toBe(3);expect(f.gate().selectionError).toContain('repository writer');expect(f.gate().attempt.conclusion).toBe('failure');
 f.authority('operator',3,true);await f.service.reconcile(f.gate().gateId);await f.drain(6);
 expect(f.gate().coverageGeneration).toBe(4);expect(f.gate().selectionError).toBeUndefined();expect(f.gate().attempt.members[0]!.requestId).not.toBe(accepted);
});

test('lost tagged child checkpoint renews only a positively expired unaccepted preview',async()=>{
 const f=fixture();await f.start();for(const member of f.gate().attempt.members)f.publishFailed(member.requestId!);await f.drain();
 f.context.labels=[(await f.references.copy('one','s',f.gate().attempt.suiteId!)).label];await f.service.intake(12,'expired-checkpoint','d'.repeat(64),structuredClone(f.context));await f.service.reconcile(f.gate().gateId);await f.drain(2);
 f.losePreviewCheckpoint();await f.drain(1);const preview=[...f.reruns.values()][0]!;expect(preview.state).toBe('preview');
 f.advance(11*60000);f.restart();await f.drain(5);
 expect(f.reruns.get(preview.rerunId)!.state).toBe('preview');expect([...f.reruns.values()].filter(row=>row.state==='accepted')).toHaveLength(1);
 expect(f.gate().attempt.members[0]!.status).toBe('running');expect(f.gate().attempt.members[0]!.linkedPreview!.renewals).toBe(1);
});

test('intended-fix outage keeps the preview identity and independent jobs moving until association is recorded',async()=>{
 const f=fixture();await f.start();for(const member of f.gate().attempt.members)f.publishFailed(member.requestId!);await f.drain()
 const suiteId=f.gate().attempt.suiteId!,original=f.gate().attempt.members[0]!.requestId!
 f.context.labels=[(await f.references.copy('one','s',suiteId)).label,'routine:two'];f.failFollowUp(true)
 await f.service.intake(12,'case-outage','d'.repeat(64),structuredClone(f.context));await f.service.reconcile(f.gate().gateId);await f.drain(12)
 const member=f.gate().attempt.members.find(row=>row.linkedTarget)!,retained=member.requestId!
 expect(retained).toMatch(/^rerun-/);expect(f.requests.has(retained)).toBe(false)
 expect(member.waitReason).toContain('intended fix');expect(f.gate().attempt.members.find(row=>!row.linkedTarget)?.originalRequestId).toBeDefined()
 f.restart();f.failFollowUp(false);await f.drain(3)
 expect(f.gate().attempt.members.find(row=>row.linkedTarget)!.requestId).toBe(retained);expect(f.requests.has(retained)).toBe(true)
 expect(f.followUpCalls.every(row=>row.requestId===original)).toBe(true)
})

test('mixed labelled linked and ordinary coverage omits only request identity from finite selection deduplication',async()=>{
 const f=fixture();await f.start();for(const member of f.gate().attempt.members)f.publishFailed(member.requestId!);await f.drain()
 const originalSuite=f.gate().attempt.suiteId!
 f.context.labels=[(await f.references.copy('one','s',originalSuite)).label,'routine:one','routine:two']
 await f.service.intake(12,'mixed-linked-ordinary','d'.repeat(64),structuredClone(f.context));await f.service.reconcile(f.gate().gateId);await f.drain(6)
 expect(f.gate().attempt.members).toHaveLength(2)
 expect(f.gate().attempt.members.find(member=>member.linkedTarget)?.requestId).toMatch(/^rerun-/)
 expect(f.gate().attempt.members.find(member=>!member.linkedTarget)?.routineId).toBe('two')
 expect(f.gate().attempt.members.every(member=>!!member.originalRequestId&&f.requests.has(member.requestId!))).toBe(true)
 expect(f.gate().reporting.error).toBeUndefined()
})
