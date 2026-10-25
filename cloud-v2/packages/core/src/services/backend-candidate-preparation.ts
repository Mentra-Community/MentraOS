import {isDeepStrictEqual} from 'node:util'
import {backendConnectivityObservationMatches, backendConnectivityObservationSchema, candidatePrerequisiteSettlementSchema, BACKEND_CANDIDATE_ROUTINE_API_VERSION} from '../types/backend-connectivity.types'
import {fleetCandidatePreparationSchema, MAX_FLEET_CANDIDATE_PREPARATIONS, type FleetCandidatePreparation, type StoredRoutineJob} from '../types/routine-job.types'
import {exclusiveHostReservationSchema, exclusiveResourceIntentSchema, exclusiveResourceReturnSchema, resourceReservationObservationSchema, type ExclusiveResourceIntent} from '../types/resource-reservations.types'
import {z} from 'zod'
import type {TestHostState} from './test-host-state.service'
import {permissionContext} from '../types/resource-permissions.types'
import {requestInputDigest} from './test-request.service'
import {graphReturnReporterMatches, graphReturnSuccessorMatches} from './graph-return-continuation'

export const graphCheckOperationId = (targetInputSha256: string, resourceId: string) =>
  `graph-check:${targetInputSha256}:${requestInputDigest(resourceId).slice(0, 24)}`
export const graphFinalCheckOperationId = (targetInputSha256: string, resourceId: string) =>
  `graph-final:${targetInputSha256}:${requestInputDigest(resourceId).slice(0, 24)}`
const graphMemberOperationMatches = (targetInputSha256: string, resourceId: string, operationId: string) =>
  operationId === graphCheckOperationId(targetInputSha256, resourceId) || operationId === graphFinalCheckOperationId(targetInputSha256, resourceId)
