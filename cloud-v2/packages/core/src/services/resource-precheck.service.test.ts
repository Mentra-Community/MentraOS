import {expect, test} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {ResourceReservationsService, type ResourceReservationHost, type ResourceReservationRepository} from './resource-reservations.service'
import {LaneControlsService, type LaneControlRepository, type LaneControlHost} from './lane-controls.service'
import {testFrameworkBinding} from '../testing/framework-fixtures'
import {requestInputDigest} from './test-request.service'
import {projectResourceLifecycle} from './resource-lifecycle.service'
import {hostStateSchema} from './test-host-state.service'
import {resourceAvailable} from './resource-readiness'
import {exclusiveResourceIntentSchema, hostResourceReservationsSchema, type ExclusiveResourceIntent, type ExclusiveHostReservation, type ExclusiveResourceReturn, type HostResourceReservation} from '../types/resource-reservations.types'
import {resourceLifecycleSubjectSchema, type ResourceLifecycleHistory} from '../types/resource-lifecycle.types'

const start = Date.parse('2026-10-18T23:00:00Z'), hash = 'a'.repeat(64)
function completedUnknownControls(f: ReturnType<typeof fixture>) {
  const now = Date.parse('2026-10-29T13:00:00Z')
  f.advance(now - start)
  const subject = f.subject(), check = f.intent.resourceCheck!
  subject.generation = check.subjectGeneration = 1390
  subject.status = 'unknown'; subject.idle.outcome = 'not-checked'; subject.idle.acceptedCheck = null
  check.deadlineAt = now + 60_000
  const journal = f.host.snapshot.resourceReservations!.resourceChecks![0]!
  journal.intent = structuredClone(f.intent); journal.resourceCheck = structuredClone(check)
  journal.observedAt = f.host.snapshot.observedAt
  journal.intentSha256 = requestInputDigest({...f.intent, controller: {incarnation: f.intent.controller.incarnation, generation: f.intent.controller.generation},
    dependencies: [{resourceId: check.resourceId, authorityHostId: 'mini', capability: 'resource-idle'}]})
  f.host.laneControls = [1240, 1253].map((generation, i) => {
    const operationId = ['d920b80e-1394-421b-9690-96144217a8fd', '5f2d96c8-7ea8-42df-9e87-3835cf2e1e66'][i]!
    const command = {operationId, hostId: 'mini', subject: {resourceId: check.resourceId, subjectGeneration: generation - 2},
      operatorId: 'c'.repeat(64), expiresAt: Date.parse('2026-10-25T20:05:00Z'), action: 'check' as const}
    return {command, receipt: {operationId, hostId: 'mini', subject: command.subject, inputSha256: requestInputDigest(command),
      completedAt: '2026-10-25T20:01:14.214Z', result: {status: 'accepted' as const,
        check: {operationId, resourceId: check.resourceId, generation, state: 'unknown' as const}}}}
  })
  return f
}

test('two completed October25 UNKNOWN receipts cannot block current generation1390 unowned precheck', async () => {
  const f = completedUnknownControls(fixture()), history = structuredClone(f.host.laneControls)
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('reserved')
  expect(f.writes).toHaveLength(1); expect(f.host.laneControls).toEqual(history)
})

test('retained recorder bytes do not reserve an unowned phone Check or change the original budget', async () => {
  const f = fixture(), retained = {id: randomUUID(), requestId: 'uploading-original', fleetInputSha256: hash,
    hostId: 'mini', laneId: 'android', poolId: 'mini-disk', minimumAvailableBytes: 1, reservedAt: f.host.snapshot.observedAt}
  f.host.resourceReservations = [retained]
  const original = structuredClone(f.intent)
  const answer = await f.service.acquire(f.intent, 'mini')
  expect(answer.status).toBe('reserved'); expect(answer.claims).toHaveLength(1)
  expect(f.writes).toHaveLength(1); expect(f.host.resourceReservations).toContainEqual(retained)
  expect(f.host.resourceReservations).toHaveLength(2); expect(f.intent).toEqual(original)
})

for (const condition of ['owned', 'checking', 'repair', 'unknown-writer'] as const) test(`completed Check receipts do not bypass current ${condition} custody`, async () => {
  const f = completedUnknownControls(fixture()), subject = f.subject()
  if (condition === 'owned') subject.owner = {id: 'current-owner', kind: 'run', generation: 1390, hostId: 'mini', laneId: 'android'}
  if (condition === 'checking') subject.status = 'checking'
  if (condition === 'repair') {subject.status = 'in-repair'; subject.repair.state = 'queued'}
  if (condition === 'unknown-writer') f.host.resourceReservations = [{kind: 'exclusive', id: randomUUID(),
    resourceId: f.intent.resourceCheck!.resourceId, authorityHostId: 'mini', borrowerHostId: 'mini', laneId: 'android',
    operationId: 'unknown-writer', intentSha256: hash, inputSha256: hash, owner: {id: 'unknown-writer', kind: 'run'},
    controllerIncarnation: 'controller', controllerGeneration: 1, borrowerSequence: f.host.sequence, reservedAt: f.host.snapshot.observedAt}]
  const retained = structuredClone(f.host.resourceReservations)
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
  expect(f.writes).toHaveLength(0); expect(f.host.resourceReservations).toEqual(retained)
})

function fixture(standalone = false) {
  let debugHistory: ResourceLifecycleHistory[] = []
  let now = start, lost = false, beforeWrite: (() => Promise<void>) | undefined, afterWrite: (() => Promise<void>) | undefined
  const at = () => new Date(now).toISOString(), binding = {...testFrameworkBinding(), routineApiVersion: 70}
  const resourceId = standalone ? 'google-account-exact' : 'phone-exact', laneId = standalone ? undefined : 'android'
  const contract = {version: 'baseline-v1', maximumAgeMs: 120000, qualifiedScope: {kind: 'same-controller' as const, controllerId: 'mini'},
    conditions: ['credential-and-no-owner'], repairConfigured: true}
  const subject = resourceLifecycleSubjectSchema.parse({subject: {kind: 'resource', id: resourceId, authorityHostId: 'mini'}, generation: 2,
    status: 'idle', observedAt: at(), receivedAt: at(), current: true, reason: null, owner: null,
    idle: {contractVersion: contract.version, outcome: 'passed', checkedAt: at(), acceptedCheck: {operationId: 'previous', subjectGeneration: 2,
      resultSha256: hash, acceptedAt: at()}, qualifiedScope: contract.qualifiedScope, evidenceRefs: []}, repair: {configured: true, state: 'none'},
    supportedActions: ['reserve','release','check','mark-out-of-service'], resource: {kind: standalone ? 'fixture-data' : 'phone', capabilities: [],
      memberships: standalone ? [] : [{hostId: 'mini', laneId}], dependencies: [], placement: standalone ? 'fleet' : 'installed'}})
  const ref = {id: resourceId, kind: standalone ? 'fixture-data' as const : 'phone' as const, idleContract: contract}
  const host: ResourceReservationHost = {hostId: 'mini', incarnation: 'controller', incarnationGeneration: 1, sequence: 1,
    receivedAt: new Date(now), resourceReservationVersion: 0, resourceReservations: [], laneControlVersion: 0, laneControls: [], snapshot: hostStateSchema.parse({
      hostId: 'mini', incarnation: 'controller', incarnationGeneration: 1, sequence: 1, observedAt: at(), frameworkBinding: binding,
      frameworkAcceptedAt: at(), frameworkProcess: {pid: 100, startedAt: 'exact-lifetime'}, resourceLifecycle: {schemaVersion: 1, subjects: [subject], history: []},
      laneControls: {schemaVersion: 1, receipts: [], resourceControls: true}, resourceReservations: {claims: [], returns: [], resourceChecks: []},
      ...(standalone ? {resources: [ref]} : {}), lanes: standalone ? [] : [{id: laneId, platform: 'android', dispatchMode: 'automatic', state: 'idle', resources: [ref]}]})}
  const operationId = 'check-original', intent: ExclusiveResourceIntent = {operationId, hostId: 'mini', ...(laneId ? {laneId} : {}),
    controller: {incarnation: 'controller', generation: 1, sequence: 1}, owner: {kind: 'boundary-cleanup',
      id: `resource-check:${requestInputDigest({operationId,resourceId})}`}, inputSha256: hash, resources: [{id: resourceId, capabilities: ['resource-idle']}],
    resourceCheck: {resourceId, subjectGeneration: 2, contractVersion: contract.version, deadlineAt: now + 60000, binding,
      controller: {incarnation: 'controller', generation: 1}}}
  const digest = requestInputDigest({...intent, controller: {incarnation: 'controller', generation: 1},
    dependencies: [{resourceId, authorityHostId: 'mini', capability: 'resource-idle'}]})
  host.snapshot.resourceReservations!.resourceChecks = [{intentSha256: digest, operationId, resourceId, resourceCheck: intent.resourceCheck!,
    intent: structuredClone(intent), state: 'prepared', observedAt: at()}]
  const writes: HostResourceReservation[][] = []
  const repository: ResourceReservationRepository = {async get(id) {return id === 'mini' ? structuredClone(host) : null}, async replace(previous, claims) {
    if (beforeWrite) {const action=beforeWrite; beforeWrite=undefined; await action()}
    if (previous.sequence !== host.sequence || previous.incarnation !== host.incarnation || previous.incarnationGeneration !== host.incarnationGeneration ||
      previous.resourceReservationVersion !== host.resourceReservationVersion || previous.laneControlVersion !== host.laneControlVersion) return false
    host.resourceReservations=structuredClone(claims); host.resourceReservationVersion!++; writes.push(structuredClone(claims))
    if (afterWrite) {const action=afterWrite; afterWrite=undefined; await action()}
    if (lost) {lost=false; throw Error('Original CAS response lost')}
    return true
  }}
  const controlsRows: LaneControlRepository = {async get(id) {return id === 'mini' ? {...structuredClone(host),observedAt:new Date(host.snapshot.observedAt)} as LaneControlHost : null},
    async replace(id, version, records, authority) {
      if(id !== host.hostId || version !== host.laneControlVersion || authority && authority.resourceReservationVersion !== host.resourceReservationVersion) return false
      host.laneControls=structuredClone(records); host.laneControlVersion!++; return true
    }}
  const controls = new LaneControlsService(controlsRows, () => now, {async detail() {
    const projected=projectResourceLifecycle([host],now).subjects[0]!
    return {generatedAt:at(), coverage:'Actual Core canonical projection from inert host CAS', subject:projected}
  }})
  const service=new ResourceReservationsService(repository, () => now)
  return {host, intent, digest, service, controls, writes,
    get debugHistory() {return debugHistory}, set debugHistory(value: ResourceLifecycleHistory[]) {debugHistory=value}, subject:()=>host.snapshot.resourceLifecycle!.subjects[0]!,
    beforeWrite(action:()=>Promise<void>) {beforeWrite=action}, loseReply() {lost=true},
    afterWrite(action:()=>Promise<void>) {afterWrite=action},
    advance(ms=1) {now+=ms; host.sequence++;host.snapshot.sequence=host.sequence;host.snapshot.observedAt=at();host.receivedAt=new Date(now)
      host.snapshot.resourceLifecycle!.subjects[0]!.observedAt=at();host.snapshot.resourceLifecycle!.subjects[0]!.receivedAt=at()},
    control(action:'reserve'|'mark-out-of-service') {return {operationId:randomUUID(),hostId:'mini',subject:{resourceId,subjectGeneration:2},expiresAt:now+120000,
      action,...(action==='reserve'?{purpose:'Human reservation'}:{reason:'Human restriction'})}},
    return(claim:ExclusiveHostReservation, neverBegan=true) {
      this.advance(); const journal=host.snapshot.resourceReservations!.resourceChecks![0]!, eventId=`return:${operationId}`
      journal.state=neverBegan?'never-began':'began'; journal.observedAt=at();journal.eventId=eventId
      const s=this.subject();s.owner=null;s.generation++;s.status='unknown';s.idle.outcome='not-checked';s.idle.acceptedCheck=null
      const proof:ExclusiveResourceReturn={claimId:claim.id,authorityHostId:'mini',resourceId,intentSha256:digest,inputSha256:hash,originalOwner:intent.owner,
        ...(laneId?{laneId}:{}),controller:{incarnation:host.incarnation,generation:host.incarnationGeneration,sequence:host.sequence},
        release:{kind:neverBegan?'resource-check-not-started':'resource-check',operationId,subjectGeneration:s.generation,releasedAt:at(),eventId,
          ...(neverBegan?{resourceCheck:structuredClone(intent.resourceCheck!)}:{})} as ExclusiveResourceReturn['release']}
      if(!neverBegan)debugHistory.push({id:eventId,resourceId,subjectGeneration:s.generation,at:at(),event:'resource-check-released',checkOperationId:operationId})
      const {controller:_,...published}=proof;host.snapshot.resourceReservations!.returns=[published];return proof
    }}
}

function passiveScopeFixture() {
  const f = fixture(), lane = f.host.snapshot.lanes[0]!, lifecycle = f.host.snapshot.resourceLifecycle!
  f.subject().status = 'unknown'; f.subject().idle.outcome = 'not-checked'; f.subject().idle.checkedAt = null
  f.subject().idle.acceptedCheck = null
  f.subject().supportedActions = ['mark-out-of-service']
  const add = (id: string, dependencies: string[] = [], kind: typeof lane.resources[number]['kind'] = 'glasses') => {
    const ref = {...structuredClone(lane.resources[0]!), id, kind, idleContract: {...structuredClone(lane.resources[0]!.idleContract!), dependencies}}
    lane.resources.push(ref)
    if (kind === 'glasses') lane.glasses = [{resourceId: id, deviceId: '0123456789abcdef0123456789abcdef', model: 'mentra-live', capabilities: []}]
    const subject = {...structuredClone(f.subject()), subject: {...f.subject().subject, id},
      resource: {...structuredClone(f.subject().resource), kind}}
    lifecycle.subjects.push(subject)
    const intent = structuredClone(f.intent)
    intent.operationId = `check-${id}`; intent.resources[0]!.id = id; intent.resourceCheck!.resourceId = id
    intent.owner.id = `resource-check:${requestInputDigest({operationId: intent.operationId, resourceId: id})}`
    const intentSha256 = requestInputDigest({...intent, controller: {incarnation: 'controller', generation: 1},
      dependencies: [{resourceId: id, authorityHostId: 'mini', capability: 'resource-idle'}]})
    const journal = {intentSha256, operationId: intent.operationId, resourceId: id, intent: structuredClone(intent),
      resourceCheck: structuredClone(intent.resourceCheck!), state: 'prepared' as 'prepared' | 'began' | 'never-began', observedAt: f.host.snapshot.observedAt}
    f.host.snapshot.resourceReservations!.resourceChecks!.push(journal)
    return {ref, subject, intent, journal}
  }
  return {...f, lane, lifecycle, add}
}

