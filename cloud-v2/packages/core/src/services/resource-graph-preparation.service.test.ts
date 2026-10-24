import {expect, test} from 'bun:test'
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures'
import {candidatePrerequisiteSettlementSchema, type ResourceReadinessCheck} from '../types/backend-connectivity.types'
import {exclusiveResourceIntentSchema, resourceReservationObservationSchema} from '../types/resource-reservations.types'
import {fleetCandidatePreparationSchema, routineQualificationTargetSchema} from '../types/routine-job.types'
import {requestInputDigest} from './test-request.service'
import {candidateSettlement, graphCheckOperationId, graphFinalCheckOperationId, graphCandidateClaimMatches, graphCandidateReturnMatches, qualifiedGraphCandidate} from './backend-candidate-preparation'
import type {FleetCandidatePreparation, StoredRoutineJob} from '../types/routine-job.types'
import type {TestHostState} from './test-host-state.service'

const initial = Date.parse('2026-10-24T16:00:00Z'), at = (offset = 0) => new Date(initial + offset).toISOString()
const kinds = ['phone', 'app', 'recorder', 'fixture-data', 'audio', 'browser'] as const
const hash = 'a'.repeat(64)

/** CPU-only immutable protocol fixture; it does not qualify an installed provider. */
export function graphProtocolFixture(platform: 'android' | 'ios-on-mac' = 'android') {
  const members = kinds.map(kind => ({id: `host:${kind}`, kind, authorityHostId: 'host', subjectGeneration: 1,
    contractVersion: 'cpu-baseline', capabilities: []}))
  const resources = members.map(({id, kind}) => ({id, kind})), source = {channel: 'pr' as const, prNumber: 12, buildRunId: 55, publicationAttempt: 1}
  const routineSource = testRoutineSource(), definition = {id: 'probe', minimumRoutineApiVersion: 1, title: 'A check', purpose: 'Verify prerequisites',
    platforms: [platform], entry: 'home', account: 'lane', requirements: [], fixtures: [{provider: 'cpu-fixture', description: 'Isolated protocol fixture'}],
    steps: [{id: 'check', instruction: 'Check', expected: 'Checked'}],
    execution: {resourceKinds: [...kinds], policy: {estimatedOutputBytes: 1024}}, resourceRequirements: kinds.map(kind => ({kind, capabilities: []})),
    source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: routineSource.commit, path: 'routines/probe/routine.ts'}}
  const build = {kind: platform === 'android' ? 'android-apk' as const : 'mac-ci-package' as const, repository: 'Mentra-Community/MentraOS',
    channel: 'pr', prNumber: 12, source, headSha: 'b'.repeat(40),
    archive: {name: 'app.zip', size: 100, sha256: hash, url: 'https://artifactscdn.mentraglass.com/app.zip'},
    receipt: {size: 10, sha256: hash, url: 'https://artifactscdn.mentraglass.com/receipt.json'}}
  const selection = {requestId: 'job-one', routineId: 'probe', platform, source, routineRevision: routineSource.commit, build}
  const candidate = {attemptId: 'candidate:job-one:1', requestedAt: at(), fleetInputSha256: hash,
    selectionSha256: requestInputDigest(selection), controller: {incarnation: 'controller', generation: 1}}
  const body = {jobId: 'job-one', hostId: 'host', laneId: 'lane', deadline: at(300_000), acceptedBinding: testFrameworkBinding(),
    purpose: {kind: 'resource-readiness' as const, resourceId: members[0]!.id, resources: members}, candidate,
    proposedInput: {routineId: 'probe', routineSource, definitionRevision: routineSource.commit, platform, laneId: 'lane', build, resources},
    definition, definitionSha256: requestInputDigest(definition), selection: {...selection, routineSource},
    requirements: {platform, resources: definition.resourceRequirements}, target: {hostId: 'host', laneId: 'lane'}}
  const target = routineQualificationTargetSchema.parse({...body, inputSha256: requestInputDigest(body)})
  const parent = `graph-prerequisite:${target.inputSha256}`
  const intent = exclusiveResourceIntentSchema.parse({operationId: parent, hostId: 'host', laneId: 'lane',
    controller: {...candidate.controller, sequence: 1}, owner: {id: 'graph-owner', kind: 'boundary-cleanup'}, inputSha256: target.inputSha256,
    prerequisite: {...body.purpose, jobId: body.jobId, targetInputSha256: target.inputSha256, binding: body.acceptedBinding, candidate},
    resources: members.map(member => ({id: member.id, capabilities: ['resource-idle']}))})
  return {members, resources, candidate, target, parent, intent}
}

