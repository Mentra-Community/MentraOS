import {isDeepStrictEqual} from 'node:util'
import {backendConnectivityObservationMatches, backendConnectivityObservationSchema, candidatePrerequisiteSettlementSchema, BACKEND_CANDIDATE_ROUTINE_API_VERSION} from '../types/backend-connectivity.types'
import {fleetCandidatePreparationSchema, MAX_FLEET_CANDIDATE_PREPARATIONS, type FleetCandidatePreparation, type StoredRoutineJob} from '../types/routine-job.types'
import {exclusiveHostReservationSchema, exclusiveResourceReturnSchema, type ExclusiveResourceIntent} from '../types/resource-reservations.types'
import type {TestHostState} from './test-host-state.service'
import {permissionContext} from '../types/resource-permissions.types'
import {requestInputDigest} from './test-request.service'

/** Only the immediately preceding returned positive can be remeasured on the same pair. */
export function candidateRenewal(row: StoredRoutineJob, hostId: string, laneId: string) {
  const previous = row.fleetCandidatePreparations?.at(-1), selected = row.fleetCandidateSelection
  return previous?.settlement?.outcome === 'qualified' && previous.hostId === hostId && previous.laneId === laneId &&
    selected?.hostId === hostId && selected.laneId === laneId && selected.targetInputSha256 === previous.targetInputSha256 &&
    !row.fleetCandidatePreparation && !row.fleetBinding && !row.hostId && !row.dispatchIntent && !row.inputSha256 && !row.hostReceipt &&
    (!row.fleetResourceReservation || row.fleetResourceReservation.hostId === hostId && row.fleetResourceReservation.laneId === laneId) &&
    (!row.fleetResourceAdmission || row.fleetResourceAdmission.intent?.hostId === hostId && row.fleetResourceAdmission.intent.laneId === laneId) &&
    previous.claimReceipt && previous.returnReceipt ? previous : undefined
}

export function candidateReturnMatches(pending: FleetCandidatePreparation, value: unknown) {
  const claim = exclusiveHostReservationSchema.safeParse(pending.claimReceipt), returned = exclusiveResourceReturnSchema.safeParse(value)
  if (!claim.success || !returned.success || !('kind' in returned.data.release) || returned.data.release.kind !== 'resource-check') return false
  const c = claim.data, r = returned.data, release = r.release
  if (!('kind' in release) || release.kind !== 'resource-check') return false
  return c.prerequisite?.candidate && isDeepStrictEqual(c.prerequisite.candidate, pending.candidate) &&
    c.prerequisite.targetInputSha256 === pending.targetInputSha256 && isDeepStrictEqual(c.prerequisite.target, pending.backendTarget) &&
    c.authorityHostId === pending.hostId && c.borrowerHostId === pending.hostId && c.laneId === pending.laneId &&
    c.resourceId === pending.target.purpose?.resourceId && c.inputSha256 === pending.targetInputSha256 &&
    c.controllerIncarnation === pending.candidate.controller.incarnation && c.controllerGeneration === pending.candidate.controller.generation &&
    r.claimId === c.id && r.authorityHostId === c.authorityHostId && r.resourceId === c.resourceId &&
    r.intentSha256 === c.intentSha256 && r.inputSha256 === c.inputSha256 && r.laneId === c.laneId &&
    isDeepStrictEqual(r.originalOwner, c.owner) && release.operationId === c.operationId &&
    Date.parse(release.releasedAt) >= Date.parse(c.reservedAt) && r.controller.incarnation === c.controllerIncarnation &&
    r.controller.generation === c.controllerGeneration && r.controller.sequence > c.borrowerSequence
}