test('disjoint unknown baseline probes acquire separate original claims on the same idle lane', async () => {
  const f = passiveScopeFixture(), other = f.add('independent-glasses')
  const first = await f.service.acquire(f.intent, 'mini')
  expect(first.status).toBe('reserved')
  const second = await f.service.acquire(other.intent, 'mini')
  expect(second.status).toBe('reserved'); expect(second.claims).toHaveLength(1)
  expect(f.host.resourceReservations).toContainEqual(first.claims[0]!); expect(f.host.resourceReservations).toHaveLength(2)
  expect(f.subject().owner).toBeNull(); expect(other.subject.owner).toBeNull()
  expect(resourceAvailable({...f.host, authorityReservations: f.host.resourceReservations}, other.ref.id, start)).toBe(false)
})

test('six independent probes retain their exact current returned baselines after observation age passes120s', async () => {
  const f = passiveScopeFixture(), kinds = ['glasses', 'app', 'recorder', 'audio', 'fixture-data'] as const,
    others = kinds.map((kind, i) => f.add(`independent-${i}`, [], kind))
  for (const intent of [f.intent, ...others.map(value => value.intent)])
    expect((await f.service.acquire(intent, 'mini')).status).toBe('reserved')
  expect(f.host.resourceReservations).toHaveLength(6)
  // Six serialized successful29s observations would age the first145s before
  // the last return. Concurrent original claims avoid that forced serialization;
  // each qualification still requires its actual observation and ordinary return; age cannot revoke a returned baseline.
  f.host.resourceReservations = []
  f.advance(6 * 29_000)
  for (const [i, subject] of f.lifecycle.subjects.entries()) {
    subject.observedAt = f.host.snapshot.observedAt; subject.receivedAt = subject.observedAt
    subject.status = 'idle'; subject.idle.outcome = 'passed'; subject.idle.checkedAt = new Date(start + (i + 1) * 29_000).toISOString()
    subject.idle.acceptedCheck = {operationId: `timing-${i}`, subjectGeneration: subject.generation, resultSha256: hash, acceptedAt: subject.idle.checkedAt}
  }
  expect(resourceAvailable(f.host, f.subject().subject.id, start + 6 * 29_000)).toBe(true)
  expect(resourceAvailable(f.host, others.at(-1)!.ref.id, start + 6 * 29_000)).toBe(true)
})

function beginPassiveCheck(f: ReturnType<typeof passiveScopeFixture>, intent: ExclusiveResourceIntent) {
  const subject = f.lifecycle.subjects.find(value => value.subject.id === intent.resourceCheck!.resourceId)!,
    journal = f.host.snapshot.resourceReservations!.resourceChecks!.find(value => value.operationId === intent.operationId)!
  journal.state = 'began'; journal.eventId = `resource-check-began:${intent.operationId}`
  subject.generation++; subject.status = 'checking'
  subject.owner = {...intent.owner, generation: 3, hostId: 'mini', laneId: 'android'}
  f.debugHistory.push({id: `checking:${intent.operationId}`, resourceId: subject.subject.id,
    subjectGeneration: subject.generation, event: 'checking', at: journal.observedAt})
}

test('a current began passive reader and its original claim remain intact during a disjoint admission', async () => {
  const f = passiveScopeFixture(), other = f.add('independent-glasses'), first = await f.service.acquire(f.intent, 'mini')
  beginPassiveCheck(f, f.intent)
  const original = structuredClone(f.subject())
  expect((await f.service.acquire(other.intent, 'mini')).status).toBe('reserved')
  expect(f.subject()).toEqual(original); expect(f.host.resourceReservations).toContainEqual(first.claims[0]!)
})

test('disjoint admission refuses unresolved original scopes, ownership, controls and stale source without removing claims', async () => {
  for (const mutate of [
    (f: ReturnType<typeof passiveScopeFixture>) => {f.host.snapshot.resourceReservations!.resourceChecks!.shift()},
    (f: ReturnType<typeof passiveScopeFixture>) => {f.host.snapshot.resourceReservations!.resourceChecks![0]!.state = 'never-began'},
    (f: ReturnType<typeof passiveScopeFixture>) => {f.host.snapshot.resourceReservations!.resourceChecks![0]!.intent.inputSha256 = 'b'.repeat(64)},
    (f: ReturnType<typeof passiveScopeFixture>) => {f.subject().status = 'unknown'; f.subject().owner = null},
    (f: ReturnType<typeof passiveScopeFixture>) => {f.subject().owner!.id = 'foreign-reader'},
    (f: ReturnType<typeof passiveScopeFixture>) => {f.subject().generation++},
    (f: ReturnType<typeof passiveScopeFixture>) => {f.subject().repair.state = 'running'},
    (f: ReturnType<typeof passiveScopeFixture>) => {f.subject().supportedActions = []},
    (f: ReturnType<typeof passiveScopeFixture>) => {f.subject().resource.memberships[0]!.hostId = 'foreign'},
    (f: ReturnType<typeof passiveScopeFixture>) => {(f.host.resourceReservations as ExclusiveHostReservation[])[0]!.controllerGeneration++},
    (f: ReturnType<typeof passiveScopeFixture>) => {(f.host.resourceReservations as ExclusiveHostReservation[])[0]!.resourceCheck!.deadlineAt = start},
    (f: ReturnType<typeof passiveScopeFixture>) => {f.lane.resources[0]!.idleContract!.dependencies = ['unreported-secondary']},
    (f: ReturnType<typeof passiveScopeFixture>) => {f.lane.resources[0]!.idleContract!.dependencies = [f.subject().subject.id]},
    (f: ReturnType<typeof passiveScopeFixture>) => {f.lane.resources[1]!.idleContract!.dependencies = [f.subject().subject.id]},
    (f: ReturnType<typeof passiveScopeFixture>) => {f.host.laneControls = [{command: {operationId: randomUUID(), hostId: 'mini',
      operatorId: hash, expiresAt: start + 120000, subject: {resourceId: f.subject().subject.id, subjectGeneration: f.subject().generation},
      action: 'mark-out-of-service', reason: 'Human withdrawal'}}]},
  ]) {
    const f = passiveScopeFixture(), other = f.add('independent-glasses')
    await f.service.acquire(f.intent, 'mini'); beginPassiveCheck(f, f.intent); mutate(f)
    const originalClaims = structuredClone(f.host.resourceReservations)
    expect((await f.service.acquire(other.intent, 'mini')).status).toBe('unknown')
    expect(f.writes).toHaveLength(1); expect(f.host.resourceReservations).toEqual(originalClaims)
  }
})

test('recorder and fixture probes sharing a secondary app still serialize', async () => {
  const f = passiveScopeFixture(), app = f.add('app-exact', [], 'app'),
    recorder = f.add('recorder-exact', [app.ref.id], 'recorder'), fixture = f.add('fixture-exact', [app.ref.id], 'fixture-data')
  const first = await f.service.acquire(recorder.intent, 'mini')
  expect(first.status).toBe('reserved')
  expect((await f.service.acquire(fixture.intent, 'mini')).status).toBe('unknown')
  expect(f.host.resourceReservations).toEqual(first.claims)
})

test('post-CAS changed passive scope refuses native authority while retaining the committed original', async () => {
  const f = passiveScopeFixture(), other = f.add('independent-glasses')
  await f.service.acquire(f.intent, 'mini')
  f.afterWrite(async () => {f.lane.resources[0]!.idleContract!.dependencies = [other.ref.id]})
  expect((await f.service.acquire(other.intent, 'mini')).status).toBe('unknown')
  expect(f.host.resourceReservations).toHaveLength(2)
  // The lost/refused reply is reconciled through the same actual committed claim.
  expect((await f.service.observe({intent: other.intent, controller: other.intent.controller}, 'mini')).status).toBe('reserved')
  expect(f.host.resourceReservations).toHaveLength(2); expect(f.writes).toHaveLength(2)
})

test('queued exact manual reserve or OOS wins before generic check changes local authority', async () => {
  for(const action of ['reserve','mark-out-of-service'] as const){const f=fixture();await f.controls.submit(f.control(action),'alice')
    expect((await f.service.acquire(f.intent,'mini')).status).toBe('unknown');expect(f.writes).toEqual([]);expect(f.subject().owner).toBeNull();expect(f.subject().generation).toBe(2)}
})
test('a manual command winning the reciprocal host CAS prevents all precheck writes',async()=>{
  const f=fixture();f.beforeWrite(async()=>{await f.controls.submit(f.control('reserve'),'alice')})
  expect((await f.service.acquire(f.intent,'mini')).status).toBe('unknown');expect(f.writes).toEqual([]);expect(f.host.laneControlVersion).toBe(1)
})
test('preclaim wins first and canonical custody disables later new manual control without erasing original',async()=>{
  const f=fixture(),result=await f.service.acquire(f.intent,'mini');expect(result.status).toBe('reserved');expect(result.claims).toHaveLength(1)
  await expect(f.controls.submit(f.control('reserve'),'alice')).rejects.toThrow();expect(await f.service.acquire(f.intent,'mini')).toEqual(result);expect(f.writes).toHaveLength(1)
})
test('standalone canonical resource gets a real same-host claim without a lane or exclusive dependency',async()=>{
  const f=fixture(true),result=await f.service.acquire(f.intent,'mini');expect(result.status).toBe('reserved');expect(result.claims).toHaveLength(1)
  expect(result.claims[0]).not.toHaveProperty('laneId');expect(result.claims[0]).toMatchObject({resourceId:'google-account-exact',authorityHostId:'mini',borrowerHostId:'mini',resourceCheck:f.intent.resourceCheck})
  expect(exclusiveResourceIntentSchema.safeParse({...f.intent,resourceCheck:undefined}).success).toBe(false)
  expect(await f.service.giveBack(f.return(result.claims[0]!,true),'mini')).toMatchObject({status:'returned'});expect(f.host.resourceReservations).toEqual([])
})
test('source, generation, contract, deadline, journal and currentness mismatches have no claim side effect',async()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>{f.host.snapshot.frameworkBinding!.routineApiVersion=69},
    (f:ReturnType<typeof fixture>)=>{f.host.snapshot.frameworkBinding!.revision='e'.repeat(40)},
    (f:ReturnType<typeof fixture>)=>{f.subject().generation++;f.subject().status='unknown'},
    (f:ReturnType<typeof fixture>)=>{f.subject().idle.contractVersion='different'},
    (f:ReturnType<typeof fixture>)=>{f.advance(60000)},
    (f:ReturnType<typeof fixture>)=>{f.host.snapshot.resourceReservations!.resourceChecks=[]},
    (f:ReturnType<typeof fixture>)=>{f.host.snapshot.resourceReservations!.resourceChecks![0]!.state='never-began'},
    (f:ReturnType<typeof fixture>)=>{f.subject().current=false},
    (f:ReturnType<typeof fixture>)=>{f.subject().status='out-of-service'},
    (f:ReturnType<typeof fixture>)=>{f.subject().repair.state='running'},
  ]){const f=fixture();mutate(f);expect((await f.service.acquire(f.intent,'mini')).status).toBe('unknown');expect(f.writes).toEqual([])}
})
test('lost original claim response reconciles the same claim and no-start returns after deadline or generation refusal',async()=>{
  const f=fixture();f.loseReply();await expect(f.service.acquire(f.intent,'mini')).rejects.toThrow('response lost')
  expect(f.host.resourceReservations).toHaveLength(1);f.advance(60001)
  const result=await f.service.observe({intent:f.intent,controller:{incarnation:f.host.incarnation,generation:1,sequence:f.host.sequence}},'mini')
  expect(result.status).toBe('reserved');expect(f.writes).toHaveLength(1)
  const proof=f.return(result.claims[0]!);f.subject().reason={code:'resource-operator-out-of-service',message:'Withdrawn'};f.subject().status='out-of-service'
  expect(await f.service.giveBack(proof,'mini')).toMatchObject({status:'returned'});expect(await f.service.giveBack(proof,'mini')).toMatchObject({status:'returned'})
  expect(f.host.resourceReservations).toEqual([])
})
test('began check raw return stays exact and recoverable after its original Core ACK is lost',async()=>{
  const f=fixture(),result=await f.service.acquire(f.intent,'mini'),proof=f.return(result.claims[0]!,false)
  expect(await f.service.giveBack(proof,'mini')).toMatchObject({status:'returned'});expect(await f.service.giveBack(proof,'mini')).toMatchObject({status:'returned'})
  expect(f.writes).toHaveLength(2)
})

