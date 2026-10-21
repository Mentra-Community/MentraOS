import {expect, spyOn, test} from 'bun:test'
import {isDeepStrictEqual} from 'node:util'
import {requestInputDigest, TestRequestService, type TestRequestRepository, type StoredRequest, type StoredTestRequest} from './test-request.service'
import {backendPrerequisiteRequestMatches, resourceReservationRepository, ResourceReservationsService, type ResourceReservationHost, type ResourceReservationRepository} from './resource-reservations.service'
import {RoutineJobService, compatibleRoutineLane, reconcileRecorderHostReservations, routineJobInputDigest, routineJobRepository, routineLaneContext, routineLaneDescriptorRevision, type RoutineJobRepository} from './routine-job.service'
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures'
import {routineDispatchIntentSchema} from '../types/routine-dispatch.types'
import {portableRoutineSelectionSchema, type OwnedRoutineQualification, type StoredRoutineJob, type FleetCandidatePreparation} from '../types/routine-job.types'
import {hostStateSchema, type ReceivedTestHostState} from './test-host-state.service'
import {backendConnectivityObservationSchema} from '../types/backend-connectivity.types'
import {resourceLifecycleSubjectSchema} from '../types/resource-lifecycle.types'
import {hostResourceReservationsSchema, type ExclusiveResourceIntent, type ExclusiveResourceReturn, type HostResourceReservation} from '../types/resource-reservations.types'
import {TestHostStateModel} from '../models/test-host-state.model'
import {TestRequestModel} from '../models/test-request.model'
import {projectResourceLifecycle} from './resource-lifecycle.service'
import type {RecorderHostReservation} from '../types/recorder-storage.types'
import {candidateSettlement, candidatePrerequisiteRequestMatches, completedCandidatePreparationForHost} from './backend-candidate-preparation'
import {BACKEND_CANDIDATE_ROUTINE_API_VERSION, backendConnectivityObservationRefusesPreparation} from '../types/backend-connectivity.types'

const now = Date.parse('2026-10-18T23:00:00Z'), timestamp = new Date(now).toISOString(), hash = 'a'.repeat(64), sha = 'b'.repeat(40)
const binding = {...testFrameworkBinding(), version: 1110, routineApiVersion: 61}
function phoneSubject() {
  return resourceLifecycleSubjectSchema.parse({subject: {kind: 'resource', id: 'phone', authorityHostId: 'mini'}, generation: 2,
    status: 'unknown', observedAt: timestamp, receivedAt: timestamp, current: true, reason: null, owner: null,
    idle: {contractVersion: 'not-commissioned', outcome: 'not-checked', checkedAt: null, acceptedCheck: null,
      qualifiedScope: {kind: 'unqualified'}, evidenceRefs: []}, repair: {configured: false, state: 'none'}, supportedActions: [],
    resource: {kind: 'phone', capabilities: ['backend-connectivity'], memberships: [{hostId: 'mini', laneId: 'android'}],
      dependencies: [], placement: 'installed'}})
}
function host(): ReceivedTestHostState {
  return {hostId: 'mini', incarnation: 'controller', incarnationGeneration: 1, sequence: 1, observedAt: timestamp,
    receivedAt: timestamp, frameworkBinding: structuredClone(binding), frameworkAcceptedAt: timestamp,
    frameworkProcess: {pid: 100, startedAt: 'framework lifetime'}, resourceLifecycle: {schemaVersion: 1, subjects: [phoneSubject()], history: []},
    lanes: [{id: 'android', platform: 'android', dispatchMode: 'automatic', state: 'idle', resources: [
      {id: 'phone', kind: 'phone', capabilities: ['backend-connectivity']}, {id: 'app', kind: 'app'},
      {id: 'recorder', kind: 'recorder', storage: {poolId: 'mini:disk', observedAt: timestamp, availableBytes: 10e9,
        stagingBudgetBytes: 1e9, pendingEvidenceBytes: 0, reservations: []}}]}]}
}
function job(): StoredRoutineJob {
  const source = {channel: 'dev', buildRunId: 100, publicationAttempt: 1}, selection = portableRoutineSelectionSchema.parse({
    requestId: 'original', routineId: 'battery', platform: 'android', routineRevision: sha, source,
    build: {repository: 'Mentra-Community/MentraOS', headSha: sha, channel: 'dev', kind: 'android-apk', source,
      archive: {name: 'app.apk', url: 'https://artifactscdn.mentraglass.com/app.apk', sha256: hash, size: 100},
      receipt: {url: 'https://artifactscdn.mentraglass.com/app.json', sha256: hash, size: 100}}}),
    requirements = {platform: 'android' as const, resources: [{kind: 'phone' as const, capabilities: ['backend-connectivity']},
      {kind: 'app' as const, capabilities: []}, {kind: 'recorder' as const, capabilities: [], storage: {minimumAvailableBytes: 100}}]},
    definition = {id: 'battery', minimumRoutineApiVersion: 1, title: 'Battery', purpose: 'Read battery', platforms: ['android'],
      entry: 'home', account: 'lane', requirements: [], fixtures: [], steps: [{id: 'battery', instruction: 'Read', expected: 'Read'}],
      execution: {resourceKinds: ['phone', 'app', 'recorder'], policy: {estimatedOutputBytes: 0}}, resourceRequirements: requirements.resources,
      source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: sha, path: 'routines/battery/routine.ts'}},
    value = {requestId: 'original', state: 'awaiting-runner' as const, fleetSelection: selection,
      fleetSelectionSha256: requestInputDigest(selection), fleetDeadline: new Date(now + 60_000),
      fleetPreparation: {routineSource: testRoutineSource(sha), requirements, definitionSha256: requestInputDigest(definition), definition}} as StoredRoutineJob
  value.fleetInputSha256 = routineJobInputDigest(value)
  return value
}
function selectPreparing(value: StoredRoutineJob, observed: ReceivedTestHostState) {
  const lane = observed.lanes[0]!, intent = routineDispatchIntentSchema.parse({...value.fleetSelection, routineSource: value.fleetPreparation!.routineSource, laneId: lane.id})
  value.state = 'preparing'; value.hostId = observed.hostId; value.dispatchIntent = intent; value.dispatchIntentSha256 = requestInputDigest(intent)
  value.fleetBinding = {jobId: value.requestId, requestId: value.requestId, hostId: observed.hostId, laneId: lane.id,
    descriptorRevision: routineLaneDescriptorRevision(lane), actionsRunId: '1', actionsJobId: '2', boundAt: timestamp}
  value.fleetResourceReservation = {id: 'd7f3b61c-083b-44d6-8b4e-29b088424e97', requestId: value.requestId,
    fleetInputSha256: value.fleetInputSha256!, hostId: observed.hostId, laneId: lane.id, poolId: 'mini:disk', minimumAvailableBytes: 2147483648, reservedAt: timestamp}
  value.fleetResourceAdmission = {intent: {operationId: `run:${value.requestId}`, hostId: observed.hostId, laneId: lane.id,
    owner: {id: value.requestId, kind: 'run'}, inputSha256: value.fleetInputSha256!, controller: {incarnation: 'controller', generation: 1, sequence: 1},
    resources: value.fleetPreparation!.requirements.resources.map(required => ({id: lane.resources.find(resource => resource.kind === required.kind)!.id, capabilities: required.capabilities}))}, dependencies: []}
}
function fixture() {
  const observed = host(), original = job(); selectPreparing(original, observed); const requests: RoutineJobRepository = {async get() {return structuredClone(original)},
    async *qualificationCandidates() {yield structuredClone(original)}, async insert() {throw Error('No mutations')},
    async prepare() {throw Error('No mutations')}, async bind() {throw Error('No mutations')}, async cancel() {throw Error('No mutations')}}
  const service = new RoutineJobService(requests, undefined, undefined, undefined,
    {async get() {return structuredClone(observed)}}, undefined, undefined, () => now)
  return {observed, original, service}
}
function qualified() {
  return backendConnectivityObservationSchema.parse({schemaVersion: 1, capability: 'backend-connectivity', outcome: 'qualified',
    observedAt: timestamp, phoneResourceId: 'phone', binding, controller: {incarnation: 'controller', generation: 1},
    app: {headSha: sha, archiveSha256: hash, receiptSha256: hash}, target: {schemaVersion: 1, coreUrl: 'https://api.dev.mentraglass.com'},
    targetSource: 'verified-apk-configuration', bootId: '06965353-509e-4b20-a6d9-746e553b5315', tool: {path: '/tools/adb', sha256: hash},
    check: {operationId: 'probe', resultSha256: hash, readersSha256: hash, closedAt: timestamp},
    releasedGeneration: 2, appRouteVerified: false})
}
function unqualified() {
  const value = qualified(), targetInputSha256 = 'c'.repeat(64)
  value.outcome = 'unqualified'
  value.qualification = {jobId: 'previous-original', targetInputSha256, inputSha256: hash,
    preparing: {dispatchIntentSha256: hash, fleetInputSha256: hash, bindingSha256: hash, admissionSha256: hash, reservationSha256: hash}}
  value.check.operationId = `backend-prerequisite:${targetInputSha256}`
  return value
}

/** Later admission/CAS fixtures begin after an authentic candidate contract has returned. */
async function returnedCandidateFixture(value: StoredRoutineJob, observed: ReceivedTestHostState, laneId = 'android') {
  observed.frameworkBinding = {...observed.frameworkBinding!, routineApiVersion: BACKEND_CANDIDATE_ROUTINE_API_VERSION}
  observed.resourceReservations = {claims: [], returns: [], candidatePrerequisites: []}
  observed.authorityReservations = []
  const repository = {async get() {return structuredClone(value)}, async recorderClaims() {return []}, async selectedLanes() {return []},
    async candidatePreparation(_row: StoredRoutineJob, pending: FleetCandidatePreparation) {value.fleetCandidatePreparation = structuredClone(pending); return structuredClone(value)},
    async reserveResources() {throw Error('Candidate construction cannot claim run capacity')},
  } as unknown as RoutineJobRepository
  const service = new RoutineJobService(repository, undefined, undefined, undefined,
    {async get() {return structuredClone(observed)}, async list() {return [structuredClone(observed)]}}, undefined, undefined, () => now)
  const offered = observed.lanes; observed.lanes = offered.filter(lane => lane.id === laneId)
  try {await service.preparation(value.requestId)} finally {observed.lanes = offered}
  const pending = value.fleetCandidatePreparation
  if (!pending) throw Error('Fixture must construct the real pre-binding target')
  const lane = observed.lanes.find(lane => lane.id === laneId)!, phone = lane.resources.find(resource => resource.kind === 'phone')!,
    subject = observed.resourceLifecycle!.subjects.find(subject => subject.subject.id === phone.id)!, operationId = `backend-prerequisite:${pending.targetInputSha256}`,
    owner = {id: `fixture-check:${value.requestId}`, kind: 'boundary-cleanup' as const}, health = qualified()
  pending.backendTarget = health.target
  pending.claimReceipt = {kind: 'exclusive', id: 'db92760a-6ee2-445d-b1f7-c1b454fdceab', authorityHostId: observed.hostId,
    borrowerHostId: observed.hostId, laneId, resourceId: phone.id, operationId, intentSha256: hash, inputSha256: pending.targetInputSha256,
    owner, controllerIncarnation: observed.incarnation!, controllerGeneration: observed.incarnationGeneration!, borrowerSequence: observed.sequence!, reservedAt: timestamp,
    prerequisite: {kind: 'backend-connectivity', jobId: value.requestId, targetInputSha256: pending.targetInputSha256,
      resourceId: phone.id, binding: observed.frameworkBinding, candidate: pending.candidate, target: pending.backendTarget}}
  pending.returnReceipt = {claimId: 'db92760a-6ee2-445d-b1f7-c1b454fdceab', authorityHostId: observed.hostId, resourceId: phone.id,
    intentSha256: hash, inputSha256: pending.targetInputSha256, originalOwner: owner, laneId,
    controller: {incarnation: observed.incarnation!, generation: observed.incarnationGeneration!, sequence: observed.sequence! + 1},
    release: {kind: 'resource-check', operationId, subjectGeneration: subject.generation!, releasedAt: timestamp, eventId: 'fixture-returned'}}
  health.binding = observed.frameworkBinding!; health.controller = pending.candidate.controller; health.phoneResourceId = phone.id
  health.releasedGeneration = subject.generation!; health.check.operationId = operationId
  health.qualification = {jobId: value.requestId, targetInputSha256: pending.targetInputSha256,
    inputSha256: requestInputDigest(pending.target.proposedInput), candidate: pending.candidate}
  phone.backendConnectivity = health
  observed.resourceReservations.candidatePrerequisites = [{targetInputSha256: pending.targetInputSha256, candidate: pending.candidate,
    outcome: 'qualified', hostWorkSettled: true, checkOperationId: operationId}]
  const settlement = candidateSettlement(pending, observed, [], now)
  if (!settlement) throw Error('Fixture must retain matching raw-work and phone-return settlement')
  value.fleetCandidatePreparations = [{...structuredClone(pending), settlement}]
  value.fleetCandidateSelection = {hostId: observed.hostId, laneId, targetInputSha256: pending.targetInputSha256}
  delete value.fleetCandidatePreparation
}