/** Historical metadata acknowledges only this host's exact consumed probe, never current reader authority. */
export function completedCandidatePreparationForHost(row: StoredRoutineJob, hostId: string) {
  const history = row.fleetCandidatePreparations, deadline = row.fleetDeadline?.getTime();
  if (!history?.length || history.length > MAX_FLEET_CANDIDATE_PREPARATIONS || !Number.isFinite(deadline) ||
    !row.fleetPreparation || requestInputDigest(row.fleetSelection) !== row.fleetSelectionSha256 ||
    requestInputDigest({selection: row.fleetSelection, prepared: row.fleetPreparation, deadline: row.fleetDeadline.toISOString(), target: row.fleetTarget ?? null}) !== row.fleetInputSha256) return false;
  const attempts = new Set<string>();
  for (const value of history) {
    const parsed = fleetCandidatePreparationSchema.safeParse(value);
    if (!parsed.success || attempts.has(parsed.data.candidate.attemptId)) return false;
    attempts.add(parsed.data.candidate.attemptId);
  }
  return history.some(value => value.hostId === hostId && value.target.hostId === hostId && value.target.laneId === value.laneId &&
    value.target.jobId === row.requestId && value.target.deadline === row.fleetDeadline.toISOString() &&
    Date.parse(value.candidate.requestedAt) < deadline! && value.candidate.fleetInputSha256 === row.fleetInputSha256 &&
    value.candidate.selectionSha256 === row.fleetSelectionSha256 && isDeepStrictEqual(value.target.candidate, value.candidate) &&
    value.target.inputSha256 === value.targetInputSha256 &&
    requestInputDigest((({inputSha256: _, ...target}) => target)(value.target)) === value.targetInputSha256 &&
    isDeepStrictEqual(value.target.selection, {...row.fleetSelection, routineSource: row.fleetPreparation!.routineSource}) &&
    isDeepStrictEqual(value.target.definition, row.fleetPreparation!.definition) &&
    value.target.definitionSha256 === row.fleetPreparation!.definitionSha256 && requestInputDigest(value.target.definition) === value.target.definitionSha256 &&
    Boolean(value.settlement && value.settlement.targetInputSha256 === value.targetInputSha256 &&
      isDeepStrictEqual(value.settlement.candidate, value.candidate)) &&
    row.fleetCandidatePreparation?.candidate.attemptId !== value.candidate.attemptId &&
    (value.settlement!.checkOperationId ? candidateReturnMatches(value, value.returnReceipt) &&
      value.settlement!.checkOperationId === `backend-prerequisite:${value.targetInputSha256}` :
      value.settlement!.outcome === 'unknown' && !value.backendTarget && !value.claimReceipt && !value.returnReceipt));
}