async function completedHistoricalCheck() {
  const f=fixture(), first=await f.service.acquire(f.intent,'mini'), claim=first.claims[0]!, proof=f.return(claim,false)
  await f.service.giveBack(proof,'mini')
  f.advance();f.subject().generation+=2
  proof.controller.sequence=f.host.sequence
  return {f,claim,proof}
}
test('completed historical check ACK fences absence without renewing the newer unowned resource',async()=>{
  for(const status of ['unknown','out-of-service'] as const){
    const {f,claim,proof}=await completedHistoricalCheck()
    f.subject().status=status
    const {resourceCheck:_,...other}=claim, unrelated=['browser','glasses'].map(kind=>({...other,id:randomUUID(),resourceId:`${kind}-exact`,
      operationId:`other-${kind}`,intentSha256:'b'.repeat(64),inputSha256:'c'.repeat(64),owner:{kind:'run' as const,id:`other-${kind}`}}))
    expect(hostResourceReservationsSchema.parse(unrelated)).toEqual(unrelated)
    f.host.resourceReservations=structuredClone(unrelated)
    const lifecycle=structuredClone(f.host.snapshot.resourceLifecycle), writes=f.writes.length, version=f.host.resourceReservationVersion!
    expect(await f.service.giveBack(proof,'mini')).toEqual({status:'returned',claimId:claim.id})
    expect(f.writes).toHaveLength(writes+1);expect(f.host.resourceReservationVersion).toBe(version+1)
    expect(f.host.resourceReservations).toEqual(unrelated);expect(f.host.snapshot.resourceLifecycle).toEqual(lifecycle)
    expect(f.subject().idle.acceptedCheck).toBeNull();expect(f.subject().idle.outcome).toBe('not-checked')
    expect((await f.service.acquire(f.intent,'mini')).status).toBe('unknown')
  }
})
test('historical check ACK refuses altered original proof, current owner, stale reporter and generation rollback',async()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.subject().generation=2},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.subject().current=false},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.subject().owner={id:'replacement',kind:'run',generation:9,hostId:'mini',laneId:'android'}},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.advance(120001);p.controller.sequence=f.host.sequence;f.host.receivedAt=new Date(start)},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{p.controller.sequence--},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{p.controller.incarnation='foreign'},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.host.snapshot.resourceReservations!.returns=[]},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.host.snapshot.resourceReservations!.resourceChecks=[]},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.host.snapshot.resourceReservations!.resourceChecks![0]!.state='prepared'},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.host.snapshot.resourceReservations!.resourceChecks![0]!.intent.inputSha256='b'.repeat(64)},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.host.snapshot.resourceReservations!.resourceChecks![0]!.intent.owner.id='foreign'},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.host.snapshot.resourceReservations!.resourceChecks![0]!.resourceCheck.subjectGeneration++},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.host.snapshot.resourceReservations!.resourceChecks![0]!.observedAt=f.host.snapshot.observedAt},
  ]){const {f,proof}=await completedHistoricalCheck(),writes=f.writes.length;mutate(f,proof)
    await expect(f.service.giveBack(proof,'mini')).rejects.toThrow();expect(f.writes).toHaveLength(writes)}
})
test('historical check never relaxes a present original or foreign claim, or a never-began return',async()=>{
  for(const foreign of [false,true]){const {f,claim,proof}=await completedHistoricalCheck()
    f.host.resourceReservations=[{...claim,...(foreign?{id:randomUUID(),owner:{kind:'boundary-cleanup' as const,id:'foreign'}}:{})}]
    expect(f.host.resourceReservations).toEqual(hostResourceReservationsSchema.parse(f.host.resourceReservations))
    const retained=structuredClone(f.host.resourceReservations),writes=f.writes.length
    await expect(f.service.giveBack(proof,'mini')).rejects.toThrow();expect(f.host.resourceReservations).toEqual(retained);expect(f.writes).toHaveLength(writes)}
  const f=fixture(),first=await f.service.acquire(f.intent,'mini'),proof=f.return(first.claims[0]!,true)
  await f.service.giveBack(proof,'mini');f.advance();f.subject().generation++;proof.controller.sequence=f.host.sequence
  const writes=f.writes.length
  await expect(f.service.giveBack(proof,'mini')).rejects.toThrow();expect(f.writes).toHaveLength(writes)
})
test('same-generation check return still requires the exact present claim UUID',async()=>{
  const f=fixture(),first=await f.service.acquire(f.intent,'mini'),claim=first.claims[0]!,proof=f.return(claim,false)
  f.host.resourceReservations=[{...claim,id:randomUUID()}]
  const retained=hostResourceReservationsSchema.parse(f.host.resourceReservations),writes=f.writes.length
  await expect(f.service.giveBack(proof,'mini')).rejects.toThrow();expect(f.host.resourceReservations).toEqual(retained);expect(f.writes).toHaveLength(writes)
})
test('historical check completion must follow its matching frozen beginning generation',async()=>{
  for(const generation of [3,4]){const {f,proof}=await completedHistoricalCheck(),j=f.host.snapshot.resourceReservations!.resourceChecks![0]!
    j.resourceCheck.subjectGeneration=generation;j.intent.resourceCheck=structuredClone(j.resourceCheck)
    j.intentSha256=requestInputDigest({...j.intent,controller:{incarnation:j.intent.controller.incarnation,generation:j.intent.controller.generation},
      dependencies:[{resourceId:j.resourceId,authorityHostId:'mini',capability:'resource-idle'}]})
    proof.intentSha256=j.intentSha256;const {controller:_,...published}=proof;f.host.snapshot.resourceReservations!.returns=[published]
    expect(hostStateSchema.parse(f.host.snapshot)).toEqual(f.host.snapshot)
    const writes=f.writes.length;await expect(f.service.giveBack(proof,'mini')).rejects.toThrow();expect(f.writes).toHaveLength(writes)}
})
test('historical absence fence refuses a concurrent claim or changed report before commit',async()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>,claim:ExclusiveHostReservation)=>{f.host.resourceReservationVersion!++},
    (f:ReturnType<typeof fixture>,claim:ExclusiveHostReservation)=>{f.host.resourceReservations=[claim];f.host.resourceReservationVersion!++},
    (f:ReturnType<typeof fixture>,claim:ExclusiveHostReservation)=>{f.advance()},
    (f:ReturnType<typeof fixture>,claim:ExclusiveHostReservation)=>{f.host.laneControlVersion!++;f.subject().owner={id:'replacement',kind:'run',generation:9,hostId:'mini'}},
  ]){const {f,claim,proof}=await completedHistoricalCheck(),writes=f.writes.length;f.beforeWrite(async()=>{mutate(f,claim)})
    await expect(f.service.giveBack(proof,'mini')).rejects.toThrow();expect(f.writes).toHaveLength(writes)}
})
test('historical absence ACK re-reads the committed fence and refuses post-commit races',async()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>,claim:ExclusiveHostReservation)=>{f.host.resourceReservationVersion!++},
    (f:ReturnType<typeof fixture>,claim:ExclusiveHostReservation)=>{f.host.resourceReservations=[claim];f.host.resourceReservationVersion!++},
    (f:ReturnType<typeof fixture>,claim:ExclusiveHostReservation)=>{f.advance()},
    (f:ReturnType<typeof fixture>,claim:ExclusiveHostReservation)=>{f.host.laneControlVersion!++},
    (f:ReturnType<typeof fixture>,claim:ExclusiveHostReservation)=>{f.subject().owner={id:'replacement',kind:'run',generation:9,hostId:'mini',laneId:'android'}},
    (f:ReturnType<typeof fixture>,claim:ExclusiveHostReservation)=>{f.host.snapshot.resourceReservations!.returns=[]},
  ]){const {f,claim,proof}=await completedHistoricalCheck(),writes=f.writes.length;f.afterWrite(async()=>{mutate(f,claim)})
    await expect(f.service.giveBack(proof,'mini')).rejects.toThrow();expect(f.writes).toHaveLength(writes+1)}
})
test('lost historical absence fence response remains recoverable through the SAME return',async()=>{
  const {f,claim,proof}=await completedHistoricalCheck(),writes=f.writes.length;f.loseReply()
  await expect(f.service.giveBack(proof,'mini')).rejects.toThrow('response lost')
  expect(await f.service.giveBack(proof,'mini')).toEqual({status:'returned',claimId:claim.id})
  expect(f.writes).toHaveLength(writes+2);expect(f.host.resourceReservations).toEqual([]);expect(f.subject().idle.acceptedCheck).toBeNull()
})
test('missing no-start evidence, begun journal, foreign sidecar, owner or changed return report retain the original claim',async()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.host.snapshot.resourceReservations!.resourceChecks=[]},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.host.snapshot.resourceReservations!.resourceChecks![0]!.state='began'},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{if('resourceCheck' in p.release)p.release.resourceCheck.subjectGeneration++},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.subject().owner={id:'replacement',kind:'run',generation:20,hostId:'mini',laneId:'android'}},
    (f:ReturnType<typeof fixture>,p:ExclusiveResourceReturn)=>{f.host.snapshot.resourceReservations!.returns=[]},
  ]){const f=fixture(),result=await f.service.acquire(f.intent,'mini'),proof=f.return(result.claims[0]!);mutate(f,proof)
    await expect(f.service.giveBack(proof,'mini')).rejects.toThrow();expect(f.host.resourceReservations).toHaveLength(1)}
})
test('authentic never-began absence takes one CAS barrier and cannot revive the old operation',async()=>{
  const f=fixture(),journal=f.host.snapshot.resourceReservations!.resourceChecks![0]!;f.advance();journal.state='never-began';journal.eventId='no-start';journal.observedAt=f.host.snapshot.observedAt
  const result=await f.service.observe({intent:f.intent,controller:{incarnation:'controller',generation:1,sequence:f.host.sequence}},'mini')
  expect(result.status).toBe('not-acquired');expect(result.claims).toEqual([]);expect(f.writes).toHaveLength(1)
  expect((await f.service.acquire(f.intent,'mini')).status).toBe('unknown');expect(f.writes).toHaveLength(1)
})

test('failed generic precheck retains original claim through fixer until exact normal release lineage returns',async()=>{
  const f=fixture(),result=await f.service.acquire(f.intent,'mini'),claim=result.claims[0]!
  f.advance();const subject=f.subject(),fixer={id:'original-check-fixer',kind:'fixer' as const,generation:6}
  subject.owner={...fixer,hostId:'mini',laneId:'android'};subject.status='in-repair';subject.repair.state='running'
  expect(await f.service.observe({intent:f.intent,controller:{incarnation:'controller',generation:1,sequence:f.host.sequence}},'mini')).toMatchObject({status:'reserved'})
  const refused=f.return(claim);subject.owner={...fixer,hostId:'mini',laneId:'android'};subject.status='in-repair'
  await expect(f.service.giveBack(refused,'mini')).rejects.toThrow();expect(f.host.resourceReservations).toHaveLength(1)
  f.advance();subject.owner=null;subject.status='idle';subject.idle.outcome='passed';subject.idle.acceptedCheck={operationId:'original-fixer-baseline',subjectGeneration:subject.generation,resultSha256:hash,acceptedAt:f.host.snapshot.observedAt}
  subject.repair.state='none';const proof:ExclusiveResourceReturn={claimId:claim.id,authorityHostId:'mini',resourceId:claim.resourceId,
    intentSha256:claim.intentSha256,inputSha256:claim.inputSha256,originalOwner:claim.owner,laneId:'android',
    controller:{incarnation:'controller',generation:1,sequence:f.host.sequence},release:{eventId:`lane-release:${fixer.id}:6`,owner:fixer,
      releasedAt:f.host.snapshot.observedAt,lineage:[{...claim.owner,generation:3},fixer]}}
  const {controller:_,...published}=proof;f.host.snapshot.resourceReservations!.returns=[published]
  expect(await f.service.giveBack(proof,'mini')).toMatchObject({status:'returned'});expect(f.host.resourceReservations).toEqual([])
})

test('reported journal advances sequence while claim preserves the original frozen acquisition epoch',async()=>{
  const f=fixture();f.intent.controller.sequence=0;f.host.snapshot.resourceReservations!.resourceChecks![0]!.intent=structuredClone(f.intent)
  const result=await f.service.acquire(f.intent,'mini');expect(result.status).toBe('reserved');expect(result.claims[0]!.borrowerSequence).toBe(0)
  expect(f.host.sequence).toBe(1);expect(f.writes).toHaveLength(1)
})
test('first uncommissioned zero-generation never-began observation reports zero without local transition',async()=>{
  const f=fixture(),s=f.subject(),j=f.host.snapshot.resourceReservations!.resourceChecks![0]!
  s.generation=0;s.status='unknown';s.idle.outcome='not-checked';s.idle.acceptedCheck=null;f.intent.resourceCheck!.subjectGeneration=0
  const digest=requestInputDigest({...f.intent,controller:{incarnation:'controller',generation:1},dependencies:[{resourceId:s.subject.id,authorityHostId:'mini',capability:'resource-idle'}]})
  j.intent=structuredClone(f.intent);j.resourceCheck=structuredClone(f.intent.resourceCheck!);j.intentSha256=digest
  f.advance();j.state='never-began';j.eventId='zero-no-start';j.observedAt=f.host.snapshot.observedAt
  const result=await f.service.observe({intent:f.intent,controller:{incarnation:'controller',generation:1,sequence:f.host.sequence}},'mini')
  expect(result.status).toBe('not-acquired');if(result.status==='not-acquired')expect(result.fence.subjectGeneration).toBe(0)
  expect(s.generation).toBe(0);expect(s.owner).toBeNull();expect(f.writes).toEqual([[]])
})