test.each(['android', 'ios-on-mac'] as const)('current graph target retains the frozen %s job and all member identities', platform => {
  const f = graphProtocolFixture(platform)
  expect(f.target.selection.platform).toBe(platform)
  expect(f.target.deadline).toBe(at(300_000))
  expect(f.intent.resources.map(resource => resource.id)).toEqual(f.members.map(member => member.id))
  expect(fleetCandidatePreparationSchema.safeParse({candidate: f.candidate, hostId: 'host', laneId: 'lane',
    target: f.target, targetInputSha256: f.target.inputSha256}).success).toBe(true)
})

test.each(['missing-member', 'foreign-authority', 'scalar-check', 'changed-controller', 'changed-parent'] as const)('graph acquisition rejects %s', changed => {
  const f = graphProtocolFixture(), intent = structuredClone(f.intent)
  if (changed === 'missing-member') intent.resources.pop()
  if (changed === 'foreign-authority' && intent.prerequisite?.kind === 'resource-readiness') intent.prerequisite.resources[1]!.authorityHostId = 'other'
  if (changed === 'scalar-check') Object.assign(intent, {resourceCheck: {resourceId: f.members[0]!.id, subjectGeneration: 1,
    contractVersion: 'cpu-baseline', deadlineAt: initial + 300_000, binding: f.target.acceptedBinding, controller: f.candidate.controller}})
  if (changed === 'changed-controller') intent.controller.generation++
  if (changed === 'changed-parent') intent.operationId += '-changed'
  expect(exclusiveResourceIntentSchema.safeParse(intent).success).toBe(false)
})

test('no-acquisition unknown can retain an empty original graph; qualified cannot invent missing or failed checks', () => {
  const f = graphProtocolFixture(), receipt = {candidate: f.candidate, targetInputSha256: f.target.inputSha256,
    outcome: 'unknown' as const, hostWorkSettled: true as const, checkOperationId: f.parent, graphChecks: []}
  expect(candidatePrerequisiteSettlementSchema.safeParse(receipt).success).toBe(true)
  expect(candidatePrerequisiteSettlementSchema.safeParse({...receipt, outcome: 'qualified'}).success).toBe(false)
  expect(candidatePrerequisiteSettlementSchema.safeParse({...receipt, checkOperationId: undefined}).success).toBe(false)
  const check = {resourceId: f.members[0]!.id, checkOperationId: 'original-member-check', outcome: 'failed', subjectGeneration: 4,
    contractVersion: 'cpu-baseline', resultSha256: hash, checkedAt: at(29_000)}
  expect(candidatePrerequisiteSettlementSchema.safeParse({...receipt, outcome: 'qualified', graphChecks: [check]}).success).toBe(false)
  expect(candidatePrerequisiteSettlementSchema.safeParse({...receipt, graphChecks: [check, check]}).success).toBe(false)
})

test('installed graph capability is explicit; old phone-only observation remains accepted', () => {
  const old = {claims: [], returns: [], candidatePrerequisites: []}
  expect(resourceReservationObservationSchema.safeParse(old).success).toBe(true)
  expect(resourceReservationObservationSchema.safeParse({...old, resourceReadiness: true}).success).toBe(true)
  expect(resourceReservationObservationSchema.safeParse({...old, resourceReadiness: false}).success).toBe(false)
})