async function executableFixture() {
  const f = fixture(); f.original.fleetDeadline = new Date(now + 300_000)
  f.original.fleetInputSha256 = routineJobInputDigest(f.original); selectPreparing(f.original, f.observed)
  const target = (await f.service.qualificationTargets('mini'))[0]!, input = target.proposedInput!, writes: unknown[] = []
  let clock = now
  const observation = qualified()
  observation.qualification = {jobId: 'original', targetInputSha256: target.inputSha256,
    inputSha256: requestInputDigest(input), preparing: target.preparing!}
  observation.check.operationId = `backend-prerequisite:${target.inputSha256}`
  f.observed.lanes[0]!.resources[0]!.backendConnectivity = observation
  f.observed.authorityReservations = [f.original.fleetResourceReservation!]
  const repository = {async get() {return structuredClone(f.original) as unknown as StoredRequest},
    async completePreparation(_requestId: string, _hostId: string, _intent: string, saved: unknown, digest: string, _exclusive: unknown, _admission: unknown, fence: Record<string, unknown>) {
      expect(fence.fleetResourceReservation).toEqual(f.original.fleetResourceReservation)
      if (f.original.state !== 'preparing' || f.original.fleetCancellation || f.original.fleetDeadline.getTime() <= clock) return null
      writes.push(saved); f.original.state = 'queued'; Object.assign(f.original, {input: saved, inputSha256: digest})
      return structuredClone(f.original) as unknown as StoredTestRequest
    }} as unknown as TestRequestRepository
  const make = (enrolled: (() => Promise<void>) | null = null, get = async () => structuredClone(f.observed)) =>
    new TestRequestService(repository, undefined, enrolled, null, () => clock, {get})
  return {...f, target, input, writes, make, setClock(value: number) {clock = value},
    complete(service = make()) {return service.completePreparation('original', 'mini', f.original.dispatchIntentSha256!, input)}}
}
test('executable adoption uses one late fresh original proof after preparation exceeds 120 seconds', async () => {
  const f = await executableFixture(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const completing = f.complete(f.make(async () => {entered.resolve(); await resume.promise}))
  await entered.promise; f.setClock(now + 120_001)
  expect(f.writes).toEqual([]); expect(f.original.state).toBe('preparing')
  const late = new Date(now + 120_001).toISOString(), observation = f.observed.lanes[0]!.resources[0]!.backendConnectivity!
  f.observed.receivedAt = late; f.observed.observedAt = late; observation.observedAt = late; observation.check.closedAt = late
  resume.resolve(); expect((await completing).state).toBe('queued'); expect(f.writes).toHaveLength(1)
})
test('executable adoption refuses stale, different original, unknown, changed generation or retained phone claim', async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof executableFixture>>) => {f.setClock(now + 120_001)},
    (f: Awaited<ReturnType<typeof executableFixture>>) => {delete f.observed.lanes[0]!.resources[0]!.backendConnectivity!.qualification},
    (f: Awaited<ReturnType<typeof executableFixture>>) => {f.observed.lanes[0]!.resources[0]!.backendConnectivity!.qualification!.jobId = 'other'},
    (f: Awaited<ReturnType<typeof executableFixture>>) => {f.observed.lanes[0]!.resources[0]!.backendConnectivity!.qualification!.inputSha256 = 'f'.repeat(64)},
    (f: Awaited<ReturnType<typeof executableFixture>>) => {f.observed.lanes[0]!.resources[0]!.backendConnectivity!.qualification!.preparing!.bindingSha256 = 'f'.repeat(64)},
    (f: Awaited<ReturnType<typeof executableFixture>>) => {f.observed.lanes[0]!.resources[0]!.backendConnectivity!.outcome = 'unknown'},
    (f: Awaited<ReturnType<typeof executableFixture>>) => {f.observed.resourceLifecycle!.subjects[0]!.generation++},
    (f: Awaited<ReturnType<typeof executableFixture>>) => {f.observed.authorityReservations = []},
    (f: Awaited<ReturnType<typeof executableFixture>>) => {f.observed.frameworkBinding!.revision = 'e'.repeat(40)},
  ]) {const f = await executableFixture(); mutate(f); await expect(f.complete()).rejects.toThrow('current settled'); expect(f.writes).toEqual([])}
  const wrong=await executableFixture(),value=wrong.observed.lanes[0]!.resources[0]!.backendConnectivity!
  value.qualification!.targetInputSha256='f'.repeat(64);value.check.operationId=`backend-prerequisite:${'f'.repeat(64)}`
  await expect(wrong.complete()).rejects.toThrow('changed before executable admission');expect(wrong.writes).toEqual([])
})
test('cancellation or source replacement during current host read cannot adopt executable input', async () => {
  for (const cancel of [true, false]) {
    const f = await executableFixture(), get = async () => {
      if (cancel) f.original.fleetCancellation = {requestedAt: timestamp, reason: 'Cancelled during host read'}
      else f.original.fleetPreparation!.routineSource = testRoutineSource('e'.repeat(40))
      return structuredClone(f.observed)
    }
    await expect(f.complete(f.make(null, get))).rejects.toThrow('changed before executable admission')
    expect(f.writes).toEqual([])
  }
})

test('Android discovery returns exact selected preparing target and legacy API cannot discover it', async () => {
  const f = fixture(), before = structuredClone(f.original), targets = await f.service.qualificationTargets('mini')
  expect(targets).toHaveLength(1)
  expect(targets[0]!.purpose).toEqual({kind: 'backend-connectivity', resourceId: 'phone'})
  const {inputSha256, ...target} = targets[0]!
  expect(inputSha256).toBe(requestInputDigest(target)); expect(f.original).toEqual(before)
  expect(targets[0]!.preparing?.reservationSha256).toBe(requestInputDigest(f.original.fleetResourceReservation)); expect(targets[0]!.proposedInput).toBeDefined()
  f.observed.lanes[0]!.dispatchMode = 'paused'
  expect(await f.service.qualificationTargets('mini')).toEqual([])
  f.observed.lanes[0]!.dispatchMode = 'automatic'
  f.observed.frameworkBinding!.routineApiVersion = 60
  expect(await f.service.qualificationTargets('mini')).toEqual([])
})
test('cancelled, expired, selected or structurally unsuitable Android work cannot qualify', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {f.original.fleetCancellation = {requestedAt: timestamp, reason: 'Cancelled'}},
    (f: ReturnType<typeof fixture>) => {f.original.fleetDeadline = new Date(now)},
    (f: ReturnType<typeof fixture>) => {f.original.state = 'awaiting-runner'},
    (f: ReturnType<typeof fixture>) => {f.original.fleetResourceAdmission = {} as never},
    (f: ReturnType<typeof fixture>) => {f.observed.lanes[0]!.resources[2]!.storage!.availableBytes = 0},
    (f: ReturnType<typeof fixture>) => {f.observed.lanes[0]!.resources[0]!.capabilities = []},
  ]) {const f = fixture(); mutate(f); expect(await f.service.qualificationTargets('mini')).toEqual([])}
})
test('backend health matches current APK/controller/released resource generation without physical idle proof', async () => {
  const f = fixture(), lane = f.observed.lanes[0]!, requirements = f.original.fleetPreparation!.requirements
  expect(compatibleRoutineLane(requirements, lane, routineLaneContext(f.observed, f.original.fleetSelection.build, now))).toBe(false)
  lane.resources[0]!.backendConnectivity = qualified()
  expect(compatibleRoutineLane(requirements, lane, routineLaneContext(f.observed, f.original.fleetSelection.build, now))).toBe(true)
  const context = routineLaneContext(f.observed, f.original.fleetSelection.build, now)
  context!.binding = Object.fromEntries(Object.entries(context!.binding).reverse()) as NonNullable<typeof context>['binding']
  context!.app = Object.fromEntries(Object.entries(context!.app!).reverse()) as NonNullable<typeof context>['app']
  expect(compatibleRoutineLane(requirements, lane, context)).toBe(true)
  expect(f.observed.resourceLifecycle!.subjects[0]!.idle.outcome).toBe('not-checked')
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {f.observed.lanes[0]!.resources[0]!.backendConnectivity!.observedAt = new Date(now - 120_001).toISOString()},
    (f: ReturnType<typeof fixture>) => {f.observed.lanes[0]!.resources[0]!.backendConnectivity!.app.headSha = 'c'.repeat(40)},
    (f: ReturnType<typeof fixture>) => {const value=f.observed.lanes[0]!.resources[0]!.backendConnectivity!;value.binding={...value.binding,publicApiSha256:'f'.repeat(64)}},
    (f: ReturnType<typeof fixture>) => {f.observed.lanes[0]!.resources[0]!.backendConnectivity!.app.receiptSha256 = 'd'.repeat(64)},
    (f: ReturnType<typeof fixture>) => {f.observed.incarnation = 'replacement'},
    (f: ReturnType<typeof fixture>) => {f.observed.resourceLifecycle!.subjects[0]!.generation++},
    (f: ReturnType<typeof fixture>) => {f.observed.resourceLifecycle!.subjects[0]!.current = false},
    (f: ReturnType<typeof fixture>) => {f.observed.lanes[0]!.resources[0]!.backendConnectivity!.outcome = 'unknown'},
  ]) {const f = fixture(); f.observed.lanes[0]!.resources[0]!.backendConnectivity = qualified(); mutate(f)
    expect(compatibleRoutineLane(f.original.fleetPreparation!.requirements, f.observed.lanes[0]!, routineLaneContext(f.observed, f.original.fleetSelection.build, now))).toBe(false)}
  const offline = {...requirements, resources: requirements.resources.map(resource => resource.kind === 'phone' ? {...resource, capabilities: []} : resource)}
  delete lane.resources[0]!.backendConnectivity
  expect(compatibleRoutineLane(offline, lane, routineLaneContext(f.observed, f.original.fleetSelection.build, now))).toBe(true)
})

