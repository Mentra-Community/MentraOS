import {expect, test} from 'bun:test'
import {PrRoutineCheckService, prRoutineGateId, routineCheckPayload, routineCheckPublicName} from './pr-routine-check.service'
import type {PrRoutineCheckRepository} from './pr-routine-check.repository'
import type {PrRoutineCheckRow, PrRoutineContext, CheckPayload} from '../types/pr-routine-check.types'
import {requestInputDigest} from './test-request.service'
import {PrBuildDispatchFailure} from './pr-routine-check-github'
import {TestRunError} from './test-result-error'
import {testRoutineSource} from '../testing/framework-fixtures'

function fixture() {
  let now = Date.parse('2026-10-12T00:00:00Z'), lease = 0, resolveCount = 0, deliveries = 0, lostDelivery = false, unavailableDelivery = false, crashCreation = false, crashProducer = false
  const stored = new Map<string, PrRoutineCheckRow>(), events = new Map<string, string>(), requests = new Map<string, any>(), results = new Map<string, any>()
  const checkPayloads: CheckPayload[] = [], submissions: Array<{selection: any; deadline: string}> = [], cancellations: string[] = []
  const context: PrRoutineContext = {number: 12, headSha: 'b'.repeat(40), headRef: 'feature', baseRef: 'dev', open: true,
    sameRepository: true, labels: ['routine:login'], peers: [12]}
  const rows: PrRoutineCheckRepository = {
    async get(id) {return structuredClone(stored.get(id) ?? null)},
    async insert(payload, nextAt) {if (!stored.has(payload.gateId)) stored.set(payload.gateId, {gateId: payload.gateId, revision: 0, payload: structuredClone(payload), nextAt})},
    async claim(id) {const row = stored.get(id); if (!row || row.lease) return null; row.lease = {id: String(++lease), expiresAt: new Date(now + 120000)}; return structuredClone(row)},
    async save(row, payload, nextAt) {const current = stored.get(row.gateId)!; if (current.revision !== row.revision || current.lease?.id !== row.lease?.id) return false;
      stored.set(row.gateId, {gateId: row.gateId, revision: row.revision + 1, payload: structuredClone(payload), nextAt});
      if (crashCreation && payload.creation && !payload.checkId) {crashCreation = false; return false}
      if (crashProducer && Object.values(payload.buildRequests ?? {}).some(value => value.state === 'uncertain')) {crashProducer = false; return false}
      return true},
    async due(date) {return [...stored.values()].filter(row => row.nextAt <= date).map(row => row.gateId)},
    async predecessors(number, except) {return [...stored.values()].filter(row => row.payload.context.number === number && row.gateId !== except).map(row => row.gateId)},
    async eventsDue() {return []}, async eventSettled() {}, async event(id, hash) {if (events.has(id) && events.get(id) !== hash) throw Error('conflict'); events.set(id, hash)},
  }
  let builds: any[] = [], history: any[] = [], failSubmit = false, dispatchFailure: boolean | undefined
  const buildCalls: string[] = []
  let producerReceipt: {id: number; failed: boolean} | undefined, findCalls = 0
  const previews: any[] = [], rerunSubmits: any[] = []
  const definition = {id: 'login', title: 'Account login', steps: [{id: 'open', instruction: 'Open account'}, {id: 'check', instruction: 'Verify login'}], platforms: ['android']}
  const createService = () => new PrRoutineCheckService(rows, {
    async context() {return structuredClone(context)}, async permission() {return true}, async ownedCheck() {return true},
    async findCheck() {findCalls++; return deliveries && !lostDelivery ? 99 : undefined}, async producer() {return producerReceipt}, async deliver(_id, payload) {if (unavailableDelivery) throw Error('outage'); deliveries++; checkPayloads.push(structuredClone(payload)); if (lostDelivery) {lostDelivery = false, unavailableDelivery = false, crashCreation = false, crashProducer = false; throw Error('lost')} return 99}, async requestBuild(platform) {buildCalls.push(platform); if (dispatchFailure !== undefined) throw new PrBuildDispatchFailure(dispatchFailure)},
  }, {
    async freezeSelection(value: any) {return {...value, build: {repository: 'Mentra-Community/MentraOS', kind: 'android-apk', channel: 'pr', headSha: context.headSha, source: value.source,
      archive: {name: 'app.apk', url: 'https://artifactscdn.mentraglass.com/app.apk', size: 10, sha256: 'd'.repeat(64)}, receipt: {url: 'https://artifactscdn.mentraglass.com/receipt', size: 1, sha256: 'e'.repeat(64)}}} as any},
    async submitFrozen(selection, deadline) {submissions.push({selection: structuredClone(selection), deadline}); if (failSubmit) throw Error('unavailable before admission');
      if (!requests.has(selection.requestId)) requests.set(selection.requestId, {requestId: selection.requestId, fleetSelection: selection,
        fleetBinding: {hostId: 'testing-air-1', laneId: 'android'}, state: 'running'})
      return requests.get(selection.requestId)},
    async cancel(id) {cancellations.push(id); return {} as any},
  }, {async catalog(revision) {return {routineRevision: revision!, routines: [{routineId: 'login', platforms: ['android']}]}}},
  {async getExact() {return {routineId: 'login', platform: 'android', definitionRevision: 'a'.repeat(40), definitionSha256: requestInputDigest(definition),
    routineSource: testRoutineSource(), definition} as any}}, {async inventory() {return structuredClone(builds)}},
  {async get(id) {return requests.get(id) ?? null}}, {async summary(id) {if (!results.has(id)) throw new TestRunError(404, 'missing'); return results.get(id)}},
  {async create() {return {} as any}, async bind() {return {} as any}, async complete() {return {} as any}},
  {async preview(input: any) {previews.push(input); return {previewDigest: 'f'.repeat(64), plan: {members: []}} as any}, async submit(input: any) {rerunSubmits.push(input); return {} as any}, async history() {return {original: {} as any, attempts: history, nextBefore: null}}},
  {async get() {return null}}, () => now, {async resolve() {resolveCount++; return 'a'.repeat(40)}})
  let service = createService()
  const gateId = prRoutineGateId(context.headSha)
  return {get service() {return service}, restart() {service = createService()}, stored, context, requests, results, submissions, cancellations, checkPayloads, previews, rerunSubmits, buildCalls, dispatchFailure(value: boolean | undefined) {dispatchFailure = value},
    failSubmit(value = true) {failSubmit = value}, history(value: any[]) {history = value},
    gate: () => stored.get(gateId)!.payload, advance(ms = 30000) {now += ms}, get now() {return now},
    get resolves() {return resolveCount}, get deliveries() {return deliveries}, get findCalls() {return findCalls}, outage(value = true) {unavailableDelivery = value}, crashAtCreation() {crashCreation = true}, crashAtProducer() {crashProducer = true}, receipt(value: typeof producerReceipt) {producerReceipt = value}, loseDelivery() {lostDelivery = true},
    inventory(value: any[]) {builds = value},
    build() {builds = [{headSha: context.headSha, availability: 'available', source: {channel: 'pr', prNumber: 12, buildRunId: 44, publicationAttempt: 1}}]},
    async intake(event = 'event-one') {await service.intake(12, event, requestInputDigest(event)); await service.tick()},
    async drain(count = 6) {for (let i = 0; i < count; i++) {now += 30000; await service.tick()}}
  }
}

