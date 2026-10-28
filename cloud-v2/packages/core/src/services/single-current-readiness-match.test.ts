import {expect, mock, spyOn, test} from 'bun:test'
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures'
import type {StoredRoutineJob} from '../types/routine-job.types'
import type {RoutingTestHostState, ReceivedTestHostState} from './test-host-state.service'
import {requestInputDigest} from './test-request.service'
import {RoutineJobService, routineJobInputDigest, routinePortableRequirements, routineLaneDescriptorRevision, type RoutineJobRepository} from './routine-job.service'
import {routineResourcesAvailable} from './resource-reservations.service'
import {testRequestMatchReport} from './test-request-match.service'

type TestHost = ReceivedTestHostState & Pick<RoutingTestHostState, 'authorityReservations' | 'resourceControlRecords' | 'resourceLifecycleCursor'>
const now = Date.parse('2026-10-27T16:25:57Z')
function fixture() {
  const definition = {id: 'account-email', minimumRoutineApiVersion: 15, title: 'Account', purpose: 'Sign in', platforms: ['android'], entry: 'sign-in', account: 'lane',
    requirements: ['The Mentra App displays English.', 'The provisioned account supports email/password sign-in.', 'Owned app relaunch and private credential recording intervals.'],
    fixtures: [], steps: [{id: 'sign-in', instruction: 'Sign in', expected: 'Account visible'}],
    execution: {resourceKinds: ['phone', 'app', 'recorder'], policy: {estimatedOutputBytes: 1_107_296_256}},
    resourceRequirements: [{kind: 'phone', capabilities: ['backend-connectivity']}, {kind: 'app', capabilities: ['relaunch']},
      {kind: 'recorder', capabilities: [], storage: {minimumAvailableBytes: 100}}],
    source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: 'a'.repeat(40), path: 'routines/account-email/routine.ts'}}
  const source = {channel: 'dev' as const, buildRunId: 1150, publicationAttempt: 1}
  const selection = {requestId: 'original-request', routineId: definition.id, platform: 'android' as const, routineRevision: 'a'.repeat(40), source,
    build: {repository: 'Mentra-Community/MentraOS', kind: 'android-apk', headSha: 'b'.repeat(40), channel: 'dev', source,
      archive: {url: 'https://artifactscdn.mentraglass.com/app.apk', name: 'app.apk', sha256: 'c'.repeat(64), size: 100},
      receipt: {url: 'https://artifactscdn.mentraglass.com/receipt.json', sha256: 'd'.repeat(64), size: 100}}}
  const row = {requestId: selection.requestId, state: 'awaiting-runner', fleetSelection: selection, fleetSelectionSha256: requestInputDigest(selection),
    fleetDeadline: new Date(now + 3600_000), createdAt: new Date(now - 1000), fleetPreparation: {
      routineSource: {...testRoutineSource('a'.repeat(40)), minimumRoutineApiVersion: 15}, definition, definitionSha256: requestInputDigest(definition),
      requirements: routinePortableRequirements({platform: 'android', definition} as never)}} as StoredRoutineJob
  row.fleetInputSha256 = routineJobInputDigest(row)
  const host = {hostId: 'mini', receivedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), frameworkBinding: testFrameworkBinding(),
    lanes: [{id: 'mini-android', platform: 'android', state: 'idle', dispatchMode: 'automatic', resources: [
      {id: 'phone', kind: 'phone', capabilities: ['backend-connectivity']}, {id: 'app', kind: 'app', capabilities: ['relaunch']},
      {id: 'recorder', kind: 'recorder', capabilities: [], storage: {poolId: 'disk', observedAt: new Date(now).toISOString(),
        availableBytes: 10_000_000_000, stagingBudgetBytes: 10_000_000_000, pendingEvidenceBytes: 100, reservations: []}}]}]} as TestHost
  host.incarnation = '4ddc2b57-c6e8-4fb5-9fc7-954b8c012ef1'; host.incarnationGeneration = 7; host.sequence = 9
  host.resourceReservations = {schemaVersion: 1, resourceReadiness: true} as never
  host.laneControls = {resourceControls: true} as never
  host.frameworkBinding!.routineApiVersion = 111
  for (const lane of host.lanes) for (const resource of lane.resources) resource.idleContract = {version: 'baseline', maximumAgeMs: 120000,
    qualifiedScope: {kind: 'same-controller', controllerId: host.hostId}, conditions: ['writers-absent'], repairConfigured: true}
  host.resourceLifecycle = {schemaVersion: 1, subjects: host.lanes.flatMap(lane => lane.resources.map(resource => ({
    subject: {kind: 'resource', id: resource.id, authorityHostId: host.hostId}, generation: 7, status: 'idle', observedAt: new Date(now).toISOString(), receivedAt: null, current: true, reason: null, owner: null,
    idle: {contractVersion: 'baseline', outcome: 'passed', checkedAt: new Date(now).toISOString(), acceptedCheck: {operationId: `check:${resource.id}`, subjectGeneration: 7, resultSha256: 'a'.repeat(64), acceptedAt: new Date(now).toISOString()}, qualifiedScope: resource.idleContract!.qualifiedScope, evidenceRefs: []},
    repair: {configured: true, state: 'none'}, supportedActions: ['reserve', 'check', 'mark-out-of-service'],
    resource: {kind: resource.kind, capabilities: resource.capabilities ?? [], memberships: [{hostId: host.hostId, laneId: lane.id}], dependencies: [], placement: 'installed'},
  })))} as never
  for (const lane of host.lanes) lane.descriptorRevision = routineLaneDescriptorRevision(lane)
  return {row, host}
}