async function claimFixture(options: {cancelAfterWrite?: boolean; loseAnswer?: boolean; advanceBeforeRelease?: boolean} = {}) {
  const f = fixture(), target = (await f.service.qualificationTargets('mini'))[0]!, operationId = 'probe',
    ownerId = `resource-check:${requestInputDigest({operationId, resourceId: 'phone'})}`,
    subject = f.observed.resourceLifecycle!.subjects[0]!
  subject.status = 'checking'; subject.owner = {id: ownerId, kind: 'boundary-cleanup', generation: 2, hostId: 'mini', laneId: 'android'}
  const {receivedAt: _, ...snapshot} = f.observed
  const row: ResourceReservationHost = {hostId: 'mini', incarnation: 'controller', incarnationGeneration: 1, sequence: 1,
    receivedAt: new Date(now), snapshot, resourceReservations: [], resourceReservationVersion: 0}, writes: HostResourceReservation[][] = []
  let lost = false, replacing = false
  const repository: ResourceReservationRepository = {async request() {return structuredClone(f.original)}, async get() {const value = structuredClone(row)
    if (options.advanceBeforeRelease && replacing) {row.sequence++; row.snapshot.sequence = row.sequence}
    return value}, async replace(previous, claims) {
      if (previous.incarnation !== row.incarnation || previous.incarnationGeneration !== row.incarnationGeneration ||
        previous.sequence !== row.sequence || previous.resourceReservationVersion !== row.resourceReservationVersion) return false
      row.resourceReservations = structuredClone(claims); row.resourceReservationVersion!++; writes.push(structuredClone(claims))
      if (options.cancelAfterWrite) f.original.fleetCancellation = {requestedAt: timestamp, reason: 'Cancelled during CAS'}
      if (options.loseAnswer && !lost) {lost = true; throw Error('CAS answer lost')}
      return true
    }, async replaceBackend(previous, claims, intent) {
      if (!backendPrerequisiteRequestMatches(f.original, intent, now)) return false
      return this.replace(previous, claims)
    }}
  const intent: ExclusiveResourceIntent = {operationId, hostId: 'mini', laneId: 'android', owner: {id: ownerId, kind: 'boundary-cleanup'},
    controller: {incarnation: 'controller', generation: 1, sequence: 1}, inputSha256: target.inputSha256,
    resources: [{id: 'phone', capabilities: ['backend-connectivity']}],
    prerequisite: {kind: 'backend-connectivity', jobId: 'original', targetInputSha256: target.inputSha256, resourceId: 'phone', binding, preparing: target.preparing!}}
  const service = new ResourceReservationsService(repository, () => now, (hostId, owned) => f.service.qualificationTargets(hostId, owned))
  return {...f, row, intent, service, repository, writes, target, targets: (hostId: string, owned?: OwnedRoutineQualification) => f.service.qualificationTargets(hostId, owned),
    beforeRelease() {replacing = true},
    owned(): OwnedRoutineQualification {return {jobId: 'original', laneId: 'android', inputSha256: target.inputSha256,
      ownerId, generation: 2, binding, controller: {incarnation: 'controller', generation: 1}, purpose: {kind: 'backend-connectivity', resourceId: 'phone'}}}}
}
test('owned lookup requires exact resource check owner and original target while lane stays physically idle', async () => {
  const f = await claimFixture()
  const original = fixture(); original.observed.resourceLifecycle = f.observed.resourceLifecycle
  expect((await original.service.qualificationTargets('mini', f.owned()))[0]?.inputSha256).toBe(f.target.inputSha256)
  expect(await original.service.qualificationTargets('mini', {...f.owned(), generation: 3})).toEqual([])
})
test('owned lookup can omit the unchanged exact phone target during a same-reporter heartbeat', async () => {
  for (const advanceAt of [2, 3]) {
    const claim = await claimFixture(), f = fixture(); f.observed.resourceLifecycle = claim.observed.resourceLifecycle
    const before = structuredClone(f.original), target = (await f.service.qualificationTargets('mini', claim.owned()))[0]!
    let reads = 0, advancing = true
    const service = new RoutineJobService({async get() {return structuredClone(f.original)}} as unknown as RoutineJobRepository,
      undefined, undefined, undefined, {async get() {
        if (++reads === advanceAt && advancing) f.observed.sequence++
        return structuredClone(f.observed)
      }}, undefined, undefined, () => now)
    expect(await service.qualificationTargets('mini', claim.owned())).toEqual([])
    expect(f.observed.incarnation).toBe('controller'); expect(f.observed.incarnationGeneration).toBe(1)
    expect(f.observed.lanes[0]!.state).toBe('idle')
    expect(f.observed.resourceLifecycle!.subjects[0]!.owner).toMatchObject({id: claim.owned().ownerId, generation: 2})
    expect(f.original).toEqual(before); expect(claim.writes).toEqual([])
    advancing = false
    const current = (await service.qualificationTargets('mini', claim.owned()))[0]!
    expect(current).toEqual(target); expect(current.proposedInput).toEqual(target.proposedInput)
  }
})
test('owned lookup budget exhaustion is absence without withdrawal or any acquired phone claim', async () => {
  const claim = await claimFixture(), f = fixture(); f.observed.resourceLifecycle = claim.observed.resourceLifecycle
  const target = (await f.service.qualificationTargets('mini', claim.owned()))[0]!, before = structuredClone(f.original)
  let clock = now, exhaust = true
  const service = new RoutineJobService({async get() {
    if (exhaust) clock += 5_000
    return structuredClone(f.original)
  }} as unknown as RoutineJobRepository, undefined, undefined, undefined,
  {async get() {return structuredClone(f.observed)}}, undefined, undefined, () => clock)
  expect(await service.qualificationTargets('mini', claim.owned())).toEqual([])
  expect(f.original).toEqual(before); expect(claim.writes).toEqual([])
  exhaust = false
  expect((await service.qualificationTargets('mini', claim.owned()))[0]).toEqual(target)
})
test('owned lookup needs the actual check-owner snapshot after an older in-flight report', async () => {
  const claim = await claimFixture(), f = fixture(), oldReport = structuredClone(f.observed)
  f.observed.resourceLifecycle = claim.observed.resourceLifecycle
  const target = (await f.service.qualificationTargets('mini', claim.owned()))[0]!
  let pendingOldReport = true
  const service = new RoutineJobService({async get() {return structuredClone(f.original)}} as unknown as RoutineJobRepository,
    undefined, undefined, undefined, {async get() {return structuredClone(pendingOldReport ? oldReport : f.observed)}},
    undefined, undefined, () => now)
  expect(await service.qualificationTargets('mini', claim.owned())).toEqual([])
  expect(claim.writes).toEqual([]); pendingOldReport = false; f.observed.sequence++
  expect((await service.qualificationTargets('mini', claim.owned()))[0]).toEqual(target)
  expect(await service.qualificationTargets('mini', {...claim.owned(), generation: 3})).toEqual([])
  f.original.fleetCancellation = {requestedAt: timestamp, reason: 'Original cancelled'}
  expect(await service.qualificationTargets('mini', claim.owned())).toEqual([])
})
test('one phone check contends with retained run claims before any target stage or native authority', async () => {
  const f = await claimFixture()
  f.row.resourceReservations = [{id: 'd7f3b61c-083b-44d6-8b4e-29b088424e97', requestId: 'retained-run',
    fleetInputSha256: hash, hostId: 'mini', laneId: 'android', poolId: 'mini:disk', minimumAvailableBytes: 100, reservedAt: timestamp}]
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('waiting'); expect(f.writes).toHaveLength(0)
  f.row.resourceReservations = []
  const outcomes = await Promise.all([f.service.acquire(f.intent, 'mini'), f.service.acquire(f.intent, 'mini')])
  expect(outcomes.every(value => value.status === 'reserved')).toBe(true)
  expect(f.writes).toHaveLength(1); expect(f.row.resourceReservations).toHaveLength(1)
})
test('cancellation during phone CAS retains uncertain claim; observation never renews or creates custody', async () => {
  const f = await claimFixture({cancelAfterWrite: true})
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
  expect(f.row.resourceReservations).toHaveLength(1)
  expect((await f.service.observe({intent: f.intent, controller: f.intent.controller}, 'mini')).status).toBe('reserved')
  expect(f.writes).toHaveLength(1)
  expect((await f.service.observe({intent: {...f.intent, prerequisite: {...f.intent.prerequisite!, jobId: 'substitute'}}, controller: f.intent.controller}, 'mini')).status).toBe('unknown')
  expect(f.writes).toHaveLength(1)
})
test('lost acquisition answer recovers only original raw phone claim without another write', async () => {
  const f = await claimFixture({loseAnswer: true})
  await expect(f.service.acquire(f.intent, 'mini')).rejects.toThrow('CAS answer lost')
  expect((await f.service.observe({intent: f.intent, controller: f.intent.controller}, 'mini')).status).toBe('reserved')
  expect(f.writes).toHaveLength(1)
})
test('reporter replacement during target lookup refuses reader authority before any phone claim', async () => {
  const f = await claimFixture(), service = new ResourceReservationsService({
    async get() {return structuredClone(f.row)}, async replace() {throw Error('No generic authority mutation')},
    async replaceBackend() {throw Error('No admission after a stale target lookup')},
  }, () => now, async (hostId, owned) => {
    const targets = await fixtureWithHost(f.observed).qualificationTargets(hostId, owned)
    f.row.sequence++; f.row.snapshot.sequence = f.row.sequence
    return targets
  })
  expect((await service.acquire(f.intent, 'mini')).status).toBe('unknown')
  expect(f.row.resourceReservations).toEqual([])
})
function fixtureWithHost(observed: ReceivedTestHostState) {
  const f = fixture(); Object.assign(f.observed, structuredClone(observed)); return f.service
}
test('retained raw phone claim preserves real local generation and unqualified idle in resource overview', async () => {
  const f = await claimFixture()
  await f.service.acquire(f.intent, 'mini')
  const [subject] = projectResourceLifecycle([f.row], now, 'phone').subjects
  expect(subject!.resource.kind).toBe('phone'); expect(subject!.resource.placement).toBe('installed')
  expect(subject!.generation).toBe(2); expect(subject!.idle.outcome).toBe('not-checked')
  expect(subject!.owner?.id).toBe(f.intent.owner.id); expect(subject!.supportedActions).toEqual([])
})
test('only real settled resource check event/current unowned generation returns phone; no physical idle is invented', async () => {
  const f = await claimFixture(), acquired = await f.service.acquire(f.intent, 'mini'), claim = acquired.claims[0]!
  const subject = f.row.snapshot.resourceLifecycle!.subjects[0]!
  subject.owner = null; subject.status = 'unknown'; subject.generation = 3
  f.row.sequence = 2; f.row.snapshot.sequence = 2
  const proof: ExclusiveResourceReturn = {claimId: claim.id, authorityHostId: 'mini', resourceId: 'phone', intentSha256: claim.intentSha256,
    inputSha256: claim.inputSha256, originalOwner: claim.owner, laneId: 'android',
    controller: {incarnation: 'controller', generation: 1, sequence: 2},
    release: {kind: 'resource-check', operationId: 'probe', subjectGeneration: 3, releasedAt: timestamp, eventId: 'settled-check'}}
  const {controller: _, ...receipt} = proof
  f.row.snapshot.resourceReservations = {claims: [], returns: [receipt]}
  await expect(f.service.giveBack(proof, 'mini')).rejects.toThrow('exact settled')
  f.row.snapshot.resourceLifecycle!.history = [{id: 'settled-check', resourceId: 'phone', subjectGeneration: 3,
    at: timestamp, event: 'resource-check-released', checkOperationId: 'probe'}]
  expect((await f.service.giveBack(proof, 'mini')).status).toBe('returned')
  expect(hostResourceReservationsSchema.parse(f.row.resourceReservations)).toEqual([])
  expect(subject.idle.outcome).toBe('not-checked')
})