export function graphCandidateClaimMatches(pending: FleetCandidatePreparation, value: unknown) {
  const purpose = pending.target.purpose, parsed = exclusiveHostReservationSchema.safeParse(value)
  if (purpose?.kind !== 'resource-readiness' || !parsed.success) return false
  const claim = parsed.data, member = purpose.resources.find(resource => resource.id === claim.resourceId)
  return Boolean(member && claim.prerequisite?.kind === 'resource-readiness' && claim.resourceCheck &&
    claim.authorityHostId === member.authorityHostId && claim.authorityHostId === pending.hostId &&
    claim.borrowerHostId === pending.hostId && claim.laneId === pending.laneId &&
    claim.operationId === `graph-prerequisite:${pending.targetInputSha256}` && claim.inputSha256 === pending.targetInputSha256 &&
    claim.owner.kind === 'boundary-cleanup' && claim.owner.id === `resource-graph:${pending.targetInputSha256}` &&
    claim.controllerIncarnation === pending.candidate.controller.incarnation && claim.controllerGeneration === pending.candidate.controller.generation &&
    claim.prerequisite.jobId === pending.target.jobId && claim.prerequisite.targetInputSha256 === pending.targetInputSha256 &&
    isDeepStrictEqual(claim.prerequisite.candidate, pending.candidate) &&
    isDeepStrictEqual(claim.prerequisite.binding, pending.target.acceptedBinding) &&
    isDeepStrictEqual(claim.prerequisite.target, pending.backendTarget) &&
    isDeepStrictEqual(claim.prerequisite.resources, purpose.resources) &&
    claim.resourceCheck.resourceId === member.id && claim.resourceCheck.subjectGeneration === member.subjectGeneration &&
    claim.resourceCheck.contractVersion === member.contractVersion && claim.resourceCheck.deadlineAt === Date.parse(pending.target.deadline) &&
    isDeepStrictEqual(claim.resourceCheck.binding, pending.target.acceptedBinding) &&
    isDeepStrictEqual(claim.resourceCheck.controller, pending.candidate.controller))
}
export function graphCandidateReturnMatches(pending: FleetCandidatePreparation, value: unknown) {
  const parsed = exclusiveResourceReturnSchema.safeParse(value)
  if (!parsed.success || pending.target.purpose?.kind !== 'resource-readiness') return false
  const returned = parsed.data, claims = pending.resourceClaims ?? [], claim = claims.find(value => {
    const parsedClaim = exclusiveHostReservationSchema.safeParse(value)
    return parsedClaim.success && parsedClaim.data.id === returned.claimId
  }), parsedClaim = exclusiveHostReservationSchema.safeParse(claim)
  if (!parsedClaim.success || !graphCandidateClaimMatches(pending, parsedClaim.data) || !('kind' in returned.release)) return false
  const original = parsedClaim.data, release = returned.release
  return release.kind === 'resource-check' && graphMemberOperationMatches(pending.targetInputSha256, original.resourceId, release.operationId) &&
    returned.authorityHostId === original.authorityHostId && returned.resourceId === original.resourceId &&
    returned.intentSha256 === original.intentSha256 && returned.inputSha256 === original.inputSha256 &&
    returned.laneId === original.laneId && isDeepStrictEqual(returned.originalOwner, original.owner) &&
    (returned.controller.incarnation === original.controllerIncarnation && returned.controller.generation === original.controllerGeneration &&
      returned.controller.sequence > original.borrowerSequence || graphReturnSuccessorMatches(pending, returned)) &&
    release.subjectGeneration > original.resourceCheck!.subjectGeneration &&
    Date.parse(release.releasedAt) >= Date.parse(original.reservedAt)
}
export function graphCandidateNoAcquisitionMatches(pending: FleetCandidatePreparation, host?: TestHostState) {
  const purpose = pending.target.purpose, saved = pending.noAcquisitionReceipt as {
    intent?: ExclusiveResourceIntent; journal?: unknown; observation?: {status?: string; intentSha256?: string; claims?: unknown[];
      fence?: {hostId?: string; controller?: {incarnation?: string; generation?: number; sequence?: number};
        resourceReservationVersion?: number; subjects?: {resourceId: string; subjectGeneration: number}[]}}} | undefined
  if (purpose?.kind !== 'resource-readiness' || pending.resourceClaims?.length || pending.resourceReturns?.length || !saved?.intent ||
    !exclusiveResourceIntentSchema.safeParse(saved.intent).success || !candidatePrerequisiteIdentityMatches(pending, saved.intent) ||
    saved.intent.prerequisite?.kind !== 'resource-readiness' ||
    saved.intent.prerequisite.jobId !== pending.target.jobId || saved.intent.prerequisite.targetInputSha256 !== pending.targetInputSha256 ||
    !isDeepStrictEqual(saved.intent.prerequisite.candidate, pending.candidate) || !isDeepStrictEqual(saved.journal, pending.target) ||
    saved.observation?.status !== 'not-acquired' || saved.observation.claims?.length !== 0 ||
    saved.observation.fence?.hostId !== pending.hostId || saved.observation.fence.controller?.incarnation !== pending.candidate.controller.incarnation ||
    saved.observation.fence.controller.generation !== pending.candidate.controller.generation ||
    (saved.observation.fence.controller.sequence ?? -1) <= saved.intent.controller.sequence ||
    !isDeepStrictEqual(saved.observation.fence.subjects, purpose.resources.map(member => ({resourceId: member.id, subjectGeneration: member.subjectGeneration}))) ||
    !Number.isSafeInteger(saved.observation.fence.resourceReservationVersion) ||
    saved.observation.intentSha256 !== requestInputDigest({...saved.intent,
      controller: {incarnation: saved.intent.controller.incarnation, generation: saved.intent.controller.generation},
      dependencies: purpose.resources.map(member => ({resourceId: member.id, authorityHostId: member.authorityHostId, capability: 'resource-idle'}))})) return false
  return !host || purpose.resources.every(member => {
    const subject = host.resourceLifecycle?.subjects.find(value => value.subject.id === member.id)
    return subject?.current && subject.subject.authorityHostId === member.authorityHostId && subject.owner === null &&
      subject.generation === member.subjectGeneration
  })
}
/** A producer may close its original host-only phase before it ever creates an
 * acquisition intent. This does not stand in for an unanswered Core request. */