test('never-requested closure cannot authorize execution, hide checks or replace the original host parent', () => {
  const f = graphProtocolFixture(), receipt = {candidate: f.candidate, targetInputSha256: f.target.inputSha256,
    outcome: 'unknown' as const, hostWorkSettled: true as const, checkOperationId: f.parent, graphChecks: [], neverRequested: true}
  expect(candidatePrerequisiteSettlementSchema.safeParse(receipt).success).toBe(true)
  expect(candidatePrerequisiteSettlementSchema.safeParse({...receipt, outcome: 'qualified'}).success).toBe(false)
  expect(candidatePrerequisiteSettlementSchema.safeParse({...receipt, checkOperationId: undefined}).success).toBe(false)
  expect(candidatePrerequisiteSettlementSchema.safeParse({...receipt, graphChecks: undefined}).success).toBe(false)
  expect(candidatePrerequisiteSettlementSchema.safeParse({...receipt, neverRequested: false}).success).toBe(false)
})


/** Real Core qualification path, synthetic closed reader/return receipts only. */
function closedGraphFixture() {
  const f = graphProtocolFixture(), returnedAt = at(174_000), generation = 4,
    owner = {kind: 'boundary-cleanup' as const, id: `resource-graph:${f.target.inputSha256}`},
    checks = f.members.map((member, index) => ({resourceId: member.id,
      checkOperationId: (member.kind === 'phone' ? graphFinalCheckOperationId : graphCheckOperationId)(f.target.inputSha256, member.id), outcome: 'passed' as const,
      subjectGeneration: generation, contractVersion: member.contractVersion, resultSha256: hash,
      // Static members take29s each. The current phone/network observation is last.
      checkedAt: at(member.kind === 'phone' ? 174_000 : index * 29_000)})),
    claims = f.members.map((member, index) => ({kind: 'exclusive', id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      authorityHostId: 'host', borrowerHostId: 'host', laneId: 'lane', resourceId: member.id, operationId: f.parent,
      intentSha256: hash, inputSha256: f.target.inputSha256, owner,
      controllerIncarnation: f.candidate.controller.incarnation, controllerGeneration: f.candidate.controller.generation,
      borrowerSequence: 1, reservedAt: at(), prerequisite: f.intent.prerequisite,
      resourceCheck: {resourceId: member.id, subjectGeneration: member.subjectGeneration,
        contractVersion: member.contractVersion, deadlineAt: initial + 300_000, binding: f.target.acceptedBinding, controller: f.candidate.controller}})),
    returns = claims.map((claim, index) => ({claimId: claim.id, authorityHostId: 'host', resourceId: claim.resourceId,
      intentSha256: claim.intentSha256, inputSha256: claim.inputSha256, originalOwner: owner, laneId: 'lane',
      controller: {...f.candidate.controller, sequence: 2}, release: {kind: 'resource-check',
        operationId: checks[index]!.checkOperationId, subjectGeneration: generation, releasedAt: returnedAt, eventId: `released:${claim.id}`}})),
    settlement = {targetInputSha256: f.target.inputSha256, candidate: f.candidate, outcome: 'qualified' as const,
      hostWorkSettled: true as const, checkOperationId: f.parent, graphChecks: checks},
    pending = fleetCandidatePreparationSchema.parse({candidate: f.candidate, hostId: 'host', laneId: 'lane', target: f.target,
      targetInputSha256: f.target.inputSha256, resourceClaims: claims, resourceReturns: returns, settlement}),
    refs = f.members.map(member => ({id: member.id, kind: member.kind, capabilities: [], idleContract: {
      version: member.contractVersion, maximumAgeMs: 120_000, conditions: ['original-baseline'], dependencies: [],
      repairConfigured: true, qualifiedScope: {kind: 'same-controller', controllerId: 'host'}}})),
    host = {hostId: 'host', incarnation: f.candidate.controller.incarnation, incarnationGeneration: f.candidate.controller.generation,
      sequence: 2, frameworkBinding: f.target.acceptedBinding, observedAt: returnedAt, resources: refs,
      lanes: [{id: 'lane', platform: 'android', state: 'idle', dispatchMode: 'automatic', resources: refs}],
      resourceReservations: {claims: [], returns: [], resourceReadiness: true, candidatePrerequisites: [settlement]},
      resourceLifecycle: {schemaVersion: 1, history: [], subjects: f.members.map((member, index) => ({
        subject: {kind: 'resource', id: member.id, authorityHostId: 'host'}, generation, current: true, status: 'idle', owner: null,
        observedAt: returnedAt, receivedAt: returnedAt, reason: null,
        idle: {contractVersion: member.contractVersion, outcome: 'passed', checkedAt: checks[index]!.checkedAt,
          qualifiedScope: refs[index]!.idleContract.qualifiedScope, evidenceRefs: [], acceptedCheck: {
            operationId: checks[index]!.checkOperationId, subjectGeneration: generation, resultSha256: hash, acceptedAt: checks[index]!.checkedAt}},
        repair: {configured: true, state: 'none'}, supportedActions: ['mark-out-of-service'], resource: {kind: member.kind,
          capabilities: [], memberships: [{hostId: 'host', laneId: 'lane'}], dependencies: [], placement: 'installed'}}))}} as unknown as TestHostState,
    row = {fleetInputSha256: f.candidate.fleetInputSha256, fleetSelectionSha256: f.candidate.selectionSha256,
      fleetDeadline: new Date(f.target.deadline), fleetCandidatePreparations: [pending],
      fleetCandidateSelection: {hostId: 'host', laneId: 'lane', targetInputSha256: f.target.inputSha256}} as StoredRoutineJob
  return {...f, host, pending, row, now: initial + 174_000}
}