test('pending exact-head gate precedes source/build admission and freezes one main revision', async () => {
  const f = fixture(); await f.intake()
  expect(f.checkPayloads[0]).toMatchObject({head_sha: f.context.headSha, status: 'queued'})
  expect(f.submissions).toHaveLength(0); await f.drain(1); expect(f.resolves).toBe(1)
  await f.drain(2); expect(f.gate().attempt.members.map(row => row.memberId)).toEqual(['login.android'])
  f.build(); await f.drain(5)
  expect(f.submissions.length).toBeGreaterThan(0)
  expect(f.submissions[0]!.selection.routineRevision).toBe('a'.repeat(40))
  expect(f.submissions[0]!.deadline).toBe('2026-10-12T03:00:00.000Z'); expect(f.resolves).toBe(1)
})

test('published pass needs exact result plus ordinary custody completion', async () => {
  const f = fixture(); await f.intake(); f.build(); await f.drain()
  const member = f.gate().attempt.members[0]!, request = f.requests.get(member.requestId!)
  request.state = 'terminal'; request.terminalStatus = 'pass'
  f.results.set(member.requestId!, {routineId: 'login', platform: 'android', definitionRevision: 'a'.repeat(40),
    build: {headSha: f.context.headSha}, outcome: 'pass', uploadsComplete: false, evidenceStatus: 'complete'})
  await f.drain(1); expect(f.gate().attempt.conclusion).toBeUndefined()
  f.results.get(member.requestId!).uploadsComplete = true
  await f.drain(1); expect(f.gate().attempt.conclusion).toBeUndefined()
  request.dispatchCompletion = {disposition: 'clean'}
  await f.drain(2); expect(f.gate().attempt.conclusion).toBe('success')
})