function graphCandidateNeverRequestedMatches(pending: FleetCandidatePreparation,
  settlement: NonNullable<FleetCandidatePreparation['settlement']>, host?: TestHostState) {
  const purpose = pending.target.purpose
  if (purpose?.kind !== 'resource-readiness' || settlement.neverRequested !== true || settlement.outcome !== 'unknown' ||
    !settlement.hostWorkSettled || settlement.graphChecks?.length !== 0 ||
    settlement.checkOperationId !== `graph-prerequisite:${pending.targetInputSha256}` ||
    pending.backendTarget || pending.claimReceipt || pending.returnReceipt || pending.resourceClaims || pending.resourceReturns ||
    pending.noAcquisitionReceipt || pending.provisionalReturn && !pending.provisionalReturn.releasedAt) return false
  if (!host) return true
  const lane = host.lanes.find(value => value.id === pending.laneId)
  return Boolean(lane && !lane.activity && purpose.resources.every(member => {
    const subject = host.resourceLifecycle?.subjects.find(value => value.subject.id === member.id),
      refs = [...host.resources ?? [], ...host.lanes.flatMap(value => value.resources)].filter(value => value.id === member.id), ref = refs[0]
    return subject?.current && subject.subject.authorityHostId === member.authorityHostId && subject.owner === null &&
      subject.generation === member.subjectGeneration &&
      ref?.kind === member.kind && ref.idleContract?.version === member.contractVersion &&
      member.capabilities.every(capability => ref.capabilities?.includes(capability)) &&
      refs.every(value => value.kind === ref.kind && isDeepStrictEqual(value.idleContract, ref.idleContract) &&
        isDeepStrictEqual(value.exclusiveDependencies, ref.exclusiveDependencies)) &&
      [...ref.idleContract.dependencies ?? [], ...subject.resource?.dependencies ?? []].every(id =>
        purpose.resources.some(value => value.id === id && value.authorityHostId === pending.hostId)) &&
      (ref.exclusiveDependencies ?? []).every(dependency => dependency.authorityHostId === pending.hostId &&
        purpose.resources.some(value => value.id === dependency.resourceId && value.authorityHostId === dependency.authorityHostId))
  }))
}
export function graphCandidateHistoricalSettlement(pending: FleetCandidatePreparation) {
  const purpose = pending.target.purpose, settlement = pending.settlement
  if (purpose?.kind !== 'resource-readiness' || !settlement || settlement.checkOperationId !== `graph-prerequisite:${pending.targetInputSha256}`) return false
  if (pending.resourceReturnContinuation && (settlement.outcome !== 'unknown' || !settlement.graphChecks?.length ||
    !settlement.graphChecks.every(check => check.outcome === 'unknown' && !check.backendConnectivity))) return false
  if (settlement.outcome === 'unknown' && !settlement.graphChecks?.length) return settlement.neverRequested
    ? graphCandidateNeverRequestedMatches(pending, settlement) : graphCandidateNoAcquisitionMatches(pending)
  return settlement.graphChecks?.length === purpose.resources.length && pending.resourceClaims?.length === purpose.resources.length &&
    pending.resourceReturns?.length === purpose.resources.length && pending.resourceClaims.every(value => graphCandidateClaimMatches(pending, value)) &&
    pending.resourceReturns.every(value => graphCandidateReturnMatches(pending, value)) &&
    new Set(pending.resourceReturns.map(value => exclusiveResourceReturnSchema.parse(value).resourceId)).size === purpose.resources.length &&
    settlement.graphChecks.every(check => purpose.resources.some(member => member.id === check.resourceId && member.contractVersion === check.contractVersion) &&
      graphMemberOperationMatches(pending.targetInputSha256, check.resourceId, check.checkOperationId))
}

/** A complete current owned phase, rather than simultaneous historical TTLs,
 * authorizes this same original's final binding. Every intervening generation,
 * owner, contract, source, cancellation or unknown-work change still refuses. */