test('six29-second checks qualify one unchanged phase without expiring early static PASS results', () => {
  const f = closedGraphFixture(), staticCheck = f.pending.settlement!.graphChecks!.find(check => check.resourceId === 'host:app')!
  expect(f.now - Date.parse(staticCheck.checkedAt)).toBeGreaterThan(120_000)
  expect(f.pending.resourceClaims!.map(value => graphCandidateClaimMatches(f.pending, value))).toEqual(Array(6).fill(true))
  expect(f.pending.resourceReturns!.map(value => graphCandidateReturnMatches(f.pending, value))).toEqual(Array(6).fill(true))
  expect(qualifiedGraphCandidate(f.row, f.host, 'lane', f.now, f.host.observedAt)).toBeDefined()
  const open = {...f.pending, settlement: undefined} as FleetCandidatePreparation
  expect(candidateSettlement(open, f.host, [], f.now)?.outcome).toBe('qualified')
  expect(f.pending.settlement!.graphChecks!.find(check => check.resourceId === 'host:phone')!.checkedAt).toBe(at(174_000))
})

test.each(['missing-check', 'missing-return', 'new-owner', 'generation', 'controller', 'contract', 'failed-check', 'deadline', 'out-of-service', 'dependency'] as const)(
  'a completed slow graph cannot bind after %s', changed => {
    const f = closedGraphFixture(), subject = f.host.resourceLifecycle!.subjects[0]!
    if (changed === 'missing-check') f.pending.settlement!.graphChecks!.pop()
    if (changed === 'missing-return') f.pending.resourceReturns!.pop()
    if (changed === 'new-owner') subject.owner = {kind: 'fixer', id: 'another-owner', generation: 9, hostId: 'host'}
    if (changed === 'generation') subject.generation++
    if (changed === 'controller') f.host.incarnation += '-restarted'
    if (changed === 'contract') f.host.resources![0]!.idleContract!.version = 'changed-provider-contract'
    if (changed === 'failed-check') f.pending.settlement!.graphChecks![0]!.outcome = 'failed'
    if (changed === 'deadline') f.row.fleetDeadline = new Date(f.now)
    if (changed === 'out-of-service') subject.status = 'out-of-service'
    if (changed === 'dependency') f.host.resources![0]!.idleContract!.dependencies = ['new-unchecked-resource']
    expect(qualifiedGraphCandidate(f.row, f.host, 'lane', f.now, f.host.observedAt)).toBeUndefined()
  })