test('source or incarnation replacement never adopts a foreign precheck, while accepted original stays cleanup-only',async()=>{
  const f=fixture(),first=await f.service.acquire(f.intent,'mini');f.advance()
  f.host.snapshot.frameworkBinding={...f.host.snapshot.frameworkBinding!,revision:'e'.repeat(40)}
  expect((await f.service.acquire(f.intent,'mini')).status).toBe('reserved')
  f.host.incarnation='replacement-controller';f.host.snapshot.incarnation=f.host.incarnation;f.host.incarnationGeneration=2;f.host.snapshot.incarnationGeneration=2
  expect((await f.service.acquire(f.intent,'mini')).status).toBe('unknown')
  expect((await f.service.observe({intent:f.intent,controller:{incarnation:f.host.incarnation,generation:2,sequence:f.host.sequence}},'mini')).claims).toEqual(first.claims)
  expect(f.writes).toHaveLength(1)
})
test('begun, unpublished, old-epoch or concurrently changed no-start absence has no terminal fence',async()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>{f.host.snapshot.resourceReservations!.resourceChecks![0]!.state='began'},
    (f:ReturnType<typeof fixture>)=>{f.host.snapshot.resourceReservations!.resourceChecks=[]},
    (f:ReturnType<typeof fixture>)=>{f.host.snapshot.resourceReservations!.resourceChecks![0]!.intent.controller.sequence++},
    (f:ReturnType<typeof fixture>)=>{f.beforeWrite(async()=>{f.advance()})},
  ]){const f=fixture(),j=f.host.snapshot.resourceReservations!.resourceChecks![0]!;f.advance();j.state='never-began';j.eventId='authentic-no-begin';j.observedAt=f.host.snapshot.observedAt;mutate(f)
    const result=await f.service.observe({intent:f.intent,controller:{incarnation:'controller',generation:1,sequence:f.host.sequence}},'mini')
    expect(result.status).toBe('unknown');expect(f.host.resourceReservations).toEqual([])}
})
test('an unchanged same-epoch reporter cannot confirm that the original preclaim never acquired',async()=>{
  const f=fixture(),j=f.host.snapshot.resourceReservations!.resourceChecks![0]!;j.state='never-began';j.eventId='local-no-begin'
  expect((await f.service.observe({intent:f.intent,controller:f.intent.controller},'mini')).status).toBe('unknown');expect(f.writes).toEqual([])
})
test('support-advertised controller cannot omit precheck sidecar and fall back to empty generic dependency success',async()=>{
  const f=fixture(),{resourceCheck:_,...legacy}=f.intent
  await expect(f.service.acquire(legacy,'mini')).rejects.toThrow('precheck authority');expect(f.writes).toEqual([])
})
test('standalone failed-check claim returns only through real cleanup lane and fresh own-resource baseline',async()=>{
  const f=fixture(true),first=await f.service.acquire(f.intent,'mini'),claim=first.claims[0]!;f.advance()
  f.host.snapshot.lanes=[{id:'repair-controller-lane',platform:'ios-on-mac',dispatchMode:'automatic',state:'idle',resources:[]}]
  const fixer={id:'standalone-fixer-original',kind:'fixer' as const,generation:9},s=f.subject();s.generation=5;s.idle.checkedAt=f.host.snapshot.observedAt
  s.idle.acceptedCheck={operationId:'standalone-return-baseline',subjectGeneration:5,resultSha256:hash,acceptedAt:f.host.snapshot.observedAt}
  const proof:ExclusiveResourceReturn={claimId:claim.id,authorityHostId:'mini',resourceId:claim.resourceId,intentSha256:claim.intentSha256,inputSha256:claim.inputSha256,
    originalOwner:claim.owner,laneId:'repair-controller-lane',controller:{incarnation:'controller',generation:1,sequence:f.host.sequence},
    release:{eventId:`lane-release:${fixer.id}:9`,owner:fixer,releasedAt:f.host.snapshot.observedAt,lineage:[{...claim.owner,generation:3},fixer]}}
  const {controller:_,...published}=proof;f.host.snapshot.resourceReservations!.returns=[published]
  s.idle.checkedAt=new Date(start-1).toISOString();await expect(f.service.giveBack(proof,'mini')).rejects.toThrow('fresh normal baseline')
  expect(f.host.resourceReservations).toHaveLength(1);s.idle.checkedAt=f.host.snapshot.observedAt
  expect(await f.service.giveBack(proof,'mini')).toMatchObject({status:'returned'});expect(f.host.resourceReservations).toEqual([])
})

test('canonical preclaim overlay preserves genuine installed generation and memberships for generic and standalone checks',async()=>{
  for(const independent of [false,true]){const f=fixture(independent),before=structuredClone(f.subject());await f.service.acquire(f.intent,'mini')
    const actual=projectResourceLifecycle([f.host],start).subjects[0]!
    expect(actual.generation).toBe(before.generation);expect(actual.resource).toEqual(before.resource)
    expect(actual.owner?.generation).toBeNull();expect(actual.supportedActions).toEqual([]);expect(actual.status).toBe('reserved')}
})


function completedNormalReturn(f: ReturnType<typeof fixture>, claim: ExclusiveHostReservation, releaseDelay = 1) {
  f.advance(10)
  const subject = f.subject(), owner = {id: 'resume-cleanup:original-fixer', kind: 'boundary-cleanup' as const, generation: 9},
    laneId = claim.laneId ?? 'repair-controller-lane', checkedAt = f.host.snapshot.observedAt
  if (!claim.laneId) f.host.snapshot.lanes = [{id: laneId, platform: 'ios-on-mac', dispatchMode: 'automatic', state: 'idle', resources: []}]
  subject.owner = null; subject.generation = 10; subject.status = 'unknown'; subject.repair.state = 'none'
  subject.reason = {code: 'resource-not-returned', message: 'Original Core claim prevents allocation'}
  subject.idle.outcome = 'passed'; subject.idle.checkedAt = checkedAt
  subject.idle.evidenceRefs = ['exact-final-check-evidence']
  subject.idle.acceptedCheck = {operationId: 'exact-final-cleanup-baseline', subjectGeneration: 10, resultSha256: hash, acceptedAt: checkedAt}
  f.debugHistory = [{id: 'exact-check-passed', resourceId: claim.resourceId, subjectGeneration: 9,
    at: checkedAt, event: 'check-passed', ownerId: owner.id, ownerGeneration: owner.generation, hostId: 'mini', laneId}]
  f.advance(releaseDelay)
  const releasedAt = f.host.snapshot.observedAt
  f.debugHistory.push({id: 'exact-resource-released', resourceId: claim.resourceId, subjectGeneration: 10,
    at: releasedAt, event: 'released', ownerId: owner.id, ownerGeneration: owner.generation, hostId: 'mini', laneId})
  const proof: ExclusiveResourceReturn = {claimId: claim.id, authorityHostId: 'mini', resourceId: claim.resourceId,
    intentSha256: claim.intentSha256, inputSha256: claim.inputSha256, originalOwner: claim.owner, laneId,
    controller: {incarnation: f.host.incarnation, generation: f.host.incarnationGeneration, sequence: f.host.sequence},
    release: {eventId: `lane-release:${owner.id}:${owner.generation}`, owner, releasedAt,
      lineage: [{...claim.owner, generation: 3}, owner]}}
  const {controller: _, ...published} = proof
  f.host.snapshot.resourceReservations!.returns = [published]
  return proof
}
function currentReturnReporter(f: ReturnType<typeof fixture>, proof: ExclusiveResourceReturn, elapsed = 120001) {
  f.advance(elapsed)
  proof.controller = {incarnation: f.host.incarnation, generation: f.host.incarnationGeneration, sequence: f.host.sequence}
  f.subject().idle.outcome = 'unknown'; f.subject().reason = {code: 'idle-check-required', message: 'Accepted baseline aged; current allocation needs a new check'}
}
test('normal return clears the retained precheck without requiring its own claim to be allocatable', async () => {
  for (const standalone of [false, true]) {
    const f = fixture(standalone), result = await f.service.acquire(f.intent, 'mini'), claim = result.claims[0]!, proof = completedNormalReturn(f, claim)
    expect(f.subject().status).toBe('unknown')
    expect(await f.service.giveBack(proof, 'mini')).toMatchObject({status: 'returned', claimId: claim.id})
    expect(f.host.resourceReservations).toEqual([]); expect(f.subject().status).toBe('unknown')
  }
})
test('original closed normal return survives delayed ACK while historical proof never becomes current allocation readiness', async () => {
  for (const standalone of [false, true]) {
    const f = fixture(standalone), result = await f.service.acquire(f.intent, 'mini'), claim = result.claims[0]!, proof = completedNormalReturn(f, claim)
    const published = structuredClone(f.host.snapshot.resourceReservations!.returns)
    currentReturnReporter(f, proof)
    expect(await f.service.giveBack(proof, 'mini')).toMatchObject({status: 'returned', claimId: claim.id})
    expect(f.host.snapshot.resourceReservations!.returns).toEqual(published)
    expect(f.subject()).toMatchObject({status: 'unknown', idle: {outcome: 'unknown', acceptedCheck: {subjectGeneration: 10}}})
    expect(resourceAvailable({...f.host, authorityReservations: f.host.resourceReservations}, claim.resourceId, Date.parse(f.host.snapshot.observedAt))).toBe(false)
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
    expect(await f.service.giveBack(proof, 'mini')).toMatchObject({status: 'returned'})
    expect(f.writes).toHaveLength(2)
  }
})
test('historical normal return refuses missing or changed release authority instead of blessing an unknown resource', async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => {f.subject().owner = {id: 'foreign-owner', kind: 'run', generation: 11, hostId: 'mini', laneId: 'android'}},
    (f: ReturnType<typeof fixture>) => {f.subject().repair.state = 'running'},
    (f: ReturnType<typeof fixture>) => {f.subject().status = 'out-of-service'},
    (f: ReturnType<typeof fixture>) => {f.subject().idle.outcome = 'failed'},
    (f: ReturnType<typeof fixture>) => {f.subject().current = false},
    (f: ReturnType<typeof fixture>) => {f.subject().generation++},
    (f: ReturnType<typeof fixture>) => {f.subject().idle.contractVersion = 'different-contract'},
    (f: ReturnType<typeof fixture>) => {f.subject().idle.qualifiedScope = {kind: 'fleet'}},
    (f: ReturnType<typeof fixture>) => {f.subject().idle.evidenceRefs = []},
    (f: ReturnType<typeof fixture>) => {f.subject().idle.acceptedCheck!.acceptedAt = new Date(start).toISOString()},
    (f: ReturnType<typeof fixture>) => {f.subject().idle.checkedAt = new Date(start - 1).toISOString()},
    (f: ReturnType<typeof fixture>) => {f.subject().reason = {code: 'different-unknown', message: 'Unknown custody'}},
  ]
  for (const change of changes) {
    const f = fixture(), result = await f.service.acquire(f.intent, 'mini'), proof = completedNormalReturn(f, result.claims[0]!)
    currentReturnReporter(f, proof); change(f)
    await expect(f.service.giveBack(proof, 'mini')).rejects.toThrow()
    expect(f.host.resourceReservations).toHaveLength(1); expect(f.writes).toHaveLength(1)
  }
})
test('a check already expired when its original lane released cannot satisfy historical normal return', async () => {
  const f = fixture(), result = await f.service.acquire(f.intent, 'mini'), proof = completedNormalReturn(f, result.claims[0]!, 120001)
  currentReturnReporter(f, proof)
  await expect(f.service.giveBack(proof, 'mini')).rejects.toThrow()
  expect(f.host.resourceReservations).toHaveLength(1); expect(f.writes).toHaveLength(1)
})
test('historical normal return refuses a reporter changing between proof read and the original host CAS', async () => {
  const f = fixture(), result = await f.service.acquire(f.intent, 'mini'), proof = completedNormalReturn(f, result.claims[0]!)
  currentReturnReporter(f, proof); f.beforeWrite(async () => {f.advance()})
  await expect(f.service.giveBack(proof, 'mini')).rejects.toThrow()
  expect(f.host.resourceReservations).toHaveLength(1); expect(f.writes).toHaveLength(1)
})