test('lost GitHub delivery retries the identical intended payload without dispatching tests', async () => {
  const f = fixture(); f.loseDelivery(); await f.intake(); const first = f.checkPayloads[0]!
  await f.drain(1)
  expect(f.checkPayloads[1]).toEqual(first); expect(f.submissions).toHaveLength(0)
})

test('no labels succeeds explicitly, unsupported selected source fails and same-head ambiguity cannot pass', async () => {
  for (const kind of ['none', 'unsupported', 'ambiguous']) {
    const f = fixture()
    if (kind === 'none') {f.context.labels = []; f.context.sameRepository = false; f.context.baseRef = 'other'}
    if (kind === 'unsupported') f.context.sameRepository = false
    if (kind === 'ambiguous') f.context.peers = [12, 13]
    await f.intake(); await f.drain(4)
    expect(f.gate().attempt.conclusion).toBe(kind === 'none' ? 'success' : 'failure')
    expect(f.submissions).toHaveLength(0)
  }
})

test('cancellation command redelivery preserves one attempt and waits for native cessation', async () => {
  const f = fixture(); await f.intake(); f.build(); await f.drain()
  const g = f.gate(), command = {deliveryId: 'cancel-event', digest: 'c'.repeat(64), gateId: g.gateId,
    checkId: g.checkId!, externalId: g.checkExternalId, headSha: g.headSha, kind: 'cancel' as const, actor: 'employee'}
  await f.service.control(command); await f.service.control(command); await f.drain(1)
  expect(f.gate().controls).toHaveLength(1); expect(f.gate().attempt.conclusion).toBeUndefined()
  const request = f.requests.get(g.attempt.members[0]!.requestId!); request.state = 'terminal'; request.terminalStatus = 'cancelled'
  await f.drain(1); expect(f.gate().attempt.conclusion).toBeUndefined()
  request.dispatchCompletion = {disposition: 'repair'}
  await f.drain(2); expect(f.gate().attempt.conclusion).toBe('cancelled')
})

test('same-head label change resets gate and waits for old ownership before new admission', async () => {
  const f = fixture(); await f.intake(); f.build(); await f.drain()
  const original = f.gate().attempt.members[0]!.requestId!, count = f.submissions.length
  f.context.baseRef = 'staging'; await f.intake('base-changed'); await f.drain(4)
  expect(f.gate().coverageGeneration).toBe(2); expect(f.cancellations).toContain(original)
  expect(f.submissions).toHaveLength(count)
  expect(f.checkPayloads.at(-1)!.status).toBe('queued')
})

test('public projection refuses credential/contact/path copy and stale progress claims no movement', async () => {
  expect(routineCheckPublicName('Read secret token abc', 'check')).toBe('check')
  expect(routineCheckPublicName('employee@example.test', 'check')).toBe('check')
  const f = fixture(); await f.intake(); await f.drain(2)
  const payload = routineCheckPayload(f.gate(), f.now)
  expect(payload.output.summary).toContain('Progress unavailable')
  expect(payload.output.summary).not.toContain('device')
})