/** Exercise the production host/request CAS paths without database transaction support. */
async function portableFixture() {
  const f = await claimFixture(); f.original = job()
  f.row.snapshot.resourceLifecycle!.subjects[0]!.owner = null
  f.row.snapshot.resourceLifecycle!.subjects[0]!.status = 'unknown'
  f.row.snapshot.lanes[0]!.resources[0]!.backendConnectivity = qualified()
  const current = {host: structuredClone(f.row), request: structuredClone(f.original)}, events: string[] = []
  const returnedHost:ReceivedTestHostState = {...structuredClone(current.host.snapshot), receivedAt: timestamp}
  await returnedCandidateFixture(current.request, returnedHost)
  const {receivedAt: _receivedAt, authorityReservations: _claims, ...returnedSnapshot} = returnedHost
  current.host.snapshot = hostStateSchema.parse(returnedSnapshot)
  const requests = new Map([['original', current.request]])
  const clock = spyOn(Date, 'now').mockReturnValue(now)
  const reserveFleet = ResourceReservationsService.prototype.reserveFleet
  const reserveClock = spyOn(ResourceReservationsService.prototype, 'reserveFleet').mockImplementation(async (...args) =>
    reserveFleet.call(new ResourceReservationsService(resourceReservationRepository, () => now), ...args))
  let loseHost = false, loseStage = false, cancelOnHost = false, unavailable = false
  let pausedKind: 'probe' | 'run' | undefined, pauseEntered = () => {}, pauseResume = () => {}
  let pausePromise: Promise<void> | undefined
  let duplicates: HostResourceReservation[] = []
  const requestGet = spyOn(routineJobRepository, 'get').mockImplementation(async id => structuredClone(requests.get(id) ?? null))
  const hostGet = spyOn(resourceReservationRepository, 'get').mockImplementation(async () => structuredClone(current.host))
  const originalGet = spyOn(resourceReservationRepository, 'request').mockImplementation(async id => structuredClone(requests.get(id) ?? null))
  const claimedHosts = spyOn(resourceReservationRepository, 'claimedHosts').mockImplementation(async () => [])
  const recorderClaims = spyOn(resourceReservationRepository, 'recorderClaims').mockImplementation(async id =>
    [...hostResourceReservationsSchema.parse(current.host.resourceReservations), ...hostResourceReservationsSchema.parse(duplicates)]
      .filter((claim): claim is import('../types/recorder-storage.types').RecorderHostReservation => !('kind' in claim) && claim.requestId === id))
  const requestRead = spyOn(TestRequestModel.collection, 'findOne').mockImplementation((async (filter: Record<string, unknown>) => {
    const row = requests.get(String(filter.requestId))
    if (!row) return null
    if (filter.state && (row.state !== filter.state || row.fleetCancellation || row.fleetBinding || row.fleetDeadline <= new Date(now))) return null
    return structuredClone(row)
  }) as never)
  const requestList = spyOn(TestRequestModel.collection, 'find').mockImplementation((() => ({limit() {return this}, async toArray() {return [...requests.values()].map(value => structuredClone(value))}})) as never)
  const hostRead = spyOn(TestHostStateModel.collection, 'findOne').mockImplementation((async () => structuredClone(current.host)) as never)
  const hostCas = async (filter: Record<string, unknown>, update: {$inc: {resourceReservationVersion: number}; $set: {resourceReservations: HostResourceReservation[]}}) => {
    const kind = update.$set.resourceReservations.some(claim => 'kind' in claim) ? 'probe' : 'run'
    if (pausedKind === kind) {pausedKind = undefined; pauseEntered(); await pausePromise}
    if (unavailable) throw Error('Host CAS unavailable')
    const row = current.host
    if (filter.sequence !== row.sequence || filter.resourceReservationVersion !== row.resourceReservationVersion) return null
    row.resourceReservationVersion! += update.$inc.resourceReservationVersion
    row.resourceReservations = structuredClone(update.$set.resourceReservations)
    events.push('host-claim')
    if (cancelOnHost) current.request.fleetCancellation = {requestedAt: timestamp, reason: 'Cancelled during retained admission'}
    if (loseHost) {loseHost = false; throw Error('Host CAS answer lost')}
    return structuredClone(row)
  }
  const hostWrite = spyOn(TestHostStateModel.collection, 'findOneAndUpdate').mockImplementation(hostCas as never)
  const replace = spyOn(resourceReservationRepository, 'replace').mockImplementation(async (host, claims) => Boolean(await hostCas({sequence: host.sequence,
    resourceReservationVersion: host.resourceReservationVersion}, {$inc: {resourceReservationVersion: 1}, $set: {resourceReservations: claims}})))
  const requestWrite = spyOn(TestRequestModel.collection, 'findOneAndUpdate').mockImplementation((async (filter: Record<string, unknown>, update: {$set: Partial<StoredRoutineJob>}) => {
    const row = requests.get(String(filter.requestId))
    if (!row) return null
    if (row.fleetCancellation || row.fleetBinding || row.state !== 'awaiting-runner' || row.fleetDeadline <= new Date(now)) return null
    if (update.$set.fleetResourceAdmission) {
      if (row.fleetResourceAdmission) return null
      row.fleetResourceAdmission = structuredClone(update.$set.fleetResourceAdmission)
      events.push('request-stage')
      if (loseStage) {loseStage = false; throw Error('Stage answer lost')}
    } else if (update.$set.fleetResourceReservation) {
      if (row.fleetResourceReservation) return null
      Object.assign(row, structuredClone(update.$set)); events.push('request-receipt')
    } else {Object.assign(row, structuredClone(update.$set)); events.push('request-bind')}
    return structuredClone(row)
  }) as never)
  const admission = {intent: {operationId: 'run:original', hostId: 'mini', laneId: 'android', owner: {id: 'original', kind: 'run' as const},
    inputSha256: f.original.fleetInputSha256!, controller: {incarnation: 'controller', generation: 1, sequence: 1},
    resources: [{id: 'phone', capabilities: ['backend-connectivity']}, {id: 'app', capabilities: []}, {id: 'recorder', capabilities: []}]}, dependencies: []}
  const probe = {kind: 'exclusive' as const, id: '9e62b752-e4ce-46e5-acb9-bc682c5b4862', resourceId: 'phone', authorityHostId: 'mini', borrowerHostId: 'mini',
    laneId: 'android', operationId: f.intent.operationId, intentSha256: hash, inputSha256: f.intent.inputSha256, owner: f.intent.owner,
    prerequisite: f.intent.prerequisite, controllerIncarnation: 'controller', controllerGeneration: 1, borrowerSequence: 1, reservedAt: timestamp}
  return {...f, current, admission, probe, events, requests,
    addRequest(id: string, offline = false) {const value = job(); value.requestId = id; value.fleetSelection.requestId = id;
      value.fleetSelectionSha256 = requestInputDigest(value.fleetSelection)
      if (offline) {const required = value.fleetPreparation!.requirements.resources[0]!; required.capabilities = []
        value.fleetPreparation!.definition.resourceRequirements[0]!.capabilities = []
        value.fleetPreparation!.definitionSha256 = requestInputDigest(value.fleetPreparation!.definition)}
      value.fleetInputSha256 = routineJobInputDigest(value); requests.set(id, value); return value},
    loseHost() {loseHost = true}, loseStage() {loseStage = true}, cancelOnHost() {cancelOnHost = true}, unavailable() {unavailable = true},
    duplicate() {const claim = current.host.resourceReservations as HostResourceReservation[]; duplicates = [{...claim[0]!, id: '05e28570-91a8-486e-aecb-c1d7b7874e79', hostId: 'other'} as HostResourceReservation]},
    pause(kind: 'probe' | 'run') {pausedKind = kind; pausePromise = new Promise(resolve => {pauseResume = resolve})
      return {entered: new Promise<void>(resolve => {pauseEntered = resolve}), resume() {pauseResume()}}},
    async prepareCandidate(id = 'original', laneId = 'android') {const observed:ReceivedTestHostState = {...structuredClone(current.host.snapshot), receivedAt: timestamp};
      await returnedCandidateFixture(requests.get(id)!, observed, laneId);const {receivedAt: _, authorityReservations: _claims, ...snapshot} = observed;current.host.snapshot = hostStateSchema.parse(snapshot)},
    async reserve(hostId = 'mini', laneId = 'android', id = 'original', at = now, onWaiting?: (reason: string) => void) {return routineJobRepository.reserveResources!(id, requests.get(id)!.fleetInputSha256!, hostId, laneId, new Date(at), onWaiting)},
    restore() {for (const mock of [reserveClock, clock, requestGet, hostGet, originalGet, claimedHosts, recorderClaims, requestRead, requestList, hostRead, hostWrite, replace, requestWrite]) mock.mockRestore()}}
}
test('fresh settled negative refuses repeated new original admissions before any custody write', async () => {
  const f = await portableFixture()
  try {
    f.current.host.snapshot.lanes[0]!.resources[0]!.backendConnectivity = {...unqualified(),binding:f.current.host.snapshot.frameworkBinding!}
    const reasons: string[] = []
    for (let i = 0; i < 10; i++) {
      const id = `scheduled-original-${i}`; f.addRequest(id)
      expect(await f.reserve('mini', 'android', id, now, reason => {reasons.push(reason)})).toBeNull()
      expect(f.requests.get(id)!.fleetResourceAdmission).toBeUndefined()
      expect(f.requests.get(id)!.fleetResourceReservation).toBeUndefined()
    }
    expect(reasons).toEqual(Array(10).fill('The phone’s internet connection check failed. Waiting for a new check.'))
    expect(f.events).toEqual([]); expect(f.current.host.resourceReservations).toEqual([])
    const offline = f.addRequest('offline-original', true)
    expect(await f.reserve('mini', 'android', offline.requestId)).not.toBeNull()
  } finally {f.restore()}
})
test('new preparation selects a healthy alternative while preserving an already selected original', async () => {
  const observed = host(), other = structuredClone(observed), negative = unqualified()
  observed.lanes[0]!.resources[0]!.backendConnectivity = negative
  other.hostId = 'other'; other.lanes[0]!.id = 'other-android'
  other.resourceLifecycle!.subjects[0]!.subject.authorityHostId = 'other'
  const original = job(), choices: string[] = []
  const rows: RoutineJobRepository = {async get() {return structuredClone(original)},
    async insert() {throw Error('No insert')}, async prepare() {throw Error('No prepare')}, async bind() {throw Error('No bind')}, async cancel() {throw Error('No cancel')},
    async reserveResources(id, digest, hostId, laneId) {choices.push(hostId); return {...structuredClone(original), fleetResourceReservation: {
      id: 'd7f3b61c-083b-44d6-8b4e-29b088424e97', requestId: id, fleetInputSha256: digest, hostId, laneId,
      poolId: 'mini:disk', minimumAvailableBytes: 2147483648, reservedAt: timestamp}}}, async recorderClaims() {return []}}
  const service = new RoutineJobService(rows, undefined, undefined, undefined,
    {async get(id) {return structuredClone(id === 'mini' ? observed : other)}, async list() {return [structuredClone(observed), structuredClone(other)]}},
    undefined, undefined, () => now)
  for (let i = 0; i < 10; i++) {
    original.requestId = `next-${i}`
    original.fleetSelection.requestId = original.requestId; original.fleetSelectionSha256 = requestInputDigest(original.fleetSelection);original.fleetInputSha256 = routineJobInputDigest(original)
    delete original.fleetResourceReservation; delete original.fleetCandidateSelection; delete original.fleetCandidatePreparations
    await returnedCandidateFixture(original, other, 'other-android')
    expect(await service.preparation(original.requestId)).toMatchObject({resourceTarget: {hostId: 'other', laneId: 'other-android'}})
  }
  expect(choices).toEqual(Array(10).fill('other'))
  original.fleetResourceReservation = {id: 'd7f3b61c-083b-44d6-8b4e-29b088424e97', requestId: original.requestId,
    fleetInputSha256: original.fleetInputSha256!, hostId: 'mini', laneId: 'android', poolId: 'mini:disk', minimumAvailableBytes: 2147483648, reservedAt: timestamp}
  delete original.fleetCandidateSelection;delete original.fleetCandidatePreparations
  expect(await service.preparation(original.requestId)).toMatchObject({resourceTarget: {hostId: 'mini', laneId: 'android'}})
  expect(choices.at(-1)).toBe('mini')
  const bound = fixture(); bound.observed.lanes[0]!.resources[0]!.backendConnectivity = negative
  expect((await bound.service.qualificationTargets('mini'))[0]!.jobId).toBe('original')
})
test('the original negative expires after 120 seconds without renewing its timestamp or creating an earlier claim', async () => {
  const f = await portableFixture()
  try {
    const value = {...unqualified(),binding:f.current.host.snapshot.frameworkBinding!}, original = f.current.request, observedAt = new Date(now - 120_000).toISOString()
    value.observedAt = value.check.closedAt = observedAt
    original.fleetDeadline = new Date(now + 300_000); original.fleetInputSha256 = routineJobInputDigest(original)
    f.current.host.snapshot.lanes[0]!.resources[0]!.backendConnectivity = value
    expect(await f.reserve()).toBeNull(); expect(f.events).toEqual([])
    const later = now + 1
    expect(await f.reserve('mini', 'android', 'original', later)).toBeNull()
    expect(value.observedAt).toBe(observedAt); expect(value.check.closedAt).toBe(observedAt)
    expect(f.events).toEqual([]); expect(f.current.request.fleetResourceReservation).toBeUndefined()
  } finally {f.restore()}
})
test('a late negative cannot move or erase the original provisional claim after a lost reply', async () => {
  const f = await portableFixture()
  try {
    f.loseHost(); await expect(f.reserve()).rejects.toThrow('Host CAS answer lost')
    const claim = structuredClone((f.current.host.resourceReservations as RecorderHostReservation[])[0]!)
    f.current.host.snapshot.lanes[0]!.resources[0]!.backendConnectivity = {...unqualified(),binding:f.current.host.snapshot.frameworkBinding!}
    expect(await f.reserve()).toBeNull()
    expect(f.current.request.fleetResourceReservation).toBeUndefined()
    expect(f.current.host.resourceReservations).toEqual([claim])
    expect(f.events).toEqual(['host-claim'])
  } finally {f.restore()}
})
test('a negative reported after lane preference still refuses the authoritative new claim', async () => {
  const f = await portableFixture()
  try {
    const before = {...structuredClone(f.current.host.snapshot), receivedAt: timestamp}
    const rows: RoutineJobRepository = {...routineJobRepository,
      async get(id) {return structuredClone(f.requests.get(id) ?? null)}, async recorderClaims() {return []},
      async selectedLanes() {return []}, async reserveResources(id, _digest, hostId, laneId) {
        f.current.host.snapshot.lanes[0]!.resources[0]!.backendConnectivity = {...unqualified(),binding:f.current.host.snapshot.frameworkBinding!}
        return f.reserve(hostId, laneId, id)
      }}
    const service = new RoutineJobService(rows, undefined, undefined, undefined,
      {async get() {return structuredClone(before)}, async list() {return [structuredClone(before)]}}, undefined, undefined, () => now)
    expect(await service.preparation('original')).toMatchObject({state: 'awaiting-runner'})
    expect(f.events).toEqual([]); expect(f.current.host.resourceReservations).toEqual([])
    expect(f.current.request.fleetResourceAdmission).toBeUndefined()
  } finally {f.restore()}
})
test.each(['stale', 'future', 'binding', 'incarnation', 'controller-generation', 'phone-generation', 'not-current', 'owned', 'apk', 'receipt', 'unknown', 'qualified', 'boot', 'operation'])(
  'a %s negative cannot suppress a new original prerequisite', async kind => {
    const f = await portableFixture()
    try {
      const value = {...unqualified(),binding:f.current.host.snapshot.frameworkBinding!}, subject = f.current.host.snapshot.resourceLifecycle!.subjects[0]!
      f.current.host.snapshot.lanes[0]!.resources[0]!.backendConnectivity = value
      if (kind === 'stale') value.observedAt = value.check.closedAt = new Date(now - 120_001).toISOString()
      if (kind === 'future') value.observedAt = value.check.closedAt = new Date(now + 1).toISOString()
      if (kind === 'binding') value.binding = {...value.binding, revision: 'e'.repeat(40)}
      if (kind === 'incarnation') value.controller.incarnation = 'other'
      if (kind === 'controller-generation') value.controller.generation++
      if (kind === 'phone-generation') subject.generation++
      if (kind === 'not-current') subject.current = false
      if (kind === 'owned') subject.owner = {id: 'other', kind: 'boundary-cleanup', generation: 2, hostId: 'mini', laneId: 'android'}
      if (kind === 'apk') value.app.archiveSha256 = 'd'.repeat(64)
      if (kind === 'receipt') value.app.receiptSha256 = 'd'.repeat(64)
      if (kind === 'unknown') value.outcome = 'unknown'
      if (kind === 'qualified') value.outcome = 'qualified'
      if (kind === 'boot') value.bootId = null
      if (kind === 'operation') value.check.operationId = 'foreign'
      expect(backendConnectivityObservationRefusesPreparation(value,'phone',routineLaneContext(f.current.host.snapshot,f.current.request.fleetSelection.build,now)!)).toBe(false)
      expect(await f.reserve()).toBeNull();expect(f.events).toEqual([]);expect(f.current.request.fleetResourceAdmission).toBeUndefined()
    } finally {f.restore()}
  }
)
test('portable backend admission retains the byte claim before staging and refuses a stale probe CAS', async () => {
  const f = await portableFixture()
  try {
    expect(await f.reserve()).not.toBeNull()
    expect(f.events).toEqual(['host-claim', 'request-stage', 'request-receipt'])
    expect(await resourceReservationRepository.replaceBackend!(f.row, [f.probe], f.intent, new Date(now))).toBe(false)
    expect(f.current.host.resourceReservations).toHaveLength(1)
    expect('kind' in (f.current.host.resourceReservations as HostResourceReservation[])[0]!).toBe(false)
    expect(f.current.request.fleetBinding).toBeUndefined(); expect(f.current.request.hostId).toBeUndefined()
  } finally {f.restore()}
})
test('selected prerequisite claim shares the host CAS with a concurrent unrelated run claim', async () => {
  const f = await claimFixture(), own = structuredClone(f.original.fleetResourceReservation!), originalReplace = f.repository.replace
  f.row.resourceReservations = [own]
  let enter!: () => void, resume!: () => void
  const entered = new Promise<void>(resolve => {enter = resolve}), held = new Promise<void>(resolve => {resume = resolve})
  f.repository.replace = async (previous, claims) => {enter(); await held; return originalReplace.call(f.repository, previous, claims)}
  const probe = f.service.acquire(f.intent, 'mini'); await entered
  const other = {...own, id: 'e7cd9d0b-b18d-44e2-bd7a-f7d7f795a4a6', requestId: 'other-run'}
  expect(await originalReplace.call(f.repository, structuredClone(f.row), [own, other])).toBe(true)
  resume()
  expect((await probe).status).toBe('waiting'); expect(f.writes).toHaveLength(1)
  expect(f.row.resourceReservations).toEqual([own, other])
})
test('an unbound original cannot create phone prerequisite custody', async () => {
  const f = await portableFixture()
  try {
    expect(await resourceReservationRepository.replaceBackend!(f.row, [f.probe], f.intent, new Date(now))).toBe(false)
    expect(f.events).toEqual([]); expect(await f.reserve()).not.toBeNull()
    expect(f.current.request.fleetBinding).toBeUndefined()
  } finally {f.restore()}
})
test('another original retained on the same phone blocks prerequisite custody before any run receipt', async () => {
  const f = await claimFixture()
  f.row.resourceReservations = [{id: '2734af72-1351-4f1a-a940-9f7f1d843557', requestId: 'other-original', fleetInputSha256: hash,
    hostId: 'mini', laneId: 'android', poolId: 'mini:disk', minimumAvailableBytes: 100, reservedAt: timestamp}]
  const answer = await f.service.acquire(f.intent, 'mini')
  expect(answer.status).toBe('waiting')
  if ('blocked' in answer && answer.blocked) {expect(answer.blocked.resourceId).toBe('phone'); expect(answer.blocked.owner).toEqual({kind: 'run', id: 'other-original'})}
  expect(f.writes).toHaveLength(0)
})
test('portable admission refuses unavailable host CAS without a stage or fallback', async () => {
  const f = await portableFixture()
  try {
    f.unavailable()
    await expect(f.reserve()).rejects.toThrow('Host CAS unavailable')
    expect(f.events).toEqual([]); expect(f.current.host.resourceReservations).toEqual([])
    expect(f.current.request.fleetResourceAdmission).toBeUndefined()
  } finally {f.restore()}
})
test('negative or expired capability health cannot claim run capacity before fresh candidate qualification', async () => {
  for (const outcome of ['unqualified', 'unknown'] as const) {
    const f = await portableFixture()
    try {
      f.current.host.snapshot.lanes[0]!.resources[0]!.backendConnectivity!.outcome = outcome
      f.current.host.snapshot.lanes[0]!.resources[0]!.backendConnectivity!.observedAt = new Date(now - 120001).toISOString()
      expect(await f.reserve()).toBeNull()
      expect(f.current.request.fleetResourceAdmission).toBeUndefined(); expect(f.current.request.fleetBinding).toBeUndefined()
      expect((f.current.request as unknown as {input?:unknown}).input).toBeUndefined(); expect(f.current.request.inputSha256).toBeUndefined()
    } finally {f.restore()}
  }
})
test('an ambiguous late provisional claimant cannot overwrite the immutable staged winner', async () => {
  const f = await portableFixture()
  try {
    f.loseStage(); await expect(f.reserve()).rejects.toThrow('Stage answer lost')
    const winner = structuredClone(f.current.request.fleetResourceAdmission)
    f.duplicate()
    expect(await resourceReservationRepository.stageBackend!('original', f.original.fleetInputSha256!,
      {...f.admission, intent: {...f.admission.intent, hostId: 'other'}}, {...f.current.host, hostId: 'other'}, new Date(now))).toBeNull()
    expect(f.current.request.fleetResourceAdmission).toEqual(winner)
    expect(await f.reserve()).toBeNull(); expect(f.current.request.fleetResourceReservation).toBeUndefined()
    expect(f.current.host.resourceReservations).toHaveLength(1)
  } finally {f.restore()}
})
test('lost byte claim reply retains original custody and restart selects only the same claim', async () => {
  const f = await portableFixture()
  try {
    f.loseHost()
    await expect(f.reserve()).rejects.toThrow('Host CAS answer lost')
    const originalClaim = structuredClone((f.current.host.resourceReservations as RecorderHostReservation[])[0]!)
    expect(f.current.request.fleetResourceAdmission).toBeUndefined()
    expect(await f.reserve('other', 'android')).toBeNull()
    expect((await f.reserve())?.fleetResourceReservation).toEqual(originalClaim)
    expect(f.current.host.resourceReservations).toEqual([originalClaim])
    expect(f.events).toEqual(['host-claim', 'request-stage', 'request-receipt'])
  } finally {f.restore()}
})
test('lost stage reply retains the same original claim and restart adopts its existing request stage', async () => {
  const f = await portableFixture()
  try {
    f.loseStage()
    await expect(f.reserve()).rejects.toThrow('Stage answer lost')
    const claim = structuredClone((f.current.host.resourceReservations as RecorderHostReservation[])[0]!)
    expect(f.current.request.fleetResourceAdmission).toEqual(f.admission)
    expect((await f.reserve())?.fleetResourceReservation).toEqual(claim)
    expect(f.events).toEqual(['host-claim', 'request-stage', 'request-receipt'])
  } finally {f.restore()}
})
test('cross-host duplicate original custody refuses staging, receipt and binding', async () => {
  const f = await portableFixture()
  try {
    f.loseHost(); await expect(f.reserve()).rejects.toThrow('Host CAS answer lost'); f.duplicate()
    expect(await f.reserve()).toBeNull()
    expect(await resourceReservationRepository.stageBackend!('original', f.original.fleetInputSha256!, f.admission, f.current.host, new Date(now))).toBeNull()
    f.current.request.fleetResourceAdmission = f.admission
    f.current.request.fleetResourceReservation = (f.current.host.resourceReservations as import('../types/recorder-storage.types').RecorderHostReservation[])[0]
    expect(await routineJobRepository.bind('original', f.original.fleetInputSha256!, {jobId: 'original', requestId: 'original',
      hostId: 'mini', laneId: 'android', descriptorRevision: hash, actionsRunId: '1', actionsJobId: '2', boundAt: timestamp}, {}, new Date(now))).toBeNull()
    expect(f.current.request.fleetBinding).toBeUndefined(); expect(f.events).toEqual(['host-claim'])
  } finally {f.restore()}
})
test('cancellation after byte CAS never stages or binds; uncertain or absent requests retain original custody', async () => {
  const f = await portableFixture()
  try {
    f.cancelOnHost(); expect(await f.reserve()).toBeNull()
    const claims = f.current.host.resourceReservations as import('../types/recorder-storage.types').RecorderHostReservation[]
    expect(claims).toHaveLength(1); expect(f.current.request.fleetResourceAdmission).toBeUndefined()
    const offer = f.current.host.snapshot.lanes[0]!.resources[2]!.storage!
    expect(reconcileRecorderHostReservations(claims, [], offer)).toEqual(claims)
    const waiting = structuredClone(f.original)
    expect(reconcileRecorderHostReservations(claims, [waiting], offer)).toEqual(claims)
    expect(reconcileRecorderHostReservations(claims, [f.current.request], offer)).toEqual([])
    expect(f.current.host.resourceReservations).toEqual(claims); expect(f.events).toEqual(['host-claim'])
  } finally {f.restore()}
})
test('exact terminal cancellation reconciles a provisional byte claim with current empty offer and preserves another owner', async () => {
  const f = await portableFixture()
  try {
    f.loseHost(); await expect(f.reserve()).rejects.toThrow('Host CAS answer lost')
    const claim = (f.current.host.resourceReservations as RecorderHostReservation[])[0]!
    f.current.host.resourceReservations = [claim, {...claim, requestId: 'other-original', id: '4d3c730b-a12a-42fc-817d-aa4c459332e0'}]
    f.current.request.fleetCancellation = {requestedAt: timestamp, reason: 'Original cancelled before execution'}
    f.current.request.state = 'terminal'
    const offer = f.current.host.snapshot.lanes[0]!.resources[2]!.storage!
    offer.reservations = [{requestId: 'original', inputSha256: hash, remainingOutputBytes: 0}]
    await routineJobRepository.reconcileBackendRecorderCancellation!('original', new Date(now))
    expect(f.current.host.resourceReservations).toHaveLength(2)
    offer.reservations = []; offer.observedAt = new Date(now - 1).toISOString()
    await routineJobRepository.reconcileBackendRecorderCancellation!('original', new Date(now))
    expect(f.current.host.resourceReservations).toHaveLength(2)
    offer.observedAt = timestamp
    await routineJobRepository.reconcileBackendRecorderCancellation!('original', new Date(now))
    expect((f.current.host.resourceReservations as RecorderHostReservation[]).map(value => value.requestId)).toEqual(['other-original'])
    expect(f.current.request.fleetResourceAdmission).toBeUndefined(); expect(f.current.request.fleetBinding).toBeUndefined()
  } finally {f.restore()}
})

