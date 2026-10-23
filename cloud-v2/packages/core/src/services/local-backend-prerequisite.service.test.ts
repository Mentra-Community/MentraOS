import {expect, spyOn, test} from 'bun:test'
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures'
import {frameworkExecutableBuild, frameworkRequestInputSchema} from '../types/framework-request.types'
import {routineQualificationTargetSchema} from '../types/routine-job.types'
import {resourceLifecycleSubjectSchema} from '../types/resource-lifecycle.types'
import {exclusiveResourceIntentSchema, resourceReservationObservationSchema, type HostResourceReservation, type ExclusiveResourceReturn} from '../types/resource-reservations.types'
import {requestInputDigest, TestRequestConflict} from './test-request.service'
import {TestRunError} from './test-result-error'
import {RoutineJobService, routinePortableRequirements, routineJobInputDigest, type RoutineJobRepository} from './routine-job.service'
import {hostStateSchema, type ReceivedTestHostState} from './test-host-state.service'
import {resourceReservationRepository, ResourceReservationsService, type ResourceReservationHost, type ResourceReservationRepository} from './resource-reservations.service'
import type {RoutineEnrollment} from '../types/routine-definition.types'
import type {CandidateAuthorization} from './candidate-verification.service'

const now = Date.parse('2026-10-19T15:00:00Z'), timestamp = new Date(now).toISOString(), expiry = now + 60_000,
  hash = 'a'.repeat(64), sha = 'b'.repeat(40), binding = {...testFrameworkBinding(), version: 1110, routineApiVersion: 61}