import {routingGraphFixture} from './backend-candidate-preparation.test-support'
import {routineJobInputDigest} from './routine-job.service'


test('a returned offline-phone graph selects a ready alternate with the same original job/build/routine/deadline', async () => {
  const f = routingGraphFixture(), original = structuredClone({selection: f.row.fleetSelection, deadline: f.row.fleetDeadline,
    input: f.row.fleetInputSha256})
  await f.service.preparation('job-one')
  expect(f.row.fleetCandidatePreparation?.hostId).toBe('air1'); expect(f.bindWrites).toBe(0)
  f.settleGraph('unqualified'); await f.service.preparation('job-one')
  expect(f.row.fleetCandidatePreparations?.[0]?.settlement?.outcome).toBe('unqualified')
  expect(f.row.fleetCandidatePreparation?.hostId).toBe('air2'); expect(f.bindWrites).toBe(0)
  f.settleGraph('qualified'); await f.service.preparation('job-one')
  expect(f.row.fleetCandidatePreparations?.[1]?.settlement?.outcome).toBe('qualified')
  expect(f.row.fleetResourceReservation?.hostId).toBe('air2')
  expect({selection: f.row.fleetSelection, deadline: f.row.fleetDeadline, input: f.row.fleetInputSha256}).toEqual(original)
})

test('an offline result without the original whole-graph return ACK retains custody and cannot dispatch an alternate', async () => {
  const f = routingGraphFixture(); await f.service.preparation('job-one'); f.settleGraph('unqualified', false)
  const pending = structuredClone(f.row.fleetCandidatePreparation)
  await f.service.preparation('job-one')
  expect(f.row.fleetCandidatePreparation).toEqual(pending); expect(f.writes).toBe(1); expect(f.bindWrites).toBe(0)
})

test.each(['unqualified', 'unknown'] as const)('a physically healthy phone with %s backend evidence returns and selects an alternate', async outcome => {
  const f = routingGraphFixture(), original = structuredClone({selection: f.row.fleetSelection, deadline: f.row.fleetDeadline,
    input: f.row.fleetInputSha256})
  await f.service.preparation('job-one')
  f.settleGraph(outcome, true, 'passed')
  const phone = f.hosts[0]!.resourceLifecycle!.subjects.find(subject => subject.resource?.kind === 'phone')!
  expect(phone.status).toBe('idle'); expect(phone.idle.outcome).toBe('passed')
  await f.service.preparation('job-one')
  expect(f.row.fleetCandidatePreparations?.[0]?.settlement?.outcome).toBe(outcome)
  expect(f.row.fleetCandidatePreparation?.hostId).toBe('air2'); expect(f.bindWrites).toBe(0)
  f.settleGraph('qualified'); await f.service.preparation('job-one')
  expect(f.row.fleetResourceReservation?.hostId).toBe('air2')
  expect(phone.status).toBe('idle'); expect(phone.idle.outcome).toBe('passed')
  expect({selection: f.row.fleetSelection, deadline: f.row.fleetDeadline, input: f.row.fleetInputSha256}).toEqual(original)
})

test('a backend refusal still retains its original candidate when normal resource return is unknown', async () => {
  const f = routingGraphFixture(); await f.service.preparation('job-one'); f.settleGraph('unqualified', false, 'passed')
  const pending = structuredClone(f.row.fleetCandidatePreparation)
  await f.service.preparation('job-one')
  expect(f.row.fleetCandidatePreparation).toEqual(pending); expect(f.bindWrites).toBe(0)
})