function releasedNoClaim(f: Awaited<ReturnType<typeof claimFixture>>) {
  f.row.sequence++; f.row.snapshot.sequence = f.row.sequence
  const subject = f.row.snapshot.resourceLifecycle!.subjects[0]!
  subject.owner = null; subject.status = 'unknown'; subject.generation++
  return {incarnation: f.row.incarnation, generation: f.row.incarnationGeneration, sequence: f.row.sequence}
}
test('not-acquired needs a newer reporter and host CAS barrier after current unowned phone release', async () => {
  const f = await claimFixture()
  f.original.fleetCancellation = {requestedAt: timestamp, reason: 'Target cancelled before any claim'}
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown'); expect(f.writes).toHaveLength(0)
  const controller = releasedNoClaim(f), unrelated: RecorderHostReservation = {id: 'ca48a08f-1b0b-4f8d-a8bb-1d0a35cda011',
    requestId: 'another-original', fleetInputSha256: hash, hostId: 'mini', laneId: 'android', poolId: 'mini:disk', minimumAvailableBytes: 100, reservedAt: timestamp}
  f.row.resourceReservations = [unrelated]
  expect(await f.service.observe({intent: f.intent, controller}, 'mini')).toEqual({status: 'not-acquired',
    intentSha256: requestInputDigest({...f.intent, controller: {incarnation: 'controller', generation: 1},
      dependencies: [{resourceId: 'phone', authorityHostId: 'mini', capability: 'backend-connectivity'}]}), claims: [],
    fence: {hostId: 'mini', resourceId: 'phone', controller, resourceReservationVersion: 1, subjectGeneration: 3}})
  expect(f.row.resourceReservations).toEqual([unrelated]); expect(f.writes).toEqual([[unrelated]])
  expect(f.row.snapshot.lanes[0]!.resources[0]!.backendConnectivity).toBeUndefined()
  expect(f.row.snapshot.resourceLifecycle!.subjects[0]!.idle.outcome).toBe('not-checked')
})
test('same original reporter, owned phone and substituted current reporter cannot confirm no claim', async () => {
  const f = await claimFixture(); f.original = job()
  f.row.snapshot.resourceLifecycle!.subjects[0]!.owner = null
  expect((await f.service.observe({intent: f.intent, controller: f.intent.controller}, 'mini')).status).toBe('unknown')
  expect(f.writes).toHaveLength(0)
  const controller = releasedNoClaim(f)
  f.row.snapshot.resourceLifecycle!.subjects[0]!.owner = {id: 'unsettled-check', kind: 'boundary-cleanup', generation: 3, hostId: 'mini', laneId: 'android'}
  expect((await f.service.observe({intent: f.intent, controller}, 'mini')).status).toBe('unknown'); expect(f.writes).toHaveLength(0)
  await expect(f.service.observe({intent: f.intent, controller: {...controller, incarnation: 'substitute'}}, 'mini')).rejects.toThrow('current reporting controller')
  expect(f.writes).toHaveLength(0)
})
test('no-claim barrier invalidates delayed original writes and original acquire never renews on a new report', async () => {
  const f = await claimFixture(), controller = releasedNoClaim(f), delayedHost = structuredClone(f.row)
  const response = await f.service.observe({intent: f.intent, controller}, 'mini')
  expect(response.status).toBe('not-acquired')
  expect(await f.repository.replaceBackend!(delayedHost, [], f.intent, new Date(now))).toBe(false)
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('unknown')
  expect(f.writes).toHaveLength(1); expect(f.row.resourceReservations).toEqual([])
})
test('lost no-claim barrier reply stays uncertain until another current CAS confirms original absence', async () => {
  const f = await claimFixture({loseAnswer: true}), controller = releasedNoClaim(f)
  await expect(f.service.observe({intent: f.intent, controller}, 'mini')).rejects.toThrow('CAS answer lost')
  expect(f.row.resourceReservations).toEqual([]); expect(f.row.resourceReservationVersion).toBe(1)
  const recovered = await f.service.observe({intent: f.intent, controller}, 'mini')
  expect(recovered.status).toBe('not-acquired')
  if (recovered.status === 'not-acquired') expect(recovered.fence.resourceReservationVersion).toBe(2)
  expect(f.writes).toHaveLength(2)
})
test('post-barrier unrelated write or reporter replacement cannot produce a not-acquired answer', async () => {
  for (const replaceReporter of [false, true]) {
    const f = await claimFixture(), controller = releasedNoClaim(f), replace = f.repository.replace.bind(f.repository)
    f.repository.replace = async (previous, claims) => {
      const won = await replace(previous, claims)
      if (won) {if (replaceReporter) {f.row.incarnation = 'replacement'; f.row.incarnationGeneration++; f.row.snapshot.incarnation = f.row.incarnation;
        f.row.snapshot.incarnationGeneration = f.row.incarnationGeneration} else f.row.resourceReservationVersion!++}
      return won
    }
    expect((await f.service.observe({intent: f.intent, controller}, 'mini')).status).toBe('unknown')
    expect(f.row.resourceReservations).toEqual([])
  }
})
test('retained raw phone claim is recovered after release instead of confirming absence or mutating custody', async () => {
  const f = await claimFixture(), acquired = await f.service.acquire(f.intent, 'mini'), controller = releasedNoClaim(f)
  expect(acquired.status).toBe('reserved')
  const observed = await f.service.observe({intent: f.intent, controller}, 'mini')
  expect(observed.status).toBe('reserved'); expect(observed.claims).toEqual(acquired.claims)
  expect(f.writes).toHaveLength(1)
  const claims = f.row.resourceReservations as import('../types/resource-reservations.types').ExclusiveHostReservation[]
  claims[0]!.owner = {id: 'different-original', kind: 'boundary-cleanup'}
  expect((await f.service.observe({intent: f.intent, controller}, 'mini')).status).toBe('unknown')
  expect(f.writes).toHaveLength(1)
})
test('new controller can confirm settled absent original but stale controller and failed CAS cannot', async () => {
  const f = await claimFixture(), controller = releasedNoClaim(f)
  f.row.incarnation = 'new-controller'; f.row.incarnationGeneration = 2; f.row.snapshot.incarnation = f.row.incarnation;
  f.row.snapshot.incarnationGeneration = 2; f.row.sequence = 1; f.row.snapshot.sequence = 1
  await expect(f.service.observe({intent: f.intent, controller}, 'mini')).rejects.toThrow('current reporting controller')
  const current = {incarnation: 'new-controller', generation: 2, sequence: 1}
  const replace = f.repository.replace.bind(f.repository)
  f.repository.replace = async () => false
  expect((await f.service.observe({intent: f.intent, controller: current}, 'mini')).status).toBe('unknown'); expect(f.writes).toHaveLength(0)
  f.repository.replace = replace
  expect((await f.service.observe({intent: f.intent, controller: current}, 'mini')).status).toBe('not-acquired')
  expect(f.writes).toHaveLength(1)
})