/** Pending preparation is request custody, before recorder/dependency/run admission. */
export function candidateRequestCurrent(row: StoredRoutineJob | null, pending: FleetCandidatePreparation | undefined, now: number, returningProvisional = false) {
  const provisional = pending?.provisionalReturn, returning = returningProvisional && provisional && !provisional.releasedAt &&
    isDeepStrictEqual(row?.fleetResourceReservation, provisional.recorder) && isDeepStrictEqual(row?.fleetResourceAdmission, provisional.admission) &&
    isDeepStrictEqual(row?.fleetExclusiveReservation, provisional.exclusive)
  if (!row || !pending || !fleetCandidatePreparationSchema.safeParse(pending).success || row.state !== 'awaiting-runner' ||
    row.fleetBinding || row.hostId || row.inputSha256 || row.hostReceipt || row.runId || row.dispatchCompletion ||
    row.fleetCandidateSelection || !returning && (row.fleetResourceAdmission || row.fleetResourceReservation || row.fleetExclusiveReservation) || row.fleetCancellation ||
    pending.provisionalReturn && !pending.provisionalReturn.releasedAt && !returning ||
    row.hostCancellation || row.preparationCancellation || row.hostRejection || row.preparationRejection ||
    !row.fleetPreparation || row.fleetDeadline.getTime() <= now ||
    pending.candidate.fleetInputSha256 !== row.fleetInputSha256 || pending.candidate.selectionSha256 !== row.fleetSelectionSha256 ||
    requestInputDigest(row.fleetSelection) !== row.fleetSelectionSha256 ||
    requestInputDigest({selection: row.fleetSelection, prepared: row.fleetPreparation, deadline: row.fleetDeadline.toISOString(), target: row.fleetTarget ?? null}) !== row.fleetInputSha256 ||
    pending.target.jobId !== row.requestId || pending.target.hostId !== pending.hostId || pending.target.laneId !== pending.laneId ||
    pending.target.deadline !== row.fleetDeadline.toISOString() || pending.target.inputSha256 !== pending.targetInputSha256 ||
    requestInputDigest((({inputSha256: _, ...target}) => target)(pending.target)) !== pending.targetInputSha256 ||
    !isDeepStrictEqual(pending.target.candidate, pending.candidate) ||
    !isDeepStrictEqual(pending.target.definition, row.fleetPreparation.definition) ||
    pending.target.definitionSha256 !== row.fleetPreparation.definitionSha256 ||
    requestInputDigest(pending.target.definition) !== pending.target.definitionSha256 ||
    row.fleetTarget && (row.fleetTarget.hostId !== pending.hostId || row.fleetTarget.laneId && row.fleetTarget.laneId !== pending.laneId)) return false
  return true
}
export function candidatePrerequisiteRequestMatches(row: StoredRoutineJob | null, intent: ExclusiveResourceIntent, now: number) {
  const pending = row?.fleetCandidatePreparation, purpose = intent.prerequisite
  return Boolean(purpose?.candidate && purpose.target && candidateRequestCurrent(row, pending, now) && pending &&
    isDeepStrictEqual(pending.candidate, purpose.candidate) && pending.hostId === intent.hostId && pending.laneId === intent.laneId &&
    pending.targetInputSha256 === purpose.targetInputSha256 && pending.target.purpose?.resourceId === purpose.resourceId &&
    isDeepStrictEqual(pending.target.acceptedBinding, purpose.binding) &&
    pending.candidate.controller.incarnation === intent.controller.incarnation && pending.candidate.controller.generation === intent.controller.generation &&
    (!pending.backendTarget || isDeepStrictEqual(pending.backendTarget, purpose.target)))
}
/** Raw-work closure is a current authenticated producer account, separate from phone return proof. */
export function candidateSettlement(pending: FleetCandidatePreparation, host: TestHostState, claims: unknown[], now: number) {
  const phoneId = pending.target.purpose!.resourceId, lane = host.lanes.find(value => value.id === pending.laneId),
    phone = lane?.resources.find(resource => resource.id === phoneId && resource.kind === 'phone'),
    subject = host.resourceLifecycle?.subjects.find(value => value.subject.id === phoneId),
    found = (host.resourceReservations?.candidatePrerequisites ?? []).filter(value =>
      value.candidate.attemptId === pending.candidate.attemptId)
  if (found.length !== 1 || !candidatePrerequisiteSettlementSchema.safeParse(found[0]).success ||
    host.hostId !== pending.hostId || host.incarnation !== pending.candidate.controller.incarnation ||
    host.incarnationGeneration !== pending.candidate.controller.generation ||
    !isDeepStrictEqual(host.frameworkBinding, pending.target.acceptedBinding) || !lane || lane.state !== 'idle' || lane.activity ||
    lane.dispatchMode !== 'automatic' || !phone || !subject?.current || subject.owner !== null ||
    subject.subject.authorityHostId !== pending.hostId || !isDeepStrictEqual(found[0]!.candidate, pending.candidate) ||
    found[0]!.targetInputSha256 !== pending.targetInputSha256 || claims.some(value => {
      const claim = value as {kind?: string; borrowerHostId?: string; laneId?: string; resourceId?: string}
      return claim.kind === 'exclusive' && (claim.resourceId === phoneId || claim.borrowerHostId === pending.hostId && claim.laneId === pending.laneId)
    })) return undefined
  const receipt = found[0]!
  if (receipt.outcome === 'unknown' && receipt.checkOperationId) return undefined
  if (!receipt.checkOperationId) return receipt.outcome === 'unknown' && !pending.backendTarget && !pending.claimReceipt && !pending.returnReceipt ? receipt : undefined
  const returned = exclusiveResourceReturnSchema.safeParse(pending.returnReceipt)
  if (!pending.backendTarget || !candidateReturnMatches(pending, pending.returnReceipt) || !returned.success || !('kind' in returned.data.release) || returned.data.release.kind !== 'resource-check' ||
    returned.data.release.operationId !== receipt.checkOperationId || receipt.checkOperationId !== `backend-prerequisite:${pending.targetInputSha256}` ||
    returned.data.inputSha256 !== pending.targetInputSha256 || returned.data.resourceId !== phoneId ||
    returned.data.laneId !== pending.laneId || returned.data.controller.incarnation !== host.incarnation ||
    returned.data.controller.generation !== host.incarnationGeneration || subject.generation !== returned.data.release.subjectGeneration) return undefined
  const parsedHealth = backendConnectivityObservationSchema.safeParse(phone.backendConnectivity),
    app = permissionContext(pending.target.acceptedBinding, pending.target.selection.build, now)?.app
  if (!parsedHealth.success || !app) return undefined
  const health = parsedHealth.data, qualification = health.qualification, observedAt = Date.parse(health.observedAt),
    closedAt = Date.parse(health.check.closedAt), releasedAt = Date.parse(returned.data.release.releasedAt)
  if (!qualification || !isDeepStrictEqual(health.binding, pending.target.acceptedBinding) ||
    !isDeepStrictEqual(health.controller, pending.candidate.controller) || !isDeepStrictEqual(health.app, app) ||
    health.phoneResourceId !== phoneId || health.outcome !== receipt.outcome || qualification.jobId !== pending.target.jobId ||
    qualification.targetInputSha256 !== pending.targetInputSha256 || !isDeepStrictEqual(qualification.candidate, pending.candidate) ||
    qualification.preparing || qualification.local || health.check.operationId !== receipt.checkOperationId ||
    !isDeepStrictEqual(health.target, pending.backendTarget) || qualification.inputSha256 !== requestInputDigest(pending.target.proposedInput) ||
    health.releasedGeneration !== subject.generation || observedAt < Date.parse(pending.candidate.requestedAt) ||
    observedAt > closedAt || closedAt > releasedAt || releasedAt > now || observedAt > Date.parse(pending.target.deadline) ||
    // A returned negative settles immutable history; only a current positive may select executable resources.
    receipt.outcome === 'qualified' && now - observedAt > 120_000) return undefined
  return receipt
}
/** Retained positive identity is necessary but never sufficient for current admission. */
function returnedCandidate(row: StoredRoutineJob, host: TestHostState, laneId: string) {
  if (row.fleetCandidatePreparation || !host.frameworkBinding || host.frameworkBinding.routineApiVersion < BACKEND_CANDIDATE_ROUTINE_API_VERSION) return undefined
  const pending = row.fleetCandidatePreparations?.at(-1)
  if (!pending?.settlement || pending.settlement.outcome !== 'qualified' || pending.hostId !== host.hostId || pending.laneId !== laneId ||
    !candidateReturnMatches(pending, pending.returnReceipt) || row.fleetCandidateSelection?.hostId !== host.hostId ||
    row.fleetCandidateSelection.laneId !== laneId || row.fleetCandidateSelection.targetInputSha256 !== pending.targetInputSha256 ||
    pending.candidate.fleetInputSha256 !== row.fleetInputSha256 || pending.candidate.selectionSha256 !== row.fleetSelectionSha256 ||
    pending.candidate.controller.incarnation !== host.incarnation || pending.candidate.controller.generation !== host.incarnationGeneration ||
    !isDeepStrictEqual(host.frameworkBinding, pending.target.acceptedBinding)) return undefined
  return pending
}
/** Authenticated receive time belongs to the repository envelope, never to the worker snapshot. */
export function qualifiedCandidate(row: StoredRoutineJob, host: TestHostState, laneId: string, now: number, receivedAt: string | Date) {
  const received = receivedAt instanceof Date ? receivedAt.getTime() : Date.parse(receivedAt), observed = Date.parse(host.observedAt),
    pending = returnedCandidate(row, host, laneId)
  if (!pending || !Number.isFinite(received) || received > now || now - received > 120_000 ||
    !Number.isFinite(observed) || observed > now || now - observed > 120_000) return undefined
  const phone = host.lanes.find(lane => lane.id === laneId)?.resources.find(value => value.id === pending.target.purpose!.resourceId),
    health = phone?.backendConnectivity
  if (!health || !isDeepStrictEqual(health.qualification?.candidate, pending.candidate) ||
    health.qualification?.jobId !== row.requestId || health.qualification.targetInputSha256 !== pending.targetInputSha256 ||
    !isDeepStrictEqual(health.target, pending.backendTarget) || pending.candidate.fleetInputSha256 !== row.fleetInputSha256 ||
    pending.candidate.selectionSha256 !== row.fleetSelectionSha256 || !isDeepStrictEqual(host.frameworkBinding, pending.target.acceptedBinding) ||
    !backendConnectivityObservationMatches(health, phone!.id, {...permissionContext(host.frameworkBinding, row.fleetSelection.build, now)!,
      backend: {hostId: host.hostId, incarnation: host.incarnation, generation: host.incarnationGeneration,
        resourceGenerations: host.resourceLifecycle?.subjects.map(subject => ({resourceId: subject.subject.id, generation: subject.generation,
          current: subject.current && subject.subject.authorityHostId === host.hostId, unowned: subject.owner === null})) ?? []}})) return undefined
  return pending
}