function initialBaseline(f: ReturnType<typeof fixture>) {
  const subject = f.subject(), journal = f.host.snapshot.resourceReservations!.resourceChecks![0]!
  subject.generation = 0; subject.status = 'unknown'; subject.idle.outcome = 'not-checked'
  subject.idle.checkedAt = null; subject.idle.acceptedCheck = null; f.intent.resourceCheck!.subjectGeneration = 0
  journal.intent = structuredClone(f.intent); journal.resourceCheck = structuredClone(f.intent.resourceCheck!)
  journal.intentSha256 = requestInputDigest({...f.intent, controller: {incarnation: 'controller', generation: 1},
    dependencies: [{resourceId: subject.subject.id, authorityHostId: 'mini', capability: 'resource-idle'}]})
  return f
}
async function queuedFixtureRepair() {
  const f = initialBaseline(fixture()), lane = f.host.snapshot.lanes[0]!, app = f.subject(),
    resourceId = 'fixture-exact', operationId = 'fixture-check-original'
  lane.platform = 'ios-on-mac'; lane.resources[0]!.kind = 'app'; app.resource.kind = 'app'
  lane.resources[0]!.idleContract!.version = 'installed-resource-baseline-v1'
  lane.resources[0]!.idleContract!.conditions = ['app-managed-processes-absent', 'app-managed-storage-absent']
  app.idle.contractVersion = lane.resources[0]!.idleContract!.version
  f.intent.resourceCheck!.contractVersion = app.idle.contractVersion
  const target = f.host.snapshot.resourceReservations!.resourceChecks![0]!
  target.intent = structuredClone(f.intent); target.resourceCheck = structuredClone(f.intent.resourceCheck!)
  target.intentSha256 = requestInputDigest({...f.intent, controller: f.intent.resourceCheck!.controller,
    dependencies: [{resourceId: app.subject.id, authorityHostId: 'mini', capability: 'resource-idle'}]})
  lane.resources.push({id: resourceId, kind: 'fixture-data', idleContract: {
    ...structuredClone(lane.resources[0]!.idleContract!), conditions: ['fixture-owned-effects-returned', 'fixture-native-children-settled'],
    dependencies: [app.subject.id]}})
  const fixtureSubject = structuredClone(app)
  fixtureSubject.subject.id = resourceId; fixtureSubject.resource.kind = 'fixture-data'
  f.host.snapshot.resourceLifecycle!.subjects.push(fixtureSubject)
  const original = structuredClone(f.intent)
  original.operationId = operationId; original.resources[0]!.id = resourceId; original.resourceCheck!.resourceId = resourceId
  original.owner.id = `resource-check:${requestInputDigest({operationId, resourceId})}`
  const digest = requestInputDigest({...original, controller: original.resourceCheck!.controller,
    dependencies: [{resourceId, authorityHostId: 'mini', capability: 'resource-idle'}]})
  const journal = {intentSha256: digest, operationId, resourceId, intent: structuredClone(original),
    resourceCheck: structuredClone(original.resourceCheck!), state: 'prepared' as 'prepared' | 'began' | 'never-began',
    observedAt: f.host.snapshot.observedAt}
  f.host.snapshot.resourceReservations!.resourceChecks!.push(journal)
  const acquired = await f.service.acquire(original, 'mini')
  expect(acquired.status).toBe('reserved')
  f.advance(); journal.state = 'began'; journal.observedAt = f.host.snapshot.observedAt
  fixtureSubject.generation = 3; fixtureSubject.status = 'in-repair'
  fixtureSubject.owner = {...original.owner, generation: 1, hostId: 'mini', laneId: lane.id}
  fixtureSubject.observedAt = journal.observedAt; fixtureSubject.receivedAt = journal.observedAt
  fixtureSubject.repair.state = 'queued'; fixtureSubject.idle.outcome = 'unknown'
  fixtureSubject.supportedActions = ['mark-out-of-service']
  fixtureSubject.idle.checkedAt = journal.observedAt
  fixtureSubject.idle.acceptedCheck = {operationId, subjectGeneration: 2, resultSha256: hash, acceptedAt: journal.observedAt}
  const failure = {id: 'fixture-check-unknown', resourceId, subjectGeneration: 2, at: journal.observedAt, event: 'check-unknown'}
  const queued = {id: 'fixture-repair-queued', resourceId, subjectGeneration: 3, at: journal.observedAt, event: 'repair-queued'}
  f.debugHistory.push(failure, queued)
  return {...f, fixtureSubject, original, journal, failure, queued, claim: acquired.claims[0]!}
}
test('settled queued fixture permits its fresh app dependency baseline without releasing original custody', async () => {
  const f = await queuedFixtureRepair(), before = structuredClone(f.fixtureSubject), claim = structuredClone(f.claim)
  const result = await f.service.acquire(f.intent, 'mini')
  expect(result.status).toBe('reserved')
  expect(result.claims).toHaveLength(1); expect(f.host.resourceReservations).toHaveLength(2)
  expect(f.host.resourceReservations).toContainEqual(claim); expect(f.fixtureSubject).toEqual(before)
  expect(f.debugHistory).toContainEqual(f.queued)
  expect(f.subject().owner).toBeNull(); expect(f.subject().generation).toBe(0)
})
async function queuedAppPhoneRepair(phoneVersion = 'installed-resource-baseline-v1') {
  const f = await queuedFixtureRepair(), lane = f.host.snapshot.lanes[0]!, phone = f.subject(), app = f.fixtureSubject
  lane.platform = 'android'; lane.resources[0]!.kind = 'phone'; phone.resource.kind = 'phone'
  lane.resources[0]!.idleContract!.version = phoneVersion
  lane.resources[0]!.idleContract!.conditions = phoneVersion === 'installed-phone-baseline-v2' ? ['phone-identity', 'phone-same-boot'] :
    ['phone-identity', 'phone-same-boot', 'phone-default-network', 'phone-network-stable']
  phone.idle.contractVersion = phoneVersion; f.intent.resourceCheck!.contractVersion = phoneVersion
  lane.resources[1]!.kind = 'app'; app.resource.kind = 'app'
  lane.resources[1]!.idleContract!.conditions = ['app-phone-identity', 'app-phone-same-boot', 'app-package-absent', 'app-process-absent', 'app-data-absent']
  // The captured parent settled after its original deadline. That proves
  // cessation of an UNKNOWN check, never a timely result or a released claim.
  f.advance(88971)
  const at = f.host.snapshot.observedAt
  app.observedAt = at; app.receivedAt = at; app.idle.checkedAt = at
  app.idle.acceptedCheck!.acceptedAt = at; f.failure.at = at; f.queued.at = at
  f.intent.controller.sequence = f.host.sequence; f.intent.resourceCheck!.deadlineAt = Date.parse(at) + 30000
  const target = f.host.snapshot.resourceReservations!.resourceChecks![0]!
  target.intent = structuredClone(f.intent); target.resourceCheck = structuredClone(f.intent.resourceCheck!)
  target.intentSha256 = requestInputDigest({...f.intent, controller: f.intent.resourceCheck!.controller,
    dependencies: [{resourceId: phone.subject.id, authorityHostId: 'mini', capability: 'resource-idle'}]})
  return {...f, app, phone}
}
test('settled queued Android app permits only its fresh passive phone baseline while retaining the late UNKNOWN parent', async () => {
  const f = await queuedAppPhoneRepair(), parent = structuredClone(f.app), claim = structuredClone(f.claim)
  expect(Date.parse(parent.idle.acceptedCheck!.acceptedAt)).toBeGreaterThan(f.claim.resourceCheck!.deadlineAt)
  const result = await f.service.acquire(f.intent, 'mini')
  expect(result.status).toBe('reserved'); expect(result.claims).toHaveLength(1)
  expect(f.host.resourceReservations).toContainEqual(claim); expect(f.app).toEqual(parent)
  expect(f.phone.owner).toBeNull(); expect(f.phone.generation).toBe(0)
  expect(result.claims[0]!.resourceCheck!.deadlineAt).toBe(f.intent.resourceCheck!.deadlineAt)
})
async function queuedRecorderAppRepair(phoneVersion = 'installed-phone-baseline-v2') {
  const f = await queuedFixtureRepair(), lane = f.host.snapshot.lanes[0]!, app = f.subject(), recorder = f.fixtureSubject
  lane.platform = 'android'
  lane.resources[0]!.idleContract!.conditions = ['app-phone-identity', 'app-phone-same-boot', 'app-package-absent', 'app-process-absent', 'app-data-absent']
  lane.resources[0]!.idleContract!.dependencies = ['phone-dependency']
  lane.resources[1]!.kind = 'recorder'; recorder.resource.kind = 'recorder'
  lane.resources[1]!.idleContract!.conditions = ['recorder-native-children-settled', 'recorder-storage-available']
  const phoneRef = {id: 'phone-dependency', kind: 'phone' as const, idleContract: {
    ...structuredClone(lane.resources[0]!.idleContract!), version: phoneVersion,
    conditions: phoneVersion === 'installed-phone-baseline-v2' ? ['phone-identity', 'phone-same-boot'] :
      ['phone-identity', 'phone-same-boot', 'phone-default-network', 'phone-network-stable'], dependencies: []}}
  lane.resources.push(phoneRef)
  const phone = structuredClone(app)
  phone.subject.id = phoneRef.id; phone.resource.kind = 'phone'; phone.idle.contractVersion = phoneRef.idleContract.version
  f.host.snapshot.resourceLifecycle!.subjects.push(phone)
  f.advance(88971)
  const at = f.host.snapshot.observedAt
  for (const subject of [app, phone, recorder]) {subject.observedAt = at; subject.receivedAt = at}
  recorder.idle.checkedAt = at; recorder.idle.acceptedCheck!.acceptedAt = at; f.failure.at = at; f.queued.at = at
  f.intent.controller.sequence = f.host.sequence; f.intent.resourceCheck!.deadlineAt = Date.parse(at) + 30000
  const target = f.host.snapshot.resourceReservations!.resourceChecks![0]!
  target.intent = structuredClone(f.intent); target.resourceCheck = structuredClone(f.intent.resourceCheck!)
  target.intentSha256 = requestInputDigest({...f.intent, controller: f.intent.resourceCheck!.controller,
    dependencies: [{resourceId: app.subject.id, authorityHostId: 'mini', capability: 'resource-idle'}]})
  return {...f, app, recorder, phone, phoneRef}
}
test('queued recorder permits its current Android app dependency with accepted phone-v2 contract and retains late UNKNOWN custody', async () => {
  const f = await queuedRecorderAppRepair(), original = structuredClone(f.recorder), claim = structuredClone(f.claim)
  expect(Date.parse(original.idle.acceptedCheck!.acceptedAt)).toBeGreaterThan(claim.resourceCheck!.deadlineAt)
  const result = await f.service.acquire(f.intent, 'mini')
  expect(result.status).toBe('reserved'); expect(result.claims).toHaveLength(1)
  expect(f.host.resourceReservations).toContainEqual(claim); expect(f.host.resourceReservations).toHaveLength(2)
  expect(f.recorder).toEqual(original); expect(f.app.owner).toBeNull(); expect(f.phone.owner).toBeNull()
})
test('queued app phone dependency accepts the current phone-v2 family without network conditions', async () => {
  const f = await queuedAppPhoneRepair('installed-phone-baseline-v2'), original = structuredClone(f.claim)
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('reserved')
  expect(f.host.resourceReservations).toContainEqual(original); expect(f.app.owner!.id).toBe(original.owner.id)
})
test('queued recorder app dependency preserves the supported phone-v1 family', async () => {
  const f = await queuedRecorderAppRepair('installed-resource-baseline-v1')
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('reserved')
  expect(f.host.resourceReservations).toContainEqual(f.claim)
})
test('queued recorder dependency refuses incomplete original closure, foreign effects, changed contracts and stale authority', async () => {
  const changes: Array<(f: Awaited<ReturnType<typeof queuedRecorderAppRepair>>) => void> = [
    f => {f.recorder.idle.acceptedCheck = null},
    // An original unclosed reader projects retained checking custody, not the
    // producer-accepted UNKNOWN and queued repair needed by this exception.
    f => {f.recorder.status = 'checking'; f.recorder.repair.state = 'none'; f.recorder.idle.acceptedCheck = null},
    f => {f.recorder.repair.state = 'running'; f.recorder.repair.executionId = 'active-native-cleanup'},
    f => {f.recorder.owner!.id = 'foreign-native-owner'},
    f => {f.recorder.owner!.hostId = 'foreign-host'},
    f => {f.recorder.idle.outcome = 'failed'}, // Late physical failure remains non-qualifying.
    f => {f.recorder.generation++},
    f => {f.recorder.current = false},
    f => {f.journal.state = 'prepared'},
    f => {f.journal.intent.inputSha256 = 'b'.repeat(64)},
    f => {f.host.snapshot.lanes[0]!.resources[1]!.idleContract!.dependencies = ['foreign-app']},
    f => {f.host.snapshot.lanes[0]!.resources[1]!.idleContract!.conditions.pop()},
    f => {f.host.snapshot.lanes[0]!.resources[1]!.idleContract!.version = 'unsupported-recorder-v2'},
    f => {f.phoneRef.idleContract.version = 'unsupported-phone-v3'; f.phone.idle.contractVersion = 'unsupported-phone-v3'},
    f => {f.phoneRef.idleContract.conditions.pop()},
    f => {f.phoneRef.idleContract.conditions.push('phone-network-stable')},
    f => {f.phone.idle.contractVersion = 'installed-resource-baseline-v1'},
    f => {f.phone.owner = {id: 'unclosed-native-reader', kind: 'boundary-cleanup', generation: 1, hostId: 'mini', laneId: 'android'}},
    f => {f.phone.status = 'out-of-service'; f.phone.idle.outcome = 'failed'},
    f => {f.phone.resource.dependencies = [f.recorder.subject.id]},
    f => {f.phone.resource.memberships[0]!.hostId = 'foreign-host'},
    f => {f.app.owner = {id: 'foreign-app-writer', kind: 'run', generation: 1, hostId: 'mini', laneId: 'android'}},
    f => {f.intent.resourceCheck!.subjectGeneration++},
    f => {f.host.snapshot.frameworkBinding = {...f.intent.resourceCheck!.binding, revision: 'different-source'}},
    f => {f.host.laneControls = [{command: {...f.control('mark-out-of-service'), operatorId: hash,
      subject: {resourceId: f.recorder.subject.id, subjectGeneration: f.recorder.generation}}}]},
    f => {f.advance(30001)},
  ]
  for (const change of changes) {
    const f = await queuedRecorderAppRepair(); change(f)
    const before = structuredClone(f.host.resourceReservations)
    let status: string
    try {status = (await f.service.acquire(f.intent, 'mini')).status} catch {status = 'invalid-report'}
    expect(status).not.toBe('reserved'); expect(f.host.resourceReservations).toEqual(before); expect(f.writes).toHaveLength(1)
  }
})
test('queued recorder dependency revalidates native custody and current contract at the host CAS', async () => {
  for (const change of [
    (f: Awaited<ReturnType<typeof queuedRecorderAppRepair>>) => {f.recorder.repair.state = 'running'},
    (f: Awaited<ReturnType<typeof queuedRecorderAppRepair>>) => {f.phone.owner = {id: 'late-native-reader', kind: 'boundary-cleanup', generation: 1, hostId: 'mini', laneId: 'android'}},
    (f: Awaited<ReturnType<typeof queuedRecorderAppRepair>>) => {f.phoneRef.idleContract.conditions.pop()},
    (f: Awaited<ReturnType<typeof queuedRecorderAppRepair>>) => {f.advance(30001)},
  ]) {
    const f = await queuedRecorderAppRepair(), original = structuredClone(f.claim)
    f.afterWrite(async () => {change(f)})
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
    expect(f.host.resourceReservations).toHaveLength(2); expect(f.host.resourceReservations).toContainEqual(original)
    expect(f.writes).toHaveLength(2)
  }
  const f = await queuedRecorderAppRepair()
  f.beforeWrite(async () => {f.recorder.repair.state = 'running'; f.advance()})
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
  expect(f.host.resourceReservations).toEqual([f.claim]); expect(f.writes).toHaveLength(1)
})
test('queued app phone dependency refuses incomplete settlement, running work, foreign scope and operator restrictions', async () => {
  const changes: Array<(f: Awaited<ReturnType<typeof queuedAppPhoneRepair>>) => void> = [
    f => {f.app.idle.acceptedCheck = null},
    f => {f.app.idle.outcome = 'failed'}, // A late failure is not the producer's ceased UNKNOWN path.
    f => {f.app.status = 'unknown'; f.app.repair.state = 'none'},
    f => {f.app.repair.state = 'running'},
    f => {f.app.repair.executionId = 'running-fixer'},
    f => {f.app.repair.interruptionId = 'halted-fixer'},
    f => {f.app.owner!.kind = 'fixer'},
    f => {f.app.owner!.id = 'foreign-owner'},
    f => {f.app.owner!.hostId = 'foreign-host'},
    f => {f.app.owner!.laneId = 'other-lane'},
    f => {f.app.current = false},
    f => {f.app.supportedActions = []},
    f => {f.app.generation++},
    f => {f.journal.state = 'prepared'},
    f => {f.journal.intent.owner.id = 'foreign-original'},
    f => {f.host.snapshot.resourceReservations!.resourceChecks!.splice(1)},
    f => {f.claim.controllerGeneration = 0; f.host.resourceReservations = [f.claim]},
    f => {f.claim.controllerIncarnation = 'retired-controller'; f.host.resourceReservations = [f.claim]},
    f => {f.host.snapshot.lanes[0]!.platform = 'ios-on-mac'},
    f => {f.host.snapshot.lanes[0]!.dispatchMode = 'paused'},
    f => {f.host.snapshot.lanes[0]!.activity = {generation: 1, owner: {id: 'foreign-run', kind: 'run', requestId: 'foreign-run'}}},
    f => {f.host.snapshot.lanes[0]!.resources[1]!.idleContract!.dependencies = ['unrelated-phone']},
    f => {f.host.snapshot.lanes[0]!.resources[1]!.idleContract!.conditions.pop()},
    f => {f.app.resource.dependencies = ['foreign-resource']},
    f => {f.app.resource.memberships.push({hostId: 'mini', laneId: 'other-lane'})},
    f => {f.phone.resource.memberships.push({hostId: 'mini', laneId: 'other-lane'})},
    f => {f.phone.resource.dependencies = [f.app.subject.id]},
    f => {f.host.snapshot.lanes[0]!.resources[0]!.idleContract!.dependencies = [f.app.subject.id]},
    f => {f.host.snapshot.lanes[0]!.resources[1]!.exclusiveDependencies = [{resourceId: f.phone.subject.id, capability: 'resource-idle', authorityHostId: 'mini'}]},
    f => {f.phone.status = 'out-of-service'},
    f => {f.app.status = 'out-of-service'},
    f => {f.phone.owner = {id: 'foreign-native-work', kind: 'run', generation: 1, hostId: 'mini', laneId: 'android'}},
    f => {f.host.snapshot.frameworkBinding = {...f.intent.resourceCheck!.binding, revision: 'different-source'}},
    f => {f.host.laneControls = [{command: {...f.control('mark-out-of-service'), operatorId: hash, subject: {resourceId: f.app.subject.id, subjectGeneration: f.app.generation}}}]},
    f => {f.host.laneControls = [{command: {...f.control('reserve'), operatorId: hash}}]},
    f => {f.app.status = 'checking'; f.app.owner = {id: 'current-manual-check', kind: 'boundary-cleanup', generation: f.app.generation, hostId: 'mini', laneId: 'android'}; const command = {operationId: randomUUID(), hostId: 'mini', expiresAt: Date.parse(f.host.snapshot.observedAt) + 30000, action: 'check' as const,
      subject: {resourceId: f.app.subject.id, subjectGeneration: f.app.generation}, operatorId: hash}
      f.host.laneControls = [{command, receipt: {operationId: command.operationId, inputSha256: hash, hostId: 'mini', subject: command.subject,
        completedAt: f.host.snapshot.observedAt, result: {status: 'accepted', check: {operationId: 'foreign-parent-check', resourceId: f.app.subject.id, generation: f.app.generation, state: 'active'}}}}]},
    f => {f.advance(30001)},
  ]
  for (const change of changes) {
    const f = await queuedAppPhoneRepair(); change(f)
    const before = structuredClone(f.host.resourceReservations)
    let status: string
    try {status = (await f.service.acquire(f.intent, 'mini')).status} catch {status = 'invalid-report'}
    expect(status).not.toBe('reserved'); expect(f.host.resourceReservations).toEqual(before); expect(f.writes).toHaveLength(1)
  }
})
test('queued dependency revalidates parent and target after CAS while retaining a committed uncertain phone claim', async () => {
  for (const change of [
    (f: Awaited<ReturnType<typeof queuedAppPhoneRepair>>) => {f.app.repair.state = 'running'},
    (f: Awaited<ReturnType<typeof queuedAppPhoneRepair>>) => {f.phone.owner = {id: 'foreign-work', kind: 'run', generation: 1, hostId: 'mini'}},
    (f: Awaited<ReturnType<typeof queuedAppPhoneRepair>>) => {f.host.laneControls = [{command: {...f.control('mark-out-of-service'), operatorId: hash,
      subject: {resourceId: f.app.subject.id, subjectGeneration: f.app.generation}}}]; f.host.laneControlVersion!++},
    (f: Awaited<ReturnType<typeof queuedAppPhoneRepair>>) => {f.advance(30001)},
  ]) {
    const f = await queuedAppPhoneRepair(), original = structuredClone(f.claim)
    f.afterWrite(async () => {change(f)})
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
    expect(f.host.resourceReservations).toHaveLength(2); expect(f.host.resourceReservations).toContainEqual(original)
    expect(f.writes).toHaveLength(2)
  }
  const f = await queuedAppPhoneRepair()
  f.beforeWrite(async () => {f.app.repair.state = 'running'; f.advance()})
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
  expect(f.host.resourceReservations).toHaveLength(1); expect(f.writes).toHaveLength(1)
})
test('recorder capacity appearing after the dependency CAS retains every claim and permits the independent phone reader', async () => {
  const f = await queuedAppPhoneRepair(), parent = structuredClone(f.claim), recorder = {id: randomUUID(), requestId: 'concurrent-recorder',
    fleetInputSha256: hash, hostId: 'mini', laneId: 'android', poolId: 'mini-disk', minimumAvailableBytes: 1, reservedAt: f.host.snapshot.observedAt}
  f.afterWrite(async () => {
    f.host.resourceReservations = [...hostResourceReservationsSchema.parse(f.host.resourceReservations), recorder]
    f.host.resourceReservationVersion!++
  })
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('reserved')
  expect(f.host.resourceReservations).toHaveLength(3); expect(f.host.resourceReservations).toContainEqual(parent)
  expect(f.host.resourceReservations).toContainEqual(recorder); expect(f.writes).toHaveLength(2)
})
test('resource-only owner keeps the original journal lane even when Core overview hides its actions', async () => {
  const f = await queuedFixtureRepair()
  delete f.fixtureSubject.owner!.laneId
  const projected = projectResourceLifecycle([f.host], Date.parse(f.host.snapshot.observedAt)).subjects.find(value => value.subject.id === 'fixture-exact')!
  expect(projected).toMatchObject({status: 'reserved', supportedActions: []})
  expect(f.fixtureSubject).toMatchObject({status: 'in-repair', supportedActions: ['mark-out-of-service']})
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('reserved')
  expect(f.host.resourceReservations).toContainEqual(f.claim)
})
test('queued fixture bootstrap rejects missing settlement, unknown effects, changed scope and active lane work', async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.fixtureSubject.supportedActions = []},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.fixtureSubject.idle.acceptedCheck = null},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.fixtureSubject.idle.acceptedCheck!.resultSha256 = ''},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.fixtureSubject.idle.acceptedCheck!.subjectGeneration++},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.fixtureSubject.repair.state = 'running'},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.fixtureSubject.repair.executionId = 'already-started-fixer'},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.fixtureSubject.owner!.kind = 'fixer'},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.fixtureSubject.owner!.id = 'foreign-owner'},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.fixtureSubject.owner!.laneId = 'foreign-lane'},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.fixtureSubject.resource.dependencies = ['other-app']},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.host.snapshot.lanes[0]!.resources[1]!.idleContract!.dependencies = ['other-app']},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.fixtureSubject.resource.memberships.push({hostId: 'mini', laneId: 'shared-lane'})},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.subject().resource.dependencies = ['fixture-exact']},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.host.snapshot.lanes[0]!.resources[0]!.idleContract!.dependencies = ['fixture-exact']},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.subject().resource.memberships.push({hostId: 'mini', laneId: 'other-lane'})},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.subject().owner = {id: 'native-owner', kind: 'run', generation: 1, hostId: 'mini', laneId: 'android'}},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.subject().status = 'returning'},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.subject().current = false},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.subject().supportedActions = []},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.claim.controllerIncarnation = 'foreign-controller'; f.host.resourceReservations = [f.claim]},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.claim.owner.id = 'foreign-claim'; f.host.resourceReservations = [f.claim]},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.claim.inputSha256 = 'b'.repeat(64); f.host.resourceReservations = [f.claim]},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.journal.state = 'prepared'},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.host.snapshot.resourceReservations!.resourceChecks!.splice(1)},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.host.snapshot.lanes[0]!.activity = {generation: 1, owner: {id: 'active-run', kind: 'run', requestId: 'active-run'}}},
    (f: Awaited<ReturnType<typeof queuedFixtureRepair>>) => {f.host.snapshot.lanes[0]!.dispatchMode = 'paused'},
  ]) {
    const f = await queuedFixtureRepair(); mutate(f)
    const before = structuredClone(f.host.resourceReservations)
    let result
    try {result = await f.service.acquire(f.intent, 'mini')} catch {result = {status: 'invalid-report'}}
    expect(result.status).not.toBe('reserved'); expect(f.writes).toHaveLength(1)
    expect(f.host.resourceReservations).toEqual(before); expect(f.subject().generation).toBe(0)
  }
})
async function queuedAndroidFixtureRepair() {
  const f = await queuedFixtureRepair(), lane = f.host.snapshot.lanes[0]!, app = lane.resources[0]!, subject = f.subject(),
    phone = structuredClone(subject), phoneRef = {...structuredClone(app), id: 'physical-phone', kind: 'phone' as const}
  lane.platform = 'android'
  phoneRef.idleContract!.conditions = ['phone-identity', 'phone-same-boot', 'phone-default-network', 'phone-network-stable']
  phone.subject.id = phoneRef.id; phone.resource.kind = 'phone'; phone.idle.acceptedCheck = null
  phone.generation = 0; phone.status = 'unknown'; phone.idle.outcome = 'not-checked'
  lane.resources.push(phoneRef); f.host.snapshot.resourceLifecycle!.subjects.push(phone)
  app.idleContract!.conditions = ['app-phone-identity', 'app-phone-same-boot', 'app-package-absent', 'app-process-absent', 'app-data-absent']
  app.idleContract!.dependencies = [phoneRef.id]
  return {...f, phone, phoneRef}
}
test('Android app baseline checks its current phone scope while the stopped fixture claim remains queued', async () => {
  const f = await queuedAndroidFixtureRepair()
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('reserved')
  expect(f.host.resourceReservations).toContainEqual(f.claim); expect(f.phone.owner).toBeNull()
})
test('pending phone commands and current manual checking prevent conflicting app baseline', async () => {
  for (const action of ['reserve', 'mark-out-of-service', 'check'] as const) for (const accepted of [false, true]) {
    const f = await queuedAndroidFixtureRepair(), operationId = randomUUID(), subject = {resourceId: f.phoneRef.id, subjectGeneration: f.phone.generation},
      command = {operationId, hostId: 'mini', subject, operatorId: hash, expiresAt: start + 60000, action,
        ...(action === 'reserve' ? {purpose: 'Human phone use'} : action === 'mark-out-of-service' ? {reason: 'Phone withdrawn'} : {})},
      result = action === 'reserve' ? {status: 'accepted', reservation: {id: 'phone-reservation', resourceId: f.phoneRef.id,
        generation: 1, state: 'granted', purpose: 'Human phone use', requestedAt: f.host.snapshot.observedAt}} :
        action === 'mark-out-of-service' ? {status: 'accepted', resource: {resourceId: f.phoneRef.id, generation: 1, status: 'out-of-service'}} :
          {status: 'accepted', check: {operationId, resourceId: f.phoneRef.id, generation: 1, state: 'active'}}
    f.host.laneControls = [{command, ...(accepted ? {receipt: {operationId, hostId: 'mini', subject,
      inputSha256: hash, completedAt: f.host.snapshot.observedAt, result}} : {})}]
    if (action === 'check' && accepted) {f.phone.status = 'checking'; f.phone.owner = {id: 'current-manual-check', kind: 'boundary-cleanup', generation: f.phone.generation, hostId: 'mini', laneId: 'android'}}
    expect(f.phone.supportedActions).toContain('mark-out-of-service')
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
    expect(f.writes).toHaveLength(1); expect(f.host.resourceReservations).toEqual([f.claim])
  }
})
test('phone withdrawal winning the same host-row CAS prevents the app dependency claim', async () => {
  const f = await queuedAndroidFixtureRepair()
  f.beforeWrite(async () => {
    f.host.laneControlVersion!++
    f.host.laneControls = [{command: {operationId: randomUUID(), hostId: 'mini', operatorId: hash, expiresAt: start + 60000,
      subject: {resourceId: f.phoneRef.id, subjectGeneration: f.phone.generation}, action: 'reserve', purpose: 'Human phone use'}}]
  })
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
  expect(f.writes).toHaveLength(1); expect(f.host.resourceReservations).toEqual([f.claim])
})
test('new accepted controller may check app beside an exact historical stopped fixture claim without renewing its old authority', async () => {
  const f = await queuedFixtureRepair(), target = f.host.snapshot.resourceReservations!.resourceChecks![0]!,
    binding = {...f.intent.resourceCheck!.binding, revision: 'e'.repeat(40), installationId: 'replacement-source'}
  f.advance(); f.host.incarnation = 'replacement-controller'; f.host.incarnationGeneration = 2
  f.host.snapshot.incarnation = f.host.incarnation; f.host.snapshot.incarnationGeneration = 2
  f.host.snapshot.frameworkBinding = binding; f.host.snapshot.frameworkAcceptedAt = f.host.snapshot.observedAt
  f.intent.controller = {incarnation: f.host.incarnation, generation: 2, sequence: f.host.sequence}
  f.intent.resourceCheck!.controller = {incarnation: f.host.incarnation, generation: 2}; f.intent.resourceCheck!.binding = binding
  target.intent = structuredClone(f.intent); target.resourceCheck = structuredClone(f.intent.resourceCheck!)
  target.intentSha256 = requestInputDigest({...f.intent, controller: f.intent.resourceCheck!.controller,
    dependencies: [{resourceId: f.subject().subject.id, authorityHostId: 'mini', capability: 'resource-idle'}]})
  const original = structuredClone(f.claim)
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('reserved')
  expect(f.host.resourceReservations).toContainEqual(original); expect(f.claim.controllerGeneration).toBe(1)
  expect(f.fixtureSubject.repair.state).toBe('queued')
})
test('queued fixture retains recorder budget while real run and target claims still refuse the reader', async () => {
  for (const kind of ['recorder', 'run', 'target']) {
    const f = await queuedFixtureRepair(), blocker: HostResourceReservation = kind === 'recorder' ?
      {id: randomUUID(), requestId: 'waiting-original', fleetInputSha256: hash, hostId: 'mini', laneId: 'android',
        poolId: 'mini-disk', minimumAvailableBytes: 1, reservedAt: f.host.snapshot.observedAt} :
      {...structuredClone(f.claim), id: randomUUID(), resourceId: kind === 'target' ? 'phone-exact' : 'other-resource', resourceCheck: undefined,
        ...(kind === 'run' ? {owner: {kind: 'run', id: 'original-run'}, operationId: 'run:original-run'} : {}),
        ...(kind === 'target' ? {laneId: 'other-lane'} : {})} as ExclusiveHostReservation
    f.host.resourceReservations = [...hostResourceReservationsSchema.parse(f.host.resourceReservations), blocker]
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe(kind === 'recorder' ? 'reserved' : 'unknown')
    expect(f.writes).toHaveLength(kind === 'recorder' ? 2 : 1); expect(f.host.resourceReservations).toContainEqual(blocker)
  }
})
test('queued fixture baseline cancellation or controller change before CAS preserves both original authorities', async () => {
  for (const change of ['cancel', 'restart', 'started-repair']) {
    const f = await queuedFixtureRepair()
    f.beforeWrite(async () => {
      f.advance()
      if (change === 'cancel') f.host.snapshot.resourceReservations!.resourceChecks![0]!.state = 'never-began'
      if (change === 'restart') {f.host.incarnation = 'new-controller'; f.host.incarnationGeneration++}
      if (change === 'started-repair') {f.fixtureSubject.repair.state = 'running'; f.fixtureSubject.owner!.kind = 'fixer'}
    })
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
    expect(f.host.resourceReservations).toEqual([f.claim]); expect(f.writes).toHaveLength(1)
    expect(f.subject().owner).toBeNull()
  }
})
async function originalGlassesRepair() {
  const f = initialBaseline(fixture()), lane = f.host.snapshot.lanes[0]!, phone = f.subject(), resourceId = 'glasses-exact',
    operationId = 'glasses-check-original', at = f.host.snapshot.observedAt
  lane.resources.push({id: resourceId, kind: 'glasses', idleContract: structuredClone(lane.resources[0]!.idleContract!)})
  lane.glasses = [{resourceId, deviceId: '0123456789abcdef0123456789abcdef', model: 'mentra-live', capabilities: []}]
  const glasses = structuredClone(phone); glasses.subject.id = resourceId; glasses.resource.kind = 'glasses'
  f.host.snapshot.resourceLifecycle!.subjects.push(glasses)
  const original = structuredClone(f.intent)
  original.operationId = operationId; original.resources[0]!.id = resourceId; original.resourceCheck!.resourceId = resourceId
  original.owner.id = `resource-check:${requestInputDigest({operationId, resourceId})}`
  const digest = requestInputDigest({...original, controller: {incarnation: 'controller', generation: 1},
    dependencies: [{resourceId, authorityHostId: 'mini', capability: 'resource-idle'}]})
  const journal = {intentSha256: digest, operationId, resourceId, intent: structuredClone(original),
    resourceCheck: structuredClone(original.resourceCheck!), state: 'prepared' as 'prepared' | 'began' | 'never-began', observedAt: at}
  f.host.snapshot.resourceReservations!.resourceChecks!.push(journal)
  const acquired = await f.service.acquire(original, 'mini')
  expect(acquired.status).toBe('reserved'); expect(acquired.claims).toHaveLength(1)
  f.advance(); journal.state = 'began'; journal.observedAt = f.host.snapshot.observedAt
  // The existing failed-check repair flow retains this original claim and journals its transfer.
  glasses.generation = 7; glasses.status = 'in-repair'; glasses.owner = {id: 'original-glasses-fixer', kind: 'fixer',
    generation: 6, hostId: 'mini', laneId: 'android'}
  glasses.observedAt = f.host.snapshot.observedAt; glasses.receivedAt = glasses.observedAt
  glasses.repair.state = 'running'; glasses.repair.interruptionId = 'original-glasses-repair'; glasses.repair.executionId = glasses.owner.id; glasses.idle.outcome = 'failed'
  glasses.idle.acceptedCheck = {operationId, subjectGeneration: 3, resultSha256: hash, acceptedAt: journal.observedAt}
  glasses.idle.checkedAt = journal.observedAt
  lane.state = 'in-repair'; lane.activity = {owner: {id: glasses.owner.id, kind: 'fixer'}, generation: 6}
  const transfer = {id: 'original-glasses-repair-started', resourceId, subjectGeneration: 7, at: journal.observedAt,
    event: 'repair-started', ownerId: glasses.owner.id, ownerGeneration: 6, hostId: 'mini', laneId: 'android'}
  f.debugHistory.push({id: 'original-glasses-check-failed', resourceId, subjectGeneration: 3,
    at: journal.observedAt, event: 'check-failed'}, transfer)
  return {...f, glasses, original, journal, transfer, claim: acquired.claims[0]!}
}
test('initial offline lane admits an original uncommissioned baseline without marking the phone ready', async () => {
  const f = initialBaseline(fixture()); f.host.snapshot.lanes[0]!.state = 'offline'
  const result = await f.service.acquire(f.intent, 'mini')
  expect(result.status).toBe('reserved'); expect(result.claims).toHaveLength(1); expect(f.writes).toHaveLength(1)
  expect(result.claims[0]).toMatchObject({resourceId: 'phone-exact', operationId: f.intent.operationId,
    resourceCheck: f.intent.resourceCheck, inputSha256: f.intent.inputSha256})
  expect(f.subject().generation).toBe(0); expect(f.subject().owner).toBeNull(); expect(f.subject().idle.acceptedCheck).toBeNull()
  expect(resourceAvailable({...f.host, authorityReservations: f.host.resourceReservations}, 'phone-exact', start)).toBe(false)
})
test('disjoint original glasses-check repair admits phone baseline while preserving original repair claim and owner', async () => {
  const f = await originalGlassesRepair(), before = structuredClone(f.glasses), claim = structuredClone(f.claim)
  const result = await f.service.acquire(f.intent, 'mini')
  expect(result.status).toBe('reserved'); expect(result.claims).toHaveLength(1); expect(f.writes).toHaveLength(2)
  expect(f.host.resourceReservations).toContainEqual(claim); expect(f.host.resourceReservations).toHaveLength(2)
  expect(f.glasses).toEqual(before); expect(f.subject().generation).toBe(0); expect(f.subject().owner).toBeNull()
})
async function haltedFixtureRepair() {
  const f = await originalGlassesRepair(), lane = f.host.snapshot.lanes[0]!, target = f.subject(),
    journal = f.host.snapshot.resourceReservations!.resourceChecks![0]!
  lane.platform = 'ios-on-mac'; lane.resources[0]!.kind = 'fixture-data'; target.resource.kind = 'fixture-data'
  lane.state = 'out-of-service'; f.glasses.status = 'out-of-service'; f.glasses.repair.state = 'halted'
  f.advance(); f.host.incarnation = 'replacement-controller'; f.host.incarnationGeneration = 2
  f.host.snapshot.incarnation = f.host.incarnation; f.host.snapshot.incarnationGeneration = 2
  f.intent.controller = {incarnation: f.host.incarnation, generation: 2, sequence: f.host.sequence}
  f.intent.resourceCheck!.controller = {incarnation: f.host.incarnation, generation: 2}
  journal.intent = structuredClone(f.intent); journal.resourceCheck = structuredClone(f.intent.resourceCheck!)
  journal.intentSha256 = requestInputDigest({...f.intent, controller: f.intent.resourceCheck!.controller,
    dependencies: [{resourceId: target.subject.id, authorityHostId: 'mini', capability: 'resource-idle'}]})
  return f
}
test('unowned fixture baseline survives a halted disjoint glasses repair and controller replacement', async () => {
  const f = await haltedFixtureRepair(), retained = structuredClone(f.claim), glasses = structuredClone(f.glasses)
  const result = await f.service.acquire(f.intent, 'mini')
  expect(result.status).toBe('reserved'); expect(result.claims).toHaveLength(1)
  expect(f.host.resourceReservations).toContainEqual(retained); expect(f.glasses).toEqual(glasses)
  expect(f.subject().owner).toBeNull(); expect(f.subject().generation).toBe(0)
})
for (const conflict of ['target-owner', 'target-dependency', 'repair-dependency', 'unknown-scope', 'noncurrent', 'exclusive-fixer', 'unscoped-effect'] as const)
test(`halted repair does not relax current fixture conflict: ${conflict}`, async () => {
  const f = await haltedFixtureRepair(), lane = f.host.snapshot.lanes[0]!
  if (conflict === 'target-owner') f.subject().owner = {id: 'target-writer', kind: 'run', hostId: 'mini', laneId: lane.id, generation: 1}
  if (conflict === 'target-dependency') lane.resources[0]!.idleContract!.dependencies = [f.glasses.subject.id]
  if (conflict === 'repair-dependency') f.glasses.resource.dependencies = [f.subject().subject.id]
  if (conflict === 'unknown-scope') delete lane.resources[1]!.idleContract
  if (conflict === 'noncurrent') f.glasses.current = false
  if (conflict === 'exclusive-fixer') lane.activity!.owner.id = 'controller-exclusive-fixer'
  if (conflict === 'unscoped-effect') f.host.resourceReservations = [...hostResourceReservationsSchema.parse(f.host.resourceReservations),
    {...structuredClone(f.claim), id: randomUUID(), resourceId: 'unscoped-effect', resourceCheck: undefined,
      owner: {id: 'unknown-writer', kind: 'run'}, operationId: 'unknown-effect'}]
  const claims = structuredClone(f.host.resourceReservations)
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
  expect(f.host.resourceReservations).toEqual(claims); expect(f.writes).toHaveLength(1)
})
test('new fixture dependency winning host CAS retains halted repair custody without admitting the probe', async () => {
  const f = await haltedFixtureRepair()
  f.beforeWrite(async () => {f.advance(); f.subject().resource.dependencies.push(f.glasses.subject.id)})
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
  expect(f.host.resourceReservations).toEqual([f.claim]); expect(f.writes).toHaveLength(1)
})
test('own prepared baseline remains eligible without the projected check action', async () => {
  const f = initialBaseline(fixture()); f.subject().supportedActions = ['mark-out-of-service']
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('reserved'); expect(f.writes).toHaveLength(1)
})
test('repair overlap refuses missing or changed original scope, owner, source, dependency and transfer evidence', async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.host.snapshot.resourceReservations!.resourceChecks!.splice(1)},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.journal.state = 'prepared'},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.journal.intent.inputSha256 = 'e'.repeat(64)},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.journal.intent.resourceCheck!.binding.revision = 'e'.repeat(40); f.journal.resourceCheck.binding.revision = 'e'.repeat(40)},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.glasses.owner!.generation = null; f.glasses.supportedActions = []},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.glasses.owner!.generation = f.glasses.owner!.generation! + 1},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.glasses.current = false},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.glasses.repair.state = 'halted'},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.glasses.repair.executionId = 'foreign-fixer'},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {delete f.glasses.repair.interruptionId},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.glasses.idle.acceptedCheck!.subjectGeneration = 0},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.glasses.idle.acceptedCheck!.operationId = 'foreign-check'},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.glasses.resource.dependencies = ['phone-exact']},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.host.snapshot.lanes[0]!.resources[1]!.idleContract!.dependencies = ['phone-exact']},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.host.snapshot.lanes[0]!.resources[1]!.capabilities = ['audio']; f.host.snapshot.lanes[0]!.resources[1]!.exclusiveDependencies = [{resourceId: 'phone-exact', authorityHostId: 'mini', capability: 'audio'}]},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.host.snapshot.lanes[0]!.activity!.owner = {id: 'foreign-fixer', kind: 'fixer'}},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.host.snapshot.lanes[0]!.activity!.owner = {id: 'run-original', kind: 'run', requestId: 'run-original'}},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.host.snapshot.lanes[0]!.dispatchMode = 'paused'},
    (f: Awaited<ReturnType<typeof originalGlassesRepair>>) => {f.host.snapshot.resourceLifecycle!.subjects.splice(1); f.debugHistory = []},
  ]) {
    const f = await originalGlassesRepair(); mutate(f)
    const claims = structuredClone(f.host.resourceReservations), result = await f.service.acquire(f.intent, 'mini')
    expect(result.status).toBe('unknown'); expect(f.writes).toHaveLength(1); expect(f.host.resourceReservations).toEqual(claims)
    expect(f.subject().owner).toBeNull(); expect(f.subject().generation).toBe(0)
  }
})
test('unscoped account and run claims cannot use a different scarce resource ID to bypass baseline lane custody', async () => {
  for (const owner of [{id: 'account-consumer', kind: 'run' as const}, {id: 'held-authoring', kind: 'authoring' as const}]) {
    const f = await originalGlassesRepair(), unrelated = {...structuredClone(f.claim), id: randomUUID(), resourceId: 'account-exact',
      owner, resourceCheck: undefined, operationId: `run:${owner.id}`}
    f.host.resourceReservations = [...hostResourceReservationsSchema.parse(f.host.resourceReservations), unrelated]
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown'); expect(f.writes).toHaveLength(1)
    expect(f.host.resourceReservations).toContainEqual(unrelated)
  }
})
test('same-target authority still fences repair baseline while retained byte budget permits the disjoint reader', async () => {
  for (const kind of ['target', 'byte']) {
    const f = await originalGlassesRepair(), blocker: HostResourceReservation = kind === 'target' ? {...structuredClone(f.claim),
      id: randomUUID(), resourceId: 'phone-exact', laneId: 'other-lane', resourceCheck: undefined} :
      {id: randomUUID(), requestId: 'other-request', fleetInputSha256: hash, hostId: 'mini', laneId: 'android',
        poolId: 'mini-disk', minimumAvailableBytes: 1, reservedAt: f.host.snapshot.observedAt}
    f.host.resourceReservations = [...hostResourceReservationsSchema.parse(f.host.resourceReservations), blocker]
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe(kind === 'byte' ? 'reserved' : 'unknown'); expect(f.writes).toHaveLength(kind === 'byte' ? 2 : 1)
    expect(f.host.resourceReservations).toContainEqual(blocker)
  }
})
test('repair scope changing before original host CAS prevents phone claim without touching prior custody', async () => {
  for (const change of ['generation', 'dependency']) {
    const f = await originalGlassesRepair()
    f.beforeWrite(async () => {f.advance(); if (change === 'generation') f.glasses.owner!.generation = f.glasses.owner!.generation! + 1
      else f.glasses.resource.dependencies.push('phone-exact')})
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown'); expect(f.writes).toHaveLength(1)
    expect(f.host.resourceReservations).toEqual([f.claim]); expect(f.subject().owner).toBeNull()
  }
})