test('only the exact selected preparing recorder claim may coexist with its phone reader', async () => {
  const f = await claimFixture(), own = structuredClone(f.original.fleetResourceReservation!)
  f.row.resourceReservations = [own]
  expect((await f.service.acquire(f.intent, 'mini')).status).toBe('reserved')
  expect(f.row.resourceReservations).toHaveLength(2)
  expect((f.row.resourceReservations as HostResourceReservation[])[0]).toEqual(own)
  for (const changed of ['bindingSha256','reservationSha256','dispatchIntentSha256'] as const) {
    const other = await claimFixture()
    const intent = structuredClone(other.intent); intent.prerequisite!.preparing![changed] = 'f'.repeat(64)
    expect(backendPrerequisiteRequestMatches(other.original, intent, now)).toBe(false)
    expect((await other.service.acquire(intent, 'mini')).status).toBe('unknown'); expect(other.writes).toEqual([])
  }
})

test('same-phone queued preparation progresses one original at a time even with ample recorder bytes', async () => {
  for (const offline of [false, true]) {
    const f = await portableFixture()
    try {
      const second = f.addRequest('second', offline)
      expect(await f.reserve()).not.toBeNull()
      const firstClaim = structuredClone(f.current.request.fleetResourceReservation!), before = [...f.events]
      expect(await f.reserve('mini', 'android', 'second')).toBeNull()
      expect(second.fleetResourceAdmission).toBeUndefined(); expect(second.fleetResourceReservation).toBeUndefined()
      expect(f.current.host.resourceReservations).toEqual([firstClaim]); expect(f.events).toEqual(before)
      const intent = routineDispatchIntentSchema.parse({...f.current.request.fleetSelection,
        routineSource: f.current.request.fleetPreparation!.routineSource, laneId: 'android'})
      expect(await routineJobRepository.bind('original', f.current.request.fleetInputSha256!,
        {jobId: 'original', requestId: 'original', hostId: 'mini', laneId: 'android',
          descriptorRevision: routineLaneDescriptorRevision(f.current.host.snapshot.lanes[0]!), actionsRunId: '1', actionsJobId: '2', boundAt: timestamp},
        intent, new Date(now))).not.toBeNull()
      expect(f.current.request.state).toBe('preparing')
      expect(await f.reserve('mini', 'android', 'second')).toBeNull()
      const service = new RoutineJobService({async get(id: string) {return structuredClone(f.requests.get(id) ?? null)},
        async *qualificationCandidates() {yield structuredClone(f.current.request)}} as unknown as RoutineJobRepository,
        undefined, undefined, undefined, {async get() {return {...structuredClone(f.current.host.snapshot), receivedAt: timestamp}}},
        undefined, undefined, () => now)
      const target = (await service.qualificationTargets('mini'))[0]!
      const subject = f.current.host.snapshot.resourceLifecycle!.subjects[0]!, operationId = `backend-prerequisite:${target.inputSha256}`,
        owner = {id: `resource-check:${requestInputDigest({operationId, resourceId: 'phone'})}`, kind: 'boundary-cleanup' as const}
      subject.status = 'checking'; subject.owner = {...owner, generation: 2, hostId: 'mini', laneId: 'android'}
      const check = new ResourceReservationsService(resourceReservationRepository, () => now,
        (hostId, owned) => service.qualificationTargets(hostId, owned))
      const acquired = await check.acquire({...f.intent, operationId, owner, inputSha256: target.inputSha256,
        prerequisite: {...f.intent.prerequisite!, binding:target.acceptedBinding, targetInputSha256: target.inputSha256, preparing: target.preparing!}}, 'mini')
      expect(acquired.status).toBe('reserved'); expect(acquired.claims).toHaveLength(1)
      expect(await f.reserve('mini', 'android', 'second')).toBeNull()
      const claim = acquired.claims[0]!
      subject.owner = null; subject.status = 'unknown'; subject.generation = 3
      f.current.host.sequence++; f.current.host.snapshot.sequence = f.current.host.sequence
      const proof: ExclusiveResourceReturn = {claimId: claim.id, authorityHostId: 'mini', resourceId: 'phone',
        intentSha256: claim.intentSha256, inputSha256: claim.inputSha256, originalOwner: claim.owner, laneId: 'android',
        controller: {incarnation: 'controller', generation: 1, sequence: f.current.host.sequence},
        release: {kind: 'resource-check', operationId, subjectGeneration: 3, releasedAt: timestamp, eventId: 'first-reader-return'}}
      const {controller: _, ...returned} = proof
      f.current.host.snapshot.resourceReservations = {claims: [], returns: [returned]}
      f.current.host.snapshot.resourceLifecycle!.history = [{id: 'first-reader-return', resourceId: 'phone', subjectGeneration: 3,
        at: timestamp, event: 'resource-check-released', checkOperationId: operationId}]
      expect((await check.giveBack(proof, 'mini')).status).toBe('returned')
      const health = qualified(); health.binding=f.current.host.snapshot.frameworkBinding!;health.releasedGeneration = 3; health.check.operationId = operationId
      health.qualification = {jobId: 'original', targetInputSha256: target.inputSha256,
        inputSha256: requestInputDigest(target.proposedInput), preparing: target.preparing!}
      f.current.host.snapshot.lanes[0]!.resources[0]!.backendConnectivity = health
      let adoptions = 0
      const prepared = new TestRequestService({async get() {return structuredClone(f.current.request) as unknown as StoredRequest},
        async completePreparation(_id: string, _host: string, _intent: string, input: unknown, digest: string) {adoptions++; f.current.request.state = 'queued';
          Object.assign(f.current.request, {input, inputSha256: digest}); return structuredClone(f.current.request) as unknown as StoredTestRequest}} as unknown as TestRequestRepository,
        undefined, null, null, () => now, {async get() {return {...structuredClone(f.current.host.snapshot),
          receivedAt: timestamp, authorityReservations: hostResourceReservationsSchema.parse(f.current.host.resourceReservations)}}})
      expect((await prepared.completePreparation('original', 'mini', f.current.request.dispatchIntentSha256!, target.proposedInput!)).state).toBe('queued')
      expect(adoptions).toBe(1); expect(await f.reserve('mini', 'android', 'second')).toBeNull()
      // Only the original normal completion plus a current empty recorder offer
      // removes its retained byte claim; elapsed time/health alone never does.
      f.current.request.dispatchCompletion = {completedAt: timestamp} as StoredRoutineJob['dispatchCompletion']
      if(!offline)await f.prepareCandidate('second')
      expect(await f.reserve('mini', 'android', 'second')).not.toBeNull()
      expect(second.fleetResourceReservation?.requestId).toBe('second')
      expect((f.current.host.resourceReservations as RecorderHostReservation[]).map(value => value.requestId)).toEqual(['second'])
      expect(adoptions).toBe(1)
    } finally {f.restore()}
  }
})
test('concurrent same-phone provisional claims choose one host-CAS winner before either request stage', async () => {
  const f = await portableFixture()
  try {
    f.addRequest('second'); const paused = f.pause('run'), original = f.reserve(); await paused.entered
    await f.prepareCandidate('second');expect(await f.reserve('mini', 'android', 'second')).not.toBeNull(); paused.resume()
    expect(await original).toBeNull()
    expect(f.current.request.fleetResourceAdmission).toBeUndefined()
    expect((f.current.host.resourceReservations as RecorderHostReservation[]).map(value => value.requestId)).toEqual(['second'])
    expect(f.events).toEqual(['host-claim', 'request-stage', 'request-receipt'])
  } finally {f.restore()}
})

