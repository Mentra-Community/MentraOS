import {TestRequestModel} from '../models/test-request.model'
import {frameworkIdentitySchema} from '../types/framework-request.types'
import type {StoredRoutineJob} from '../types/routine-job.types'
import type {MatchCondition, MatchStatus, TestRequestMatchReport} from '../types/test-request-match.types'
import {isExclusiveHostReservation} from '../types/resource-reservations.types'
import {TestHostStateService, type RoutingTestHostState} from './test-host-state.service'
import {TestRunError} from './test-result-error'
import {pendingQueueItem} from './test-pending-queue.service'
import {evaluateRoutineLaneRequirements} from './routine-lane-eligibility'
import {routineJobRouting, routineLaneContext, routineResourceReadinessPurpose} from './routine-job.service'
import {resourceBlocker, resourceCandidateBlocker, resourceHostBlocker, resourceLaneBlocker} from './resource-readiness'

const condition = (id: string, category: MatchCondition['category'], label: string, status: MatchStatus, expected: string, observed: string): MatchCondition =>
  ({id, category, label, status, expected, observed})

/** Exact original + current enrolled offers. No preparation, reservation, reconciliation or GitHub calls. */
export function testRequestMatchReport(row: StoredRoutineJob, hosts: RoutingTestHostState[], now: number): TestRequestMatchReport {
  const item = pendingQueueItem(row, hosts, now), prepared = item.compatibilityKnown ? row.fleetPreparation : undefined
  const selected = row.fleetBinding ?? row.fleetCandidatePreparation ?? row.fleetResourceAdmission?.intent ?? row.fleetResourceReservation ?? row.fleetCandidateSelection
  const report: TestRequestMatchReport = {requestId: row.requestId, state: row.state, observedAt: new Date(now).toISOString(),
    stage: item.diagnosis?.stage ?? 'Unknown original metadata', reason: item.reason ?? 'No specific matching refusal is recorded.',
    nextAction: item.diagnosis?.nextAction ?? 'Inspect the original identity and preparation result.',
    identity: {inputSha256: row.fleetInputSha256, definitionSha256: prepared?.definitionSha256, definitionRevision: item.compatibilityKnown ? row.fleetSelection.routineRevision : undefined,
      appHeadSha: item.build?.headSha, deadline: row.fleetDeadline instanceof Date && Number.isFinite(row.fleetDeadline.getTime()) ? row.fleetDeadline.toISOString() : undefined},
    ...(selected ? {selected: {hostId: selected.hostId, laneId: selected.laneId,
      ...(row.fleetCandidatePreparation ? {operationId: row.fleetCandidatePreparation.candidate.attemptId} : row.fleetResourceAdmission ? {operationId: row.fleetResourceAdmission.intent.operationId} : {})}} : {}),
    lanes: [], summary: {candidateLanes: 0, structurallyCompatibleLanes: 0, resources: []},
    limits: ['All requested resources must match on the same eligible lane; counts cannot be combined across lanes.',
      'Current report facts are not an atomic reservation, acquisition or permission grant. The existing admission CAS remains authoritative.',
      'Missing or stale observations are unknown, not a reported physical denial. A pending original check still requires its authentic result and return.',
      'Recorder storage uses the frozen effective budget and reported reservations; later atomic capacity accounting can still refuse.',
      'This read uses the original request and current enrolled host reports only. It does not refresh devices or scan request/history records.']}
  if (!prepared) return report
  const requirements = prepared.requirements, original = {requestId: row.requestId, inputSha256: row.fleetInputSha256!}
  report.requirements = {effective: requirements, declaredResources: prepared.definition.resourceRequirements,
    human: prepared.definition.requirements, minimumRoutineApiVersion: prepared.routineSource.minimumRoutineApiVersion,
    ...(row.fleetSelection.minimumFrameworkVersion === undefined ? {} : {minimumFrameworkVersion: row.fleetSelection.minimumFrameworkVersion}),
    ...(typeof prepared.definition.execution?.policy?.estimatedOutputBytes === 'number' ? {estimatedOutputBytes: prepared.definition.execution.policy.estimatedOutputBytes} : {}),
    ...(row.fleetTarget ? {target: row.fleetTarget} : {})}
  for (const host of hosts) for (const lane of host.lanes) {
    const context = routineLaneContext(host, row.fleetSelection.build, now)
    const structural = evaluateRoutineLaneRequirements(requirements, lane, context, now, false)
    const execution = evaluateRoutineLaneRequirements(requirements, lane, context, now, true)
    const authority = {hostId: host.hostId, receivedAt: host.receivedAt, snapshot: host,
      resourceControlRecords: host.resourceControlRecords, resourceLifecycleCursor: host.resourceLifecycleCursor, authorityReservations: host.authorityReservations}
    const hostBlocker = resourceHostBlocker(authority, now), laneBlocker = resourceLaneBlocker(host, lane.id, {...original, hostId: host.hostId})
    const placement = (!row.fleetTarget?.hostId || row.fleetTarget.hostId === host.hostId) && (!row.fleetTarget?.laneId || row.fleetTarget.laneId === lane.id)
    const source = host.frameworkBinding
    const conditions = [...structural.conditions,
      condition('target', 'placement', 'Frozen placement', placement ? 'match' : 'blocked',
        row.fleetTarget ? `${row.fleetTarget.hostId}/${row.fleetTarget.laneId ?? 'any lane'}` : 'Any enrolled compatible lane', `${host.hostId}/${lane.id}`),
      {...condition('fresh-report', 'lifecycle', 'Current accepted host report', hostBlocker ? 'unknown' : 'match', 'Accepted, nonfuture report at most 120 seconds old', hostBlocker?.code ?? 'Current accepted report'), observedAt: host.receivedAt},
      condition('automatic', 'placement', 'Dispatch mode', lane.dispatchMode === 'automatic' ? 'match' : 'blocked', 'automatic', lane.dispatchMode),
      condition('idle', 'ownership', 'Lane availability', lane.state === 'idle' ? 'match' : 'blocked', 'idle', lane.state),
      condition('lane-authority', 'ownership', 'Current lane claims and controls', laneBlocker ? 'blocked' : 'match', 'No foreign retained lane claim or restrictive operator action', laneBlocker?.code ?? 'No blocking lane claim/control'),
      condition('routine-api', 'source', 'Frozen routine API requirement', !source ? 'unknown' : source.routineApiVersion >= prepared.routineSource.minimumRoutineApiVersion ? 'match' : 'blocked',
        `Routine API >= ${prepared.routineSource.minimumRoutineApiVersion}`, source ? `Routine API ${source.routineApiVersion}; source ${source.revision}` : 'No accepted framework binding'),
      ...(row.fleetSelection.minimumFrameworkVersion === undefined ? [] : [condition('framework-floor', 'source', 'Explicit framework requirement', !source ? 'unknown' : source.version >= row.fleetSelection.minimumFrameworkVersion ? 'match' : 'blocked',
        `Framework >= ${row.fleetSelection.minimumFrameworkVersion}`, source ? `Framework ${source.version}` : 'No accepted framework binding')])]
    const resources = structural.resources.map(value => {
      const ref = lane.resources.find(ref => ref.id === value.resourceId), subject = host.resourceLifecycle?.subjects.find(subject => subject.subject.id === value.resourceId)
      const ordinary = ref && resourceBlocker(authority, ref.id, now, false, {...original, laneId: lane.id})
      const candidate = ref && resourceCandidateBlocker(authority, ref.id, now, {...original, laneId: lane.id})
      const claims = (host.authorityReservations ?? []).filter(claim => isExclusiveHostReservation(claim) ? claim.resourceId === value.resourceId :
        ref?.kind === 'recorder' && claim.hostId === host.hostId && claim.laneId === lane.id)
      const checks = [...value.conditions,
        ...(execution.resources.find(resource => resource.kind === value.kind)?.conditions.filter(row => row.id === 'backend-connectivity' || row.category === 'permission')
          .map(row => ({...row, id: `execution:${row.id}`, label: `Execution: ${row.label}`})) ?? []),
        condition('candidate-baseline', 'lifecycle', 'Current candidate baseline and custody', !ref ? 'unknown' : candidate ?
          ['resource-owned', 'resource-operator-restriction', 'resource-restoration-required'].includes(candidate.code) ? 'blocked' : 'unknown' : 'match',
          'Existing candidate predicate permits an owned current check', !ref ? 'No provider' : candidate?.code ?? 'Candidate baseline predicate passes'),
        condition('execution-baseline', 'physical', 'Current accepted return baseline', !ref ? 'unknown' : ordinary ?
          ordinary.code === 'resource-owned' ? 'blocked' : 'unknown' : 'match', 'Existing run predicate accepts current baseline, exact source and custody',
          ordinary?.code ?? (ref ? 'Current run baseline predicate passes' : 'No provider')),
        ...claims.map(claim => condition(`claim:${claim.id}`, 'ownership', 'Current authority claim',
          isExclusiveHostReservation(claim) ? claim.owner.kind === 'run' && claim.owner.id === original.requestId ? 'unknown' : 'blocked' :
            claim.requestId === original.requestId ? 'unknown' : 'blocked',
          'Retained original custody is not a new grant; full current authority remains with the existing reservation/CAS predicate', isExclusiveHostReservation(claim) ?
            `${claim.id}; ${claim.owner.kind}:${claim.owner.id}; authority ${claim.authorityHostId}; borrower ${claim.borrowerHostId}/${claim.laneId}` :
            `${claim.id}; run:${claim.requestId}; ${claim.hostId}/${claim.laneId}; pool ${claim.poolId}`))]
      if (subject) checks.push({...condition('reported-custody', 'ownership', 'Native reported resource state', subject.owner || subject.repair.state !== 'none' ? 'blocked' : subject.current ? 'match' : 'unknown',
        'Current original authority, reported owner and repair state are respected', `${subject.status}; generation ${subject.generation}; owner ${subject.owner ? `${subject.owner.kind}:${subject.owner.id}` : 'none'}; repair ${subject.repair.state}`),
        ...(subject.observedAt ? {observedAt: subject.observedAt} : {})})
      return {...value, conditions: checks, ...(subject ? {authorityHostId: subject.subject.authorityHostId,
        ...(subject.owner ? {owner: subject.owner} : {}), ...(subject.idle.report ? {physicalReport: subject.idle.report} : {})} : {})}
    })
    const graph = host.resourceReservations?.resourceReadiness === true ? routineResourceReadinessPurpose(host, lane, requirements, now, original) : undefined
    if (host.resourceReservations?.resourceReadiness === true) conditions.push(condition('candidate-resource-graph', 'lifecycle', 'Exact current resource graph', graph ? 'match' : 'unknown',
      'Existing graph predicate resolves every requested resource and its required dependencies', graph ? `${graph.resources.length} exact resource/dependency subjects` : 'Graph predicate refuses; inspect listed resource conditions and original stage logs for any unrecorded leaf'))
    // A per-lane report must not borrow another compatible lane on this same host.
    const candidateMatches = placement && !structural.blocker && !hostBlocker && !laneBlocker && lane.state === 'idle' && lane.dispatchMode === 'automatic' &&
      !routineJobRouting(requirements, [host], now, {hostId: host.hostId, laneId: lane.id}, row.fleetSelection.build, true, original).waitingReason &&
      conditions.filter(row => row.category === 'source').every(row => row.status === 'match')
    report.lanes.push({hostId: host.hostId, laneId: lane.id, platform: lane.platform, state: lane.state, dispatchMode: lane.dispatchMode,
      observedAt: host.receivedAt, candidateMatch: candidateMatches ? 'match' : hostBlocker ? 'unknown' : 'blocked',
      executionCompatibility: execution.blocker ? execution.resources.some(resource => resource.conditions.some(row => row.status === 'unknown')) ? 'unknown' : 'blocked' : 'match', conditions, resources})
    if (candidateMatches) report.summary.candidateLanes++
    if (placement && !structural.blocker) report.summary.structurallyCompatibleLanes++
  }
  report.summary.resources = requirements.resources.map(required => ({kind: required.kind,
    presentLanes: report.lanes.filter(lane => lane.platform === requirements.platform && lane.resources.some(resource => resource.kind === required.kind && resource.resourceId)).length,
    capabilityMatchingLanes: report.lanes.filter(lane => lane.platform === requirements.platform && lane.resources.some(resource => resource.kind === required.kind && resource.resourceId &&
      resource.conditions.filter(row => row.category === 'capability').every(row => row.status === 'match'))).length}))
  return report
}

export class TestRequestMatchService {
  constructor(private readonly hosts: Pick<TestHostStateService, 'list'> = new TestHostStateService(), private readonly now = Date.now) {}
  async get(requestId: string): Promise<TestRequestMatchReport> {
    if (!frameworkIdentitySchema.safeParse(requestId).success) throw new TestRunError(400, 'Invalid original request identity')
    const [row, hosts] = await Promise.all([
      TestRequestModel.findOne({requestId}).select({requestId: 1, state: 1, terminalStatus: 1, createdAt: 1, fleetSelection: 1, fleetSelectionSha256: 1,
        fleetPreparation: 1, fleetInputSha256: 1, fleetDeadline: 1, fleetTarget: 1, fleetBinding: 1, fleetCandidatePreparation: 1, fleetCandidateSelection: 1,
        fleetResourceAdmission: 1, fleetResourceReservation: 1, fleetCancellation: 1, fleetDispatch: 1, fleetPreparationStatus: 1, preparation: 1, dispatchCompletion: 1})
        .read('primary').readConcern('majority').lean(), this.hosts.list()])
    if (!row) throw new TestRunError(404, 'Original routine request was not found')
    return testRequestMatchReport(row as StoredRoutineJob, hosts, this.now())
  }
}