export function qualifiedGraphCandidate(row: StoredRoutineJob, host: TestHostState, laneId: string, now: number, receivedAt: string | Date,
  requireDynamicFreshness = true) {
  const pending = row.fleetCandidatePreparations?.at(-1), purpose = pending?.target.purpose,
    received = receivedAt instanceof Date ? receivedAt.getTime() : Date.parse(receivedAt), observed = Date.parse(host.observedAt)
  if (!pending || pending.resourceReturnContinuation || purpose?.kind !== 'resource-readiness' || !fleetCandidatePreparationSchema.safeParse(pending).success ||
    pending.target.inputSha256 !== pending.targetInputSha256 ||
    requestInputDigest((({inputSha256: _, ...target}) => target)(pending.target)) !== pending.targetInputSha256 ||
    !isDeepStrictEqual(pending.candidate, pending.target.candidate) || row.fleetCandidatePreparation || requireDynamicFreshness && row.fleetCancellation ||
    requireDynamicFreshness && row.fleetDeadline.getTime() <= now || pending.settlement?.outcome !== 'qualified' || !pending.settlement.graphChecks ||
    row.fleetCandidateSelection?.hostId !== host.hostId || row.fleetCandidateSelection.laneId !== laneId ||
    row.fleetCandidateSelection.targetInputSha256 !== pending.targetInputSha256 || pending.hostId !== host.hostId || pending.laneId !== laneId ||
    pending.candidate.fleetInputSha256 !== row.fleetInputSha256 || pending.candidate.selectionSha256 !== row.fleetSelectionSha256 ||
    host.incarnation !== pending.candidate.controller.incarnation || host.incarnationGeneration !== pending.candidate.controller.generation ||
    !isDeepStrictEqual(host.frameworkBinding, pending.target.acceptedBinding) ||
    ![received, observed].every(at => Number.isFinite(at) && at <= now && now - at <= 120_000) || observed > received ||
    pending.resourceClaims?.length !== purpose.resources.length || pending.resourceReturns?.length !== purpose.resources.length ||
    pending.settlement.graphChecks.length !== purpose.resources.length ||
    !pending.resourceClaims.every(claim => graphCandidateClaimMatches(pending, claim)) ||
    !pending.resourceReturns.every(returned => graphCandidateReturnMatches(pending, returned))) return undefined
  const claims = pending.resourceClaims.map(value => exclusiveHostReservationSchema.parse(value)),
    returns = pending.resourceReturns.map(value => exclusiveResourceReturnSchema.parse(value)), checks = pending.settlement.graphChecks
  if (new Set(claims.map(value => value.resourceId)).size !== purpose.resources.length ||
    new Set(returns.map(value => value.resourceId)).size !== purpose.resources.length ||
    new Set(checks.map(value => value.resourceId)).size !== purpose.resources.length) return undefined
  for (const member of purpose.resources) {
    const check = checks.find(value => value.resourceId === member.id), returned = returns.find(value => value.resourceId === member.id),
      subject = host.resourceLifecycle?.subjects.find(value => value.subject.id === member.id),
      refs = [...host.resources ?? [], ...host.lanes.flatMap(value => value.resources)].filter(value => value.id === member.id), ref = refs[0]
    if (!check || !returned || !('kind' in returned.release) || returned.release.kind !== 'resource-check' ||
      !ref || ref.kind !== member.kind || member.capabilities.some(capability => !ref.capabilities?.includes(capability)) ||
      refs.some(value => value.kind !== ref.kind || !isDeepStrictEqual(value.idleContract, ref.idleContract) ||
        !isDeepStrictEqual(value.exclusiveDependencies, ref.exclusiveDependencies)) ||
      !subject?.current || !subject.resource || subject.subject.authorityHostId !== member.authorityHostId || subject.owner !== null ||
      subject.repair.state !== 'none' || !(subject.status === 'idle' && subject.idle.outcome === 'passed' ||
        subject.status === 'unknown' && subject.idle.outcome === 'unknown' && subject.reason?.code === 'idle-check-required') ||
      check.outcome !== 'passed' || !graphMemberOperationMatches(pending.targetInputSha256, member.id, check.checkOperationId) ||
      check.subjectGeneration !== subject.generation || check.subjectGeneration !== returned.release.subjectGeneration ||
      check.contractVersion !== member.contractVersion || ref?.idleContract?.version !== member.contractVersion ||
      subject.idle.contractVersion !== member.contractVersion || !isDeepStrictEqual(subject.idle.qualifiedScope, ref.idleContract.qualifiedScope) ||
      subject.idle.qualifiedScope.kind === 'unqualified' || subject.idle.acceptedCheck?.operationId !== check.checkOperationId ||
      subject.idle.acceptedCheck.subjectGeneration !== subject.generation || subject.idle.acceptedCheck.resultSha256 !== check.resultSha256 ||
      subject.idle.checkedAt !== check.checkedAt || Date.parse(check.checkedAt) < Date.parse(pending.candidate.requestedAt) ||
      Date.parse(check.checkedAt) > Date.parse(returned.release.releasedAt) || Date.parse(returned.release.releasedAt) > now ||
      requireDynamicFreshness && Date.parse(returned.release.releasedAt) > Date.parse(pending.target.deadline)) return undefined
    const dependencies = [...ref.idleContract.dependencies ?? [], ...subject.resource.dependencies]
    if (dependencies.some(id => !purpose.resources.some(resource => resource.id === id && resource.authorityHostId === host.hostId)) ||
      ref.exclusiveDependencies?.some(dependency => dependency.authorityHostId !== host.hostId ||
        !purpose.resources.some(resource => resource.id === dependency.resourceId && resource.authorityHostId === dependency.authorityHostId))) return undefined
    const liveGlasses = host.lanes.some(lane => lane.glasses?.some(value => value.resourceId === member.id && value.model === 'mentra-live'))
    if (requireDynamicFreshness && (member.kind === 'phone' || liveGlasses) &&
      (now - Date.parse(check.checkedAt) > (ref.idleContract.maximumAgeMs ?? 120_000) ||
        check.checkOperationId !== graphFinalCheckOperationId(pending.targetInputSha256, member.id))) return undefined
  }
  if (pending.target.requirements.resources.some(value => value.kind === 'phone' && value.capabilities.includes('backend-connectivity'))) {
    const member = purpose.resources.find(value => value.kind === 'phone'),
      phone = member && host.lanes.find(value => value.id === laneId)?.resources.find(value => value.id === member.id),
      parsed = backendConnectivityObservationSchema.safeParse(checks.find(value => value.resourceId === member?.id)?.backendConnectivity ?? phone?.backendConnectivity),
      app = permissionContext(pending.target.acceptedBinding, pending.target.selection.build, now)?.app
    if (!member || !phone || !parsed.success || !app || !pending.backendTarget) return undefined
    const health = parsed.data
    if (health.outcome !== 'qualified' || !isDeepStrictEqual(health.qualification?.candidate, pending.candidate) ||
      health.qualification?.jobId !== pending.target.jobId || health.qualification.targetInputSha256 !== pending.targetInputSha256 ||
      health.qualification.inputSha256 !== requestInputDigest(pending.target.proposedInput) || !isDeepStrictEqual(health.target, pending.backendTarget) ||
      !isDeepStrictEqual(health.binding, pending.target.acceptedBinding) || !isDeepStrictEqual(health.app, app) ||
      !isDeepStrictEqual(health.controller, pending.candidate.controller) || health.phoneResourceId !== member.id ||
      health.check.operationId !== graphFinalCheckOperationId(pending.targetInputSha256, member.id) ||
      health.releasedGeneration !== checks.find(value => value.resourceId === member.id)?.subjectGeneration ||
      Date.parse(health.observedAt) < Date.parse(pending.candidate.requestedAt) || Date.parse(health.observedAt) > Date.parse(health.check.closedAt) ||
      Date.parse(health.check.closedAt) > Date.parse(pending.target.deadline) || requireDynamicFreshness &&
      !backendConnectivityObservationMatches(health, member.id, {now, binding: pending.target.acceptedBinding!, app,
        backend: {hostId: host.hostId, incarnation: host.incarnation, generation: host.incarnationGeneration,
          resourceGenerations: host.resourceLifecycle?.subjects.map(subject => ({resourceId: subject.subject.id, generation: subject.generation,
            current: subject.current && subject.subject.authorityHostId === host.hostId, unowned: subject.owner === null})) ?? []}})) return undefined
  }
  return pending
}