function fixture(candidate = false) {
  let clock = now, alias: unknown = null, permitted = true, enrollment = true, candidateReads = 0
  const definition = {id: 'battery', minimumRoutineApiVersion: 1, title: 'Battery', purpose: 'Read battery', platforms: ['android'],
    entry: 'home', account: 'lane', requirements: [], fixtures: [], steps: [{id: 'battery', instruction: 'Read', expected: 'Read'}],
    execution: {resourceKinds: ['phone', 'app', 'recorder'], policy: {estimatedOutputBytes: 0}}, resourceRequirements: [
      {kind: 'phone', capabilities: ['backend-connectivity']}, {kind: 'app', capabilities: []}, {kind: 'recorder', capabilities: []}],
    source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: sha, path: 'routines/battery/routine.ts'}}
  const enrolled = {routineId: 'battery', platform: 'android', definitionRevision: sha, definition,
    definitionSha256: requestInputDigest(definition), routineSource: testRoutineSource(sha)} as RoutineEnrollment
  const source = {channel: 'dev', buildRunId: 100, publicationAttempt: 1}, build = {repository: 'Mentra-Community/MentraOS',
    headSha: sha, channel: 'dev', kind: 'android-apk', source,
    archive: {name: 'app.apk', url: 'https://artifactscdn.mentraglass.com/app.apk', sha256: hash, size: 100},
    receipt: {url: 'https://artifactscdn.mentraglass.com/app.json', sha256: hash, size: 100}}
  const verification = {workId: 'work:edit', attemptId: 3, sourceRevision: sha}
  const input = frameworkRequestInputSchema.parse({routineId: 'battery', platform: 'android', laneId: 'android', definitionRevision: sha,
    routineSource: enrolled.routineSource, build: frameworkExecutableBuild(build as never), policy: definition.execution.policy,
    resources: [{kind: 'phone', id: 'phone'}, {kind: 'app', id: 'app'}, {kind: 'recorder', id: 'recorder'}],
    ...(candidate ? {verification} : {})})
  const observed: ReceivedTestHostState = {hostId: 'mini', incarnation: 'controller', incarnationGeneration: 1, sequence: 1,
    observedAt: timestamp, receivedAt: timestamp, frameworkBinding: structuredClone(binding), frameworkAcceptedAt: timestamp,
    frameworkProcess: {pid: 100, startedAt: 'framework lifetime'}, resourceReservations: {claims: [], returns: []},
    resourceLifecycle: {schemaVersion: 1, history: [], subjects: [resourceLifecycleSubjectSchema.parse({
      subject: {kind: 'resource', id: 'phone', authorityHostId: 'mini'}, generation: 2, status: 'unknown', observedAt: timestamp,
      receivedAt: timestamp, current: true, reason: null, owner: null, idle: {contractVersion: 'not-commissioned', outcome: 'not-checked',
        checkedAt: null, acceptedCheck: null, qualifiedScope: {kind: 'unqualified'}, evidenceRefs: []}, repair: {configured: false, state: 'none'},
      supportedActions: [], resource: {kind: 'phone', capabilities: ['backend-connectivity'], memberships: [{hostId: 'mini', laneId: 'android'}],
        dependencies: [], placement: 'installed'}})]},
    lanes: [{id: 'android', platform: 'android', dispatchMode: 'paused', state: 'idle', resources: [
      {id: 'phone', kind: 'phone', capabilities: ['backend-connectivity']}, {id: 'app', kind: 'app'},
      {id: 'recorder', kind: 'recorder', storage: {poolId: 'mini:disk', observedAt: timestamp, availableBytes: 10e9,
        stagingBudgetBytes: 1e9, pendingEvidenceBytes: 0, reservations: []}}]}]}
  const body = {jobId: `local:${expiry}:original`, hostId: 'mini', laneId: 'android', deadline: new Date(expiry).toISOString(),
    selection: {requestId: `local:${expiry}:original`, routineId: 'battery', platform: 'android', routineRevision: sha,
      routineSource: enrolled.routineSource, source, build}, requirements: routinePortableRequirements(enrolled),
    purpose: {kind: 'backend-connectivity', resourceId: 'phone'}, acceptedBinding: binding, proposedInput: input,
    target: {hostId: 'mini', laneId: 'android'}, local: {operationId: 'submit:original', requestedAt: timestamp,
      inputSha256: requestInputDigest(input), definitionSha256: enrolled.definitionSha256, admissionExpiresAt: expiry,
      controller: {incarnation: 'controller', generation: 1}, authority: candidate ? {kind: 'candidate', verification,
        installerReceiptSha256: hash, completionOperationId: 'complete:original'} : {kind: 'operator'}}}
  const target = routineQualificationTargetSchema.parse({...body, inputSha256: requestInputDigest(body)})
  observed.resourceReservations!.localPrerequisites = [target]
  const rows = {async get() {return structuredClone(alias)}, async *qualificationCandidates() {}, async insert() {throw Error('No request insertion')}} as unknown as RoutineJobRepository
  const candidates: CandidateAuthorization = {async authorize() {candidateReads++; if (!permitted) throw Error('Candidate cancelled')}}
  const service = new RoutineJobService(rows, undefined, undefined, {async getExact() {return structuredClone(enrolled)}},
    {async get() {return structuredClone(observed)}}, undefined, undefined, () => clock, null, candidates,
    async () => {if (!enrollment) throw Error('Not enrolled')})
  return {observed, target, service, enrolled, input, candidates, rows, reads: () => candidateReads,
    setClock(value: number) {clock = value}, setAlias(value: unknown) {alias = value}, cancel() {permitted = false}, unenroll() {enrollment = false},
    rehash() {const {inputSha256: _, ...body} = target; target.inputSha256 = requestInputDigest(body)}}
}
test('local operator and candidate discovery preserves exact original source/target without fleet rows or mode changes', async () => {
  for (const candidate of [false, true]) {
    const f = fixture(candidate), before = structuredClone(f.observed)
    expect(await f.service.qualificationTargets('mini')).toEqual([f.target]); expect(f.observed).toEqual(before)
    expect(f.reads()).toBe(candidate ? 2 : 0)
    expect(f.target.preparing).toBeUndefined(); expect(f.target.local!.inputSha256).toBe(requestInputDigest(f.input))
    f.unenroll(); await expect(f.service.qualificationTargets('mini')).rejects.toThrow('Not enrolled')
  }
})
test('local target refuses aliases, deadline, build, definition, resource and reporter mismatches', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.setAlias({requestId: f.target.jobId, state: 'terminal'}),
    (f: ReturnType<typeof fixture>) => f.setClock(expiry),
    (f: ReturnType<typeof fixture>) => {f.observed.frameworkBinding!.revision = 'e'.repeat(40)},
    (f: ReturnType<typeof fixture>) => {f.observed.incarnation = 'replacement'},
    (f: ReturnType<typeof fixture>) => {f.target.proposedInput!.minimumFrameworkVersion = 1111; f.target.selection.minimumFrameworkVersion = 1111; f.target.local!.inputSha256 = requestInputDigest(f.target.proposedInput); f.rehash()},
    (f: ReturnType<typeof fixture>) => {f.target.local!.inputSha256 = 'e'.repeat(64); f.rehash()},
    (f: ReturnType<typeof fixture>) => {f.target.local!.definitionSha256 = 'e'.repeat(64); f.rehash()},
    (f: ReturnType<typeof fixture>) => {f.target.proposedInput!.build.headSha = 'e'.repeat(40); f.target.local!.inputSha256 = requestInputDigest(f.target.proposedInput); f.rehash()},
    (f: ReturnType<typeof fixture>) => {f.observed.lanes[0]!.resources[2]!.storage!.availableBytes = 0},
    (f: ReturnType<typeof fixture>) => {f.target.requirements.resources[0]!.capabilities = []; f.rehash()},
    (f: ReturnType<typeof fixture>) => {f.observed.resourceLifecycle!.subjects[0]!.owner = {id: 'other', kind: 'boundary-cleanup', generation: 2, hostId: 'mini', laneId: 'android'}},
  ]) {const f = fixture(); mutate(f); expect(await f.service.qualificationTargets('mini')).toEqual([])}
})
test('candidate cancellation during definition read denies reader eligibility and projection cannot bypass enrollment', async () => {
  const f = fixture(true), service = new RoutineJobService(f.rows, undefined, undefined,
    {async getExact() {f.cancel(); return f.enrolled}}, {async get() {return f.observed}}, undefined, undefined,
    () => now, null, f.candidates, async () => {})
  await expect(service.qualificationTargets('mini')).rejects.toThrow('Candidate cancelled'); expect(f.reads()).toBe(2)
})
test('local snapshot bounds and exclusive origin reject aliasing or oversized projections', () => {
  const f = fixture(), without = structuredClone(f.target); delete without.local
  expect(routineQualificationTargetSchema.safeParse(without).success).toBe(false)
  expect(routineQualificationTargetSchema.safeParse({...f.target, preparing: {dispatchIntentSha256: hash, fleetInputSha256: hash,
    bindingSha256: hash, admissionSha256: hash, reservationSha256: hash}}).success).toBe(false)
  const {receivedAt: _, ...snapshot} = f.observed
  expect(hostStateSchema.parse(snapshot)).toBeDefined()
  const historical = structuredClone(snapshot); historical.incarnation = 'replacement'; historical.incarnationGeneration = 2
  historical.frameworkBinding!.revision = 'e'.repeat(40)
  expect(hostStateSchema.safeParse(historical).success).toBe(true)
  f.observed.resourceReservations!.localPrerequisites = [f.target, f.target]
  expect(hostStateSchema.safeParse(snapshot).success).toBe(false)
  expect(resourceReservationObservationSchema.safeParse({claims: [], returns: [], localPrerequisites: Array(31).fill(f.target)}).success).toBe(false)
  expect(resourceReservationObservationSchema.safeParse({claims: [], returns: [], localPrerequisites: ['x'.repeat(256 * 1024)]}).success).toBe(false)
})
async function claimFixture(options: {lose?: boolean; cancel?: boolean} = {}) {
  const f = fixture(), operationId = 'probe', ownerId = `resource-check:${requestInputDigest({operationId, resourceId: 'phone'})}`,
    subject = f.observed.resourceLifecycle!.subjects[0]!
  subject.status = 'checking'; subject.owner = {id: ownerId, kind: 'boundary-cleanup', generation: 2, hostId: 'mini', laneId: 'android'}
  const {receivedAt: _, ...snapshot} = f.observed
  const row: ResourceReservationHost = {hostId: 'mini', incarnation: 'controller', incarnationGeneration: 1, sequence: 1,
    receivedAt: new Date(now), snapshot, resourceReservations: [], resourceReservationVersion: 0}, writes: HostResourceReservation[][] = []
  const repository: ResourceReservationRepository = {async request() {return null}, async get() {return structuredClone(row)},
    async replace(previous, claims) {if (previous.sequence !== row.sequence || previous.resourceReservationVersion !== row.resourceReservationVersion) return false
      row.resourceReservations = structuredClone(claims); row.resourceReservationVersion!++; writes.push(structuredClone(claims))
      if (options.cancel) row.snapshot.resourceReservations!.localPrerequisites = []
      if (options.lose && writes.length === 1) throw Error('Lost CAS answer'); return true},
    async replaceBackend(previous, claims) {return this.replace(previous, claims)}}
  const intent = exclusiveResourceIntentSchema.parse({operationId, hostId: 'mini', laneId: 'android', owner: {id: ownerId, kind: 'boundary-cleanup'},
    controller: {incarnation: 'controller', generation: 1, sequence: 1}, inputSha256: f.target.inputSha256,
    resources: [{id: 'phone', capabilities: ['backend-connectivity']}], prerequisite: {kind: 'backend-connectivity', jobId: f.target.jobId,
      targetInputSha256: f.target.inputSha256, resourceId: 'phone', binding, local: f.target.local}})
  const service = new ResourceReservationsService(repository, () => now, async (id, owned) => {
    Object.assign(f.observed, row.snapshot); f.observed.receivedAt = timestamp
    return f.service.qualificationTargets(id, owned)
  })
  return {...f, row, writes, repository, intent, service}
}
test('local phone CAS contends with every same-lane recorder and retains one exact concurrent claim', async () => {
  const f = await claimFixture()
  f.row.resourceReservations = [{id: 'd7f3b61c-083b-44d6-8b4e-29b088424e97', requestId: f.target.jobId,
    fleetInputSha256: hash, hostId: 'mini', laneId: 'android', poolId: 'mini:disk', minimumAvailableBytes: 100, reservedAt: timestamp}]
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('waiting'); expect(f.writes).toHaveLength(0)
  f.row.resourceReservations = []
  expect((await Promise.all([f.service.acquire(f.intent, 'mini'), f.service.acquire(f.intent, 'mini')])).map(v => v.status)).toEqual(['reserved', 'reserved'])
  expect(f.writes).toHaveLength(1)
})
test('cancelled or expired local intent recovers original committed custody after lost answer, never reacquires', async () => {
  for (const lose of [false, true]) {
    const f = await claimFixture({lose, cancel: true})
    if (lose) await expect(f.service.acquire(f.intent, 'mini')).rejects.toThrow('Lost CAS answer')
    else expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
    f.setClock(expiry)
    expect((await f.service.observe({intent: f.intent, controller: f.intent.controller}, 'mini')).status).toBe('reserved')
    expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown'); expect(f.writes).toHaveLength(1)
    expect((await f.service.observe({intent: {...f.intent, prerequisite: {...f.intent.prerequisite!, local: {...f.target.local!, operationId: 'different'}}}, controller: f.intent.controller}, 'mini')).status).toBe('unknown')
  }
})
test('cancelled local target accepts only authentic settled release and return ACK, independent of target availability', async () => {
  const f = await claimFixture(), acquired = await f.service.acquire(f.intent, 'mini'), claim = acquired.claims[0]!
  f.row.snapshot.resourceReservations!.localPrerequisites = []
  const subject = f.row.snapshot.resourceLifecycle!.subjects[0]!; subject.owner = null; subject.status = 'unknown'; subject.generation = 3
  f.row.sequence = 2; f.row.snapshot.sequence = 2
  const proof: ExclusiveResourceReturn = {claimId: claim.id, authorityHostId: 'mini', resourceId: 'phone', intentSha256: claim.intentSha256,
    inputSha256: claim.inputSha256, originalOwner: claim.owner, laneId: 'android', controller: {incarnation: 'controller', generation: 1, sequence: 2},
    release: {kind: 'resource-check', operationId: 'probe', subjectGeneration: 3, releasedAt: timestamp, eventId: 'closed'}}
  const {controller: _, ...receipt} = proof; f.row.snapshot.resourceReservations!.returns = [receipt]
  await expect(f.service.giveBack(proof, 'mini')).rejects.toThrow('exact settled')
  f.row.snapshot.resourceLifecycle!.history = [{id: 'closed', resourceId: 'phone', subjectGeneration: 3, at: timestamp,
    event: 'resource-check-released', checkOperationId: 'probe'}]
  expect((await f.service.giveBack(proof, 'mini')).status).toBe('returned')
  expect((await f.service.giveBack(proof, 'mini')).status).toBe('returned'); expect(f.row.resourceReservations).toEqual([])
})
test('production local acquire uses existing host CAS and refuses a Core request alias before any write', async () => {
  const f = await claimFixture(), get = spyOn(resourceReservationRepository, 'request').mockResolvedValue({requestId: f.target.jobId} as never),
    replace = spyOn(resourceReservationRepository, 'replace').mockResolvedValue(true)
  try {expect(await resourceReservationRepository.replaceBackend!(f.row, [], f.intent, new Date(now))).toBe(false); expect(replace).not.toHaveBeenCalled()
    get.mockResolvedValue(null); expect(await resourceReservationRepository.replaceBackend!(f.row, [], f.intent, new Date(now))).toBe(true); expect(replace).toHaveBeenCalledTimes(1)
  } finally {get.mockRestore(); replace.mockRestore()}
})