test('serialized phone preparation retains other-lane capacity and refuses unknown same-lane custody', async () => {
  const f = await portableFixture()
  try {
    f.addRequest('second'); expect(await f.reserve()).not.toBeNull()
    const first = structuredClone(f.current.request.fleetResourceReservation!)
    const otherLane = structuredClone(f.current.host.snapshot.lanes[0]!)
    otherLane.id = 'other-android'; otherLane.resources = otherLane.resources.map(({backendConnectivity: _, ...resource}) => ({...resource, id: `other-${resource.id}`}))
    f.current.host.snapshot.lanes.push(otherLane)
    f.current.host.snapshot.resourceLifecycle!.subjects.push({...structuredClone(f.current.host.snapshot.resourceLifecycle!.subjects[0]!),subject:{kind:'resource',id:'other-phone',authorityHostId:'mini'}})
    await f.prepareCandidate('second','other-android')
    expect(await f.reserve('mini', 'other-android', 'second')).not.toBeNull()
    expect((f.current.host.resourceReservations as RecorderHostReservation[]).map(value => value.requestId)).toEqual(['original', 'second'])
    f.addRequest('third'); f.requests.delete('original')
    expect(await f.reserve('mini', 'android', 'third')).toBeNull()
    expect((f.current.host.resourceReservations as RecorderHostReservation[])[0]).toEqual(first)
    expect(f.requests.get('third')!.fleetResourceAdmission).toBeUndefined()
  } finally {f.restore()}
})


test('same-controller report advance before CAS revalidates the original check and writes one unchanged intent', async () => {
  for (const at of ['lookup', 'cas']) {
    const f = await claimFixture(), before = structuredClone(f.original), source = structuredClone(f.intent),
      coherent = (await f.targets('mini', f.owned()))[0]!
    let advance = true, attempts = 0
    const advanceReport = () => {advance = false; f.row.sequence++; f.row.snapshot.sequence = f.row.sequence; f.observed.sequence = f.row.sequence}
    const replace = f.repository.replaceBackend!.bind(f.repository)
    f.repository.replaceBackend = async (host, claims, intent, now) => {
      attempts++; if (advance && at === 'cas') advanceReport()
      return replace(host, claims, intent, now)
    }
    const service = new ResourceReservationsService(f.repository, () => now, async (hostId, owned) => {
      const exact = await f.targets(hostId, owned)
      if (advance && at === 'lookup') advanceReport()
      return exact
    })
    const acquired = await service.acquire(f.intent, 'mini')
    expect(acquired.status).toBe('reserved'); expect(acquired.claims).toHaveLength(1)
    expect(f.writes).toHaveLength(1); expect(f.row.resourceReservations).toEqual(acquired.claims)
    expect(f.row.sequence).toBe(2); expect(acquired.claims[0]!.borrowerSequence).toBe(source.controller.sequence)
    expect(attempts).toBe(at === 'cas' ? 2 : 1)
    expect(f.original).toEqual(before); expect(f.intent).toEqual(source)
    expect((await f.targets('mini', f.owned()))[0]).toEqual(coherent)
    expect((await service.acquire(f.intent, 'mini')).claims).toEqual(acquired.claims)
    expect(f.writes).toHaveLength(1)
  }
})

test('newer reports cannot substitute check generation, source, owner, lane, target or cancellation before the CAS', async () => {
  const changes = [
    (f: Awaited<ReturnType<typeof claimFixture>>) => {f.row.snapshot.resourceLifecycle!.subjects[0]!.generation++},
    (f: Awaited<ReturnType<typeof claimFixture>>) => {f.row.snapshot.resourceLifecycle!.subjects[0]!.owner!.generation!++},
    (f: Awaited<ReturnType<typeof claimFixture>>) => {f.row.snapshot.resourceLifecycle!.subjects[0]!.owner!.id = 'different-check'},
    (f: Awaited<ReturnType<typeof claimFixture>>) => {f.row.snapshot.frameworkBinding!.revision = 'c'.repeat(40)},
    (f: Awaited<ReturnType<typeof claimFixture>>) => {f.row.snapshot.lanes[0]!.state = 'reserved'},
    (f: Awaited<ReturnType<typeof claimFixture>>) => {f.original.fleetCancellation = {requestedAt: timestamp, reason: 'Cancelled during read'}},
    (f: Awaited<ReturnType<typeof claimFixture>>) => {f.original.fleetDeadline = new Date(now)},
    (f: Awaited<ReturnType<typeof claimFixture>>) => {f.row.incarnation = 'replacement'; f.row.incarnationGeneration++},
    (f: Awaited<ReturnType<typeof claimFixture>>) => {f.original.fleetBinding!.descriptorRevision = 'c'.repeat(64)},
  ]
  for (const change of changes) {
    const f = await claimFixture(); let first = true
    const service = new ResourceReservationsService(f.repository, () => now, async (hostId, owned) => {
      const target = await f.targets(hostId, owned)
      if (first) {first = false; change(f); f.row.sequence++; f.row.snapshot.sequence = f.row.sequence; f.observed.sequence = f.row.sequence}
      return target
    })
    expect((await service.acquire(f.intent, 'mini')).status).toBe('unknown')
    expect(f.writes).toEqual([]); expect(f.row.resourceReservations).toEqual([])
  }
})

test('continuously advancing reports exhaust only the existing bounded acquisition attempt and never create a claim', async () => {
  const f = await claimFixture(); let reads = 0
  const service = new ResourceReservationsService(f.repository, () => now, async (hostId, owned) => {
    reads++; const targets = await f.targets(hostId, owned)
    f.row.sequence++; f.row.snapshot.sequence = f.row.sequence; f.observed.sequence = f.row.sequence
    return targets
  })
  expect((await service.acquire(f.intent, 'mini')).status).toBe('unknown'); expect(reads).toBe(3)
  expect(f.writes).toEqual([]); expect(f.row.resourceReservations).toEqual([])
})

test('post-CAS report advance recovers only the same committed claim through observe without a new write', async () => {
  const f = await claimFixture(), source = structuredClone(f.intent)
  let targets = 0
  const service = new ResourceReservationsService(f.repository, () => now, async (hostId, owned) => {
    const exact = await f.targets(hostId, owned)
    if (++targets === 2) {f.row.sequence++; f.row.snapshot.sequence = f.row.sequence; f.observed.sequence = f.row.sequence}
    return exact
  })
  expect((await service.acquire(f.intent, 'mini')).status).toBe('unknown')
  expect(f.writes).toHaveLength(1); expect(f.row.resourceReservations).toHaveLength(1)
  const controller = {incarnation: 'controller', generation: 1, sequence: f.row.sequence},
    recovered = await service.observe({intent: f.intent, controller}, 'mini')
  expect(recovered.status).toBe('reserved'); expect(recovered.claims).toEqual(hostResourceReservationsSchema.parse(f.row.resourceReservations).filter(value => 'kind' in value))
  expect(f.intent).toEqual(source); expect(f.writes).toHaveLength(1)
  f.original.fleetCancellation = {requestedAt: timestamp, reason: 'Original cancelled after response loss'}
  expect(await f.targets('mini', f.owned())).toEqual([])
  expect((await service.observe({intent: f.intent, controller}, 'mini')).status).toBe('reserved')
  expect((await service.acquire(f.intent, 'mini')).status).toBe('unknown'); expect(f.writes).toHaveLength(1)
})

test('same-intent observe completes a never-committed report race under current CAS without replaying acquisition',async()=>{
 const f=await claimFixture(),source=structuredClone(f.intent);let churn=true,calls=0
 const service=new ResourceReservationsService(f.repository,()=>now,async(hostId,owned)=>{
  calls++;const target=await f.targets(hostId,owned)
  if(churn){f.row.sequence++;f.row.snapshot.sequence=f.row.sequence;f.observed.sequence=f.row.sequence}
  return target
 })
 expect((await service.acquire(f.intent,'mini')).status).toBe('unknown');expect(f.writes).toEqual([]);expect(calls).toBe(3)
 churn=false
 const controller={incarnation:'controller',generation:1,sequence:f.row.sequence},recovered=await service.observe({intent:f.intent,controller},'mini')
 expect(recovered.status).toBe('reserved');expect(recovered.claims).toHaveLength(1);expect(f.writes).toHaveLength(1)
 expect(recovered.claims[0]!.borrowerSequence).toBe(source.controller.sequence);expect(f.intent).toEqual(source)
 expect((await service.observe({intent:f.intent,controller},'mini')).claims).toEqual(recovered.claims)
 expect(f.writes).toHaveLength(1)
})
test('delayed original acquire and no-claim observation compete in one host CAS and recover one claim',async()=>{
 const f=await claimFixture(),entered=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>(),replace=f.repository.replaceBackend!.bind(f.repository)
 let first=true
 f.repository.replaceBackend=async(host,claims,intent,at)=>{if(first){first=false;entered.resolve();await resume.promise}return replace(host,claims,intent,at)}
 const acquiring=f.service.acquire(f.intent,'mini');await entered.promise
 f.row.sequence++;f.row.snapshot.sequence=f.row.sequence;f.observed.sequence=f.row.sequence
 const controller={incarnation:'controller',generation:1,sequence:f.row.sequence},observed=await f.service.observe({intent:f.intent,controller},'mini')
 expect(observed.status).toBe('reserved');expect(f.writes).toHaveLength(1)
 resume.resolve();expect((await acquiring).claims).toEqual(observed.claims)
 expect(f.writes).toHaveLength(1);expect(f.row.resourceReservations).toEqual(observed.claims)
})
test('no-claim observe cannot revive released original checks or cancelled, expired and replaced authority',async()=>{
 for(const reason of ['released','cancelled','expired','replaced','different-check'] as const){
  const f=await claimFixture();f.row.sequence++;f.row.snapshot.sequence=f.row.sequence;f.observed.sequence=f.row.sequence
  if(reason==='released')f.row.snapshot.resourceLifecycle!.history.push({id:'release',resourceId:'phone',subjectGeneration:2,at:timestamp,event:'resource-check-released',checkOperationId:f.intent.operationId})
  if(reason==='cancelled')f.original.fleetCancellation={requestedAt:timestamp,reason:'Cancelled before observation'}
  if(reason==='expired')f.original.fleetDeadline=new Date(now)
  if(reason==='replaced'){f.row.incarnation='new';f.row.incarnationGeneration++;f.row.snapshot.incarnation='new';f.row.snapshot.incarnationGeneration++}
  if(reason==='different-check')f.row.snapshot.resourceLifecycle!.subjects[0]!.owner!.id='different-check'
  const controller={incarnation:f.row.incarnation,generation:f.row.incarnationGeneration,sequence:f.row.sequence}
  expect((await f.service.observe({intent:f.intent,controller},'mini')).status).toBe('unknown')
  expect(f.writes).toEqual([]);expect(f.row.resourceReservations).toEqual([])
 }
})