test('offline baseline refuses paused mode and never relaxes target ownership or returning status', async () => {
  for (const change of ['paused', 'owned', 'returning']) {
    const f = initialBaseline(fixture()); f.host.snapshot.lanes[0]!.state = 'offline'
    if (change === 'paused') f.host.snapshot.lanes[0]!.dispatchMode = 'paused'
    else if (change === 'owned') f.subject().owner = {id: 'foreign-owner', kind: 'fixer', generation: 3, hostId: 'mini', laneId: 'android'}
    else f.subject().status = 'returning'
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown'); expect(f.writes).toEqual([])
  }
})
test('historical original repair binding remains cleanup-only while new target baseline uses current accepted source', async () => {
  const f = await originalGlassesRepair(), binding = {...f.host.snapshot.frameworkBinding!, revision: 'e'.repeat(40)},
    target = f.host.snapshot.resourceReservations!.resourceChecks![0]!
  f.host.snapshot.frameworkBinding = binding; f.intent.resourceCheck!.binding = binding
  target.intent = structuredClone(f.intent); target.resourceCheck = structuredClone(f.intent.resourceCheck!)
  target.intentSha256 = requestInputDigest({...f.intent, controller: {incarnation: 'controller', generation: 1},
    dependencies: [{resourceId: 'phone-exact', authorityHostId: 'mini', capability: 'resource-idle'}]})
  const result = await f.service.acquire(f.intent, 'mini')
  expect(result.status).toBe('reserved'); expect(f.host.resourceReservations).toContainEqual(f.claim)
  expect(f.claim.resourceCheck!.binding.revision).not.toBe(binding.revision); expect(f.glasses.owner!.id).toBe('original-glasses-fixer')
})

