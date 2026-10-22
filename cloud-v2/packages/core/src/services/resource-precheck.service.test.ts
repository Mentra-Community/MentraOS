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
import {resourceLifecycleSubjectSchema} from '../types/resource-lifecycle.types'

const start = Date.parse('2026-10-18T23:00:00Z'), hash = 'a'.repeat(64)
function fixture(standalone = false) {
  let now = start, lost = false, beforeWrite: (() => Promise<void>) | undefined
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
  return {host, intent, digest, service, controls, writes, subject:()=>host.snapshot.resourceLifecycle!.subjects[0]!,
    beforeWrite(action:()=>Promise<void>) {beforeWrite=action}, loseReply() {lost=true},
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
      if(!neverBegan)host.snapshot.resourceLifecycle!.history.push({id:eventId,resourceId,subjectGeneration:s.generation,at:at(),event:'resource-check-released',checkOperationId:operationId})
      const {controller:_,...published}=proof;host.snapshot.resourceReservations!.returns=[published];return proof
    }}
}

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
  f.host.snapshot.resourceLifecycle!.history = [{id: 'exact-check-passed', resourceId: claim.resourceId, subjectGeneration: 9,
    at: checkedAt, event: 'check-passed', ownerId: owner.id, ownerGeneration: owner.generation, hostId: 'mini', laneId}]
  f.advance(releaseDelay)
  const releasedAt = f.host.snapshot.observedAt
  f.host.snapshot.resourceLifecycle!.history.push({id: 'exact-resource-released', resourceId: claim.resourceId, subjectGeneration: 10,
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
    (f: ReturnType<typeof fixture>) => {f.host.snapshot.resourceLifecycle!.history.shift()},
    (f: ReturnType<typeof fixture>) => {f.host.snapshot.resourceLifecycle!.history.pop()},
    (f: ReturnType<typeof fixture>) => {f.host.snapshot.resourceLifecycle!.history[0]!.ownerId = 'unrelated-fixer'},
    (f: ReturnType<typeof fixture>) => {f.host.snapshot.resourceLifecycle!.history[1]!.ownerGeneration = 10},
    (f: ReturnType<typeof fixture>) => {f.host.snapshot.resourceLifecycle!.history[1]!.laneId = 'unrelated-lane'},
    (f: ReturnType<typeof fixture>) => {f.host.snapshot.resourceLifecycle!.history[1]!.at = new Date(start).toISOString()},
    (f: ReturnType<typeof fixture>) => {f.host.snapshot.resourceLifecycle!.history.push({id: 'unknown-generation', resourceId: f.intent.resourceCheck!.resourceId, subjectGeneration: null, event: 'unknown', at: f.host.snapshot.observedAt})},
    (f: ReturnType<typeof fixture>) => {f.host.snapshot.resourceLifecycle!.history.push({...f.host.snapshot.resourceLifecycle!.history[0]!, id: 'ambiguous-check'})},
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