async function complete(f: ReturnType<typeof fixture>, outcome = 'failed') {
  const member = f.gate().attempt.members[0]!, request = f.requests.get(member.requestId!)
  request.state = 'terminal'; request.terminalStatus = outcome; request.dispatchCompletion = {disposition: 'clean'}
  f.results.set(member.requestId!, {routineId: 'login', platform: 'android', definitionRevision: 'a'.repeat(40),
    build: {headSha: f.context.headSha}, outcome, uploadsComplete: true, evidenceStatus: 'complete'})
  await f.drain(2)
}
function control(f: ReturnType<typeof fixture>, deliveryId: string, kind: 'rerun' | 'cancel' = 'rerun') {
  const gate = f.gate()
  return {deliveryId, digest: requestInputDigest(deliveryId), gateId: gate.gateId, checkId: gate.checkId!,
    externalId: gate.checkExternalId, headSha: gate.headSha, kind, actor: 'employee'}
}
test('duplicate native rerun retains one generation and fresh absolute deadline', async () => {
  const f = fixture(); await f.intake(); f.build(); await f.drain(); await complete(f)
  const command = control(f, 'rerun-event'), accepted = f.now
  await f.service.control(command); await f.service.control(command); await f.drain(1)
  expect(f.gate().attempt.generation).toBe(2); expect(f.gate().controls).toHaveLength(1)
  expect(f.gate().attempt.deadline).toBe(new Date(accepted + 3 * 3600000).toISOString())
  expect(f.previews[0].deadline).toBe(f.gate().attempt.deadline)
})
test('pre-admission timeout reruns as new ordinary request without fictional linked original', async () => {
  const f = fixture(); f.failSubmit(); await f.intake(); f.build(); await f.drain()
  const old = f.gate().attempt.members[0]!.requestId!; expect(f.requests.has(old)).toBe(false)
  f.advance(3 * 3600000); await f.service.reconcile(f.gate().gateId)
  expect(f.gate().attempt.conclusion).toBe('timed_out')
  f.failSubmit(false); const accepted = f.now
  await f.service.control(control(f, 'preadmission-rerun')); await f.drain(6)
  const member = f.gate().attempt.members[0]!
  expect(member.requestId).not.toBe(old); expect(f.requests.has(member.requestId!)).toBe(true)
  expect(f.previews).toHaveLength(0)
  expect(f.submissions.at(-1)!.deadline).toBe(new Date(accepted + 3 * 3600000).toISOString())
})
test('late old-head success intent cannot publish green after head changes', async () => {
  const f = fixture(); await f.intake(); f.build(); await f.drain(); await complete(f, 'pass')
  const gate = f.gate(), payload = routineCheckPayload(gate, f.now)
  gate.reporting.intended = {revision: 100, payload, digest: requestInputDigest(payload)}
  const before = f.checkPayloads.length; f.context.headSha = 'c'.repeat(40)
  await f.drain(1)
  expect(f.checkPayloads.slice(before).some(value => value.conclusion === 'success')).toBe(false)
  await f.drain(2); expect(f.gate().attempt.conclusion).toBe('cancelled')
})
test('active rerun and stale context control do not create replacement requests', async () => {
  const f = fixture(); await f.intake(); f.build(); await f.drain()
  await f.service.control(control(f, 'active-rerun'))
  expect(f.gate().attempt.generation).toBe(1); expect(f.previews).toHaveLength(0)
  const stale = control(f, 'late-control'); f.context.baseRef = 'staging'
  await expect(f.service.control(stale)).rejects.toThrow('context changed')
})
test('timeout ends check but unsettled custody blocks the next rerun', async () => {
  const f = fixture(); await f.intake(); f.build(); await f.drain()
  f.advance(3 * 3600000); await f.service.reconcile(f.gate().gateId)
  expect(f.gate().attempt.conclusion).toBe('timed_out'); expect(f.gate().attempt.members[0]!.settled).toBe(false)
  await expect(f.service.control(control(f, 'unsafe-rerun'))).rejects.toThrow('ownership is still settling')
  expect(f.gate().attempt.generation).toBe(1)
})
test('cancel reaches linked child and requires its independent custody receipt', async () => {
  const f = fixture(); await f.intake(); f.build(); await f.drain(); await complete(f)
  f.requests.set('child', {requestId: 'child', fleetBinding: {hostId: 'testing-air-1'}, state: 'running'})
  f.history([{requestId: 'child', attemptNumber: 1}]); f.gate().attempt.conclusion = undefined
  await f.service.control(control(f, 'cancel-linked', 'cancel')); await f.drain(1)
  expect(f.cancellations).toContain('child'); expect(f.gate().attempt.conclusion).toBeUndefined()
  f.requests.get('child').dispatchCompletion = {disposition: 'clean'}
  await f.drain(2); expect(f.gate().attempt.conclusion).toBe('cancelled')
})