/** Only the immediately preceding returned positive can be remeasured on the same pair. */
export function candidateRenewal(row: StoredRoutineJob, hostId: string, laneId: string) {
  const previous = row.fleetCandidatePreparations?.at(-1), selected = row.fleetCandidateSelection
  return previous?.settlement?.outcome === 'qualified' && previous.hostId === hostId && previous.laneId === laneId &&
    selected?.hostId === hostId && selected.laneId === laneId && selected.targetInputSha256 === previous.targetInputSha256 &&
    !row.fleetCandidatePreparation && !row.fleetBinding && !row.hostId && !row.dispatchIntent && !row.inputSha256 && !row.hostReceipt &&
    (!row.fleetResourceReservation || row.fleetResourceReservation.hostId === hostId && row.fleetResourceReservation.laneId === laneId) &&
    (!row.fleetResourceAdmission || row.fleetResourceAdmission.intent?.hostId === hostId && row.fleetResourceAdmission.intent.laneId === laneId) &&
    (previous.target.purpose?.kind === 'resource-readiness' ? graphCandidateHistoricalSettlement(previous) :
      previous.claimReceipt && previous.returnReceipt) ? previous : undefined
}

export function candidateReturnMatches(pending: FleetCandidatePreparation, value: unknown) {
  if (pending.target.purpose?.kind === 'resource-readiness') return graphCandidateReturnMatches(pending, value)
  const claim = exclusiveHostReservationSchema.safeParse(pending.claimReceipt), returned = exclusiveResourceReturnSchema.safeParse(value)
  if (!claim.success || !returned.success || !('kind' in returned.data.release)) return false
  const c = claim.data, r = returned.data, release = r.release
  if (!('kind' in release) || release.kind === 'resource-check-not-started' && !isDeepStrictEqual(c.resourceCheck, release.resourceCheck)) return false
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
/** Core acknowledges immutable no-reader settlement without inventing a local check. */
export function candidateNeverBegan(pending: FleetCandidatePreparation, journal: NonNullable<NonNullable<TestHostState['resourceReservations']>['resourceChecks']>[number] | undefined) {
  if (!journal || journal.state !== 'never-began' || !journal.eventId || journal.operationId !== `backend-prerequisite:${pending.targetInputSha256}` ||
    journal.resourceId !== pending.target.purpose?.resourceId || journal.intent.hostId !== pending.hostId || journal.intent.laneId !== pending.laneId ||
    journal.intent.inputSha256 !== pending.targetInputSha256 || !journal.intent.resourceCheck || !journal.intent.prerequisite?.candidate ||
    !isDeepStrictEqual(journal.intent.prerequisite.candidate, pending.candidate) || journal.intent.prerequisite.jobId !== pending.target.jobId ||
    journal.intent.prerequisite.targetInputSha256 !== pending.targetInputSha256 || !isDeepStrictEqual(journal.resourceCheck, journal.intent.resourceCheck) ||
    journal.intent.owner.id !== `resource-check:${requestInputDigest({operationId:journal.operationId,resourceId:journal.resourceId})}` ||
    !isDeepStrictEqual(journal.intent.prerequisite.binding, pending.target.acceptedBinding) ||
    pending.backendTarget && !isDeepStrictEqual(journal.intent.prerequisite.target, pending.backendTarget) ||
    !isDeepStrictEqual(journal.resourceCheck.binding, pending.target.acceptedBinding) || !isDeepStrictEqual(journal.resourceCheck.controller, pending.candidate.controller) ||
    journal.resourceCheck.deadlineAt > Date.parse(pending.target.deadline) || Date.parse(journal.observedAt) < Date.parse(pending.candidate.requestedAt) ||
    journal.intent.controller.incarnation !== pending.candidate.controller.incarnation || journal.intent.controller.generation !== pending.candidate.controller.generation ||
    requestInputDigest({...journal.intent, controller: journal.resourceCheck.controller, dependencies: [{resourceId: journal.resourceId,
      authorityHostId: pending.hostId, capability: 'backend-connectivity'}]}) !== journal.intentSha256) return false
  if (pending.claimReceipt || pending.returnReceipt) {
    const returned = exclusiveResourceReturnSchema.safeParse(pending.returnReceipt)
    return Boolean(candidateReturnMatches(pending, pending.returnReceipt) && returned.success && 'kind' in returned.data.release &&
      returned.data.release.kind === 'resource-check-not-started' && returned.data.release.eventId === journal.eventId &&
      returned.data.release.releasedAt === journal.observedAt && returned.data.intentSha256 === journal.intentSha256)
  }
  const parsed = z.object({intent: exclusiveResourceIntentSchema, journal: z.unknown(), observation: z.object({status: z.literal('not-acquired'), intentSha256: z.string(),
    claims: z.array(z.unknown()).length(0), fence: z.object({hostId:z.string(),resourceId:z.string(),resourceReservationVersion:z.number().int().positive(),
      subjectGeneration:z.number().int().nonnegative(),controller:z.object({incarnation:z.string(),generation:z.number().int().positive(),sequence:z.number().int().nonnegative()}).strict()}).strict()}).strict()}).strict().safeParse(pending.noAcquisitionReceipt)
  return Boolean(parsed.success && (pending.backendTarget === undefined || isDeepStrictEqual(pending.backendTarget, journal.intent.prerequisite.target)) &&
    isDeepStrictEqual(parsed.data.journal, journal) && isDeepStrictEqual(parsed.data.intent, journal.intent) &&
    parsed.data.observation.intentSha256 === journal.intentSha256 && parsed.data.observation.fence.hostId === pending.hostId &&
    parsed.data.observation.fence.resourceId === journal.resourceId && parsed.data.observation.fence.controller.incarnation === pending.candidate.controller.incarnation &&
    parsed.data.observation.fence.controller.generation === pending.candidate.controller.generation &&
    parsed.data.observation.fence.controller.sequence > journal.intent.controller.sequence)
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
    (value.target.purpose?.kind === 'resource-readiness' ? graphCandidateHistoricalSettlement(value) :
      value.settlement!.checkOperationId ? (candidateReturnMatches(value, value.returnReceipt) ||
      value.settlement!.outcome === 'unknown' && (() => {
        const saved = value.noAcquisitionReceipt as {journal?: unknown} | undefined,
          parsed = resourceReservationObservationSchema.innerType().shape.resourceChecks.unwrap().element.safeParse(saved?.journal)
        return parsed.success && candidateNeverBegan(value, parsed.data)
      })()) && value.settlement!.checkOperationId === `backend-prerequisite:${value.targetInputSha256}` :
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
  return candidateRequestCurrent(row, row?.fleetCandidatePreparation, now) && candidatePrerequisiteIdentityMatches(row!.fleetCandidatePreparation, intent)
}
/** Retained identity also fences a negative observation after its execution deadline. */
export function candidatePrerequisiteIdentityMatches(pending: FleetCandidatePreparation | undefined, intent: ExclusiveResourceIntent) {
  const purpose = intent.prerequisite
  return Boolean(purpose?.candidate && (purpose.kind === 'resource-readiness' || purpose.target) && pending &&
    isDeepStrictEqual(pending.candidate, purpose.candidate) && pending.hostId === intent.hostId && pending.laneId === intent.laneId &&
    pending.targetInputSha256 === purpose.targetInputSha256 && pending.target.purpose?.resourceId === purpose.resourceId &&
    isDeepStrictEqual(pending.target.acceptedBinding, purpose.binding) &&
    pending.candidate.controller.incarnation === intent.controller.incarnation && pending.candidate.controller.generation === intent.controller.generation &&
    (purpose.kind === 'resource-readiness' ? pending.target.purpose?.kind === 'resource-readiness' &&
      intent.operationId === `graph-prerequisite:${pending.targetInputSha256}` && intent.owner.id === `resource-graph:${pending.targetInputSha256}` &&
      isDeepStrictEqual(pending.target.purpose.resources, purpose.resources) &&
      (!pending.backendTarget || isDeepStrictEqual(pending.backendTarget, purpose.target)) :
      (!pending.backendTarget || isDeepStrictEqual(pending.backendTarget, purpose.target))))
}
export function reportedGraphCandidateSettlement(pending: FleetCandidatePreparation, host: TestHostState) {
  if (pending.target.purpose?.kind !== 'resource-readiness') return undefined
  const found = (host.resourceReservations?.candidatePrerequisites ?? []).filter(value => value.candidate.attemptId === pending.candidate.attemptId), receipt = found[0]
  if (found.length !== 1 || !receipt || !candidatePrerequisiteSettlementSchema.safeParse(receipt).success ||
    !isDeepStrictEqual(receipt.candidate, pending.candidate) || receipt.targetInputSha256 !== pending.targetInputSha256 ||
    receipt.checkOperationId !== `graph-prerequisite:${pending.targetInputSha256}` ||
    requestInputDigest((({inputSha256: _, ...target}) => target)(pending.target)) !== pending.targetInputSha256 ||
    host.hostId !== pending.hostId) return undefined
  const original = host.incarnation === pending.candidate.controller.incarnation &&
    host.incarnationGeneration === pending.candidate.controller.generation && isDeepStrictEqual(host.frameworkBinding, pending.target.acceptedBinding)
  if (!original && !(receipt.outcome === 'unknown' && receipt.graphChecks?.length &&
    receipt.graphChecks.every(check => check.outcome === 'unknown' && !check.backendConnectivity) && graphReturnReporterMatches(pending, host))) return undefined
  return receipt
}
export function graphCandidateHasOriginalCustody(pending: FleetCandidatePreparation, host: TestHostState, claims: unknown[]) {
  const ownerId = `resource-graph:${pending.targetInputSha256}`, originalOwner = (id?: string) => id === ownerId || id === pending.target.jobId
  return claims.some(value => {const claim = value as {owner?: {id?: string}; requestId?: string; operationId?: string; inputSha256?: string;
    prerequisite?: {jobId?: string; targetInputSha256?: string; candidate?: {attemptId?: string}}}
    return !claim || originalOwner(claim.owner?.id) || claim.requestId === pending.target.jobId ||
      claim.operationId === `graph-prerequisite:${pending.targetInputSha256}` || claim.inputSha256 === pending.targetInputSha256 ||
      claim.prerequisite?.jobId === pending.target.jobId || claim.prerequisite?.targetInputSha256 === pending.targetInputSha256 ||
      claim.prerequisite?.candidate?.attemptId === pending.candidate.attemptId}) ||
    !!host.resourceLifecycle?.subjects.some(subject => originalOwner(subject.owner?.id)) ||
    host.lanes.some(lane => originalOwner(lane.activity?.owner.id) || lane.activity?.owner.requestId === pending.target.jobId)
}
/** Raw-work closure is a current authenticated producer account, separate from phone return proof. */
export function candidateSettlement(pending: FleetCandidatePreparation, host: TestHostState, claims: unknown[], now: number) {
  if (pending.target.purpose?.kind === 'resource-readiness') {
    const purpose = pending.target.purpose, receipt = reportedGraphCandidateSettlement(pending, host)
    if (!receipt) return undefined
    if (receipt.outcome === 'unknown' && !receipt.graphChecks?.length) {
      // A contradictory partial original claim still represents custody. A
      // different graph's occupancy cannot invalidate authenticated no-work history.
      if (graphCandidateHasOriginalCustody(pending, host, claims)) return undefined
      return (receipt.neverRequested ? graphCandidateNeverRequestedMatches(pending, receipt) : graphCandidateNoAcquisitionMatches(pending)) ? receipt : undefined
    }
    if (claims.some(value => {const claim = value as {kind?: string; borrowerHostId?: string; laneId?: string; resourceId?: string}
      return claim.kind === 'exclusive' && (purpose.resources.some(member => member.id === claim.resourceId) ||
        claim.borrowerHostId === pending.hostId && claim.laneId === pending.laneId)})) return undefined
    if (!receipt.graphChecks || receipt.graphChecks.length !== purpose.resources.length ||
      pending.resourceClaims?.length !== purpose.resources.length || pending.resourceReturns?.length !== purpose.resources.length ||
      !pending.resourceClaims.every(claim => graphCandidateClaimMatches(pending, claim)) ||
      !pending.resourceReturns.every(returned => graphCandidateReturnMatches(pending, returned))) return undefined
    if (receipt.outcome !== (receipt.graphChecks.some(check => check.outcome === 'unknown' || check.backendConnectivity?.outcome === 'unknown') ? 'unknown' :
      receipt.graphChecks.some(check => check.outcome === 'failed' || check.backendConnectivity?.outcome === 'unqualified') ? 'unqualified' : 'qualified')) return undefined
    for (const member of purpose.resources) {
      const check = receipt.graphChecks.find(value => value.resourceId === member.id),
        returned = pending.resourceReturns.map(value => exclusiveResourceReturnSchema.parse(value)).find(value => value.resourceId === member.id),
        subject = host.resourceLifecycle?.subjects.find(value => value.subject.id === member.id)
      if (!check || !returned || !('kind' in returned.release) || returned.release.kind !== 'resource-check' ||
        !graphMemberOperationMatches(pending.targetInputSha256, member.id, check.checkOperationId) || check.contractVersion !== member.contractVersion ||
        !subject?.current || subject.owner !== null || subject.generation !== check.subjectGeneration ||
        subject.generation !== returned.release.subjectGeneration || subject.idle.acceptedCheck?.operationId !== check.checkOperationId ||
        subject.idle.acceptedCheck.resultSha256 !== check.resultSha256 || subject.idle.acceptedCheck.subjectGeneration !== subject.generation ||
        subject.idle.checkedAt !== check.checkedAt || Date.parse(check.checkedAt) < Date.parse(pending.candidate.requestedAt) ||
        Date.parse(check.checkedAt) > Date.parse(returned.release.releasedAt)) return undefined
      if (check.backendConnectivity) {
        const health = check.backendConnectivity, app = permissionContext(pending.target.acceptedBinding, pending.target.selection.build, now)?.app
        if (member.kind !== 'phone' || !member.capabilities.includes('backend-connectivity') || !pending.backendTarget || !app ||
          health.phoneResourceId !== member.id || !isDeepStrictEqual(health.binding, pending.target.acceptedBinding) ||
          !isDeepStrictEqual(health.controller, pending.candidate.controller) || !isDeepStrictEqual(health.app, app) ||
          !isDeepStrictEqual(health.target, pending.backendTarget) || health.qualification?.jobId !== pending.target.jobId ||
          health.qualification.targetInputSha256 !== pending.targetInputSha256 ||
          health.qualification.inputSha256 !== requestInputDigest(pending.target.proposedInput) ||
          !isDeepStrictEqual(health.qualification.candidate, pending.candidate) || health.qualification.preparing || health.qualification.local ||
          health.check.operationId !== check.checkOperationId || health.releasedGeneration !== check.subjectGeneration ||
          Date.parse(health.observedAt) < Date.parse(pending.candidate.requestedAt) || Date.parse(health.observedAt) > Date.parse(pending.target.deadline) ||
          Date.parse(health.observedAt) > Date.parse(health.check.closedAt) || Date.parse(health.check.closedAt) > Date.parse(returned.release.releasedAt) ||
          Date.parse(returned.release.releasedAt) > now) return undefined
      }
    }
    const temporary = {...pending, settlement: receipt}, current = {fleetCandidatePreparations: [temporary],
      fleetCandidateSelection: {hostId: pending.hostId, laneId: pending.laneId, targetInputSha256: pending.targetInputSha256},
      fleetInputSha256: pending.candidate.fleetInputSha256, fleetSelectionSha256: pending.candidate.selectionSha256,
      fleetDeadline: new Date(pending.target.deadline)} as StoredRoutineJob
    if (receipt.outcome === 'qualified' && !qualifiedGraphCandidate(current, host, pending.laneId, now, host.observedAt, false)) return undefined
    return receipt
  }
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
  if (receipt.outcome === 'unknown' && receipt.checkOperationId) {
    const journal = host.resourceReservations?.resourceChecks?.find(value => value.operationId === receipt.checkOperationId)
    if (journal && Date.parse(journal.observedAt) <= now && Date.parse(journal.observedAt) <= Date.parse(host.observedAt) &&
      candidateNeverBegan(pending, journal)) return receipt
    // A closed UNKNOWN read still needs every ordinary exact-return check below.
  }
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
    observedAt > closedAt || closedAt > releasedAt || releasedAt > now || observedAt > Date.parse(pending.target.deadline)) return undefined
  // Exact returned observations settle immutable history at any age. Current
  // qualifiedCandidate checks independently fence resource admission and renewal.
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
  if (row.fleetCandidatePreparations?.at(-1)?.target.purpose?.kind === 'resource-readiness')
    return qualifiedGraphCandidate(row, host, laneId, now, receivedAt)
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