test('exact operator-check repair without a Core claim permits a disjoint phone baseline', async () => {
  const f = await originalGlassesRepair()
  f.host.resourceReservations = []; f.host.snapshot.resourceReservations!.resourceChecks!.splice(1)
  const before = structuredClone(f.glasses), result = await f.service.acquire(f.intent, 'mini')
  expect(result.status).toBe('reserved'); expect(result.claims).toHaveLength(1)
  expect(f.glasses).toEqual(before); expect(f.host.resourceReservations).toEqual(result.claims)
})
test('claimless repair refuses missing or mismatched current accepted original check', async () => {
  for (const change of ['check', 'generation']) {
    const f = await originalGlassesRepair(); f.host.resourceReservations = []; f.host.snapshot.resourceReservations!.resourceChecks!.splice(1)
    if (change === 'check') f.glasses.idle.acceptedCheck = null
    if (change === 'generation') f.glasses.idle.acceptedCheck!.subjectGeneration = f.glasses.generation
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown'); expect(f.writes).toHaveLength(1)
    expect(f.host.resourceReservations).toEqual([])
  }
})

function targetDependency(f: Awaited<ReturnType<typeof originalGlassesRepair>>, mode: 'lifecycle' | 'contract' | 'exclusive' | 'transitive') {
  const phone = f.subject(), ref = f.host.snapshot.lanes[0]!.resources[0]!
  if (mode === 'lifecycle') phone.resource.dependencies = ['glasses-exact']
  if (mode === 'contract') ref.idleContract!.dependencies = ['glasses-exact']
  if (mode === 'exclusive') {ref.capabilities = ['resource-idle']; ref.exclusiveDependencies = [{resourceId: 'glasses-exact', authorityHostId: 'mini', capability: 'resource-idle'}]}
  if (mode === 'transitive') {
    const dependency = structuredClone(phone); dependency.subject.id = 'phone-dependency'; dependency.resource.kind = 'fixture-data'; dependency.resource.memberships = []; dependency.resource.dependencies = ['glasses-exact']
    f.host.snapshot.resourceLifecycle!.subjects.push(dependency)
    f.host.snapshot.resources = [{...structuredClone(ref), id: dependency.subject.id, kind: 'fixture-data'}]
    phone.resource.dependencies = [dependency.subject.id]
  }
}
for (const claimless of [false, true]) for (const mode of ['lifecycle', 'contract', 'exclusive', 'transitive'] as const)
test(`target complete baseline scope refuses ${mode} overlap with repair: claimless=${claimless}`, async () => {
    const f = await originalGlassesRepair()
    if (claimless) {f.host.resourceReservations = []; f.host.snapshot.resourceReservations!.resourceChecks!.splice(1)}
    targetDependency(f, mode)
    const prior = structuredClone(f.host.resourceReservations), result = await f.service.acquire(f.intent, 'mini')
    expect(result.status).toBe('unknown'); expect(f.writes).toHaveLength(1)
    expect(f.host.resourceReservations).toEqual(prior); expect(f.subject().owner).toBeNull()
})
for (const claimless of [false, true])
test(`target dependency appearing before host CAS cannot acquire beside repair: claimless=${claimless}`, async () => {
    const f = await originalGlassesRepair()
    if (claimless) {f.host.resourceReservations = []; f.host.snapshot.resourceReservations!.resourceChecks!.splice(1)}
    const prior = structuredClone(f.host.resourceReservations)
    f.beforeWrite(async () => {f.advance(); targetDependency(f, 'contract')})
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown'); expect(f.writes).toHaveLength(1)
    expect(f.host.resourceReservations).toEqual(prior)
})