test('queued gate uses configured Admin and stale elapsed stays at the observation boundary', async () => {
  const old = process.env.ADMIN_URL
  try {
    process.env.ADMIN_URL = 'https://admin.dev.mentraglass.com/'
    const f = fixture(); await f.intake(); await f.drain(2)
    const gate = f.gate(), member = gate.attempt.members[0]!
    member.requestId = 'run-one'
    member.progress = {requestId: 'run-one', requestDigest: 'a'.repeat(64), ownerGeneration: 1,
      controllerIncarnation: 'controller', sequence: 1, phase: 'test', currentStep: {id: 'open', index: 0},
      completedSteps: 0, totalSteps: 2, startedAt: '2026-10-12T00:00:00Z',
      lastProgressAt: '2026-10-12T00:00:10Z', observedAt: '2026-10-12T00:00:30Z'}
    const payload = routineCheckPayload(gate, f.now + 120000)
    expect(payload.details_url).toBe(`https://admin.dev.mentraglass.com/?prCheck=${gate.gateId}`)
    expect(payload.output.summary).toContain('Progress unavailable: Open account (1/2) · 0/2 test steps · 30s')
  } finally {if (old === undefined) delete process.env.ADMIN_URL; else process.env.ADMIN_URL = old}
})

test('rejected dispatch retries; uncertain acceptance waits for complete separated absence before recovery', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture(); f.dispatchFailure(uncertain); await f.intake(); await f.drain(5)
    const calls = f.buildCalls.filter(value => value === 'asg').length
    if (uncertain) expect(calls).toBe(1); else expect(calls).toBeGreaterThan(1)
    expect(f.gate().buildRequests?.asg?.state).toBe(uncertain ? 'uncertain' : 'intended')
    f.dispatchFailure(undefined); await f.drain(4)
    expect(f.buildCalls.filter(value => value === 'asg').length).toBe(calls + 1)
    expect(f.submissions).toHaveLength(0)
  }
})