test('a source-only preparation that never requested resources closes UNKNOWN and routes the same job to an alternate', async () => {
  const f = routingGraphFixture(), original = structuredClone({selection: f.row.fleetSelection, deadline: f.row.fleetDeadline,
    input: f.row.fleetInputSha256})
  await f.service.preparation('job-one'); f.settleNeverRequested()
  await f.service.preparation('job-one')
  expect(f.row.fleetCandidatePreparations?.[0]?.settlement?.outcome).toBe('unknown')
  expect(f.row.fleetCandidatePreparations?.[0]?.settlement?.neverRequested).toBe(true)
  expect(f.row.fleetCandidatePreparation?.hostId).toBe('air2'); expect(f.bindWrites).toBe(0)
  f.settleGraph('qualified'); await f.service.preparation('job-one')
  expect(f.row.fleetResourceReservation?.hostId).toBe('air2')
  expect({selection: f.row.fleetSelection, deadline: f.row.fleetDeadline, input: f.row.fleetInputSha256}).toEqual(original)
})

test.each(['backend-target', 'claim', 'return', 'absence-receipt', 'owner', 'generation', 'contract', 'parent', 'candidate', 'not-never-requested'] as const)(
  'never-requested cannot hide %s or invent an alternate dispatch', async changed => {
    const f = routingGraphFixture(); await f.service.preparation('job-one')
    const {pending, host, receipt} = f.settleNeverRequested(), subject = host.resourceLifecycle!.subjects[0]!
    if (changed === 'backend-target') pending.backendTarget = {schemaVersion: 1, coreUrl: 'https://core.example/'}
    if (changed === 'claim') pending.resourceClaims = [{id: 'unknown-original-claim'}]
    if (changed === 'return') pending.resourceReturns = [{claimId: 'unknown-original-claim'}]
    if (changed === 'absence-receipt') pending.noAcquisitionReceipt = {status: 'unknown'}
    if (changed === 'owner') subject.owner = {kind: 'fixer', id: 'other-owner', generation: 2, hostId: host.hostId}
    if (changed === 'generation') subject.generation++
    if (changed === 'contract') host.lanes[0]!.resources[0]!.idleContract!.version = 'changed-contract'
    if (changed === 'parent') receipt.checkOperationId += '-different'
    if (changed === 'candidate') receipt.candidate = {...receipt.candidate, attemptId: 'foreign-candidate'}
    if (changed === 'not-never-requested') delete receipt.neverRequested
    const before = structuredClone(f.row.fleetCandidatePreparation)
    await f.service.preparation('job-one')
    expect(f.row.fleetCandidatePreparation).toEqual(before); expect(f.bindWrites).toBe(0)
    expect(f.row.fleetCandidatePreparations).toBeUndefined()
  })

test('switching a lane out of service does not strand closed source-only work or authorize that lane', async () => {
  const f = routingGraphFixture(); await f.service.preparation('job-one')
  const {host} = f.settleNeverRequested()
  host.lanes[0]!.state = 'out-of-service'; host.lanes[0]!.dispatchMode = 'paused'
  await f.service.preparation('job-one')
  expect(f.row.fleetCandidatePreparations?.[0]?.settlement?.outcome).toBe('unknown')
  expect(f.row.fleetCandidatePreparation?.hostId).toBe('air2'); expect(f.bindWrites).toBe(0)
})

test('logical workspace stays on its admission path instead of inventing a physical baseline provider', async () => {
  const f = routingGraphFixture(), required = {kind: 'workspace' as const, capabilities: []},
    prepared = f.row.fleetPreparation!
  for (const host of f.hosts) host.lanes[0]!.resources.push({id: `${host.hostId}:workspace`, ...required})
  prepared.requirements.resources = [...prepared.requirements.resources, required]
  prepared.definition.execution!.resourceKinds.push('workspace')
  prepared.definition.resourceRequirements = [...prepared.definition.resourceRequirements!, required]
  prepared.definitionSha256 = requestInputDigest(prepared.definition)
  f.row.fleetInputSha256 = routineJobInputDigest(f.row)
  await f.service.preparation('job-one')
  const pending = f.row.fleetCandidatePreparation!, purpose = pending?.target.purpose
  expect(pending?.hostId).toBe('air1'); expect(purpose?.kind).toBe('resource-readiness')
  if (purpose?.kind !== 'resource-readiness') throw new Error('Expected physical preflight with logical workspace admission')
  expect(purpose.resources.map(member => member.kind)).toEqual(['phone', 'app', 'recorder'])
  expect(pending.target.proposedInput!.resources.some(resource => resource.kind === 'workspace')).toBe(true)
  expect(pending.target.requirements.resources).toContainEqual(required)
  f.settleGraph('qualified'); await f.service.preparation('job-one')
  expect(f.row.fleetResourceReservation?.hostId).toBe('air1')
})