function authority(host: TestHost) {
  return {hostId: host.hostId, incarnation: host.incarnation!, incarnationGeneration: host.incarnationGeneration!, sequence: host.sequence!,
    receivedAt: new Date(host.receivedAt), snapshot: host, laneControls: host.resourceControlRecords,
    resourceReservations: host.authorityReservations, resourceLifecycleCursor: host.resourceLifecycleCursor}
}
function serviceFixture() {
  const f = fixture(); let row = f.row, reservations = 0, bindings = 0
  const probes = mock(async () => {throw new Error('Per-request qualification probe was called')})
  const rows = {candidatePreparation: probes, get: async () => structuredClone(row), cancel: async (_id: string, _digest: string, value: NonNullable<StoredRoutineJob['fleetCancellation']>) => {row = {...row, fleetCancellation: value, state: 'terminal', terminalStatus: 'not-run'}; return structuredClone(row)}, recorderClaims: async () => [], selectedLanes: async () => [],
    reserveResources: async (id: string, digest: string, hostId: string, laneId: string, at: Date) => {
      const host = hosts.find(value => value.hostId === hostId)!
      if (row.fleetCancellation || row.fleetDeadline <= at || !routineResourcesAvailable(authority(host), row, laneId, at.getTime())) return null
      reservations++
      row = {...row, fleetResourceReservation: {id: '591e0c34-ee97-41df-a0ec-5e2d0c7503ee', requestId: id, fleetInputSha256: digest,
        hostId, laneId, poolId: 'disk', minimumAvailableBytes: 3_254_779_904, reservedAt: at.toISOString()}}
      return structuredClone(row)
    }, bind: async (_id: string, _digest: string, binding: StoredRoutineJob['fleetBinding'], intent: unknown, at: Date) => {
      if (row.fleetBinding || row.fleetCancellation || row.fleetDeadline <= at) return null
      bindings++; row = {...row, hostId: binding!.hostId, fleetBinding: binding, state: 'preparing', dispatchIntent: intent} as StoredRoutineJob
      return structuredClone(row)
    }} as unknown as RoutineJobRepository
  const hosts = [f.host]
  const service = new RoutineJobService(rows, undefined, undefined, undefined,
    {list: async () => hosts, get: async id => hosts.find(value => value.hostId === id)!}, undefined, undefined, () => now)
  const observation = spyOn(service, 'observation').mockImplementation(async () => ({state: row.state} as never))
  return {...f, service, hosts, probes, get row() {return row}, get reservations() {return reservations}, get bindings() {return bindings},
    restore(value: StoredRoutineJob) {row = value}, close() {observation.mockRestore()}}
}

test('one current green checklist reserves and binds without a per-request qualification probe', async () => {
  const f = serviceFixture()
  try {
    expect(routineResourcesAvailable(authority(f.host), f.row, f.host.lanes[0]!.id, now)).toBe(true)
    const report = testRequestMatchReport(f.row, f.hosts, now)
    expect(report.lanes[0]!.candidateMatch).toBe('match')
    expect(report.lanes[0]!.executionCompatibility).toBe('match')
    const prepared = await f.service.preparation(f.row.requestId)
    expect(prepared.waitingReason).toBeUndefined(); expect(('resourceTarget' in prepared ? prepared.resourceTarget : undefined)).toEqual({hostId: f.host.hostId, laneId: f.host.lanes[0]!.id})
    expect(f.reservations).toBe(1); expect(f.probes).not.toHaveBeenCalled()
    const bound = await f.service.bind(f.row.requestId, f.host.hostId, {inputSha256: f.row.fleetInputSha256,
      laneId: f.host.lanes[0]!.id, descriptorRevision: f.host.lanes[0]!.descriptorRevision, actionsRunId: '11', actionsJobId: '22'})
    expect(bound.execute).toBe(true); expect(f.bindings).toBe(1); expect(f.row.fleetCandidatePreparation).toBeUndefined()
  } finally {f.close()}
})