test('restart after persisted check intent but before POST recovers from separated bounded absence', async () => {
  const f = fixture(); f.crashAtCreation(); await f.intake(); f.restart()
  expect(f.deliveries).toBe(0); expect(f.gate().creation!.attempts).toBe(1)
  await f.drain(3); expect(f.deliveries).toBe(0)
  await f.drain(2); expect(f.deliveries).toBeGreaterThan(0); expect(f.gate().checkId).toBe(99)
  expect(f.findCalls).toBeGreaterThanOrEqual(3)
})
test('restart before native producer POST recovers the same correlation after complete absence', async () => {
  const f = fixture(); await f.intake(); await f.drain(2); f.crashAtProducer(); await f.drain(1); f.restart()
  const intent = f.gate().buildRequests!.asg!, correlation = intent.operationId
  expect(intent.state).toBe('uncertain'); expect(f.buildCalls).toHaveLength(0)
  await f.drain(3); expect(f.buildCalls.filter(value => value === 'asg')).toHaveLength(0)
  await f.drain(2); expect(f.buildCalls).toContain('asg'); expect(f.gate().buildRequests!.asg!.operationId).toBe(correlation)
})
test('late producer acknowledgement adopts exact run and failed requested producer ends coverage promptly', async () => {
  const f = fixture(); f.dispatchFailure(true); await f.intake(); await f.drain(3)
  expect(f.buildCalls).toEqual(['asg']); f.receipt({id: 71, failed: true}); await f.drain(2)
  expect(f.buildCalls).toEqual(['asg']); expect(f.gate().attempt.members[0]!.status).toBe('not-run')
  expect(f.gate().attempt.conclusion).toBe('failure'); expect(f.gate().buildRequests!.asg!.runId).toBe(71)
})
test('delivery outage cannot starve timeout, head supersession or linked cancellation custody', async () => {
  const f = fixture(); await f.intake(); f.build(); await f.drain(); const requestId = f.gate().attempt.members[0]!.requestId!
  f.outage(); const pending = routineCheckPayload(f.gate(), f.now)
  f.gate().reporting.intended = {revision: 100, payload: pending, digest: requestInputDigest(pending)}
  f.advance(3 * 3600000); await f.drain(1)
  expect(f.gate().attempt.conclusion).toBe('timed_out'); expect(f.cancellations).toContain(requestId)
  expect(f.gate().attempt.members[0]!.settled).toBe(false)
  f.context.headSha = 'd'.repeat(40); const before = f.cancellations.length; await f.drain(2)
  expect(f.cancellations.length).toBeGreaterThan(before)
})
test('signed context intake persists pending state without GitHub metadata, delivery or admission', async () => {
  const f = fixture(); await f.service.intake(12, 'signed-event', 'd'.repeat(64), f.context)
  expect(f.deliveries).toBe(0); expect(f.resolves).toBe(0); expect(f.submissions).toHaveLength(0)
  expect(f.gate().reporting.intended!.payload.status).toBe('queued')
})

test('producer failure rerun resets unlinked status and actually admits recovered publication', async () => {
 const f = fixture(); f.dispatchFailure(true); await f.intake(); await f.drain(3);
 f.receipt({id: 71, failed: true}); await f.drain(2);
 expect(f.gate().attempt.conclusion).toBe('failure'); expect(f.submissions).toHaveLength(0);
 f.receipt(undefined); f.dispatchFailure(undefined); await f.service.control(control(f, 'build-failed-rerun')); f.build(); await f.drain(5);
 expect(f.gate().attempt.generation).toBe(2); expect(f.submissions.length).toBeGreaterThan(0);
 expect(f.gate().attempt.members[0]!.status).toBe('running');
 expect(f.gate().attempt.members[0]!.waitReason).toBeUndefined(); expect(f.previews).toHaveLength(0);
});
test('native rerun waits for its replacement producer while the previous failed publication remains visible', async () => {
 const f = fixture(); await f.intake();
 f.inventory([{headSha: f.context.headSha, availability: 'unavailable', producerStatus: 'failed',
   createdAt: new Date(f.now).toISOString(), source: {channel: 'pr', prNumber: 12, buildRunId: 71, publicationAttempt: 1}}]);
 await f.drain(3); expect(f.gate().attempt.conclusion).toBe('failure'); expect(f.submissions).toHaveLength(0);
 await f.service.control(control(f, 'old-publication-rerun')); await f.drain(5);
 expect(f.gate().attempt.generation).toBe(2); expect(f.gate().attempt.conclusion).toBeUndefined();
 expect(f.gate().attempt.members[0]!.settled).toBe(false); expect(f.buildCalls).toContain('android');
 f.build(); await f.drain(4); expect(f.submissions.length).toBeGreaterThan(0);
 expect(f.gate().attempt.members[0]!.status).toBe('running');
});
test('terminal and cancelling PATCH projections explicitly remove the Cancel action', async () => {
 const f = fixture(); await f.intake();
 expect(routineCheckPayload(f.gate(), f.now).actions).toEqual([]);
 f.gate().attempt.cancellation = {kind: 'cancel', requestedAt: new Date(f.now).toISOString()};
 expect(routineCheckPayload(f.gate(), f.now).actions).toEqual([]);
 f.gate().attempt.conclusion = 'cancelled';
 expect(routineCheckPayload(f.gate(), f.now).actions).toEqual([]);
});

