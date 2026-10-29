import {expect, spyOn, test} from 'bun:test'
import {TestRequestModel} from '../models/test-request.model'
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures'
import type {StoredRoutineJob} from '../types/routine-job.types'
import type {RoutingTestHostState} from './test-host-state.service'
import {requestInputDigest} from './test-request.service'
import {routineJobInputDigest, routineJobRouting, routinePortableRequirements, routineResourceReadinessPurpose} from './routine-job.service'
import {TestRequestMatchService, testRequestMatchReport} from './test-request-match.service'

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
        availableBytes: 10_000_000_000, stagingBudgetBytes: 10_000_000_000, pendingEvidenceBytes: 100, reservations: []}}]}]} as RoutingTestHostState
  return {row, host}
}
test('complete frozen requirements and every requested provider appear on every lane without changing the original', () => {
  const {row, host} = fixture(), original = structuredClone({row, host}), report = testRequestMatchReport(row, [host], now)
  expect(report.requirements?.human).toEqual(row.fleetPreparation!.definition.requirements)
  expect(report.requirements?.minimumRoutineApiVersion).toBe(15)
  expect(report.requirements?.declaredResources[2]?.storage?.minimumAvailableBytes).toBe(100)
  expect(report.requirements?.effective.resources[2]?.storage?.minimumAvailableBytes).toBe(3_254_779_904)
  expect(report.requirements?.effective.resources.every(value => !value.permissions?.length)).toBe(true)
  expect(report.lanes[0]?.resources.map(value => value.kind)).toEqual(['phone', 'app', 'recorder'])
  expect(report.lanes[0]?.resources[0]?.conditions.find(value => value.id === 'backend-connectivity')).toMatchObject({category: 'source', status: 'match', observed: 'Routine API 111'})
  expect(report.lanes[0]?.candidateMatch).toBe(routineJobRouting(row.fleetPreparation!.requirements, [host], now, undefined, row.fleetSelection.build, true,
    {requestId: row.requestId, inputSha256: row.fleetInputSha256!}).waitingReason ? 'blocked' : 'match')
  expect({row, host}).toEqual(original)
})
test('global provider counts cannot combine resources across different lanes', () => {
  const {row, host} = fixture()
  host.lanes = [structuredClone(host.lanes[0]!), {...structuredClone(host.lanes[0]!), id: 'other'}]
  host.lanes[0]!.resources = host.lanes[0]!.resources.filter(value => value.kind !== 'app')
  host.lanes[1]!.resources = host.lanes[1]!.resources.filter(value => value.kind !== 'phone')
  const report = testRequestMatchReport(row, [host], now)
  expect(report.summary.resources.map(value => value.presentLanes)).toEqual([1, 1, 2])
  expect(report.summary.candidateLanes).toBe(0)
  expect(report.lanes.every(lane => lane.resources.length === 3 && lane.candidateMatch === 'blocked')).toBe(true)
})
test('per-lane routing keeps required same-host dependency offers from other lanes', () => {
  const {row, host} = fixture(), at = new Date(now).toISOString()
  host.frameworkBinding!.routineApiVersion = 111
  host.resourceReservations = {schemaVersion: 1, resourceReadiness: true} as never
  host.lanes.push({id: 'other-lane', platform: 'android', state: 'idle', dispatchMode: 'automatic', resources: [{id: 'shared-helper', kind: 'browser', capabilities: []}]})
  for (const lane of host.lanes) for (const resource of lane.resources) resource.idleContract = {version: 'baseline', maximumAgeMs: 120000,
    qualifiedScope: {kind: 'same-controller', controllerId: host.hostId}, conditions: ['writers-absent'], repairConfigured: true,
    ...(resource.kind === 'app' ? {dependencies: ['shared-helper']} : {})}
  host.resourceLifecycle = {schemaVersion: 1, history: [], subjects: host.lanes.flatMap(lane => lane.resources.map(resource => ({
    subject: {kind: 'resource', id: resource.id, authorityHostId: host.hostId}, generation: 7, status: 'idle', observedAt: at, receivedAt: null, current: true, reason: null, owner: null,
    idle: {contractVersion: 'baseline', outcome: 'passed', checkedAt: at, acceptedCheck: {operationId: `check:${resource.id}`, subjectGeneration: 7, resultSha256: 'a'.repeat(64), acceptedAt: at}, qualifiedScope: resource.idleContract!.qualifiedScope, evidenceRefs: []},
    repair: {configured: true, state: 'none'}, supportedActions: ['reserve', 'check', 'mark-out-of-service'],
    resource: {kind: resource.kind, capabilities: resource.capabilities ?? [], memberships: [{hostId: host.hostId, laneId: lane.id}], dependencies: [], placement: 'installed'},
  })))} as never
  expect(routineResourceReadinessPurpose(host, host.lanes[0]!, row.fleetPreparation!.requirements, now)).toBeDefined()
  expect(routineResourceReadinessPurpose({...host, lanes: [host.lanes[0]!]}, host.lanes[0]!, row.fleetPreparation!.requirements, now)).toBeUndefined()
  const report = testRequestMatchReport(row, [host], now)
  expect(report.lanes[0]?.candidateMatch).toBe('match'); expect(report.lanes[1]?.candidateMatch).toBe('blocked')
  expect(report.summary.candidateLanes).toBe(1)
})
test('quantitative byte claims do not masquerade as exclusive ownership', () => {
  const {row, host} = fixture()
  host.authorityReservations = [{id: 'ec0501bc-105e-4e54-9f25-3f3cec0c0001', requestId: 'foreign-original', hostId: host.hostId, laneId: host.lanes[0]!.id,
    poolId: 'disk', fleetInputSha256: 'f'.repeat(64), reservedAt: new Date(now).toISOString(), minimumAvailableBytes: 1}]
  const before = structuredClone(host)
  const report = testRequestMatchReport(row, [host], now)
  expect(report.lanes[0]?.candidateMatch).toBe('match')
  expect(report.lanes[0]?.resources[2]?.conditions.some(value => value.id.startsWith('claim:'))).toBe(false)
  expect(host).toEqual(before)
  host.authorityReservations[0] = {...host.authorityReservations[0]!, requestId: row.requestId, fleetInputSha256: row.fleetInputSha256!} as never
  expect(testRequestMatchReport(row, [host], now).lanes[0]?.candidateMatch).toBe('match')
})
test('source, stale physical observation and explicit target are separate refusals', () => {
  const {row, host} = fixture()
  row.fleetTarget = {hostId: 'another-host'}; row.fleetInputSha256 = routineJobInputDigest(row)
  host.frameworkBinding!.routineApiVersion = 14
  host.lanes[0]!.resources[2]!.storage!.availableBytes = 1
  const report = testRequestMatchReport(row, [host], now)
  expect(report.lanes[0]?.conditions.find(value => value.id === 'target')?.status).toBe('blocked')
  expect(report.lanes[0]?.conditions.find(value => value.id === 'routine-api')?.status).toBe('blocked')
  expect(report.lanes[0]?.resources[2]?.conditions.find(value => value.id === 'storage')?.status).toBe('blocked')
  host.receivedAt = new Date(now - 120_001).toISOString()
  expect(testRequestMatchReport(row, [host], now).lanes[0]?.conditions.find(value => value.id === 'fresh-report')?.status).toBe('unknown')
})
test('corrupt requirements and terminal originals remain truthful and do not gain executable authority', () => {
  const {row, host} = fixture()
  row.state = 'terminal'; row.terminalStatus = 'not-run'
  expect(testRequestMatchReport(row, [host], now).stage).toBe('Terminal original result')
  row.fleetPreparation!.requirements.resources[0]!.capabilities = []
  const corrupt = testRequestMatchReport(row, [host], now)
  expect(corrupt.requirements).toBeUndefined(); expect(corrupt.lanes).toEqual([])
})
test('matching GET is exactly one point query and one enrolled-current-host read with no writes', async () => {
  const {row, host} = fixture(), calls: unknown[] = [], query = {select: (projection: unknown) => {calls.push(projection); return query}, read: () => query,
    readConcern: () => query, lean: async () => row}
  const find = spyOn(TestRequestModel, 'findOne').mockImplementation((filter: unknown) => {calls.push(filter); return query as never})
  let hostReads = 0
  try {
    const service = new TestRequestMatchService({list: async () => {hostReads++; return [host]}}, () => now)
    expect((await service.get(row.requestId)).requestId).toBe(row.requestId)
    expect(calls[0]).toEqual({requestId: row.requestId}); expect(find).toHaveBeenCalledTimes(1); expect(hostReads).toBe(1)
    expect((calls[1] as Record<string, unknown>).fleetCandidatePreparations).toBeUndefined()
    expect((calls[1] as Record<string, unknown>).frameworkHistory).toBeUndefined()
    await expect(service.get('../invalid')).rejects.toThrow('Invalid original'); expect(find).toHaveBeenCalledTimes(1)
  } finally {find.mockRestore()}
})