test('old dynamic evidence requests a refresh without changing a passed resource to failed', () => {
  const f = closedGraphFixture(), now = f.now + 120_001, before = structuredClone(f.host.resourceLifecycle),
    snapshot = new Date(now).toISOString()
  f.host.observedAt = snapshot
  expect(qualifiedGraphCandidate(f.row, f.host, 'lane', now, snapshot)).toBeUndefined()
  const open = {...f.pending, settlement: undefined} as FleetCandidatePreparation
  expect(candidateSettlement(open, f.host, [], now)?.outcome).toBe('qualified')
  expect(f.host.resourceLifecycle).toEqual(before)
})

test('two returned offline graphs leave the same job unassigned instead of dispatching onto a broken phone', async () => {
  const f = routingGraphFixture(), original = structuredClone(f.row.fleetSelection), deadline = f.row.fleetDeadline
  await f.service.preparation('job-one'); f.settleGraph('unqualified'); await f.service.preparation('job-one')
  f.settleGraph('unqualified'); await f.service.preparation('job-one')
  expect(f.row.fleetCandidatePreparations?.map(candidate => candidate.settlement?.outcome)).toEqual(['unqualified', 'unqualified'])
  expect(f.row.fleetCandidatePreparation).toBeUndefined(); expect(f.row.fleetBinding).toBeUndefined(); expect(f.bindWrites).toBe(0)
  expect(f.row.fleetSelection).toEqual(original); expect(f.row.fleetDeadline).toEqual(deadline)
})

test('cancellation retains graph settlement history and cannot accept a returned positive as execution authority', async () => {
  const f = routingGraphFixture(); await f.service.preparation('job-one'); f.settleGraph('qualified')
  f.row = {...f.row, state: 'terminal', terminalStatus: 'cancelled', fleetCancellation: {requestedAt: new Date(f.now).toISOString(), reason: 'Cancelled original'}}
  await f.service.preparation('job-one')
  expect(f.row.fleetCandidatePreparations?.[0]?.settlement?.outcome).toBe('qualified')
  expect(f.row.fleetCandidatePreparation).toBeUndefined(); expect(f.row.fleetCandidateSelection).toBeUndefined(); expect(f.bindWrites).toBe(0)
})

test('ordinary idle PASS without selected-build backend evidence cannot qualify a backend-dependent job', async () => {
  const f = routingGraphFixture(); await f.service.preparation('job-one'); f.settleGraph('qualified')
  const open = f.row.fleetCandidatePreparation!, host = f.hosts[0]!, completed = {...open,
    settlement: host.resourceReservations!.candidatePrerequisites![0]!} as FleetCandidatePreparation,
    row = {...f.row, fleetCandidatePreparation: undefined, fleetCandidatePreparations: [completed],
      fleetCandidateSelection: {hostId: host.hostId, laneId: 'android', targetInputSha256: completed.targetInputSha256}} as StoredRoutineJob
  expect(qualifiedGraphCandidate(row, host, 'android', f.now, host.receivedAt)).toBeDefined()
  host.lanes[0]!.resources.find(resource => resource.kind === 'phone')!.backendConnectivity = undefined
  completed.settlement!.graphChecks!.find(check => check.resourceId === host.lanes[0]!.resources.find(resource => resource.kind === 'phone')!.id)!.backendConnectivity = undefined
  expect(qualifiedGraphCandidate(row, host, 'android', f.now, host.receivedAt)).toBeUndefined()
})
