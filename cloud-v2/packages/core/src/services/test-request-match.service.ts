import {TestRequestModel} from '../models/test-request.model'
import {frameworkIdentitySchema} from '../types/framework-request.types'
import type {StoredRoutineJob} from '../types/routine-job.types'
import type {MatchCondition, MatchStatus, TestRequestMatchReport} from '../types/test-request-match.types'
import {isExclusiveHostReservation} from '../types/resource-reservations.types'
import {TestHostStateService, type RoutingTestHostState} from './test-host-state.service'
import {TestRunError} from './test-result-error'
import {pendingQueueItem} from './test-pending-queue.service'
import {evaluateRoutineLaneReadiness} from './routine-lane-eligibility'
import {routineLaneContext} from './routine-job.service'

const condition = (id: string, category: MatchCondition['category'], label: string, status: MatchStatus, expected: string, observed: string): MatchCondition =>
  ({id, category, label, status, expected, observed})

/** Exact original + current enrolled offers. No preparation, reservation, reconciliation or GitHub calls. */
export function testRequestMatchReport(row: StoredRoutineJob, hosts: RoutingTestHostState[], now: number): TestRequestMatchReport {
  const item = pendingQueueItem(row, hosts, now), prepared = item.compatibilityKnown ? row.fleetPreparation : undefined
  const selected = row.fleetBinding ?? row.fleetCandidatePreparation ?? row.fleetResourceAdmission?.intent ?? row.fleetResourceReservation
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
      'Unavailable observations name the existing Check or repair action; a missing observation does not prove physical failure. Existing original checks still require authentic return.',
      'Recorder storage uses the frozen effective budget and reported reservations; later atomic capacity accounting can still refuse.',
      'This read uses the original request and current enrolled host reports only. It does not refresh devices or scan request/history records.']}
  if (!prepared) return report
  const requirements = prepared.requirements, original = {requestId: row.requestId, inputSha256: row.fleetInputSha256!, executionInputSha256: row.inputSha256}
  report.requirements = {effective: requirements, declaredResources: prepared.definition.resourceRequirements,
    human: prepared.definition.requirements, minimumRoutineApiVersion: prepared.routineSource.minimumRoutineApiVersion,
    ...(row.fleetSelection.minimumFrameworkVersion === undefined ? {} : {minimumFrameworkVersion: row.fleetSelection.minimumFrameworkVersion}),
    ...(typeof prepared.definition.execution?.policy?.estimatedOutputBytes === 'number' ? {estimatedOutputBytes: prepared.definition.execution.policy.estimatedOutputBytes} : {}),
    ...(row.fleetTarget ? {target: row.fleetTarget} : {})}
  for (const host of hosts) for (const lane of host.lanes) {
    const current = evaluateRoutineLaneReadiness(requirements, host, lane, routineLaneContext(host, row.fleetSelection.build, now), now, original, {
      minimumRoutineApiVersion: prepared.routineSource.minimumRoutineApiVersion,
      minimumFrameworkVersion: row.fleetSelection.minimumFrameworkVersion, target: row.fleetTarget,
      deadline: row.fleetDeadline, cancelled: Boolean(row.fleetCancellation),
    })
    const resources = current.resources.map(value => {
      const subject = host.resourceLifecycle?.subjects.find(subject => subject.subject.id === value.resourceId),
        ref = lane.resources.find(ref => ref.id === value.resourceId),
        claims = (host.authorityReservations ?? []).filter(claim => isExclusiveHostReservation(claim) ? claim.resourceId === value.resourceId :
          ref?.kind === 'recorder' && claim.hostId === host.hostId && claim.laneId === lane.id)
      return {...value, ...(subject ? {authorityHostId: subject.subject.authorityHostId,
        ...(subject.owner ? {owner: subject.owner} : {}), ...(subject.idle.report ? {physicalReport: subject.idle.report} : {})} : {}),
        conditions: [...value.conditions, ...claims.map(claim => condition(`claim:${claim.id}`, 'ownership', 'Current authority claim',
          isExclusiveHostReservation(claim) ? claim.owner.kind === 'run' && claim.owner.id === original.requestId &&
            claim.origin?.kind === 'fleet' && claim.origin.fleetInputSha256 === original.inputSha256 && claim.inputSha256 === original.inputSha256 &&
            claim.borrowerHostId === host.hostId && claim.laneId === lane.id && claim.operationId === `run:${original.requestId}` ? 'match' : 'blocked' :
            claim.requestId === original.requestId && claim.fleetInputSha256 === original.inputSha256 ? 'match' : 'blocked',
          'Exact original claim only; atomic custody validation remains authoritative', isExclusiveHostReservation(claim) ?
            `${claim.id}; ${claim.owner.kind}:${claim.owner.id}; authority ${claim.authorityHostId}; borrower ${claim.borrowerHostId}/${claim.laneId}` :
            `${claim.id}; run:${claim.requestId}; ${claim.hostId}/${claim.laneId}; pool ${claim.poolId}`))]}
    })
    const all = [...current.conditions, ...current.resources.flatMap(resource => resource.conditions)],
      status: MatchStatus = current.ready ? 'match' : all.some(condition => condition.status === 'blocked') ? 'blocked' : 'unknown'
    // Compatibility fields retain their public shape but describe one verdict.
    // The dispatcher consumes this same current checklist, with no candidate probe.
    report.lanes.push({hostId: host.hostId, laneId: lane.id, platform: lane.platform, state: lane.state, dispatchMode: lane.dispatchMode,
      observedAt: host.receivedAt, candidateMatch: status, executionCompatibility: status, conditions: current.conditions, resources})
    if (current.ready) {report.summary.candidateLanes++; report.summary.structurallyCompatibleLanes++}
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