test('reporter advancement during local lookup denies native authority without discarding historical intent', async () => {
  const f = fixture(), service = new RoutineJobService(f.rows, undefined, undefined,
    {async getExact() {f.observed.sequence++; return f.enrolled}}, {async get() {return structuredClone(f.observed)}},
    undefined, undefined, () => now, null, f.candidates, async () => {})
  expect(await service.qualificationTargets('mini')).toEqual([])
  expect(f.observed.resourceReservations!.localPrerequisites).toEqual([f.target])
})

test('known local withdrawal preserves same-host Mac qualification while outage and unknown errors remain visible', async () => {
  for (const failure of [new TestRequestConflict('Enrollment removed'), new TestRunError(409, 'Candidate cancelled'),
    new TestRunError(503, 'Candidate store unavailable'), Error('Unknown candidate read failure')]) {
    const f = fixture(true), source = {channel: 'dev' as const, buildRunId: 100, publicationAttempt: 1},
      build = {...f.target.selection.build, kind: 'mac-ci-package' as const},
      selection = {...f.target.selection, requestId: 'other-mac', platform: 'ios-on-mac' as const, source, build},
      requirements = {platform: 'ios-on-mac' as const, resources: [{kind: 'app' as const, capabilities: [],
        permissions: [{permission: 'camera' as const, recipient: 'app' as const}]}]},
      preparation = {routineSource: f.enrolled.routineSource, definition: f.enrolled.definition,
        definitionSha256: f.enrolled.definitionSha256, requirements},
      row = {requestId: 'other-mac', state: 'awaiting-runner' as const, fleetSelection: selection,
        fleetSelectionSha256: requestInputDigest(selection), fleetPreparation: preparation, fleetDeadline: new Date(expiry)} as import('../types/routine-job.types').StoredRoutineJob
    row.fleetInputSha256 = routineJobInputDigest(row)
    f.observed.lanes.push({id: 'mac', platform: 'ios-on-mac', state: 'idle', dispatchMode: 'automatic', resources: [{id: 'mac-app', kind: 'app'}]})
    const rows = {...f.rows, async *qualificationCandidates() {yield row}}, candidates = {async authorize() {throw failure}},
      service = new RoutineJobService(rows, undefined, undefined, {async getExact() {return f.enrolled}},
        {async get() {return structuredClone(f.observed)}}, undefined, undefined, () => now, null, candidates, async () => {})
    if (failure instanceof TestRequestConflict || failure instanceof TestRunError && failure.status === 409) {
      const targets = await service.qualificationTargets('mini'); expect(targets.map(value => value.jobId)).toEqual(['other-mac'])
    } else await expect(service.qualificationTargets('mini')).rejects.toThrow(failure.message)
  }
})

test('paused local original revalidates report-only advancement before CAS without adopting another local target',async()=>{
 const f=await claimFixture(),replace=f.repository.replaceBackend!.bind(f.repository);let first=true
 f.repository.replaceBackend=async(host,claims,intent,at)=>{
  if(first){first=false;f.row.sequence++;f.row.snapshot.sequence=f.row.sequence}
  return replace(host,claims,intent,at)
 }
 const answer=await f.service.acquire(f.intent,'mini')
 expect(answer.status).toBe('reserved');expect(f.row.snapshot.lanes[0]!.dispatchMode).toBe('paused')
 expect(f.writes).toHaveLength(1);expect(answer.claims[0]!.borrowerSequence).toBe(f.intent.controller.sequence)
 expect(answer.claims[0]!.prerequisite!.local).toEqual(f.target.local)
 expect((await f.service.observe({intent:f.intent,controller:{...f.intent.controller,sequence:f.row.sequence}},'mini')).claims).toEqual(answer.claims)
 expect(f.writes).toHaveLength(1)
})