function secondHost(first: TestHost) {
  const host = structuredClone(first); host.hostId = 'alternative'; host.incarnation = '18d7efec-60be-447a-bae5-dcc5a57a1932'
  for (const lane of host.lanes) for (const resource of lane.resources) resource.idleContract!.qualifiedScope = {kind: 'same-controller', controllerId: host.hostId}
  for (const subject of host.resourceLifecycle!.subjects) {
    subject.subject.authorityHostId = host.hostId; subject.idle.qualifiedScope = {kind: 'same-controller', controllerId: host.hostId}
    subject.resource!.memberships = [{hostId: host.hostId, laneId: host.lanes[0]!.id}]
  }
  for (const lane of host.lanes) lane.descriptorRevision = routineLaneDescriptorRevision(lane)
  return host
}
test('mixed current API110 and API111 lanes distinguish source upgrade from passed physical readiness', async () => {
  const f = serviceFixture(), compatible = secondHost(f.host), original = structuredClone(f.row)
  f.host.frameworkBinding!.routineApiVersion = 110
  f.hosts.push(compatible)
  try {
    const report = testRequestMatchReport(f.row, f.hosts, now), old = report.lanes[0]!, current = report.lanes[1]!
    expect(old.resources.every(resource => resource.conditions.find(condition => condition.id === 'current-baseline')?.status === 'match')).toBe(true)
    const source = old.conditions.find(condition => condition.id === 'current-readiness-dispatch')
    expect(source?.category).toBe('source'); expect(source?.status).toBe('blocked')
    expect(source).toBeDefined(); expect(source!.expected).toContain('111'); expect(source!.observed).toContain('110')
    expect(source!.nextAction).toMatch(/update|upgrade|adopt/i)
    expect(old.candidateMatch).toBe('blocked'); expect(old.executionCompatibility).toBe('blocked')
    expect(current.candidateMatch).toBe('match'); expect(current.executionCompatibility).toBe('match')
    expect(routineResourcesAvailable(authority(f.host), f.row, f.host.lanes[0]!.id, now)).toBe(false)
    expect(routineResourcesAvailable(authority(compatible), f.row, compatible.lanes[0]!.id, now)).toBe(true)
    const prepared = await f.service.preparation(f.row.requestId)
    expect('resourceTarget' in prepared ? prepared.resourceTarget : undefined).toEqual({hostId: compatible.hostId, laneId: compatible.lanes[0]!.id})
    expect(f.reservations).toBe(1); expect(f.probes).not.toHaveBeenCalled()
    const bound = await f.service.bind(f.row.requestId, compatible.hostId, {inputSha256: f.row.fleetInputSha256,
      laneId: compatible.lanes[0]!.id, descriptorRevision: compatible.lanes[0]!.descriptorRevision, actionsRunId: '11', actionsJobId: '22'})
    expect(bound.execute).toBe(true); expect(f.bindings).toBe(1); expect(f.row.fleetCandidatePreparation).toBeUndefined()
    expect(f.row.fleetSelection).toEqual(original.fleetSelection); expect(f.row.fleetInputSha256).toBe(original.fleetInputSha256)
    expect(f.row.fleetDeadline).toEqual(original.fleetDeadline)
  } finally {f.close()}
})
test('failed current physical condition skips that lane and reserves an available alternative', async () => {
  const f = serviceFixture(), good = secondHost(f.host)
  f.host.resourceLifecycle!.subjects[0]!.idle.outcome = 'failed'
  f.host.resourceLifecycle!.subjects[0]!.reason = {code: 'phone-offline', message: 'Assigned phone is disconnected'}
  f.hosts.push(good)
  try {
    const report = testRequestMatchReport(f.row, f.hosts, now)
    expect(report.lanes[0]!.candidateMatch).not.toBe('match'); expect(report.lanes[1]!.candidateMatch).toBe('match')
    expect(report.lanes[0]!.resources[0]!.conditions.find(condition => condition.id === 'current-baseline')?.status).toBe('blocked')
    expect(report.lanes[0]!.resources[0]!.conditions.find(condition => condition.id === 'current-baseline')?.nextAction).toContain('Assigned phone is disconnected')
    const result = await f.service.preparation(f.row.requestId)
    expect(('resourceTarget' in result ? result.resourceTarget as {hostId: string} : undefined)?.hostId).toBe(good.hostId); expect(f.reservations).toBe(1)
    expect(f.probes).not.toHaveBeenCalled()
  } finally {f.close()}
})
for (const refusal of ['foreign-byte-claim', 'unknown-check', 'missing-observation', 'cancelled', 'expired', 'routine-api', 'explicit-framework', 'changed-target'] as const) {
  test(`single current match preserves ${refusal} refusal without qualification or allocation`, async () => {
    const f = serviceFixture()
    if (refusal === 'foreign-byte-claim') f.host.authorityReservations = [{id: 'a316f981-e1bc-4144-a7d5-d3cb048d30e2', requestId: 'foreign',
      fleetInputSha256: 'f'.repeat(64), hostId: f.host.hostId, laneId: f.host.lanes[0]!.id, poolId: 'disk', minimumAvailableBytes: 1, reservedAt: new Date(now).toISOString()}]
    if (refusal === 'unknown-check') {f.host.resourceLifecycle!.subjects[0]!.idle.outcome = 'unknown'; f.host.resourceLifecycle!.subjects[0]!.status = 'unknown'}
    if (refusal === 'missing-observation') f.host.resourceLifecycle!.subjects = []
    if (refusal === 'routine-api') f.host.frameworkBinding!.routineApiVersion = 14
    if (refusal === 'cancelled') f.row.fleetCancellation = {reason: 'Original cancellation', requestedAt: new Date(now).toISOString()}
    if (refusal === 'expired') {f.row.fleetDeadline = new Date(now); f.row.fleetInputSha256 = routineJobInputDigest(f.row)}
    if (refusal === 'explicit-framework') {
      f.row.fleetSelection.minimumFrameworkVersion = f.host.frameworkBinding!.version + 1
      f.row.fleetSelectionSha256 = requestInputDigest(f.row.fleetSelection); f.row.fleetInputSha256 = routineJobInputDigest(f.row)
    }
    if (refusal === 'changed-target') {f.row.fleetTarget = {hostId: 'different'}; f.row.fleetInputSha256 = routineJobInputDigest(f.row)}
    try {
      expect(routineResourcesAvailable(authority(f.host), f.row, f.host.lanes[0]!.id, now)).toBe(false)
      const report = testRequestMatchReport(f.row, f.hosts, now)
      expect(report.lanes[0]?.candidateMatch).not.toBe('match')
      const result = await f.service.preparation(f.row.requestId)
      expect('resourceTarget' in result ? result.resourceTarget : undefined).toBeUndefined(); expect(f.reservations).toBe(0); expect(f.bindings).toBe(0)
      expect(f.probes).not.toHaveBeenCalled()
    } finally {f.close()}
  })
}
test('new app permissions are setup requirements, while actual worker permission denial blocks selection', () => {
  const {row, host} = fixture(), required = row.fleetPreparation!.requirements.resources.find(resource => resource.kind === 'app')!
  required.permissions = [{recipient: 'app', permission: 'camera'}]
  row.fleetPreparation!.definition.resourceRequirements.find(resource => resource.kind === 'app')!.permissions = structuredClone(required.permissions)
  row.fleetPreparation!.definitionSha256 = requestInputDigest(row.fleetPreparation!.definition); row.fleetInputSha256 = routineJobInputDigest(row)
  const report = testRequestMatchReport(row, [host], now)
  expect(report.lanes[0]!.candidateMatch).toBe('match')
  expect(report.lanes[0]!.resources[1]!.conditions.find(condition => condition.id === 'permission:app:camera')?.status).toBe('deferred')
  required.permissions = [{recipient: 'worker', permission: 'microphone'}]
  row.fleetPreparation!.definition.resourceRequirements.find(resource => resource.kind === 'app')!.permissions = structuredClone(required.permissions)
  row.fleetPreparation!.definitionSha256 = requestInputDigest(row.fleetPreparation!.definition); row.fleetInputSha256 = routineJobInputDigest(row)
  expect(routineResourcesAvailable(authority(host), row, host.lanes[0]!.id, now)).toBe(false)
  expect(testRequestMatchReport(row, [host], now).lanes[0]!.candidateMatch).not.toBe('match')
})