test('authenticated Admin cancellation fences head/generations and duplicate operation preserves custody', async () => {
 const f = fixture(); await f.intake(); f.build(); await f.drain(); const gate = f.gate();
 const input = {operationId: '00000000-0000-4000-8000-000000000001', coverageGeneration: gate.coverageGeneration, attemptGeneration: gate.attempt.generation};
 await expect(f.service.cancelFromAdmin(gate.gateId, {...input, coverageGeneration: 99}, 'admin:operator')).rejects.toThrow('generation changed');
 f.context.baseRef = 'staging'; await expect(f.service.cancelFromAdmin(gate.gateId, input, 'admin:operator')).rejects.toThrow('context changed'); f.context.baseRef = 'dev';
 await f.service.cancelFromAdmin(gate.gateId, input, 'admin:operator'); await f.service.cancelFromAdmin(gate.gateId, input, 'admin:operator');
 expect(f.gate().controls.filter(value => value.kind === 'cancel')).toHaveLength(1); expect(f.gate().controls.at(-1)!.actor).toBe('admin:operator');
 await f.drain(1); expect(f.cancellations).toContain(gate.attempt.members[0]!.requestId!); expect(f.gate().attempt.conclusion).toBeUndefined();
 const view = await f.service.adminDetail(gate.gateId); expect(view.canCancel).toBe(false); expect(view.cancelling).toBe(true);
});

test('the same mounted Admin operation cancels a later rerun once, without replaying the prior generation', async () => {
 const f = fixture(); await f.intake(); f.build(); await f.drain(); const gate = f.gate();
 const input = {operationId: '00000000-0000-4000-8000-000000000001', coverageGeneration: gate.coverageGeneration, attemptGeneration: gate.attempt.generation};
 await f.service.cancelFromAdmin(gate.gateId, input, 'admin:operator'); await f.drain(1);
 const request = f.requests.get(gate.attempt.members[0]!.requestId!); request.state = 'terminal'; request.terminalStatus = 'cancelled'; request.dispatchCompletion = {disposition: 'clean'};
 await f.drain(2); expect(f.gate().attempt.conclusion).toBe('cancelled');
 await f.service.control(control(f, 'admin-following-rerun')); expect(f.gate().attempt.generation).toBe(2);
 await expect(f.service.cancelFromAdmin(gate.gateId, input, 'admin:operator')).rejects.toThrow('generation changed');
 const next = {...input, attemptGeneration: 2};
 await f.service.cancelFromAdmin(gate.gateId, next, 'admin:operator'); await f.service.cancelFromAdmin(gate.gateId, next, 'admin:operator');
 expect(f.gate().attempt.cancellation?.kind).toBe('cancel');
 expect(f.gate().controls.filter(value => value.kind === 'cancel')).toHaveLength(2);
 expect(new Set(f.gate().controls.filter(value => value.kind === 'cancel').map(value => value.id)).size).toBe(2);
});

test('public progress renders observed completed test counts across named lifecycle phases', async () => {
 const f = fixture(); await f.intake(); await f.drain(2); const member = f.gate().attempt.members[0]!;
 for (const phase of ['framework-setup', 'test', 'routine-teardown', 'publication'] as const) {
  member.progress = {requestId: 'run-one', requestDigest: 'd'.repeat(64), ownerGeneration: 1, controllerIncarnation: 'controller', sequence: 1,
   phase, completedSteps: 1, totalSteps: 2, startedAt: new Date(f.now - 30000).toISOString(), lastProgressAt: new Date(f.now).toISOString(), observedAt: new Date(f.now).toISOString()};
  expect(routineCheckPayload(f.gate(), f.now).output.summary).toContain('1/2 test steps');
 }
});