test('a resolved current target dependency disjoint from original repair preserves baseline eligibility', async () => {
  const f = await originalGlassesRepair(), dependency = structuredClone(f.subject())
  dependency.subject.id = 'free-dependency'; dependency.resource.kind = 'fixture-data'; dependency.resource.memberships = []; dependency.generation = 2; dependency.status = 'idle'
  dependency.idle.outcome = 'passed'; dependency.idle.acceptedCheck = {operationId: 'dependency-check', subjectGeneration: 2, resultSha256: hash, acceptedAt: dependency.observedAt!}
  f.host.snapshot.resourceLifecycle!.subjects.push(dependency)
  f.host.snapshot.resources = [{...structuredClone(f.host.snapshot.lanes[0]!.resources[0]!), id: dependency.subject.id, kind: 'fixture-data'}]
  f.subject().resource.dependencies = [dependency.subject.id]
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('reserved'); expect(f.writes).toHaveLength(2)
  expect(f.host.resourceReservations).toContainEqual(f.claim); expect(dependency.owner).toBeNull()
})
test('unresolved foreign cyclic or noncurrent target dependency cannot prove disjoint repair scope', async () => {
  for (const mode of ['unresolved', 'foreign', 'cycle', 'noncurrent', 'owned']) {
    const f = await originalGlassesRepair(), ref = f.host.snapshot.lanes[0]!.resources[0]!
    if (mode === 'unresolved') f.subject().resource.dependencies = ['absent-dependency']
    if (mode === 'foreign') {ref.capabilities = ['resource-idle']; ref.exclusiveDependencies = [{resourceId: 'foreign-dependency', authorityHostId: 'foreign', capability: 'resource-idle'}]}
    if (mode === 'cycle') f.subject().resource.dependencies = ['phone-exact']
    if (mode === 'noncurrent' || mode === 'owned') {
      const dependency = structuredClone(f.subject()); dependency.subject.id = 'unknown-dependency'; dependency.resource.kind = 'fixture-data'; dependency.resource.memberships = []
      if (mode === 'noncurrent') dependency.current = false
      else dependency.owner = {id: 'foreign-holder', kind: 'fixer', generation: 1, hostId: 'mini', laneId: 'android'}
      f.host.snapshot.resourceLifecycle!.subjects.push(dependency)
      f.host.snapshot.resources = [{...structuredClone(ref), id: dependency.subject.id, kind: 'fixture-data'}]
      f.subject().resource.dependencies = [dependency.subject.id]
    }
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown'); expect(f.writes).toHaveLength(1)
    expect(f.host.resourceReservations).toEqual([f.claim])
  }
})
test('a secondary target dependency claim on another lane still blocks baseline during scoped repair', async () => {
  const f = await originalGlassesRepair(), dependency = structuredClone(f.subject())
  dependency.subject.id = 'claimed-dependency'; dependency.resource.kind = 'fixture-data'; dependency.resource.memberships = []
  f.host.snapshot.resourceLifecycle!.subjects.push(dependency)
  f.host.snapshot.resources = [{...structuredClone(f.host.snapshot.lanes[0]!.resources[0]!), id: dependency.subject.id, kind: 'fixture-data'}]
  f.subject().resource.dependencies = [dependency.subject.id]
  const held = {...structuredClone(f.claim), id: randomUUID(), resourceId: dependency.subject.id, laneId: 'another-lane',
    resourceCheck: undefined, owner: {id: 'other-run', kind: 'run' as const}, operationId: 'other-run-operation'}
  f.host.resourceReservations = [...hostResourceReservationsSchema.parse(f.host.resourceReservations), held]
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown'); expect(f.writes).toHaveLength(1)
  expect(f.host.resourceReservations).toContainEqual(held); expect(f.host.resourceReservations).toContainEqual(f.claim)
})

function backendPrecheckFixture() {
  const f = fixture(), check = f.intent.resourceCheck!, target = {jobId: 'original-backend', hostId: f.host.hostId,
    laneId: f.intent.laneId, inputSha256: hash, deadline: new Date(check.deadlineAt).toISOString(),
    purpose: {kind: 'backend-connectivity', resourceId: check.resourceId}, acceptedBinding: check.binding,
    preparing: {dispatchIntentSha256: hash, fleetInputSha256: hash, bindingSha256: hash, admissionSha256: hash, reservationSha256: hash}}
  f.host.snapshot.lanes[0]!.resources[0]!.capabilities = ['backend-connectivity']
  f.intent.resources[0]!.capabilities = ['backend-connectivity']; f.intent.inputSha256 = hash
  f.intent.prerequisite = {kind: 'backend-connectivity', jobId: target.jobId, targetInputSha256: hash,
    resourceId: check.resourceId, binding: check.binding, preparing: target.preparing}
  check.contractVersion = `backend-connectivity:${'b'.repeat(64)}`
  const journal = f.host.snapshot.resourceReservations!.resourceChecks![0]!
  journal.intent = structuredClone(f.intent); journal.resourceCheck = structuredClone(check)
  journal.intentSha256 = requestInputDigest({...f.intent, controller: {incarnation: f.intent.controller.incarnation, generation: f.intent.controller.generation},
    dependencies: [{resourceId: check.resourceId, authorityHostId: f.host.hostId, capability: 'backend-connectivity'}]})
  let targets = [target]
  ;(f.service as any).qualificationTargets = async () => structuredClone(targets)
  return {...f, target, setTargets(value: typeof targets) {targets = value}}
}
test('backend capability precheck selects its exact target without equating its scope hash to the installed idle baseline', async () => {
  const f = backendPrecheckFixture(), before = structuredClone(f.host)
  expect(f.intent.resourceCheck!.contractVersion).not.toBe(f.subject().idle.contractVersion)
  expect(await (f.service as any).resourceCheckTargetCurrent(f.host, f.intent)).toBe(true)
  expect(f.host).toEqual(before); expect(f.writes).toEqual([])
})
for (const changed of ['target', 'source', 'owner', 'generation', 'deadline', 'baseline'] as const)
test(`backend capability precheck preserves ${changed} refusal without claiming the phone`, async () => {
  const f = backendPrecheckFixture()
  if (changed === 'target') f.setTargets([{...f.target, inputSha256: 'c'.repeat(64)}])
  if (changed === 'source') f.host.snapshot.frameworkBinding!.revision = 'c'.repeat(40)
  if (changed === 'owner') {f.subject().status = 'reserved'; f.subject().owner = {id: 'foreign-owner', kind: 'run', hostId: f.host.hostId, generation: 1}}
  if (changed === 'generation') {f.subject().generation++; f.subject().idle.acceptedCheck!.subjectGeneration++}
  if (changed === 'deadline') f.advance(60001)
  if (changed === 'baseline') {delete f.intent.prerequisite; f.intent.resources[0]!.capabilities = ['resource-idle'];
    const journal = f.host.snapshot.resourceReservations!.resourceChecks![0]!; journal.intent = structuredClone(f.intent)}
  expect(await (f.service as any).resourceCheckTargetCurrent(f.host, f.intent)).toBe(false)
  expect(f.writes).toEqual([]); expect(f.host.resourceReservations).toEqual([])
})

// Diagnostic rows stay outside the authoritative host snapshot. Original
// journals, current check identity, custody, source and host CAS still decide.
test('debug event deletion or alteration cannot revoke an exact original returned check ACK', async()=>{
  for(const corrupt of [false,true]) {
    const {f,claim,proof}=await completedHistoricalCheck();
    f.debugHistory=corrupt?[{...f.debugHistory[0]!,checkOperationId:'foreign',subjectGeneration:999,event:'unknown'}]:[];
    const current=structuredClone(f.host.snapshot);
    expect(await f.service.giveBack(proof,'mini')).toEqual({status:'returned',claimId:claim.id});
    expect(f.host.snapshot).toEqual(current); expect(current.resourceLifecycle).not.toHaveProperty('history');
  }
})
test('queued dependency and disjoint repair admission preserve current originals independently of debug events',async()=>{
  for(const create of [queuedFixtureRepair,queuedAppPhoneRepair,queuedRecorderAppRepair,originalGlassesRepair]) {
    for(const corrupt of [false,true]) {
      const f=await create(),claims=structuredClone(f.host.resourceReservations),current=structuredClone(f.host.snapshot);
      f.debugHistory=corrupt?f.debugHistory.map(row=>({...row,ownerId:'foreign',ownerGeneration:999,at:new Date(start-1).toISOString()})):[];
      expect((await f.service.acquire(f.intent,'mini')).status).toBe('reserved');
      for(const claim of claims as HostResourceReservation[]) expect(f.host.resourceReservations).toContainEqual(claim);
      expect(f.host.snapshot).toEqual(current); expect(current.resourceLifecycle).not.toHaveProperty('history');
    }
  }
})