/** The new precheck uses the real unowned target before local generation admission. */
async function precheckBackendFixture() {
  const f = await claimFixture(), subject=f.row.snapshot.resourceLifecycle!.subjects[0]!
  f.row.snapshot.frameworkBinding={...f.row.snapshot.frameworkBinding!,routineApiVersion:70}
  f.observed.frameworkBinding=f.row.snapshot.frameworkBinding
  subject.owner=null;subject.status='unknown'
  f.observed.resourceLifecycle=f.row.snapshot.resourceLifecycle
  f.original.fleetDeadline=new Date(now+300000);f.original.fleetInputSha256=routineJobInputDigest(f.original);selectPreparing(f.original,f.observed)
  const target=(await f.targets('mini'))[0]!, intent:ExclusiveResourceIntent={...f.intent,inputSha256:target.inputSha256,
    prerequisite:{...f.intent.prerequisite!,targetInputSha256:target.inputSha256,binding:target.acceptedBinding!,preparing:target.preparing!},
    resourceCheck:{resourceId:'phone',subjectGeneration:subject.generation,contractVersion:subject.idle.contractVersion,
      deadlineAt:now+60000,binding:target.acceptedBinding!,controller:{incarnation:'controller',generation:1}}}
  const digest=requestInputDigest({...intent,controller:{incarnation:'controller',generation:1},
    dependencies:[{resourceId:'phone',authorityHostId:'mini',capability:'backend-connectivity'}]})
  f.row.snapshot.resourceReservations={claims:[],returns:[],resourceChecks:[{intentSha256:digest,operationId:intent.operationId,
    resourceId:'phone',intent:structuredClone(intent),resourceCheck:intent.resourceCheck!,state:'prepared',observedAt:timestamp}]}
  return {...f,intent,target,digest}
}
test('backend precheck claims before a local check exists using exact actual preparation target and source',async()=>{
  const f=await precheckBackendFixture(),before=structuredClone(f.original),result=await f.service.acquire(f.intent,'mini')
  expect(result.status).toBe('reserved');expect(result.claims).toHaveLength(1);expect(f.writes).toHaveLength(1)
  expect(f.row.snapshot.resourceLifecycle!.subjects[0]!.owner).toBeNull();expect(result.claims[0]!.resourceCheck).toEqual(f.intent.resourceCheck)
  expect(f.original).toEqual(before)
  const owner=f.row.snapshot.resourceLifecycle!.subjects[0]!,claim=result.claims[0]!
  owner.owner={...claim.owner,generation:3,hostId:'mini',laneId:'android'};owner.status='checking';owner.generation=4
  const command={operationId:'3a66d3c2-f408-4dbe-8756-ec2937d9f250',hostId:'mini',subject:{resourceId:'phone',subjectGeneration:4},
    expiresAt:now+120000,operatorId:hash,action:'reserve',purpose:'Later exact owned check reservation'}
  f.row.laneControls=[{command}];f.row.laneControlVersion=1
  expect(await f.service.acquire(f.intent,'mini')).toEqual(result);expect(f.writes).toHaveLength(1)
})
test('unowned backend precheck never admits a cancelled original or mismatched declared target',async()=>{
  for(const mutate of [
    (f:Awaited<ReturnType<typeof precheckBackendFixture>>)=>{f.original.fleetCancellation={requestedAt:timestamp,reason:'Cancelled before preclaim'}},
    (f:Awaited<ReturnType<typeof precheckBackendFixture>>)=>{f.intent.prerequisite!.targetInputSha256='e'.repeat(64);f.intent.inputSha256='e'.repeat(64)},
    (f:Awaited<ReturnType<typeof precheckBackendFixture>>)=>{f.row.snapshot.resourceLifecycle!.subjects[0]!.generation++},
  ]){const f=await precheckBackendFixture();mutate(f);expect((await f.service.acquire(f.intent,'mini')).status).toBe('unknown');expect(f.writes).toEqual([])}
})

async function candidatePrecheckFixture() {
  let time=now
  const observed=host(), original=job();original.fleetDeadline=new Date(now+300000);original.fleetInputSha256=routineJobInputDigest(original)
  observed.frameworkBinding={...observed.frameworkBinding!,routineApiVersion:70};observed.resourceReservations={claims:[],returns:[],candidatePrerequisites:[],resourceChecks:[]};observed.authorityReservations=[]
  const jobs:RoutineJobRepository={async get(){return structuredClone(original)},async *qualificationCandidates(){yield structuredClone(original)},async recorderClaims(){return []},async selectedLanes(){return []},
    async candidatePreparation(_row:StoredRoutineJob,pending:FleetCandidatePreparation){original.fleetCandidatePreparation=structuredClone(pending);return structuredClone(original)},
    async settleCandidatePreparation(_row:StoredRoutineJob,value:FleetCandidatePreparation){original.fleetCandidatePreparations=[...(original.fleetCandidatePreparations??[]),structuredClone(value)];delete original.fleetCandidatePreparation;return structuredClone(original)},
    async reserveResources(){throw Error('No candidate execution allocation')}} as unknown as RoutineJobRepository
  const jobsService=new RoutineJobService(jobs,undefined,undefined,undefined,{async get(){return structuredClone(observed)},async list(){return [structuredClone(observed)]}},undefined,undefined,()=>time)
  await jobsService.preparation(original.requestId);const pending=original.fleetCandidatePreparation!
  if(!pending)throw Error('Real service must construct original unbound candidate')
  const operationId=`backend-prerequisite:${pending.targetInputSha256}`,owner={id:`resource-check:${requestInputDigest({operationId,resourceId:'phone'})}`,kind:'boundary-cleanup' as const}
  const intent:ExclusiveResourceIntent={operationId,hostId:'mini',laneId:'android',controller:{incarnation:'controller',generation:1,sequence:0},owner,
    inputSha256:pending.targetInputSha256,resources:[{id:'phone',capabilities:['backend-connectivity']}],
    prerequisite:{kind:'backend-connectivity',jobId:original.requestId,targetInputSha256:pending.targetInputSha256,resourceId:'phone',binding:observed.frameworkBinding!,candidate:pending.candidate,target:qualified().target},
    resourceCheck:{resourceId:'phone',subjectGeneration:observed.resourceLifecycle!.subjects[0]!.generation,contractVersion:'not-commissioned',deadlineAt:now+60000,binding:observed.frameworkBinding!,controller:{incarnation:'controller',generation:1}}}
  const digest=requestInputDigest({...intent,controller:{incarnation:'controller',generation:1},dependencies:[{resourceId:'phone',authorityHostId:'mini',capability:'backend-connectivity'}]})
  observed.resourceReservations!.resourceChecks=[{intent:structuredClone(intent),intentSha256:digest,operationId,resourceId:'phone',resourceCheck:intent.resourceCheck!,state:'prepared',observedAt:timestamp}]
  const {receivedAt:_,authorityReservations:_claims,...snapshot}=observed,row:ResourceReservationHost={hostId:'mini',incarnation:'controller',incarnationGeneration:1,sequence:1,receivedAt:new Date(now),snapshot,resourceReservationVersion:0,resourceReservations:[],laneControlVersion:0,laneControls:[]},writes:HostResourceReservation[][]=[]
  const repo:ResourceReservationRepository={async get(){return structuredClone(row)},async request(){return structuredClone(original)},
    async candidateRequest(){return structuredClone(original)},async replace(previous,claims){if(previous.sequence!==row.sequence||previous.laneControlVersion!==row.laneControlVersion||previous.resourceReservationVersion!==row.resourceReservationVersion)return false;row.resourceReservations=structuredClone(claims);row.resourceReservationVersion!++;writes.push(structuredClone(claims));return true},
    async replaceBackend(previous,claims,input){if(!candidatePrerequisiteRequestMatches(original,input,time))return false;original.fleetCandidatePreparation!.backendTarget=input.prerequisite!.target;return this.replace(previous,claims)},
    async recordCandidateClaim(_id,p,c){if(p.claimReceipt)return isDeepStrictEqual(p.claimReceipt,c);original.fleetCandidatePreparation!.claimReceipt=structuredClone(c);return true},
    async recordCandidateReturn(_id,p,r){original.fleetCandidatePreparation!.returnReceipt=structuredClone(r);return true},
    async recordCandidateNoAcquisition(_id,p,r){original.fleetCandidatePreparation!.noAcquisitionReceipt=structuredClone(r);return true}}
  const service=new ResourceReservationsService(repo,()=>time,(id,owned)=>jobsService.qualificationTargets(id,owned))
  return {observed,original,row,intent,digest,writes,service,jobsService,
    ended(){time+=1;row.sequence++;row.snapshot.sequence=row.sequence;row.snapshot.observedAt=new Date(time).toISOString();row.receivedAt=new Date(time)
      const j=row.snapshot.resourceReservations!.resourceChecks![0]!;j.state='never-began';j.eventId='actual-never-began';j.observedAt=row.snapshot.observedAt;return j},
    publish(){Object.assign(observed,structuredClone(row.snapshot),{receivedAt:row.receivedAt.toISOString(),authorityReservations:structuredClone(row.resourceReservations)})},
    unknownReceipt(){return {targetInputSha256:intent.inputSha256,candidate:original.fleetCandidatePreparation!.candidate,outcome:'unknown' as const,hostWorkSettled:true as const,checkOperationId:operationId}}}
}
test('no-reader candidate uses the same original CAS no-acquisition ACK as historical settlement, without granting readiness',async()=>{
  const f=await candidatePrecheckFixture(),identity={job:f.original.requestId,input:f.original.fleetInputSha256,selection:structuredClone(f.original.fleetSelection),deadline:f.original.fleetDeadline.toISOString()}
  f.row.laneControls=[{command:{operationId:'cd5757fb-f3d5-44ec-87dc-887008043ed0',hostId:'mini',subject:{resourceId:'phone',subjectGeneration:2},operatorId:hash,expiresAt:now+120000,action:'mark-out-of-service',reason:'Human withdrawal'}}];f.row.laneControlVersion=1
  expect((await f.service.acquire(f.intent,'mini')).status).toBe('unknown');expect(f.writes).toEqual([])
  const j=f.ended();f.publish();f.observed.resourceReservations!.candidatePrerequisites=[f.unknownReceipt()]
  expect(candidateSettlement(f.original.fleetCandidatePreparation!,f.observed,[],now+1)).toBeUndefined()
  const response=await f.service.observe({intent:f.intent,controller:{incarnation:'controller',generation:1,sequence:f.row.sequence}},'mini')
  expect(response.status).toBe('not-acquired');f.publish();f.observed.resourceReservations!.candidatePrerequisites=[f.unknownReceipt()]
  const pending=f.original.fleetCandidatePreparation!,settlement=candidateSettlement(pending,f.observed,[],now+1)
  expect(settlement?.outcome).toBe('unknown');expect(f.original.fleetCandidatePreparation!.noAcquisitionReceipt).toBeDefined();expect(f.writes).toEqual([[]])
  f.original.fleetCandidatePreparations=[{...structuredClone(pending),settlement}];delete f.original.fleetCandidatePreparation
  expect(completedCandidatePreparationForHost(f.original,'mini')).toBe(true);expect(completedCandidatePreparationForHost(f.original,'foreign')).toBe(false)
  expect({job:f.original.requestId,input:f.original.fleetInputSha256,selection:f.original.fleetSelection,deadline:f.original.fleetDeadline.toISOString()}).toEqual(identity)
  expect(f.original.fleetBinding).toBeUndefined();expect(f.original.fleetResourceAdmission).toBeUndefined()
})
test('committed never-began candidate settles only after original claim return ACK and immutable host closure account',async()=>{
  const f=await candidatePrecheckFixture(),answer=await f.service.acquire(f.intent,'mini');expect(answer.status).toBe('reserved');const claim=answer.claims[0]!,j=f.ended()
  const proof:ExclusiveResourceReturn={claimId:claim.id,authorityHostId:'mini',resourceId:'phone',intentSha256:f.digest,inputSha256:f.intent.inputSha256,originalOwner:claim.owner,laneId:'android',
    controller:{incarnation:'controller',generation:1,sequence:f.row.sequence},release:{kind:'resource-check-not-started',operationId:f.intent.operationId,resourceCheck:f.intent.resourceCheck!,subjectGeneration:2,releasedAt:j.observedAt,eventId:j.eventId!}}
  const {controller:_,...published}=proof;f.row.snapshot.resourceReservations!.returns=[published];f.publish();f.observed.resourceReservations!.candidatePrerequisites=[f.unknownReceipt()]
  expect(candidateSettlement(f.original.fleetCandidatePreparation!,f.observed,answer.claims,now+1)).toBeUndefined()
  expect(await f.service.giveBack(proof,'mini')).toMatchObject({status:'returned'});f.publish();f.observed.resourceReservations!.candidatePrerequisites=[f.unknownReceipt()]
  const saved=structuredClone(f.original.fleetCandidatePreparation!),settled=candidateSettlement(saved,f.observed,[],now+1)
  expect(settled?.outcome).toBe('unknown');expect(f.row.resourceReservations).toEqual([])
  for(const mutate of [
    (p:FleetCandidatePreparation)=>{delete p.returnReceipt},(p:FleetCandidatePreparation)=>{delete p.claimReceipt},
    (p:FleetCandidatePreparation)=>{p.targetInputSha256='f'.repeat(64)},
  ]){const p=structuredClone(saved);mutate(p);expect(candidateSettlement(p,f.observed,[],now+1)).toBeUndefined()}
  const originalJournal=f.observed.resourceReservations!.resourceChecks![0]!
  f.observed.resourceReservations!.resourceChecks![0]={...originalJournal,state:'began'};expect(candidateSettlement(saved,f.observed,[],now+1)).toBeUndefined()
})
