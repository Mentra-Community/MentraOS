import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {TestHostStateModel} from '../models/test-host-state.model'
import {testWriteConcern} from '../models/test-write-concern'
import {exclusiveResourceIntentSchema, exclusiveResourceObservationInputSchema, exclusiveResourceReturnSchema, hostResourceReservationsSchema,
  fleetExclusiveObservationSchema, fleetExclusiveReservationSchema, fleetExclusiveExecutionBindingSchema, fleetResourceAdmissionSchema,
  isExclusiveHostReservation, type ExclusiveHostReservation, type ExclusiveResourceDependency, type ExclusiveResourceIntent,
  type FleetExclusiveReservation, type FleetResourceAdmission, type HostResourceReservation, type ExclusiveResourceReturn} from '../types/resource-reservations.types'
import {hostStateSchema, type TestHostState} from './test-host-state.service'
import {requestInputDigest} from './test-request.service'
import {TestRunError} from './test-result-error'
import {TestRequestModel} from '../models/test-request.model'
import {assertFleetResourceAdmission, fleetResourceExecutionBinding} from './fleet-resource-binding'
import {frameworkRequestInputSchema} from '../types/framework-request.types'
import {routineQualificationTargetSchema, MAX_FLEET_CANDIDATE_PREPARATIONS, type StoredRoutineJob, type OwnedRoutineQualification, type RoutineQualificationTarget, type FleetCandidatePreparation} from '../types/routine-job.types'
import {preparationRejectionSchema} from '../types/routine-dispatch.types'
import {z} from 'zod'
import {BACKEND_CONNECTIVITY_ROUTINE_API_VERSION} from '../types/backend-connectivity.types'
import {currentGraphReturnContinuation} from './graph-return-continuation'
import {candidatePrerequisiteRequestMatches, qualifiedCandidate, candidateReturnMatches, qualifiedGraphCandidate,
  graphCandidateClaimMatches, graphCandidateReturnMatches, graphCandidateHasOriginalCustody, graphCandidateNoAcquisitionMatches,
  candidatePrerequisiteIdentityMatches, reportedGraphCandidateSettlement, completedCandidatePreparationForHost} from './backend-candidate-preparation'
import type {RecorderHostReservation} from '../types/recorder-storage.types'
import {resourceAvailable, resourceBlocker, resourceCandidateBlocker, resourceLaneBlocker, requiredResourceBlocker, type ResourceReadinessBlocker} from './resource-readiness'
import {laneControlRecordSchema, resourceControlRecordSchema, type ResourceControlRecord} from '../types/lane-control.types'
import {manualWithdrawalNeedsRestoration} from '../types/resource-control-authority'

/** A phone check and ordinary preparation must not queue conflicting owners on one physical Android lane. */
export function requiresSerializedAndroidPreparation(lane: TestHostState['lanes'][number]) {
  return lane.platform === 'android' && lane.resources.some(resource => resource.kind === 'phone' &&
    resource.capabilities?.includes('backend-connectivity'))
}
export type ResourceReservationHost = {hostId: string; incarnation: string; incarnationGeneration: number; sequence: number;
  receivedAt: Date; snapshot: TestHostState; resourceReservationVersion?: number; resourceReservations?: unknown;
  laneControlVersion?: number; laneControls?: unknown; resourceLifecycleCursor?: unknown;
  frameworkHistory?: unknown; frameworkStopReceipts?: unknown}

function graphReturnCandidate(pending: FleetCandidatePreparation, returned: ExclusiveResourceReturn,
  host: ResourceReservationHost | null, now: number) {
  if (returned.controller.incarnation === pending.candidate.controller.incarnation &&
    returned.controller.generation === pending.candidate.controller.generation) return pending
  if (!host || !fresh(host, now) || host.incarnation !== returned.controller.incarnation ||
    host.incarnationGeneration !== returned.controller.generation || host.sequence !== returned.controller.sequence ||
    host.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === returned.resourceId)?.idle.outcome !== 'unknown') return
  const continuation = currentGraphReturnContinuation(pending, host)
  return continuation ? {...pending, resourceReturnContinuation: continuation} : undefined
}
/** Installed resource controls and new fleet claims contend on the same authority row. */
function dependencyAvailable(host: ResourceReservationHost, dependency: ExclusiveResourceDependency, now: number) {
  return resourceAvailable({...host, resourceControlRecords: host.laneControls, authorityReservations: host.resourceReservations}, dependency.resourceId, now)
}
/** Ordinary backend work needs current returned phone proof; other providers keep their idle baseline. */
export function routineResourceBlocker(host: ResourceReservationHost, row: StoredRoutineJob, laneId: string, now: number, candidateCheck = false):
  ResourceReadinessBlocker | {code: 'routine-lane-unavailable' | 'routine-preparation-unavailable' | 'routine-lane-not-idle' | 'routine-backend-proof-unavailable'; laneId: string} | undefined {
  const lane = host.snapshot.lanes.find(value => value.id === laneId)
  if (!lane) return {code: 'routine-lane-unavailable', laneId}
  if (!row.fleetPreparation) return {code: 'routine-preparation-unavailable', laneId}
  if (!candidateCheck && (lane.state !== 'idle' || lane.activity || lane.dispatchMode !== 'automatic')) return {code: 'routine-lane-not-idle', laneId}
  const readinessHost = {...host, resourceControlRecords: host.laneControls, authorityReservations: host.resourceReservations},
    original = {requestId: row.requestId, inputSha256: row.fleetInputSha256!},
    laneBlocker = resourceLaneBlocker(readinessHost, laneId, {...original, hostId: host.hostId})
  if (laneBlocker) return laneBlocker
  const phone = lane.resources.find(value => value.kind === 'phone')
  const graph = qualifiedGraphCandidate(row, host.snapshot, laneId, now, host.receivedAt)
  const retainedPurpose = row.fleetCandidatePreparations?.at(-1)?.target.purpose
  if (!candidateCheck && retainedPurpose?.kind === 'resource-readiness' && !graph)
    return {code: 'resource-idle-proof-unavailable', resourceId: retainedPurpose.resourceId}
  const backendRequired = requiresBackendConnectivity(row), qualified = backendRequired && qualifiedCandidate(row, host.snapshot, laneId, now, host.receivedAt)
  if (backendRequired && !candidateCheck && !qualified) return {code: 'routine-backend-proof-unavailable', laneId}
  if (graph?.target.purpose?.kind === 'resource-readiness') {
    for (const required of row.fleetPreparation.requirements.resources) {
      const resource = lane.resources.find(value => value.kind === required.kind)
      if (!resource) return {code: 'resource-not-enrolled', laneId, resourceKind: required.kind}
      if (['network', 'workspace'].includes(required.kind)) {
        const blocker = resourceBlocker(readinessHost, resource.id, now, false, {...original, laneId})
        if (blocker) return blocker
        continue
      }
      if (!graph.target.purpose.resources.some(member => member.id === resource.id)) return {code: 'resource-idle-proof-unavailable', resourceId: resource.id}
    }
    for (const member of graph.target.purpose.resources) {
      const blocker = resourceCandidateBlocker(readinessHost, member.id, now, {...original, laneId})
      if (blocker) return blocker
    }
    return undefined
  }
  return requiredResourceBlocker(readinessHost, lane, row.fleetPreparation.requirements.resources, now,
    (_required, resource) => resource.id === phone?.id && Boolean(candidateCheck || qualified), original)
}
export function routineResourcesAvailable(host: ResourceReservationHost, row: StoredRoutineJob, laneId: string, now: number, candidateCheck = false) {
  return routineResourceBlocker(host, row, laneId, now, candidateCheck) === undefined
}
function dependencyEnrolled(host: ResourceReservationHost, dependency: ExclusiveResourceDependency) {
  return dependency.authorityHostId===host.hostId && (host.snapshot.resources?.some(resource=>resource.id===dependency.resourceId &&
    resource.capabilities?.includes(dependency.capability)) || host.snapshot.lanes.some(lane=>lane.resources.some(resource=>
      resource.exclusiveDependencies?.some(value=>value.resourceId===dependency.resourceId && value.authorityHostId===host.hostId))));
}
export type ExclusiveResourceBlocker = {resourceId: string; hostId: string; laneId?: string; owner: ExclusiveHostReservation['owner']}
export interface ResourceReservationRepository {
  get(hostId: string): Promise<ResourceReservationHost | null>
  replace(host: ResourceReservationHost, claims: HostResourceReservation[]): Promise<boolean>
  candidateRequest?(hostId: string, targetInputSha256: string): Promise<StoredRoutineJob | null>
  request?(requestId: string): Promise<(StoredRoutineJob & {input?: unknown}) | null>
  stage?(requestId: string, digest: string, admission: FleetResourceAdmission, now: Date): Promise<StoredRoutineJob | null>
  stageBackend?(requestId: string, digest: string, admission: FleetResourceAdmission, host: ResourceReservationHost, now: Date): Promise<StoredRoutineJob | null>
  recordCandidateReturn?(requestId: string, pending: NonNullable<StoredRoutineJob['fleetCandidatePreparation']>, returned: unknown): Promise<boolean>
  recordCandidateClaim?(requestId: string, pending: NonNullable<StoredRoutineJob['fleetCandidatePreparation']>, claim: ExclusiveHostReservation): Promise<boolean>
  recordCandidateNoAcquisition?(requestId: string, pending: NonNullable<StoredRoutineJob['fleetCandidatePreparation']>, receipt: {intent: ExclusiveResourceIntent; journal: unknown; observation: unknown}): Promise<boolean>
  replaceBackend?(host: ResourceReservationHost, claims: HostResourceReservation[], intent: ExclusiveResourceIntent, now: Date): Promise<boolean>
  claimedHosts?(requestId: string): Promise<ResourceReservationHost[]>
  recorderClaims?(requestId: string): Promise<RecorderHostReservation[]>
}
const stageFilter = (requestId: string, digest: string, now: Date) => ({requestId, fleetInputSha256: digest, state: 'awaiting-runner',
  fleetCandidatePreparation: {$exists: false}, fleetResourceAdmission: {$exists: false}, fleetBinding: {$exists: false}, fleetResourceReservation: {$exists: false},
  fleetCancellation: {$exists: false}, hostId: {$exists: false}, input: {$exists: false}, inputSha256: {$exists: false}, fleetDeadline: {$gt: now}})
const hasBackendProbe = (claims: HostResourceReservation[], hostId: string, laneId: string) => claims.some(claim =>
  isExclusiveHostReservation(claim) && claim.prerequisite && claim.borrowerHostId === hostId && claim.laneId === laneId)
export const requiresBackendConnectivity = (row: StoredRoutineJob) => row.fleetSelection?.platform === 'android' &&
  Boolean(row.fleetPreparation?.requirements.resources.some(required => required.kind === 'phone' &&
    required.capabilities.includes('backend-connectivity')))
/** A provisional byte claim is custody only. Ambiguous originals cannot select or bind a candidate. */
export function backendRecorderClaimMatches(claims: RecorderHostReservation[], requestId: string, digest: string, hostId: string, laneId: string) {
  return claims.length === 1 && claims[0]!.requestId === requestId && claims[0]!.fleetInputSha256 === digest &&
    claims[0]!.hostId === hostId && claims[0]!.laneId === laneId
}
/** Reconstruct the same target from the original request, without choosing a fresh candidate. */
export function backendPrerequisiteRequestMatches(row: (StoredRoutineJob & {input?: unknown}) | null, intent: ExclusiveResourceIntent, now: number) {
  const purpose = intent.prerequisite, selected = row?.fleetBinding, reservation = row?.fleetResourceReservation, admission = row?.fleetResourceAdmission
  if (!purpose || purpose.local || !purpose.preparing || !row?.fleetPreparation || row.requestId !== purpose.jobId || row.state !== 'preparing' ||
    row.hostId !== intent.hostId || !selected || selected.hostId !== intent.hostId || selected.laneId !== intent.laneId ||
    selected.jobId !== row.requestId || selected.requestId !== row.requestId || !reservation || !admission ||
    reservation.requestId !== row.requestId || reservation.hostId !== intent.hostId || reservation.laneId !== intent.laneId ||
    reservation.fleetInputSha256 !== row.fleetInputSha256 || admission.intent.hostId !== intent.hostId ||
    admission.intent.laneId !== intent.laneId || admission.intent.owner.id !== row.requestId || admission.intent.owner.kind !== 'run' ||
    admission.intent.inputSha256 !== row.fleetInputSha256 || row.fleetExclusiveExecutionBinding || row.hostReceipt ||
    row.input || row.inputSha256 || row.runId || row.dispatchCompletion || row.hostCancellation || row.hostRejection ||
    row.preparationCancellation || row.preparationRejection || row.fleetCancellation || row.fleetDeadline.getTime() <= now ||
    row.fleetSelection.platform !== 'android' || row.fleetSelectionSha256 !== requestInputDigest(row.fleetSelection) ||
    row.dispatchIntentSha256 !== purpose.preparing.dispatchIntentSha256 || row.dispatchIntentSha256 !== requestInputDigest(row.dispatchIntent) ||
    requestInputDigest(selected) !== purpose.preparing.bindingSha256 || requestInputDigest(admission) !== purpose.preparing.admissionSha256 ||
    requestInputDigest(reservation) !== purpose.preparing.reservationSha256 || row.fleetInputSha256 !== purpose.preparing.fleetInputSha256 ||
    row.fleetInputSha256 !== requestInputDigest({selection: row.fleetSelection, prepared: row.fleetPreparation,
      deadline: row.fleetDeadline.toISOString(), target: row.fleetTarget ?? null})) return false
  return true
}
/** Same host snapshot assertion is the original local authority; it is never a fleet preparing receipt. */
function localBackendIntentMatches(host: ResourceReservationHost, intent: ExclusiveResourceIntent, now: number) {
  const local = intent.prerequisite?.local;
  if (!local || local.controller.incarnation !== host.incarnation || local.controller.generation !== host.incarnationGeneration ||
    now >= local.admissionExpiresAt || Date.parse(local.requestedAt) > now) return false;
  const targets = (host.snapshot.resourceReservations?.localPrerequisites ?? []).map(value => routineQualificationTargetSchema.safeParse(value))
    .flatMap(value => value.success && value.data.jobId === intent.prerequisite!.jobId ? [value.data] : []);
  return targets.length === 1 && targets[0]!.inputSha256 === intent.prerequisite!.targetInputSha256 &&
    targets[0]!.laneId === intent.laneId && targets[0]!.hostId === host.hostId &&
    isDeepStrictEqual(targets[0]!.local, local) && isDeepStrictEqual(targets[0]!.acceptedBinding, intent.prerequisite!.binding);
}
export const resourceReservationRepository: ResourceReservationRepository = {
  async get(hostId) {
    return await TestHostStateModel.findOne({hostId}).select({hostId: 1, incarnation: 1, incarnationGeneration: 1,
      sequence: 1, receivedAt: 1, laneControlVersion: 1, laneControls: 1, 'snapshot.laneControls': 1, 'snapshot.hostId': 1, 'snapshot.incarnation': 1, 'snapshot.incarnationGeneration': 1,
      'snapshot.sequence': 1, 'snapshot.observedAt': 1, 'snapshot.lanes.id': 1, 'snapshot.lanes.platform': 1,
      'snapshot.lanes.dispatchMode': 1, 'snapshot.lanes.state': 1, 'snapshot.lanes.activity': 1,
      'snapshot.lanes.resources': 1, 'snapshot.lanes.glasses': 1, 'snapshot.resources': 1, 'snapshot.resourceReservations': 1,
      'snapshot.frameworkBinding': 1, 'snapshot.frameworkAcceptedAt': 1, 'snapshot.frameworkProcess': 1,
      frameworkHistory: 1, frameworkStopReceipts: 1,
      'snapshot.resourceLifecycle': 1, resourceLifecycleCursor: 1, resourceReservationVersion: 1, resourceReservations: 1})
      .read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean() as ResourceReservationHost | null
  },
  async replace(host, claims) {
    const row = await TestHostStateModel.findOneAndUpdate({hostId: host.hostId, incarnation: host.incarnation,
      incarnationGeneration: host.incarnationGeneration, sequence: host.sequence,
      laneControlVersion:host.laneControlVersion??{$exists:false},
      resourceReservationVersion: host.resourceReservationVersion ?? {$exists: false}},
      {$set: {resourceReservations: claims}, $inc: {resourceReservationVersion: 1}},
      {new: true, writeConcern: testWriteConcern}).select({hostId: 1}).setOptions({timeoutMS: 5000}).lean()
    return Boolean(row)
  },
  async candidateRequest(hostId, targetInputSha256) {
    const rows = await TestRequestModel.find({'fleetCandidatePreparation.hostId': hostId,
      'fleetCandidatePreparation.targetInputSha256': targetInputSha256}).limit(2).read('primary').readConcern('majority')
      .setOptions({timeoutMS: 5000}).lean();
    return rows.length === 1 ? rows[0] as unknown as StoredRoutineJob : null;
  },
  async request(requestId) {return await TestRequestModel.findOne({requestId}).read('primary').readConcern('majority')
    .setOptions({timeoutMS: 5000}).lean() as unknown as (StoredRoutineJob & {input?: unknown}) | null},
  async stage(requestId, digest, fleetResourceAdmission, now) {
    const row = await this.request!(requestId);
    if (row?.fleetCandidatePreparation || row && requiresBackendConnectivity(row) &&
      (!row.fleetCandidateSelection || row.fleetCandidateSelection.hostId !== fleetResourceAdmission.intent.hostId ||
        row.fleetCandidateSelection.laneId !== fleetResourceAdmission.intent.laneId)) return null;
    const host = await this.get(fleetResourceAdmission.intent.hostId), laneId = fleetResourceAdmission.intent.laneId,
      stagedAt = new Date(Date.now());
    if (!row || !host || !laneId || row.fleetDeadline <= stagedAt ||
      !routineResourcesAvailable(host, row, laneId, stagedAt.getTime())) return null;
    return await TestRequestModel.collection.findOneAndUpdate({...stageFilter(requestId, digest, stagedAt),
      ...(row && requiresBackendConnectivity(row) ? {fleetCandidateSelection: row.fleetCandidateSelection} : {})},
      {$set: {fleetResourceAdmission}}, {returnDocument: 'after', writeConcern: testWriteConcern, timeoutMS: 5000}) as unknown as StoredRoutineJob | null
  },
  async stageBackend(requestId, digest, fleetResourceAdmission, host, now) {
    const original = await this.request!(requestId), claims = await this.recorderClaims!(requestId),
      current = await this.get(host.hostId), laneId = fleetResourceAdmission.intent.laneId,
      stagedAt = new Date(Date.now())
    if (!laneId || !current || !backendRecorderClaimMatches(claims, requestId, digest, host.hostId, laneId) ||
      current.incarnation !== host.incarnation || current.incarnationGeneration !== host.incarnationGeneration || current.sequence !== host.sequence ||
      !hostResourceReservationsSchema.parse(current.resourceReservations ?? []).some(claim => isDeepStrictEqual(claim, claims[0])) ||
      hasBackendProbe(hostResourceReservationsSchema.parse(current.resourceReservations ?? []), host.hostId, laneId) ||
      !fresh(current, stagedAt.getTime()) || !original || original.fleetDeadline <= stagedAt ||
      !routineResourcesAvailable(current, original, laneId, stagedAt.getTime())) return null
    // The retained byte claim already won the same host CAS as phone probes. It survives
    // failed/lost staging replies; this request CAS selects only that original candidate.
    return this.stage!(requestId, digest, fleetResourceAdmission, stagedAt)
  },
  async replaceBackend(host, claims, intent, now) {
    if (intent.prerequisite!.candidate) {
      const row = await this.request!(intent.prerequisite!.jobId), pending = row?.fleetCandidatePreparation;
      if (!candidatePrerequisiteRequestMatches(row, intent, now.getTime()) || !pending) return false;
      if (intent.prerequisite!.kind === 'resource-readiness' &&
        (pending.noAcquisitionReceipt || reportedGraphCandidateSettlement(pending, host.snapshot))) return false
      if (intent.prerequisite!.target && !pending.backendTarget) {
        const saved = await TestRequestModel.collection.findOneAndUpdate({requestId: row!.requestId, state: 'awaiting-runner',
          fleetCandidatePreparation: pending, fleetBinding: {$exists: false}, fleetResourceAdmission: {$exists: false},
          fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now}},
          {$set: {'fleetCandidatePreparation.backendTarget': intent.prerequisite!.target}},
          {returnDocument: 'after', writeConcern: testWriteConcern, timeoutMS: 5000});
        if (!saved) return false;
      }
      if (!candidatePrerequisiteRequestMatches(await this.request!(row!.requestId), intent, now.getTime())) return false;
    } else if (intent.prerequisite!.local) {
      if (await this.request!(intent.prerequisite!.jobId) || !localBackendIntentMatches(host, intent, now.getTime())) return false
    } else if (!backendPrerequisiteRequestMatches(await this.request!(intent.prerequisite!.jobId), intent, now.getTime())) return false
    // A recorder claim is retained before any backend run stage. The ordinary host-row
    // CAS makes a competing byte/probe write lose without a cross-collection transaction.
    return this.replace(host, claims)
  },
  async recordCandidateReturn(requestId, pending, returned) {
    if (pending.target.purpose?.kind === 'resource-readiness') {
      const value = exclusiveResourceReturnSchema.parse(returned),
        checked = graphReturnCandidate(pending, value, await this.get(pending.hostId), Date.now()), prior = pending.resourceReturns ?? [],
        original = prior.find(item => exclusiveResourceReturnSchema.parse(item).resourceId === value.resourceId)
      if (!checked || !graphCandidateReturnMatches(checked, value)) return false
      // A fresh authenticated report may retry a committed original return after
      // losing the ACK. Its reporting sequence is not another resource release.
      if (original) return isDeepStrictEqual((({controller: _, ...proof}) => proof)(exclusiveResourceReturnSchema.parse(original)),
        (({controller: _, ...proof}) => proof)(value))
      return Boolean(await TestRequestModel.collection.findOneAndUpdate({requestId, fleetCandidatePreparation: pending,
        fleetBinding: {$exists: false}, fleetResourceAdmission: {$exists: false}},
        {$set: {'fleetCandidatePreparation.resourceReturns': [...prior, value],
          ...(checked.resourceReturnContinuation ? {'fleetCandidatePreparation.resourceReturnContinuation': checked.resourceReturnContinuation} : {})}},
        {returnDocument: 'after', writeConcern: testWriteConcern, timeoutMS: 5000}))
    }
    if (!candidateReturnMatches(pending, returned)) return false;
    if (pending.returnReceipt) return isDeepStrictEqual(pending.returnReceipt, returned);
    return Boolean(await TestRequestModel.collection.findOneAndUpdate({requestId, fleetCandidatePreparation: pending,
      fleetBinding: {$exists: false}, fleetResourceAdmission: {$exists: false}},
      {$set: {'fleetCandidatePreparation.returnReceipt': returned}}, {returnDocument: 'after', writeConcern: testWriteConcern, timeoutMS: 5000}));
  },
  async recordCandidateNoAcquisition(requestId, pending, receipt) {
    if (pending.noAcquisitionReceipt) {
      const previous = pending.noAcquisitionReceipt as {intent?: unknown; journal?: unknown}
      return isDeepStrictEqual(previous.intent, receipt.intent) && isDeepStrictEqual(previous.journal, receipt.journal)
    }
    if (pending.claimReceipt || pending.returnReceipt || pending.resourceClaims?.length || pending.resourceReturns?.length || !receipt.intent.prerequisite?.candidate ||
      !isDeepStrictEqual(receipt.intent.prerequisite.candidate, pending.candidate) || receipt.intent.hostId !== pending.hostId ||
      receipt.intent.laneId !== pending.laneId || receipt.intent.inputSha256 !== pending.targetInputSha256) return false
    return Boolean(await TestRequestModel.collection.findOneAndUpdate({requestId, fleetCandidatePreparation: pending,
      fleetBinding: {$exists: false}, fleetResourceAdmission: {$exists: false}},
      {$set: {'fleetCandidatePreparation.noAcquisitionReceipt': receipt}}, {returnDocument: 'after', writeConcern: testWriteConcern, timeoutMS: 5000}))
  },
  async recordCandidateClaim(requestId, pending, claim) {
    if (pending.target.purpose?.kind === 'resource-readiness') {
      if (!graphCandidateClaimMatches(pending, claim)) return false
      const prior = pending.resourceClaims ?? [], original = prior.find(value =>
        (value as ExclusiveHostReservation).resourceId === claim.resourceId)
      if (original) return isDeepStrictEqual(original, claim)
      return Boolean(await TestRequestModel.collection.findOneAndUpdate({requestId, fleetCandidatePreparation: pending,
        fleetBinding: {$exists: false}, fleetResourceAdmission: {$exists: false}},
        {$set: {'fleetCandidatePreparation.resourceClaims': [...prior, claim]}},
        {returnDocument: 'after', writeConcern: testWriteConcern, timeoutMS: 5000}))
    }
    if (pending.claimReceipt) return isDeepStrictEqual(pending.claimReceipt, claim);
    if (!claim.prerequisite?.candidate || !isDeepStrictEqual(claim.prerequisite.candidate, pending.candidate) ||
      claim.prerequisite.targetInputSha256 !== pending.targetInputSha256 || !isDeepStrictEqual(claim.prerequisite.target, pending.backendTarget) ||
      claim.authorityHostId !== pending.hostId || claim.borrowerHostId !== pending.hostId || claim.laneId !== pending.laneId ||
      claim.resourceId !== pending.target.purpose?.resourceId || claim.controllerIncarnation !== pending.candidate.controller.incarnation ||
      claim.controllerGeneration !== pending.candidate.controller.generation) return false;
    return Boolean(await TestRequestModel.collection.findOneAndUpdate({requestId, fleetCandidatePreparation: pending,
      fleetBinding: {$exists: false}, fleetResourceAdmission: {$exists: false}},
      {$set: {'fleetCandidatePreparation.claimReceipt': claim}}, {returnDocument: 'after', writeConcern: testWriteConcern, timeoutMS: 5000}));
  },
  async recorderClaims(requestId) {
    const rows = await TestHostStateModel.find({resourceReservations: {$elemMatch: {requestId}}})
      .select({hostId: 1, resourceReservations: 1}).limit(101).read('primary').readConcern('majority')
      .setOptions({timeoutMS: 5000}).lean()
    if (rows.length > 100) throw new TestRunError(503, 'Original recorder custody exceeds its bounded host inventory')
    return rows.flatMap(row => hostResourceReservationsSchema.parse(row.resourceReservations ?? []).filter(
      (claim): claim is RecorderHostReservation => !isExclusiveHostReservation(claim) && claim.requestId === requestId))
  },
  async claimedHosts(requestId) {
    return await TestHostStateModel.find({resourceReservations: {$elemMatch: {kind: 'exclusive', 'owner.id': requestId, 'owner.kind': 'run', 'origin.kind': 'fleet'}}})
      .limit(2).read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean() as unknown as ResourceReservationHost[]
  },
}
const fresh = (host: ResourceReservationHost, now: number) => [host.receivedAt.getTime(), Date.parse(host.snapshot.observedAt)]
  .every(at => Number.isFinite(at) && at <= now && now - at <= 120_000)
/** An ACK removes the original claim; it cannot renew physical readiness. */
function closedNormalResourceReturn(host: ResourceReservationHost, claim: ExclusiveHostReservation, returned: ExclusiveResourceReturn) {
  if ('kind' in returned.release || claim.authorityHostId !== host.hostId || returned.authorityHostId !== host.hostId) return false
  const release = returned.release, subject = host.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === claim.resourceId),
    installed = host.snapshot.resources?.find(value => value.id === claim.resourceId) ??
      host.snapshot.lanes.find(value => value.id === claim.laneId)?.resources.find(value => value.id === claim.resourceId),
    contract = installed?.idleContract, accepted = subject?.idle.acceptedCheck,
    checkedAt = Date.parse(subject?.idle.checkedAt ?? ''), acceptedAt = Date.parse(accepted?.acceptedAt ?? ''),
    releasedAt = Date.parse(release.releasedAt), observedAt = Date.parse(host.snapshot.observedAt),
    subjectObservedAt = Date.parse(subject?.observedAt ?? '')
  if (!subject?.current || subject.subject.authorityHostId !== host.hostId || subject.owner !== null || subject.repair.state !== 'none' ||
    !['idle', 'unknown'].includes(subject.status) || !['passed', 'unknown'].includes(subject.idle.outcome) ||
    subject.status === 'unknown' && !['resource-not-returned', 'idle-check-required'].includes(subject.reason?.code ?? '') ||
    !contract || subject.idle.contractVersion !== contract.version || subject.idle.qualifiedScope.kind === 'unqualified' ||
    !isDeepStrictEqual(subject.idle.qualifiedScope, contract.qualifiedScope) || !accepted || accepted.subjectGeneration !== subject.generation || !subject.idle.evidenceRefs.length ||
    !claim.laneId && subject.resource.memberships.length ||
    ![checkedAt, acceptedAt, releasedAt, observedAt, subjectObservedAt].every(Number.isFinite) || checkedAt < Date.parse(claim.reservedAt) ||
    checkedAt > acceptedAt || acceptedAt > releasedAt || releasedAt > subjectObservedAt || subjectObservedAt > observedAt || observedAt - subjectObservedAt > 120_000 ||
    releasedAt - checkedAt > contract.maximumAgeMs) return false
  const history = host.snapshot.resourceLifecycle!.history.filter(event => event.resourceId === claim.resourceId),
    matchingOwner = (event: typeof history[number]) => event.ownerId === release.owner.id &&
      event.ownerGeneration === release.owner.generation && event.hostId === host.hostId && event.laneId === returned.laneId,
    releases = history.filter(event => event.subjectGeneration === subject.generation),
    checks = history.filter(event => event.subjectGeneration === subject.generation - 1)
  // Exact consecutive generations prove the accepted check carried into this
  // release, with no intervening resource transition or later replacement.
  return releases.length === 1 && checks.length === 1 && releases[0]!.event === 'released' && checks[0]!.event === 'check-passed' &&
    matchingOwner(releases[0]!) && matchingOwner(checks[0]!) && Date.parse(checks[0]!.at) === acceptedAt &&
    Date.parse(releases[0]!.at) >= acceptedAt && Date.parse(releases[0]!.at) <= releasedAt &&
    !history.some(event => event.subjectGeneration === null || event.subjectGeneration > subject.generation || Date.parse(event.at) > Date.parse(releases[0]!.at))
}
const dependencies = (host: ResourceReservationHost, intent: ExclusiveResourceIntent, observation = false): ExclusiveResourceDependency[] => {
  const lane = host.snapshot.lanes.find(value => value.id === intent.laneId), dispatch = intent.localDispatch,
    localDispatch = dispatch && intent.owner.kind === 'run' && intent.owner.id === dispatch.requestId &&
      intent.operationId === `run:${dispatch.requestId}` && intent.inputSha256 === dispatch.inputSha256 &&
      host.snapshot.resourceReservations?.dispatches?.some(value => isDeepStrictEqual(value, dispatch))
  if (!lane || !observation && (!['idle', 'running', 'reserved'].includes(lane.state) ||
    lane.dispatchMode === 'paused' && !localDispatch ||
    lane.activity && !isDeepStrictEqual({id: lane.activity.owner.id, kind: lane.activity.owner.kind}, intent.owner)))
    throw new TestRunError(409, 'Reservation requires the selected idle lane or its unchanged current owner')
  const selected = intent.resources.flatMap(required => {
    const offered = lane.resources.find(resource => resource.id === required.id)
    if (!offered || required.capabilities.some(capability => !offered.capabilities?.includes(capability)))
      throw new TestRunError(409, 'Reservation intent differs from installed resource capabilities')
    return offered.exclusiveDependencies?.filter(dependency => required.capabilities.includes(dependency.capability)) ?? []
  })
  const unique = new Map<string, ExclusiveResourceDependency>()
  for (const dependency of selected) {
    const previous = unique.get(dependency.resourceId)
    if (previous && previous.authorityHostId !== dependency.authorityHostId)
      throw new TestRunError(409, 'Resource dependency has conflicting authorities')
    unique.set(dependency.resourceId, dependency)
  }
  return [...unique.values()].sort((left, right) => left.authorityHostId.localeCompare(right.authorityHostId) ||
    left.resourceId.localeCompare(right.resourceId))
}
/** The authority is the existing host resource row. No lease expires merely because a controller stops reporting. */
export class ResourceReservationsService {
  constructor(private rows: ResourceReservationRepository = resourceReservationRepository, private now = Date.now,
    private qualificationTargets: (hostId: string, owned?: OwnedRoutineQualification) => Promise<RoutineQualificationTarget[]> =
      async (hostId, owned) => {const {RoutineJobService} = await import('./routine-job.service');
        return new RoutineJobService().qualificationTargets(hostId, owned)}) {}
  private async host(hostId: string) {
    const host = await this.rows.get(hostId)
    if (!host || host.hostId !== hostId) throw new TestRunError(404, 'Resource authority host was not found')
    host.snapshot = hostStateSchema.parse(host.snapshot)
    return host
  }
  /** One request CAS selects the original candidate before exclusive authority or Actions device binding.
   * Backend-required work first retains its byte claim on the borrower's existing host CAS.
   */
  async reserveFleet(requestId: string, digest: string, hostId: string, laneId: string,
    onBlocked?: (blocked: ExclusiveResourceBlocker, dependencies: ExclusiveResourceDependency[]) => void): Promise<FleetExclusiveReservation | null | undefined> {
    let row = await this.rows.request?.(requestId)
    if (row?.fleetCandidatePreparation) return null
    if (!row?.fleetPreparation || row.fleetInputSha256 !== digest || row.state !== 'awaiting-runner' || row.fleetBinding || row.fleetCancellation ||
      row.hostId || row.inputSha256 || row.input || row.fleetDeadline.getTime() <= this.now()) return null
    if (row.fleetResourceAdmission && (row.fleetResourceAdmission.intent.hostId !== hostId || row.fleetResourceAdmission.intent.laneId !== laneId)) return null
    const borrower = await this.host(hostId), lane = borrower.snapshot.lanes.find(value => value.id === laneId)
    if (requiresBackendConnectivity(row) && !row.fleetResourceAdmission && !qualifiedCandidate(row, borrower.snapshot, laneId, this.now(), borrower.receivedAt)) return null
    if (!fresh(borrower, this.now()) ||
      !lane || lane.state !== 'idle' || lane.activity || lane.dispatchMode !== 'automatic') return null
    if (!routineResourcesAvailable(borrower, row, laneId, this.now())) return null
    if (hostResourceReservationsSchema.parse(borrower.resourceReservations ?? []).some(claim => isExclusiveHostReservation(claim) &&
      claim.prerequisite && claim.borrowerHostId === hostId && claim.laneId === laneId)) return null
    const resources = row.fleetPreparation.requirements.resources.map(required => {
      const resource = lane.resources.find(value => value.kind === required.kind)
      return resource ? {id: resource.id, capabilities: [...required.capabilities]} : null
    })
    if (resources.some(value => value === null)) return null
    const candidateIntent: ExclusiveResourceIntent = {operationId: `run:${requestId}`, hostId, laneId, inputSha256: digest,
      owner: {id: requestId, kind: 'run'}, resources: resources as ExclusiveResourceIntent['resources'],
      controller: {incarnation: borrower.incarnation, generation: borrower.incarnationGeneration, sequence: borrower.sequence}},
      selected = dependencies(borrower, candidateIntent), origin = {kind: 'fleet' as const, fleetInputSha256: digest}
    if (new Set(selected.map(value => value.authorityHostId)).size > 1) return null
    // Freeze even an empty dependency set before any authority side effect. A global absence read
    // cannot serialize two different candidates for the same request; this existing request CAS can.
    const candidate = fleetResourceAdmissionSchema.parse({intent: candidateIntent, dependencies: selected})
    const serializedPreparation = requiresSerializedAndroidPreparation(lane)
    if (serializedPreparation) {
      const originals = await this.rows.recorderClaims?.(requestId)
      if (!originals || !backendRecorderClaimMatches(originals, requestId, digest, hostId, laneId) ||
        !hostResourceReservationsSchema.parse(borrower.resourceReservations ?? []).some(value => isDeepStrictEqual(value, originals[0]))) return null
    }
    if (!row.fleetResourceAdmission) {
      const stagedAt = this.now()
      if (row.fleetDeadline.getTime() <= stagedAt || !routineResourcesAvailable(borrower, row, laneId, stagedAt)) return null
      row = await (serializedPreparation
        ? this.rows.stageBackend?.(requestId, digest, candidate, borrower, new Date(stagedAt))
        : this.rows.stage?.(requestId, digest, candidate, new Date(stagedAt))) ?? await this.rows.request?.(requestId)
    }
    if (!row?.fleetResourceAdmission || row.state !== 'awaiting-runner' || row.fleetInputSha256 !== digest || row.fleetBinding ||
      row.fleetCancellation || row.hostId || row.input || row.inputSha256 || row.fleetDeadline.getTime() <= this.now()) return null
    const admission = fleetResourceAdmissionSchema.parse(row.fleetResourceAdmission), intent = admission.intent
    if (!isDeepStrictEqual(admission, {...candidate, intent: {...candidate.intent, controller: intent.controller}})) return null
    const retainedHosts = await this.rows.claimedHosts?.(requestId)
    if (!retainedHosts || retainedHosts.length > 1) return null
    const retainedHost = retainedHosts[0], retained = retainedHost ? hostResourceReservationsSchema.parse(retainedHost.resourceReservations ?? [])
      .filter(isExclusiveHostReservation).filter(claim => claim.owner.id === requestId && claim.owner.kind === 'run' && claim.origin?.kind === 'fleet') : []
    if (retainedHost && (!retained.length || retained.some(claim => claim.authorityHostId !== retainedHost.hostId ||
      claim.origin?.fleetInputSha256 !== digest || claim.inputSha256 !== digest || claim.operationId !== intent.operationId ||
      claim.borrowerHostId !== hostId || claim.laneId !== laneId)) || row.fleetExclusiveReservation && !retained.length) return null
    if (row.fleetDeadline.getTime() <= this.now() || !routineResourcesAvailable(borrower, row, laneId, this.now())) return null
    if (!selected.length) return retained.length ? null : undefined
    if (retained.length && (retained.length !== selected.length || selected.some(dependency => !retained.some(claim =>
      claim.resourceId === dependency.resourceId && claim.authorityHostId === dependency.authorityHostId)))) return null
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.rows.request?.(requestId)
      if (!current || current.fleetInputSha256 !== digest || current.fleetBinding || current.fleetCancellation || current.hostId || current.input ||
        current.inputSha256 || current.state !== 'awaiting-runner' || current.fleetDeadline.getTime() <= this.now() ||
        !isDeepStrictEqual(current.fleetResourceAdmission, admission)) return null
      const authority = await this.host(selected[0]!.authorityHostId)
      if (!fresh(authority, this.now()) || selected.some(dependency => !dependencyEnrolled(authority,dependency))) return null
      const claims = hostResourceReservationsSchema.parse(authority.resourceReservations ?? []),
        existing = claims.filter(isExclusiveHostReservation).filter(claim => selected.some(value => value.resourceId === claim.resourceId))
      if (retained.length && (existing.length !== retained.length || retained.some(claim =>
        !existing.some(value => isDeepStrictEqual(value, claim))))) return null
      if (existing.length) {
        const blocked = existing.find(claim => claim.owner.id !== requestId || claim.owner.kind !== 'run' ||
          claim.borrowerHostId !== hostId || claim.laneId !== laneId);
        if (blocked) {
          onBlocked?.({resourceId: blocked.resourceId, hostId: blocked.borrowerHostId, laneId: blocked.laneId, owner: blocked.owner}, selected);
          return null;
        }
        if (existing.length !== selected.length || existing.some(claim => !claim.origin || claim.origin.fleetInputSha256 !== digest ||
          claim.owner.id !== requestId || claim.owner.kind !== 'run' || claim.borrowerHostId !== hostId || claim.laneId !== laneId ||
          claim.operationId !== intent.operationId || claim.controllerGeneration !== existing[0]!.controllerGeneration ||
          claim.controllerIncarnation !== intent.controller.incarnation || claim.controllerGeneration !== intent.controller.generation ||
          claim.borrowerSequence !== intent.controller.sequence)) return null
        const originalIntent = intent,
          intentSha256 = requestInputDigest({...originalIntent, controller: {incarnation: originalIntent.controller.incarnation,
            generation: originalIntent.controller.generation}, origin, dependencies: selected})
        if (existing.some(claim => claim.intentSha256 !== intentSha256)) return null
        const receipt = fleetExclusiveReservationSchema.parse({origin, intent: originalIntent, intentSha256, claims: existing})
        if (current.fleetDeadline.getTime() <= this.now() || !routineResourcesAvailable(borrower, current, laneId, this.now())) return null
        return row.fleetExclusiveReservation && !isDeepStrictEqual(row.fleetExclusiveReservation, receipt) ? null : receipt
      }
      if (selected.some(dependency => {
        const graph = qualifiedGraphCandidate(current, borrower.snapshot, laneId, this.now(), borrower.receivedAt)
        return graph?.target.purpose?.kind === 'resource-readiness' && authority.hostId === hostId &&
          graph.target.purpose.resources.some(member => member.id === dependency.resourceId)
          ? resourceCandidateBlocker({...authority, resourceControlRecords: authority.laneControls, authorityReservations: authority.resourceReservations},
            dependency.resourceId, this.now(), {requestId, inputSha256: digest, laneId}) !== undefined
          : !dependencyAvailable(authority, dependency, this.now())
      })) return null
      if (claims.length + selected.length > 1000) return null
      const intentSha256 = requestInputDigest({...intent, controller: {incarnation: intent.controller.incarnation,
        generation: intent.controller.generation}, origin, dependencies: selected}),
        next: ExclusiveHostReservation[] = selected.map(dependency => ({kind: 'exclusive', id: randomUUID(), resourceId: dependency.resourceId,
          authorityHostId: authority.hostId, borrowerHostId: hostId, laneId, operationId: intent.operationId, intentSha256,
          inputSha256: digest, owner: intent.owner, origin, controllerIncarnation: intent.controller.incarnation,
          controllerGeneration: intent.controller.generation, borrowerSequence: intent.controller.sequence, reservedAt: new Date(this.now()).toISOString()}))
      const claimingAt = this.now()
      if (current.fleetDeadline.getTime() <= claimingAt ||
        !routineResourcesAvailable(borrower, current, laneId, claimingAt)) return null
      if (await this.rows.replace(authority, [...claims, ...next])) {
        const after = await this.rows.request?.(requestId)
        if (after?.fleetCancellation) await this.reconcileFleetCancellation(requestId)
        if (!after || after.fleetCancellation || after.fleetBinding || after.hostId || after.input || after.inputSha256 ||
          after.state !== 'awaiting-runner' || after.fleetInputSha256 !== digest || !isDeepStrictEqual(after.fleetResourceAdmission, admission) ||
          after.fleetDeadline.getTime() <= this.now() ||
          !routineResourcesAvailable(borrower, after, laneId, this.now())) return null
        return fleetExclusiveReservationSchema.parse({origin, intent, intentSha256, claims: next})
      }
    }
    return null
  }
  /** A terminal request without executable input cannot later use a portable claim.
   * Once input exists, only the controller's normal release can return it, even if Core never received acceptance.
   */
  async reconcileFleetCancellation(requestId: string) {
    const row = await this.rows.request?.(requestId)
    if (!row || row.state !== 'terminal' || !row.fleetInputSha256 || row.input || row.inputSha256 || row.fleetExclusiveExecutionBinding) return
    const staged = fleetResourceAdmissionSchema.safeParse(row.fleetResourceAdmission)
    if (!staged.success || staged.data.intent.owner.id !== requestId || staged.data.intent.inputSha256 !== row.fleetInputSha256) return
    const admission = staged.data, origin = {kind: 'fleet' as const, fleetInputSha256: row.fleetInputSha256},
      digest = requestInputDigest({...admission.intent, controller: {incarnation: admission.intent.controller.incarnation,
        generation: admission.intent.controller.generation}, origin, dependencies: admission.dependencies})
    const rejection = preparationRejectionSchema.safeParse(row.preparationRejection), cancellation =
      z.object({requestedAt: z.string().datetime({offset: true}), reason: z.string().min(1).max(2000)}).strict().safeParse(row.preparationCancellation),
      intent = row.dispatchIntent as {requestId?: unknown; laneId?: unknown} | undefined,
      unbound = !row.fleetBinding && !row.hostId && !row.dispatchIntent && Boolean(row.fleetCancellation),
      bound = Boolean(row.fleetBinding && row.hostId === row.fleetBinding.hostId && intent?.requestId === requestId &&
        intent.laneId === row.fleetBinding.laneId && requestInputDigest(row.dispatchIntent) === row.dispatchIntentSha256 &&
        (cancellation.success || rejection.success && rejection.data.dispatchIntentSha256 === row.dispatchIntentSha256))
    if (!unbound && !bound) return
    const authorities = await this.rows.claimedHosts?.(requestId) ?? []
    if (authorities.length > 1) throw new TestRunError(409, 'One portable operation has conflicting resource authorities; custody is retained')
    for (const initial of authorities) for (let attempt = 0; attempt < 3; attempt++) {
      const authority = await this.host(initial.hostId), claims = hostResourceReservationsSchema.parse(authority.resourceReservations ?? []),
        own = claims.filter(isExclusiveHostReservation).filter(claim => claim.owner.id === requestId && claim.owner.kind === 'run' &&
          claim.operationId === `run:${requestId}` && claim.origin?.fleetInputSha256 === row.fleetInputSha256 && claim.inputSha256 === row.fleetInputSha256 &&
          claim.borrowerHostId === admission.intent.hostId && claim.laneId === admission.intent.laneId && claim.intentSha256 === digest &&
          claim.controllerIncarnation === admission.intent.controller.incarnation && claim.controllerGeneration === admission.intent.controller.generation &&
          claim.borrowerSequence === admission.intent.controller.sequence && admission.dependencies.some(dependency =>
            dependency.resourceId === claim.resourceId && dependency.authorityHostId === authority.hostId) &&
          (!bound || claim.borrowerHostId === row.hostId && claim.laneId === row.fleetBinding!.laneId))
      if (!own.length) break
      if (await this.rows.replace(authority, claims.filter(value => !own.some(claim => claim.id === value.id)))) break
      if (attempt === 2) throw new TestRunError(409, 'Resource authority changed during terminal pre-execution reconciliation')
    }
  }
  async acquire(value: unknown, hostId: string) {
    const intent = exclusiveResourceIntentSchema.parse(value)
    if (intent.hostId !== hostId) throw new TestRunError(409, 'Resource intent differs from authenticated controller')
    if (intent.prerequisite?.kind === 'resource-readiness') return this.acquireGraphPrerequisite(intent, hostId)
    if (intent.resourceCheck) return this.acquireResourceCheck(intent, hostId)
    if (intent.prerequisite) return this.acquireBackendPrerequisite(intent, hostId)
    const borrower = await this.host(hostId)
    if (borrower.snapshot.resourceReservations?.resourceChecks !== undefined && intent.owner.kind === 'boundary-cleanup' &&
      intent.resources.some(resource => resource.capabilities.includes('resource-idle')))
      throw new TestRunError(409, 'New automatic resource checks require their frozen precheck authority')
    if (!fresh(borrower, this.now()) || borrower.incarnation !== intent.controller.incarnation ||
      borrower.incarnationGeneration !== intent.controller.generation || borrower.sequence !== intent.controller.sequence)
      throw new TestRunError(409, 'Resource reservation requires the current reporting controller observation')
    const selected = dependencies(borrower, intent),
      intentSha256 = requestInputDigest({...intent, controller: {incarnation: intent.controller.incarnation,
        generation: intent.controller.generation}, dependencies: selected})
    // A single operation uses one authority transaction. Cross-authority atomic intent is intentionally not advertised.
    if (new Set(selected.map(dependency => dependency.authorityHostId)).size > 1)
      throw new TestRunError(409, 'Exclusive dependencies require one existing host authority per operation')
    if (!selected.length) return {status: 'reserved' as const, intentSha256, claims: []}
    for (let attempt = 0; attempt < 3; attempt++) {
      const authority = await this.host(selected[0]!.authorityHostId)
      if (selected.some(dependency => !dependencyEnrolled(authority,dependency)))
        throw new TestRunError(409, 'Selected authority has not enrolled this canonical resource dependency')
      const claims = hostResourceReservationsSchema.parse(authority.resourceReservations ?? []),
        current = claims.filter(isExclusiveHostReservation).filter(claim => selected.some(value => value.resourceId === claim.resourceId)),
        blocked = current.find(claim => claim.intentSha256 !== intentSha256 || claim.borrowerHostId !== hostId || claim.operationId !== intent.operationId)
      if (blocked) return {status: 'waiting' as const, intentSha256, claims: [],
        blocked: {resourceId: blocked.resourceId, hostId: blocked.borrowerHostId, laneId: blocked.laneId, owner: blocked.owner}}
      const missing = selected.filter(dependency => !current.some(claim => claim.resourceId === dependency.resourceId))
      if (!missing.length) return {status: 'reserved' as const, intentSha256, claims: current}
      if(missing.some(dependency=>!dependencyAvailable(authority,dependency,this.now())))
        return {status:'waiting' as const,intentSha256,claims:[],blocked:undefined};
      if (claims.length + missing.length > 1000) throw new TestRunError(409, 'Resource authority is full; unresolved claims retain custody')
      const next: ExclusiveHostReservation[] = missing.map(dependency => ({kind: 'exclusive', id: randomUUID(),
        resourceId: dependency.resourceId, authorityHostId: authority.hostId, borrowerHostId: hostId, laneId: intent.laneId,
        operationId: intent.operationId, intentSha256, inputSha256: intent.inputSha256, owner: intent.owner,
        controllerIncarnation: borrower.incarnation, controllerGeneration: borrower.incarnationGeneration,
        borrowerSequence: borrower.sequence, reservedAt: new Date(this.now()).toISOString()}))
      if (await this.rows.replace(authority, [...claims, ...next]))
        return {status: 'reserved' as const, intentSha256, claims: [...current, ...next]}
    }
    throw new TestRunError(409, 'Resource authority changed; retry the unchanged reservation intent')
  }
  /** Recover the exact old claim. Prerequisite absence requires a newer reporter and a host CAS barrier. */
  async observe(value: unknown, hostId: string) {
    if (typeof value === 'object' && value !== null && 'fleetExclusive' in value) return this.observeFleet(value, hostId)
    const input = exclusiveResourceObservationInputSchema.parse(value), intent = input.intent
    if (intent.hostId !== hostId) throw new TestRunError(409, 'Original resource intent differs from authenticated controller')
    const borrower = await this.host(hostId)
    if (!fresh(borrower, this.now()) || borrower.incarnation !== input.controller.incarnation ||
      borrower.incarnationGeneration !== input.controller.generation || borrower.sequence !== input.controller.sequence ||
      input.controller.generation < intent.controller.generation ||
      input.controller.generation === intent.controller.generation && input.controller.incarnation !== intent.controller.incarnation)
      throw new TestRunError(409, 'Original claim observation requires the current reporting controller')
    if (intent.prerequisite?.kind === 'resource-readiness') return this.observeGraphPrerequisite(intent, borrower, input.controller)
    if (intent.resourceCheck) return this.observeResourceCheck(intent, borrower, input.controller)
    if (intent.prerequisite) {
      const intentSha256 = this.backendIntentDigest(intent), all = hostResourceReservationsSchema.parse(borrower.resourceReservations ?? []),
        claims = all.filter(isExclusiveHostReservation).filter(claim => claim.resourceId === intent.prerequisite!.resourceId),
        unknown = {status: 'unknown' as const, intentSha256, claims: []}
      if (claims.length) return claims.length === 1 && this.backendClaimMatches(claims[0]!, intent, intentSha256) ?
        {status: 'reserved' as const, intentSha256, claims} : unknown
      const newer = input.controller.generation > intent.controller.generation ||
        input.controller.generation === intent.controller.generation && input.controller.sequence > intent.controller.sequence,
        subject = borrower.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === intent.prerequisite!.resourceId)
      // A still-owned original check can reconcile a pre-CAS report race through
      // this same intent. Existing claim recovery above wins first; released or
      // replaced checks cannot enter the guarded acquisition transaction.
      if (input.controller.generation === intent.controller.generation && input.controller.incarnation === intent.controller.incarnation &&
        subject?.current && subject.status === 'checking' && subject.owner?.kind === 'boundary-cleanup' &&
        subject.owner.id === intent.owner.id && subject.owner.laneId === intent.laneId) {
        const recovered = await this.acquireBackendPrerequisite(intent, hostId)
        return recovered.status === 'reserved' ? recovered : unknown
      }
      if (!newer || !subject?.current || subject.generation <= 0 || subject.owner !== null || subject.subject.authorityHostId !== hostId ||
        borrower.snapshot.frameworkBinding?.routineApiVersion === undefined || borrower.snapshot.frameworkBinding.routineApiVersion < BACKEND_CONNECTIVITY_ROUTINE_API_VERSION ||
        !borrower.snapshot.lanes.some(lane => lane.id === intent.laneId && lane.platform === 'android' && lane.resources.some(resource =>
          resource.id === intent.prerequisite!.resourceId && resource.kind === 'phone' && resource.capabilities?.includes('backend-connectivity')))) return unknown
      // All original acquisition writes carry an older reporter/version fence. Preserve all
      // custody and invalidate those writes before returning authoritative absence.
      if (!await this.rows.replace(borrower, all)) return unknown
      const after = await this.host(hostId), version = (borrower.resourceReservationVersion ?? 0) + 1,
        currentSubject = after.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === intent.prerequisite!.resourceId)
      if (!Number.isSafeInteger(version) || !fresh(after, this.now()) || after.incarnation !== input.controller.incarnation ||
        after.incarnationGeneration !== input.controller.generation || after.sequence !== input.controller.sequence ||
        after.resourceReservationVersion !== version || !isDeepStrictEqual(hostResourceReservationsSchema.parse(after.resourceReservations ?? []), all) ||
        !currentSubject?.current || currentSubject.owner !== null || currentSubject.subject.authorityHostId !== hostId ||
        currentSubject.generation !== subject.generation || !isDeepStrictEqual(after.snapshot.frameworkBinding, borrower.snapshot.frameworkBinding)) return unknown
      return {status: 'not-acquired' as const, intentSha256, claims: [], fence: {hostId, resourceId: intent.prerequisite.resourceId,
        controller: input.controller, resourceReservationVersion: version, subjectGeneration: subject.generation}}
    }
    const selected = dependencies(borrower, intent, true), intentSha256 = requestInputDigest({...intent,
      controller: {incarnation: intent.controller.incarnation, generation: intent.controller.generation}, dependencies: selected})
    if (!selected.length || new Set(selected.map(dependency => dependency.authorityHostId)).size !== 1)
      throw new TestRunError(409, 'Original exclusive claim observation requires its unchanged canonical authority')
    const authority = await this.host(selected[0]!.authorityHostId), claims = hostResourceReservationsSchema.parse(authority.resourceReservations ?? [])
      .filter(isExclusiveHostReservation).filter(claim => selected.some(dependency => dependency.resourceId === claim.resourceId))
    const matches = selected.every(dependency => dependencyEnrolled(authority,dependency)) &&
      claims.length === selected.length && claims.every(claim => claim.authorityHostId === authority.hostId && claim.intentSha256 === intentSha256 &&
      claim.borrowerHostId === hostId && claim.laneId === intent.laneId && claim.operationId === intent.operationId &&
      claim.inputSha256 === intent.inputSha256 && isDeepStrictEqual(claim.owner, intent.owner) &&
      claim.controllerIncarnation === intent.controller.incarnation && claim.controllerGeneration === intent.controller.generation &&
      claim.borrowerSequence === intent.controller.sequence)
    return matches ? {status: 'reserved' as const, intentSha256, claims} : {status: 'unknown' as const, intentSha256, claims: []}
  }
  private async observeFleet(value: unknown, hostId: string) {
    const input = fleetExclusiveObservationSchema.parse(value), reservation = input.fleetExclusive.reservation, intent = reservation.intent,
      borrower = await this.host(hostId), row = await this.rows.request?.(intent.owner.id)
    if (intent.hostId !== hostId || !fresh(borrower, this.now()) || borrower.incarnation !== input.controller.incarnation ||
      borrower.incarnationGeneration !== input.controller.generation || borrower.sequence !== input.controller.sequence ||
      input.controller.generation < intent.controller.generation || input.controller.generation === intent.controller.generation &&
      input.controller.incarnation !== intent.controller.incarnation)
      throw new TestRunError(409, 'Portable claim observation requires the current authenticated selected controller')
    const unknown = {status: 'unknown' as const, intentSha256: reservation.intentSha256, claims: []}
    if (!row?.fleetResourceAdmission || !row.fleetExclusiveReservation || !row.fleetExclusiveExecutionBinding || row.fleetInputSha256 !== reservation.origin.fleetInputSha256 ||
      row.hostId !== hostId || row.fleetBinding?.laneId !== intent.laneId || row.dispatchIntentSha256 !== input.fleetExclusive.binding.dispatchIntentSha256 ||
      row.inputSha256 !== input.fleetExclusive.binding.executionInputSha256 || !row.input ||
      !isDeepStrictEqual(fleetExclusiveReservationSchema.parse(row.fleetExclusiveReservation), reservation) ||
      !isDeepStrictEqual(fleetExclusiveExecutionBindingSchema.parse(row.fleetExclusiveExecutionBinding), input.fleetExclusive.binding)) return unknown
    const executable = frameworkRequestInputSchema.parse(row.input)
    assertFleetResourceAdmission(row.fleetResourceAdmission, row.requestId, hostId, executable, reservation)
    if (requestInputDigest(executable) !== row.inputSha256 || !isDeepStrictEqual(fleetResourceExecutionBinding(reservation,
      row.requestId, hostId, row.dispatchIntentSha256!, executable, row.inputSha256), input.fleetExclusive.binding)) return unknown
    const selected = dependencies(borrower, intent, true)
    if (!selected.length || new Set(selected.map(value => value.authorityHostId)).size !== 1 ||
      selected.length !== reservation.claims.length || selected.some(dependency => !reservation.claims.some(claim =>
        claim.resourceId === dependency.resourceId && claim.authorityHostId === dependency.authorityHostId))) return unknown
    const authority = await this.host(selected[0]!.authorityHostId), claims = hostResourceReservationsSchema.parse(authority.resourceReservations ?? [])
    const enrolled = selected.every(dependency => dependencyEnrolled(authority,dependency))
    return enrolled && reservation.claims.every(claim => claims.some(value => isDeepStrictEqual(value, claim))) ?
      {status: 'reserved' as const, intentSha256: reservation.intentSha256, claims: reservation.claims} : unknown
  }
  async giveBack(value: unknown, hostId: string) {
    const returned = exclusiveResourceReturnSchema.parse(value), borrower = await this.host(hostId), release = returned.release
    if (returned.originalOwner.id === `resource-graph:${returned.inputSha256}`)
      return this.giveBackGraphPrerequisite(returned, borrower, hostId)
    if ('kind' in release && (release.kind === 'resource-check-not-started' ||
      borrower.snapshot.resourceReservations?.resourceChecks?.some(journal => journal.operationId === release.operationId &&
        journal.intentSha256 === returned.intentSha256)))
      return this.giveBackResourceCheck(returned, borrower, hostId)
    if ('kind' in returned.release) return this.giveBackBackendPrerequisite(returned, borrower, hostId)
    const lane = borrower.snapshot.lanes.find(value => value.id === returned.laneId), releasedAt = Date.parse(returned.release.releasedAt)
    if (!fresh(borrower, this.now()) || borrower.incarnation !== returned.controller.incarnation ||
      borrower.incarnationGeneration !== returned.controller.generation || borrower.sequence !== returned.controller.sequence ||
      !lane || lane.state !== 'idle' || lane.activity || Date.parse(borrower.snapshot.observedAt) < releasedAt ||
      returned.release.eventId !== `lane-release:${returned.release.owner.id}:${returned.release.owner.generation}` ||
      !borrower.snapshot.resourceReservations?.returns.some(receipt =>
        isDeepStrictEqual(receipt, (({controller: _, ...proof}) => proof)(returned))) ||
      !returned.release.lineage.some(owner => isDeepStrictEqual({id: owner.id, kind: owner.kind}, returned.originalOwner)) ||
      !isDeepStrictEqual(returned.release.lineage.at(-1), returned.release.owner) ||
      returned.release.lineage.some((owner, index, lineage) => index > 0 && owner.generation <= lineage[index - 1]!.generation) ||
      returned.release.neverStarted && (returned.originalOwner.kind !== 'run' ||
        returned.release.neverStarted.requestId !== returned.originalOwner.id || returned.release.lineage.length !== 1 ||
        !isDeepStrictEqual({...returned.originalOwner, generation: returned.release.owner.generation}, returned.release.owner)))
      throw new TestRunError(409, 'Return requires fresh idle custody and its exact recorded normal local release lineage')
    for (let attempt = 0; attempt < 3; attempt++) {
      const authority = await this.host(returned.authorityHostId), claims = hostResourceReservationsSchema.parse(authority.resourceReservations ?? [])
      if (authority.hostId === hostId && (authority.incarnation !== returned.controller.incarnation ||
        authority.incarnationGeneration !== returned.controller.generation || authority.sequence !== returned.controller.sequence))
        throw new TestRunError(409, 'Resource authority changed; retry the same normal return proof')
      const claim = claims.filter(isExclusiveHostReservation).find(value => value.resourceId === returned.resourceId)
      if (!claim) {
        return {status: 'returned' as const, claimId: returned.claimId}
      }
      const independent = claim.resourceCheck && !claim.laneId && !claim.prerequisite,
        subject = borrower.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === claim.resourceId),
        ref = borrower.snapshot.resources?.find(value => value.id === claim.resourceId), checkedAt = Date.parse(subject?.idle.checkedAt ?? '')
      const installed = ref ?? borrower.snapshot.lanes.find(value => value.id === claim.laneId)?.resources.find(value => value.id === claim.resourceId)
      const freshBaseline = !!installed?.idleContract && !!subject?.current && subject.subject.authorityHostId === hostId && !(independent && subject.resource.memberships.length) &&
        subject.owner === null && subject.status === 'idle' && subject.idle.outcome === 'passed' && subject.idle.acceptedCheck?.subjectGeneration === subject.generation &&
        subject.idle.qualifiedScope.kind !== 'unqualified' && Number.isFinite(checkedAt) && checkedAt <= this.now() &&
        this.now() - checkedAt <= installed.idleContract.maximumAgeMs && checkedAt >= Date.parse(claim.reservedAt)
      if (claim.resourceCheck && (subject?.repair.state !== 'none' || !freshBaseline && !closedNormalResourceReturn(authority, claim, returned)))
        throw new TestRunError(409, 'Independent resource return lacks its exact fresh normal baseline')
      if (claim.prerequisite || claim.id !== returned.claimId || claim.intentSha256 !== returned.intentSha256 || claim.inputSha256 !== returned.inputSha256 ||
        claim.borrowerHostId !== hostId || !independent && claim.laneId !== returned.laneId || !isDeepStrictEqual(claim.owner, returned.originalOwner) ||
        returned.release.neverStarted && claim.operationId !== `run:${returned.release.neverStarted.requestId}` ||
        releasedAt < Date.parse(claim.reservedAt) || returned.controller.generation < claim.controllerGeneration ||
        returned.controller.generation === claim.controllerGeneration && (returned.controller.incarnation !== claim.controllerIncarnation ||
          returned.controller.sequence <= claim.borrowerSequence))
        throw new TestRunError(409, 'Return proof differs from the retained original resource authority')
      if (claim.origin) {
        const row = await this.rows.request?.(claim.owner.id)
        if (!row?.fleetResourceAdmission || !row.fleetExclusiveReservation || !row.fleetExclusiveExecutionBinding || !row.input || !row.inputSha256 ||
          row.fleetInputSha256 !== claim.origin.fleetInputSha256 || row.hostId !== hostId || row.fleetBinding?.laneId !== claim.laneId ||
          !row.fleetExclusiveReservation.claims.some(value => isDeepStrictEqual(value, claim)) ||
          !isDeepStrictEqual(fleetResourceExecutionBinding(row.fleetExclusiveReservation, row.requestId, hostId,
            row.dispatchIntentSha256!, frameworkRequestInputSchema.parse(row.input), row.inputSha256), row.fleetExclusiveExecutionBinding))
          throw new TestRunError(409, 'Portable resource return requires its original committed executable binding')
        assertFleetResourceAdmission(row.fleetResourceAdmission, row.requestId, hostId,
          frameworkRequestInputSchema.parse(row.input), row.fleetExclusiveReservation)
        if (returned.release.neverStarted && !(row.hostCancellation || row.fleetCancellation || row.state === 'terminal' && row.terminalStatus === 'cancelled'))
          throw new TestRunError(409, 'Never-started portable resource return requires the matching Core cancellation')
      }
      if (await this.rows.replace(authority, claims.filter(value => value !== claim)))
        return {status: 'returned' as const, claimId: claim.id}
    }
    throw new TestRunError(409, 'Resource authority changed; retry the same normal return proof')
  }

  private backendIntentDigest(intent: ExclusiveResourceIntent) {
    return requestInputDigest({...intent, controller: {incarnation: intent.controller.incarnation, generation: intent.controller.generation},
      dependencies: [{resourceId: intent.prerequisite!.resourceId, authorityHostId: intent.hostId, capability: 'backend-connectivity'}]})
  }
  private resourceCheckIntentDigest(intent: ExclusiveResourceIntent) {
    return requestInputDigest({...intent, controller: {incarnation: intent.controller.incarnation, generation: intent.controller.generation},
      dependencies: [{resourceId: intent.resourceCheck!.resourceId, authorityHostId: intent.hostId,
        capability: intent.prerequisite ? 'backend-connectivity' : 'resource-idle'}]})
  }
  private resourceCheckClaimMatches(claim: ExclusiveHostReservation, intent: ExclusiveResourceIntent, digest: string) {
    return claim.intentSha256 === digest && claim.operationId === intent.operationId && claim.inputSha256 === intent.inputSha256 &&
      claim.authorityHostId === intent.hostId && claim.borrowerHostId === intent.hostId && claim.laneId === intent.laneId &&
      claim.resourceId === intent.resourceCheck!.resourceId && isDeepStrictEqual(claim.owner, intent.owner) && !claim.origin &&
      isDeepStrictEqual(claim.resourceCheck, intent.resourceCheck) && isDeepStrictEqual(claim.prerequisite, intent.prerequisite) &&
      claim.controllerIncarnation === intent.controller.incarnation && claim.controllerGeneration === intent.controller.generation &&
      claim.borrowerSequence === intent.controller.sequence
  }
  private resourceCheckJournal(host: ResourceReservationHost, intent: ExclusiveResourceIntent) {
    const digest = this.resourceCheckIntentDigest(intent), rows = host.snapshot.resourceReservations?.resourceChecks?.filter(value =>
      value.operationId === intent.operationId)
    return rows?.length === 1 && rows[0]!.resourceId === intent.resourceCheck!.resourceId && rows[0]!.intentSha256 === digest &&
      isDeepStrictEqual(rows[0]!.resourceCheck, intent.resourceCheck) && isDeepStrictEqual(rows[0]!.intent, intent) ? rows[0] : undefined
  }
  /** A stopped baseline retains its claim while repair waits for its passive dependency.
   * Only this installed passive dependency check may share the otherwise idle lane.
   * Prepared app intent and accepted failed-check history are producer-validated
   * settlement facts; an unknown check without an accepted result is not one. */
  private queuedDependencyClaims(host: ResourceReservationHost, intent: ExclusiveResourceIntent, acquired?: ExclusiveHostReservation): Set<string> | undefined {
    if (intent.prerequisite || !intent.laneId) return undefined
    const lane = host.snapshot.lanes.find(value => value.id === intent.laneId), lifecycle = host.snapshot.resourceLifecycle,
      now = this.now(), target = intent.resourceCheck!.resourceId
    if (!lane || !['idle', 'offline'].includes(lane.state) || lane.activity || lane.dispatchMode !== 'automatic' || !lifecycle) return undefined
    const installed = [...lane.resources, ...host.snapshot.resources ?? []], visited = new Set<string>(),
      passivePhone = lane.platform === 'android' && installed.find(ref => ref.id === target)?.kind === 'phone'
    const scopeCurrent = (id: string): boolean => {
      if (visited.has(id)) return false
      visited.add(id)
      const ref = installed.find(value => value.id === id), subject = lifecycle.subjects.find(value => value.subject.id === id),
        contract = ref?.idleContract
      if (!contract || !subject?.current || ref.kind !== subject.resource.kind || subject.subject.authorityHostId !== host.hostId ||
        subject.owner || subject.repair.state !== 'none' || !subject.supportedActions.includes('mark-out-of-service') ||
        !['idle', 'unknown'].includes(subject.status) || !subject.observedAt ||
        Date.parse(subject.observedAt) > Date.parse(host.snapshot.observedAt) ||
        !fresh({...host, snapshot: {...host.snapshot, observedAt: subject.observedAt}}, now) ||
        contract.version !== 'installed-resource-baseline-v1' || subject.idle.contractVersion !== contract.version ||
        contract.qualifiedScope.kind !== 'same-controller' || contract.qualifiedScope.controllerId !== host.hostId ||
        !isDeepStrictEqual(subject.idle.qualifiedScope, contract.qualifiedScope) || ref.exclusiveDependencies?.length ||
        subject.resource.dependencies.length || subject.resource.memberships.length !== 1 ||
        subject.resource.memberships[0]!.hostId !== host.hostId || subject.resource.memberships[0]!.laneId !== lane.id) return false
      const appConditions = lane.platform === 'android' ? ['app-phone-identity', 'app-phone-same-boot', 'app-package-absent', 'app-process-absent', 'app-data-absent'] :
        ['app-managed-processes-absent', 'app-managed-storage-absent'],
        conditions = !passivePhone && id === target ? appConditions : ['phone-identity', 'phone-same-boot', 'phone-default-network', 'phone-network-stable'],
        dependencies = contract.dependencies ?? []
      if (ref.kind !== (!passivePhone && id === target ? 'app' : 'phone') || contract.conditions.length !== conditions.length ||
        !conditions.every(condition => contract.conditions.includes(condition))) return false
      if (!passivePhone && id === target && lane.platform === 'android') return dependencies.length === 1 && scopeCurrent(dependencies[0]!)
      return dependencies.length === 0
    }
    if (!scopeCurrent(target)) return undefined
    const controls = z.array(z.union([laneControlRecordSchema, resourceControlRecordSchema])).max(100).parse(host.laneControls ?? [])
    if (controls.some(row => 'subject' in row.command && visited.has(row.command.subject.resourceId) &&
      (!row.receipt || row.receipt.result.status === 'accepted' &&
        (row.receipt.result.reservation && ['waiting', 'granted', 'returning'].includes(row.receipt.result.reservation.state) ||
          'check' in row.receipt.result && row.receipt.result.check?.state !== undefined && row.receipt.result.check.state !== 'settled' ||
          manualWithdrawalNeedsRestoration(row as ResourceControlRecord,
            lifecycle.subjects.find(value => value.subject.id === (row.command as ResourceControlRecord['command']).subject.resourceId), host.hostId, true, now)))))
      return undefined
    const all = hostResourceReservationsSchema.parse(host.resourceReservations ?? []).filter(claim => !acquired || !isDeepStrictEqual(claim, acquired)),
      retained = all.filter(isExclusiveHostReservation)
    if (retained.some(claim => visited.has(claim.resourceId))) return undefined
    const claims = retained.filter(claim => claim.laneId === lane.id), admitted = new Set<string>()
    for (const claim of claims) {
      const check = claim.resourceCheck, subject = lifecycle.subjects.find(value => value.subject.id === claim.resourceId),
        ref = lane.resources.find(value => value.id === claim.resourceId), accepted = subject?.idle.acceptedCheck,
        journals = host.snapshot.resourceReservations?.resourceChecks?.filter(value => value.operationId === claim.operationId),
        journal = journals?.length === 1 ? journals[0] : undefined, contract = ref?.idleContract
      if (!check || claim.authorityHostId !== host.hostId || claim.prerequisite || claim.origin || !subject?.current || !subject.observedAt || !contract ||
        ref.kind !== (passivePhone ? 'app' : 'fixture-data') || subject.resource.kind !== ref.kind || subject.subject.authorityHostId !== host.hostId ||
        !isDeepStrictEqual(subject.owner && {id: subject.owner.id, kind: subject.owner.kind}, claim.owner) ||
        !Number.isSafeInteger(subject.owner?.generation) || subject.owner!.hostId !== host.hostId ||
        subject.owner!.laneId !== undefined && subject.owner!.laneId !== lane.id ||
        subject.status !== 'in-repair' || subject.repair.state !== 'queued' || !subject.repair.configured ||
        !subject.supportedActions.includes('mark-out-of-service') ||
        subject.repair.executionId || subject.repair.interruptionId || !accepted || !['failed', 'unknown'].includes(subject.idle.outcome) ||
        subject.idle.contractVersion !== check.contractVersion || contract.version !== check.contractVersion ||
        contract.version !== 'installed-resource-baseline-v1' || !contract.repairConfigured ||
        contract.qualifiedScope.kind !== 'same-controller' || contract.qualifiedScope.controllerId !== host.hostId ||
        !isDeepStrictEqual(subject.idle.qualifiedScope, contract.qualifiedScope) ||
        contract.conditions.length !== (passivePhone ? 5 : 2) || !(passivePhone ?
          ['app-phone-identity', 'app-phone-same-boot', 'app-package-absent', 'app-process-absent', 'app-data-absent'] :
          ['fixture-owned-effects-returned', 'fixture-native-children-settled']).every(id => contract.conditions.includes(id)) ||
        contract.dependencies?.length !== 1 || contract.dependencies[0] !== target || ref.exclusiveDependencies?.length ||
        subject.resource.dependencies.some(id => id !== target) || subject.resource.memberships.length !== 1 ||
        subject.resource.memberships[0]!.hostId !== host.hostId || subject.resource.memberships[0]!.laneId !== lane.id ||
        !journal || journal.state !== 'began' || !this.resourceCheckClaimMatches(claim, journal.intent, this.resourceCheckIntentDigest(journal.intent)) ||
        !isDeepStrictEqual(this.resourceCheckJournal(host, journal.intent), journal) || accepted.operationId !== claim.operationId ||
        accepted.subjectGeneration <= check.subjectGeneration || accepted.subjectGeneration + 1 !== subject.generation ||
        Date.parse(accepted.acceptedAt) < Date.parse(claim.reservedAt) ||
        // A late producer-accepted UNKNOWN and queued repair prove ceased work,
        // not a timely result. Only the Android app's passive phone may proceed.
        Date.parse(accepted.acceptedAt) > check.deadlineAt && (!passivePhone || subject.idle.outcome !== 'unknown') ||
        Date.parse(journal.observedAt) > Date.parse(accepted.acceptedAt) ||
        Date.parse(subject.observedAt) > Date.parse(host.snapshot.observedAt) ||
        !fresh({...host, snapshot: {...host.snapshot, observedAt: subject.observedAt}}, now) ||
        passivePhone && (claim.controllerGeneration !== host.incarnationGeneration || claim.controllerIncarnation !== host.incarnation) ||
        claim.controllerGeneration > host.incarnationGeneration || claim.controllerGeneration === host.incarnationGeneration &&
          (claim.controllerIncarnation !== host.incarnation || claim.borrowerSequence > host.sequence)) return undefined
      const failure = lifecycle.history.filter(event => event.resourceId === claim.resourceId &&
        event.event === `check-${subject.idle.outcome}` && event.subjectGeneration === accepted.subjectGeneration && event.at === accepted.acceptedAt),
        queued = lifecycle.history.filter(event => event.resourceId === claim.resourceId && event.event === 'repair-queued' && event.subjectGeneration === subject.generation)
      if (failure.length !== 1 || queued.length !== 1 || Date.parse(queued[0]!.at) < Date.parse(accepted.acceptedAt) ||
        Date.parse(queued[0]!.at) > Date.parse(subject.observedAt)) return undefined
      if (passivePhone && controls.some(row => 'subject' in row.command && row.command.subject.resourceId === claim.resourceId &&
        (!row.receipt || row.receipt.result.status === 'accepted' &&
          (row.receipt.result.reservation && ['waiting', 'granted', 'returning'].includes(row.receipt.result.reservation.state) ||
            'check' in row.receipt.result && row.receipt.result.check && row.receipt.result.check.state !== 'settled' &&
              row.receipt.result.check.operationId !== claim.operationId ||
            manualWithdrawalNeedsRestoration(row as ResourceControlRecord, subject, host.hostId, true, now))))) return undefined
      admitted.add(claim.id)
    }
    return admitted.size ? admitted : undefined
  }
  /** Only an original resource-check repair may share controller capacity with a disjoint baseline.
   * The installed controller still checks its complete native/repair history before preparing
   * this intent and again before dispatch. Reported claim IDs alone are not physical scope. */
  private disjointResourceCheckRepairClaims(host: ResourceReservationHost, intent: ExclusiveResourceIntent): Set<string> | undefined {
    if (intent.prerequisite || !intent.laneId) return undefined
    const lane = host.snapshot.lanes.find(value => value.id === intent.laneId), activity = lane?.activity,
      lifecycle = host.snapshot.resourceLifecycle, now = this.now()
    if (!lane || lane.state !== 'in-repair' || lane.dispatchMode !== 'automatic' || activity?.owner.kind !== 'fixer' || !lifecycle) return undefined
    const owned = lifecycle.subjects.filter(subject => subject.owner?.id === activity.owner.id)
    if (!owned.length || owned.some(subject => !subject.current || subject.subject.authorityHostId !== host.hostId ||
      subject.subject.id === intent.resourceCheck!.resourceId || subject.owner?.kind !== 'fixer' ||
      subject.owner.hostId !== host.hostId || subject.owner.laneId !== lane.id || subject.owner.generation !== activity.generation ||
      subject.status !== 'in-repair' || subject.repair.state !== 'running' || !subject.repair.configured ||
      !subject.repair.interruptionId || subject.repair.executionId !== activity.owner.id || !subject.observedAt ||
      Date.parse(subject.observedAt) > Date.parse(host.snapshot.observedAt) ||
      !fresh({...host, snapshot: {...host.snapshot, observedAt: subject.observedAt}}, now))) return undefined
    const ids = new Set(owned.map(subject => subject.subject.id)), installed = [...lane.resources, ...host.snapshot.resources ?? []]
    if (owned.some(subject => {
      const ref = installed.find(value => value.id === subject.subject.id)
      return !ref || ref.kind !== subject.resource.kind || !ref.idleContract ||
        ref.idleContract.qualifiedScope.kind === 'unqualified' ||
        [...ref.idleContract.dependencies ?? [], ...subject.resource.dependencies].some(id => !ids.has(id)) ||
        ref.exclusiveDependencies?.some(dependency => dependency.authorityHostId !== host.hostId || !ids.has(dependency.resourceId))
    })) return undefined
    // The target's own declared scope must also be disjoint. A scarce claim ID
    // alone cannot exclude a secondary or transitive baseline dependency.
    const visited = new Set<string>(), visiting = new Set<string>()
    const targetDisjoint = (id: string): boolean => {
      if (ids.has(id) || visiting.has(id)) return false
      if (visited.has(id)) return true
      const ref = installed.find(value => value.id === id), subject = lifecycle.subjects.find(value => value.subject.id === id)
      if (!ref?.idleContract || !subject?.current || subject.subject.authorityHostId !== host.hostId ||
        ref.kind !== subject.resource.kind || subject.owner || !subject.observedAt ||
        Date.parse(subject.observedAt) > Date.parse(host.snapshot.observedAt) ||
        !fresh({...host, snapshot: {...host.snapshot, observedAt: subject.observedAt}}, now) ||
        ref.exclusiveDependencies?.some(dependency => dependency.authorityHostId !== host.hostId)) return false
      visiting.add(id)
      const disjoint = [...ref.idleContract.dependencies ?? [], ...subject.resource.dependencies,
        ...ref.exclusiveDependencies?.map(dependency => dependency.resourceId) ?? []].every(targetDisjoint)
      visiting.delete(id); if (disjoint) visited.add(id)
      return disjoint
    }
    if (!targetDisjoint(intent.resourceCheck!.resourceId)) return undefined
    const retained = hostResourceReservationsSchema.parse(host.resourceReservations ?? []).filter(isExclusiveHostReservation)
    if (retained.some(claim => visited.has(claim.resourceId))) return undefined
    const claims = retained.filter(claim => claim.borrowerHostId === host.hostId && claim.laneId === lane.id)
    // Operator checks have no Core preclaim, but their exact failed-check repair
    // still supplies the same current resource lifecycle transfer authority.
    const roots = owned.filter(subject => lifecycle.history.some(event => event.resourceId === subject.subject.id &&
      event.event === 'repair-started' && event.subjectGeneration === subject.generation && event.ownerId === activity.owner.id &&
      event.ownerGeneration === activity.generation && event.hostId === host.hostId && event.laneId === lane.id &&
      Date.parse(event.at) <= Date.parse(subject.observedAt!) && Date.parse(event.at) <= now &&
      subject.idle.acceptedCheck && subject.idle.acceptedCheck.subjectGeneration < event.subjectGeneration &&
      Date.parse(subject.idle.acceptedCheck.acceptedAt) <= Date.parse(event.at) &&
      lifecycle.history.some(failure => failure.resourceId === subject.subject.id &&
        ['check-failed', 'check-unknown'].includes(failure.event) &&
        failure.subjectGeneration === subject.idle.acceptedCheck!.subjectGeneration &&
        failure.at === subject.idle.acceptedCheck!.acceptedAt)))
    if (!roots.length || owned.some(subject => !roots.some(root =>
      root.subject.id === subject.subject.id || root.resource.dependencies.includes(subject.subject.id) ||
      installed.find(ref => ref.id === root.subject.id)?.idleContract?.dependencies?.includes(subject.subject.id)))) return undefined
    const admitted = new Set<string>()
    for (const claim of claims) {
      const subject = owned.find(value => value.subject.id === claim.resourceId), check = claim.resourceCheck,
        journals = host.snapshot.resourceReservations?.resourceChecks?.filter(value => value.operationId === claim.operationId),
        journal = journals?.length === 1 ? journals[0] : undefined
      if (!subject || !check || claim.prerequisite || claim.origin || !journal || journal.state !== 'began' ||
        !this.resourceCheckClaimMatches(claim, journal.intent, this.resourceCheckIntentDigest(journal.intent)) ||
        !isDeepStrictEqual(journal.resourceCheck, check) || !isDeepStrictEqual(this.resourceCheckJournal(host, journal.intent), journal) ||
        subject.idle.acceptedCheck?.operationId !== claim.operationId || subject.idle.contractVersion !== check.contractVersion ||
        claim.controllerIncarnation !== host.incarnation || claim.controllerGeneration !== host.incarnationGeneration ||
        claim.borrowerSequence > host.sequence) return undefined
      const transfer = lifecycle.history.filter(event => event.resourceId === claim.resourceId && event.event === 'repair-started' &&
        event.subjectGeneration === subject.generation && event.ownerId === activity.owner.id && event.ownerGeneration === activity.generation &&
        event.hostId === host.hostId && event.laneId === lane.id)
      if (transfer.length !== 1 || subject.generation <= check.subjectGeneration ||
        subject.idle.acceptedCheck!.subjectGeneration <= check.subjectGeneration ||
        subject.idle.acceptedCheck!.subjectGeneration > subject.generation ||
        Date.parse(subject.idle.acceptedCheck!.acceptedAt) < Date.parse(claim.reservedAt) ||
        Date.parse(subject.idle.acceptedCheck!.acceptedAt) > Date.parse(transfer[0]!.at) ||
        Date.parse(transfer[0]!.at) < Date.parse(claim.reservedAt) ||
        Date.parse(journal.observedAt) > Date.parse(transfer[0]!.at) || Date.parse(transfer[0]!.at) > Date.parse(host.snapshot.observedAt) ||
        Date.parse(transfer[0]!.at) > now) return undefined
      admitted.add(claim.id)
    }
    return admitted
  }
  /** New automatic checks contend with queued manual authority before changing any local generation. */
  private async resourceCheckTargetCurrent(host: ResourceReservationHost, intent: ExclusiveResourceIntent) {
    const check = intent.resourceCheck!, now = this.now(), lane = host.snapshot.lanes.find(value => value.id === intent.laneId),
      subject = host.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === check.resourceId), journal = this.resourceCheckJournal(host, intent),
      ref = intent.laneId ? lane?.resources.find(value => value.id === check.resourceId) : host.snapshot.resources?.find(value => value.id === check.resourceId),
      disjointRepair = !intent.prerequisite && this.disjointResourceCheckRepairClaims(host, intent),
      baselineLane = (!intent.prerequisite && lane?.state === 'offline' && !lane.activity) || Boolean(disjointRepair)
    if (!fresh(host, now) || host.incarnation !== intent.controller.incarnation || host.incarnationGeneration !== intent.controller.generation ||
      host.sequence < intent.controller.sequence || !isDeepStrictEqual(host.snapshot.frameworkBinding, check.binding) ||
      check.binding.routineApiVersion < 70 || !host.snapshot.frameworkAcceptedAt || !host.snapshot.frameworkProcess ||
      Date.parse(host.snapshot.frameworkAcceptedAt) > now || !journal || journal.state !== 'prepared' ||
      Date.parse(journal.observedAt) > Date.parse(host.snapshot.observedAt) || Date.parse(journal.observedAt) > now ||
      now >= check.deadlineAt || (intent.laneId ? !lane || !baselineLane && (lane.state !== 'idle' || Boolean(lane.activity)) ||
        lane.dispatchMode !== 'automatic' && !intent.prerequisite?.local : intent.prerequisite ||
        subject?.resource.memberships.length !== 0 || !host.snapshot.resources?.some(value => value.id === check.resourceId)) || !ref || !subject?.current ||
      subject.subject.authorityHostId !== host.hostId || subject.owner !== null || subject.generation !== check.subjectGeneration ||
      subject.idle.contractVersion !== check.contractVersion || subject.status === 'in-repair' || subject.status === 'out-of-service' ||
      subject.status === 'offline' || subject.status === 'reserved' || subject.status === 'returning' ||
      subject.status === 'checking' || subject.status === 'active' || subject.repair.state !== 'none' ||
      intent.owner.id !== `resource-check:${requestInputDigest({operationId: intent.operationId, resourceId: check.resourceId})}` ||
      host.snapshot.resourceLifecycle!.history.some(value => value.resourceId === check.resourceId && value.checkOperationId === intent.operationId &&
        value.event === 'resource-check-released')) return false
    const records = z.array(z.union([laneControlRecordSchema, resourceControlRecordSchema])).max(100).parse(host.laneControls ?? [])
    if (records.some(row => ('subject' in row.command ? row.command.subject.resourceId === check.resourceId :
      row.command.laneId === intent.laneId) && (!row.receipt || row.receipt.result.status === 'accepted' &&
        (row.receipt.result.reservation && ['waiting','granted','returning'].includes(row.receipt.result.reservation.state) ||
          'check' in row.receipt.result && row.receipt.result.check?.state !== undefined && row.receipt.result.check.state !== 'settled' ||
          'subject' in row.command && manualWithdrawalNeedsRestoration(row as ResourceControlRecord, subject, host.hostId, true, now))))) return false
    if (!intent.prerequisite) return ref.idleContract?.version === check.contractVersion &&
      ref.idleContract.qualifiedScope.kind !== 'unqualified'
    if (!lane || lane.platform !== 'android' || ref.kind !== 'phone' || !ref.capabilities?.includes('backend-connectivity') ||
      !isDeepStrictEqual(intent.prerequisite.binding, check.binding)) return false
    const targets = await this.qualificationTargets(host.hostId), matching = targets.filter(value =>
      value.jobId === intent.prerequisite!.jobId && value.hostId === host.hostId && value.laneId === intent.laneId &&
      value.inputSha256 === intent.prerequisite!.targetInputSha256 && isDeepStrictEqual(value.purpose, {kind: 'backend-connectivity', resourceId: check.resourceId}) &&
      isDeepStrictEqual(value.acceptedBinding, check.binding) && isDeepStrictEqual(value.preparing, intent.prerequisite!.preparing) &&
      isDeepStrictEqual(value.local, intent.prerequisite!.local) && isDeepStrictEqual(value.candidate, intent.prerequisite!.candidate))
    const current = await this.host(host.hostId)
    return matching.length === 1 && Date.parse(matching[0]!.deadline) >= check.deadlineAt && this.now() < check.deadlineAt &&
      fresh(current, this.now()) && current.incarnation === host.incarnation && current.incarnationGeneration === host.incarnationGeneration &&
      current.sequence === host.sequence && current.resourceReservationVersion === host.resourceReservationVersion && current.laneControlVersion === host.laneControlVersion &&
      isDeepStrictEqual(current.snapshot.resourceLifecycle, host.snapshot.resourceLifecycle) && isDeepStrictEqual(current.snapshot.resourceReservations, host.snapshot.resourceReservations)
  }
  /** Ordinary passive checks may share a lane only when their complete current
   * declared footprints are disjoint. A claim alone does not prove a reader scope. */
  private disjointResourceCheckClaims(host: ResourceReservationHost, intent: ExclusiveResourceIntent, acquired?: ExclusiveHostReservation) {
    if (intent.prerequisite || !intent.laneId) return undefined
    const lifecycle = host.snapshot.resourceLifecycle, now = this.now(),
      installed = [...host.snapshot.lanes.flatMap(lane => lane.resources), ...host.snapshot.resources ?? []],
      all = hostResourceReservationsSchema.parse(host.resourceReservations ?? []).filter(claim => !acquired || !isDeepStrictEqual(claim, acquired))
    if (!lifecycle) return undefined
    const scope = (root: string) => {
      const visited = new Set<string>(), visiting = new Set<string>()
      const visit = (id: string): boolean => {
        if (visiting.has(id)) return false
        if (visited.has(id)) return true
        const refs = installed.filter(ref => ref.id === id), ref = refs[0], contract = ref?.idleContract,
          subject = lifecycle.subjects.find(value => value.subject.id === id)
        if (!ref || !contract || contract.qualifiedScope.kind === 'unqualified' || !subject?.current ||
          subject.subject.authorityHostId !== host.hostId || subject.resource.kind !== ref.kind ||
          subject.idle.contractVersion !== contract.version || !isDeepStrictEqual(subject.idle.qualifiedScope, contract.qualifiedScope) ||
          !subject.observedAt || Date.parse(subject.observedAt) > Date.parse(host.snapshot.observedAt) ||
          !fresh({...host, snapshot: {...host.snapshot, observedAt: subject.observedAt}}, now) ||
          refs.some(other => other.kind !== ref.kind || !isDeepStrictEqual(other.idleContract, contract) ||
            !isDeepStrictEqual(other.exclusiveDependencies ?? [], ref.exclusiveDependencies ?? [])) ||
          subject.resource.memberships.some(member => member.hostId !== host.hostId || !host.snapshot.lanes.some(lane =>
            lane.id === member.laneId && lane.resources.some(resource => resource.id === id))) ||
          ref.exclusiveDependencies?.some(dependency => dependency.authorityHostId !== host.hostId)) return false
        visiting.add(id)
        if (![...contract.dependencies ?? [], ...subject.resource.dependencies,
          ...ref.exclusiveDependencies?.map(dependency => dependency.resourceId) ?? []].every(visit)) return false
        visiting.delete(id); visited.add(id)
        return true
      }
      return visit(root) ? visited : undefined
    }
    const free = (ids: Set<string>, ownedRoot?: string) => [...ids].every(id => {
      const subject = lifecycle.subjects.find(value => value.subject.id === id)!
      // Preparing this original intentionally removes its advertised Check action.
      // Known-custody withdrawal remains available; it cannot bless unknown effects.
      return subject.repair.state === 'none' && subject.supportedActions.includes('mark-out-of-service') &&
        (id === ownedRoot || subject.owner === null && ['idle', 'unknown'].includes(subject.status))
    })
    const target = scope(intent.resourceCheck!.resourceId)
    if (!target || !free(target)) return undefined
    const occupied = new Set(target), permitted = new Set<string>()
    for (const claim of all) {
      if (!isExclusiveHostReservation(claim)) {
        if (claim.hostId === host.hostId && claim.laneId === intent.laneId) return undefined
        continue
      }
      if (claim.borrowerHostId !== host.hostId || claim.laneId !== intent.laneId) {
        if (occupied.has(claim.resourceId)) return undefined
        continue
      }
      const check = claim.resourceCheck, subject = lifecycle.subjects.find(value => value.subject.id === claim.resourceId)
      if (!check || claim.prerequisite || claim.origin || !subject || claim.controllerIncarnation !== host.incarnation ||
        claim.controllerGeneration !== host.incarnationGeneration || claim.borrowerSequence > host.sequence || now >= check.deadlineAt ||
        !isDeepStrictEqual(check.binding, host.snapshot.frameworkBinding)) return undefined
      const journals = host.snapshot.resourceReservations?.resourceChecks?.filter(value => value.operationId === claim.operationId),
        journal = journals?.length === 1 ? journals[0] : undefined, footprint = scope(claim.resourceId)
      if (!journal || !this.resourceCheckClaimMatches(claim, journal.intent, this.resourceCheckIntentDigest(journal.intent)) ||
        !isDeepStrictEqual(this.resourceCheckJournal(host, journal.intent), journal) || !footprint ||
        [...footprint].some(id => occupied.has(id)) || Date.parse(journal.observedAt) > Date.parse(host.snapshot.observedAt)) return undefined
      if (journal.state === 'prepared') {
        if (subject.generation !== check.subjectGeneration || !free(footprint)) return undefined
      } else if (journal.state === 'began') {
        if (journal.eventId !== `resource-check-began:${claim.operationId}` || subject.status !== 'checking' ||
          !isDeepStrictEqual(subject.owner && {id: subject.owner.id, kind: subject.owner.kind}, claim.owner) ||
          subject.owner?.hostId !== host.hostId || subject.owner.laneId !== undefined && subject.owner.laneId !== intent.laneId ||
          subject.generation !== check.subjectGeneration + 1 || Date.parse(journal.observedAt) < Date.parse(claim.reservedAt) ||
          !free(footprint, claim.resourceId) || !lifecycle.history.some(event => event.resourceId === claim.resourceId &&
            event.event === 'checking' && event.subjectGeneration === subject.generation &&
            Date.parse(event.at) >= Date.parse(claim.reservedAt) && Date.parse(event.at) <= Date.parse(journal.observedAt))) return undefined
      } else return undefined
      for (const id of footprint) occupied.add(id)
      permitted.add(claim.id)
    }
    // A control or another authority claim on a secondary resource still wins.
    if (all.some(claim => isExclusiveHostReservation(claim) && !permitted.has(claim.id) && occupied.has(claim.resourceId))) return undefined
    const controls = z.array(z.union([laneControlRecordSchema, resourceControlRecordSchema])).max(100).parse(host.laneControls ?? [])
    if (controls.some(row => 'subject' in row.command && occupied.has(row.command.subject.resourceId) &&
      (!row.receipt || row.receipt.result.status === 'accepted' &&
        (row.receipt.result.reservation && ['waiting', 'granted', 'returning'].includes(row.receipt.result.reservation.state) ||
          'check' in row.receipt.result && row.receipt.result.check?.state !== undefined && row.receipt.result.check.state !== 'settled' ||
          manualWithdrawalNeedsRestoration(row as ResourceControlRecord,
            lifecycle.subjects.find(subject => subject.subject.id === (row.command as ResourceControlRecord['command']).subject.resourceId), host.hostId, true, now))))) return undefined
    return permitted.size ? permitted : undefined
  }
  private graphIntentDigest(intent: ExclusiveResourceIntent) {
    if (intent.prerequisite?.kind !== 'resource-readiness') throw new TestRunError(409, 'Readiness intent has no original graph')
    return requestInputDigest({...intent, controller: {incarnation: intent.controller.incarnation, generation: intent.controller.generation},
      dependencies: intent.prerequisite.resources.map(member => ({resourceId: member.id,
        authorityHostId: member.authorityHostId, capability: 'resource-idle'}))})
  }
  private graphSubjectsCurrent(host: ResourceReservationHost, intent: ExclusiveResourceIntent) {
    const purpose = intent.prerequisite
    if (purpose?.kind !== 'resource-readiness' || host.snapshot.resourceReservations?.resourceReadiness !== true ||
      !fresh(host, this.now()) || !intent.laneId ||
      host.incarnation !== intent.controller.incarnation || host.incarnationGeneration !== intent.controller.generation ||
      host.sequence < intent.controller.sequence || !isDeepStrictEqual(host.snapshot.frameworkBinding, purpose.binding)) return false
    const lane = host.snapshot.lanes.find(value => value.id === intent.laneId)
    if (!lane || lane.state !== 'idle' || lane.activity || lane.dispatchMode !== 'automatic' ||
      resourceLaneBlocker({resourceControlRecords: host.laneControls, authorityReservations: host.resourceReservations}, lane.id)) return false
    return purpose.resources.every(member => {
      const subject = host.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === member.id),
        refs = [...host.snapshot.resources ?? [], ...host.snapshot.lanes.flatMap(value => value.resources)].filter(value => value.id === member.id), ref = refs[0]
      return member.authorityHostId === host.hostId && refs.length > 0 && refs.every(value => value.kind === ref!.kind &&
        isDeepStrictEqual(value.idleContract, ref!.idleContract) && isDeepStrictEqual(value.exclusiveDependencies, ref!.exclusiveDependencies)) &&
        ref?.kind === member.kind && ref.idleContract?.version === member.contractVersion && ref.idleContract.qualifiedScope.kind !== 'unqualified' &&
        subject?.current && !!subject.resource && subject.subject.authorityHostId === host.hostId && subject.generation === member.subjectGeneration &&
        subject.owner === null && subject.repair.state === 'none' && member.capabilities.every(value => ref.capabilities?.includes(value)) &&
        !(ref.idleContract.dependencies ?? []).some(id => !purpose.resources.some(value => value.id === id)) &&
        !subject.resource.dependencies.some(id => !purpose.resources.some(value => value.id === id)) &&
        !(ref.exclusiveDependencies ?? []).some(dependency => dependency.authorityHostId !== host.hostId ||
          !purpose.resources.some(value => value.id === dependency.resourceId)) &&
        resourceCandidateBlocker({...host, resourceControlRecords: host.laneControls, authorityReservations: host.resourceReservations}, member.id, this.now()) === undefined
    })
  }
  private async checkpointGraphClaims(intent: ExclusiveResourceIntent, claims: ExclusiveHostReservation[]) {
    for (const claim of claims) {
      const row = await this.rows.request?.(intent.prerequisite!.jobId), pending = row?.fleetCandidatePreparation
      if (!row || !pending || !await this.rows.recordCandidateClaim?.(row.requestId, pending, claim)) return false
    }
    return true
  }
  private async acquireGraphPrerequisite(intent: ExclusiveResourceIntent, hostId: string) {
    const purpose = intent.prerequisite
    if (purpose?.kind !== 'resource-readiness') throw new TestRunError(409, 'Readiness graph is missing')
    const intentSha256 = this.graphIntentDigest(intent), unknown = {status: 'unknown' as const, intentSha256, claims: []}
    for (let attempt = 0; attempt < 3; attempt++) {
      const host = await this.host(hostId), all = hostResourceReservationsSchema.parse(host.resourceReservations ?? []),
        relevant = all.filter(isExclusiveHostReservation).filter(claim => purpose.resources.some(member => member.id === claim.resourceId)),
        row = await this.rows.request?.(purpose.jobId), pending = row?.fleetCandidatePreparation
      if (!pending || pending.target.purpose?.kind !== 'resource-readiness' || !fresh(host, this.now()) ||
        host.incarnation !== intent.controller.incarnation || host.incarnationGeneration !== intent.controller.generation ||
        host.sequence < intent.controller.sequence || requiresBackendConnectivity(row!) && !purpose.target) return unknown
      // A complete committed original is custody, even after the caller's deadline
      // or cancellation. It never starts a replacement reader.
      if (relevant.length) return relevant.length === purpose.resources.length && relevant.every(claim =>
        claim.intentSha256 === intentSha256 && graphCandidateClaimMatches(pending, claim)) &&
        await this.checkpointGraphClaims(intent, relevant) ? {status: 'reserved' as const, intentSha256, claims: relevant} : unknown
      if (pending.noAcquisitionReceipt || reportedGraphCandidateSettlement(pending, host.snapshot) ||
        !candidatePrerequisiteRequestMatches(row ?? null, intent, this.now()) || !this.graphSubjectsCurrent(host, intent)) return unknown
      if (all.some(claim => isExclusiveHostReservation(claim)
        ? claim.borrowerHostId === hostId && claim.laneId === intent.laneId
        : claim.hostId === hostId && claim.laneId === intent.laneId)) return unknown
      if (all.length + purpose.resources.length > 1000) throw new TestRunError(409, 'Resource authority is full; unresolved claims retain custody')
      const claims: ExclusiveHostReservation[] = purpose.resources.map(member => ({kind: 'exclusive', id: randomUUID(),
        resourceId: member.id, authorityHostId: hostId, borrowerHostId: hostId, laneId: intent.laneId, operationId: intent.operationId,
        intentSha256, inputSha256: intent.inputSha256, owner: intent.owner, prerequisite: purpose,
        resourceCheck: {resourceId: member.id, subjectGeneration: member.subjectGeneration, contractVersion: member.contractVersion,
          deadlineAt: Date.parse(pending.target.deadline), binding: purpose.binding, controller: purpose.candidate.controller},
        controllerIncarnation: intent.controller.incarnation, controllerGeneration: intent.controller.generation,
        borrowerSequence: intent.controller.sequence, reservedAt: new Date(this.now()).toISOString()}))
      if (!await this.rows.replaceBackend?.(host, [...all, ...claims], intent, new Date(this.now()))) continue
      if (!await this.checkpointGraphClaims(intent, claims)) return unknown
      const after = await this.host(hostId), committed = hostResourceReservationsSchema.parse(after.resourceReservations ?? []),
        withoutOwn = {...after, resourceReservations: committed.filter(value => !claims.some(claim => isDeepStrictEqual(value, claim)))}
      if (!fresh(after, this.now()) || after.incarnation !== host.incarnation || after.incarnationGeneration !== host.incarnationGeneration ||
        !claims.every(claim => committed.some(value => isDeepStrictEqual(value, claim))) ||
        !this.graphSubjectsCurrent(withoutOwn, intent) || !candidatePrerequisiteRequestMatches(await this.rows.request?.(purpose.jobId) ?? null, intent, this.now())) return unknown
      return {status: 'reserved' as const, intentSha256, claims}
    }
    return unknown
  }
  private async observeGraphPrerequisite(intent: ExclusiveResourceIntent, host: ResourceReservationHost, controller: ExclusiveResourceIntent['controller']) {
    const purpose = intent.prerequisite
    if (purpose?.kind !== 'resource-readiness') throw new TestRunError(409, 'Readiness graph is missing')
    const intentSha256 = this.graphIntentDigest(intent), all = hostResourceReservationsSchema.parse(host.resourceReservations ?? []),
      relevant = all.filter(isExclusiveHostReservation).filter(claim => purpose.resources.some(member => member.id === claim.resourceId)),
      row = await this.rows.request?.(purpose.jobId), candidates = [row?.fleetCandidatePreparation, ...row?.fleetCandidatePreparations ?? []]
        .filter(value => value && candidatePrerequisiteIdentityMatches(value, intent)),
      pending = candidates.length === 1 ? candidates[0] : undefined,
      unknown = {status: 'unknown' as const, intentSha256, claims: []}
    if (!row || !pending || (row.fleetCandidatePreparations?.length ?? 0) > MAX_FLEET_CANDIDATE_PREPARATIONS) return unknown
    const historical = pending !== row.fleetCandidatePreparation, saved = pending.noAcquisitionReceipt as {intent?: unknown} | undefined
    if ((historical || saved) && (!graphCandidateNoAcquisitionMatches(pending) || !isDeepStrictEqual(saved?.intent, intent)) ||
      historical && !completedCandidatePreparationForHost({...row, fleetCandidatePreparations: [pending]}, host.hostId)) return unknown
    if (relevant.length === purpose.resources.length && relevant.every(claim =>
      claim.intentSha256 === intentSha256 && graphCandidateClaimMatches(pending, claim)) && await this.checkpointGraphClaims(intent, relevant))
      return {status: 'reserved' as const, intentSha256, claims: relevant}
    const closed = reportedGraphCandidateSettlement(pending, host.snapshot), closedUnused =
      closed?.outcome === 'unknown' && closed.graphChecks?.length === 0
    if (pending.resourceClaims?.length || pending.resourceReturns?.length || !isDeepStrictEqual(host.snapshot.frameworkBinding, pending.target.acceptedBinding) ||
      controller.incarnation !== intent.controller.incarnation ||
      controller.generation !== intent.controller.generation || controller.sequence <= intent.controller.sequence ||
      graphCandidateHasOriginalCustody(pending, host.snapshot, all) ||
      !closedUnused) return unknown
    // Accepted original closure blocks acquisition on this same host snapshot.
    // This CAS fences older open-report reads before saving durable absence.
    if (!await this.rows.replace(host, all)) return unknown
    const after = await this.host(host.hostId), version = (host.resourceReservationVersion ?? 0) + 1
    if (!fresh(after, this.now()) || after.incarnation !== host.incarnation || after.incarnationGeneration !== host.incarnationGeneration ||
      after.sequence !== controller.sequence || after.resourceReservationVersion !== version || after.laneControlVersion !== host.laneControlVersion ||
      !isDeepStrictEqual(after.resourceReservations, all) || !isDeepStrictEqual(after.snapshot, host.snapshot)) return unknown
    const observation = {status: 'not-acquired' as const, intentSha256, claims: [], fence: {hostId: host.hostId,
      controller, resourceReservationVersion: version, resourceId: purpose.resourceId, subjectGeneration: purpose.resources[0]!.subjectGeneration,
      subjects: purpose.resources.map(member => ({resourceId: member.id, subjectGeneration: member.subjectGeneration}))}}
    if (!graphCandidateNoAcquisitionMatches({...pending, noAcquisitionReceipt: {intent, journal: pending.target, observation}})) return unknown
    if (!await this.rows.recordCandidateNoAcquisition?.(row!.requestId, pending, {intent, journal: pending.target, observation})) return unknown
    return observation
  }
  private async giveBackGraphPrerequisite(returned: ExclusiveResourceReturn, host: ResourceReservationHost, hostId: string) {
    const row = await this.rows.candidateRequest?.(hostId, returned.inputSha256), pending = row?.fleetCandidatePreparation,
      checked = pending && graphReturnCandidate(pending, returned, host, this.now()),
      release = returned.release, subject = host.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === returned.resourceId),
      proof = (({controller: _, ...value}) => value)(returned)
    if (!row || !pending || !checked || !graphCandidateReturnMatches(checked, returned) || !('kind' in release) || release.kind !== 'resource-check' ||
      !fresh(host, this.now()) || host.incarnation !== returned.controller.incarnation || host.incarnationGeneration !== returned.controller.generation ||
      host.sequence !== returned.controller.sequence || !subject?.current || subject.owner !== null ||
      subject.subject.authorityHostId !== hostId || subject.generation !== release.subjectGeneration ||
      subject.idle.acceptedCheck?.operationId !== release.operationId || subject.idle.acceptedCheck.subjectGeneration !== subject.generation ||
      Date.parse(release.releasedAt) > this.now() || Date.parse(release.releasedAt) > Date.parse(host.snapshot.observedAt) ||
      !host.snapshot.resourceReservations?.returns.some(value => isDeepStrictEqual(value, proof)) ||
      release.eventId !== `resource-lifecycle:${requestInputDigest({id: returned.resourceId, subjectGeneration: release.subjectGeneration})}` ||
      !host.snapshot.resourceLifecycle?.history.some(event => event.id === release.eventId && event.event === 'resource-check-released' &&
        event.resourceId === returned.resourceId && event.checkOperationId === release.operationId && event.subjectGeneration === release.subjectGeneration &&
        event.at === release.releasedAt && event.ownerId === returned.originalOwner.id))
      throw new TestRunError(409, 'Readiness graph return requires its exact owned check and normal released member')
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.host(hostId), all = hostResourceReservationsSchema.parse(current.resourceReservations ?? []),
        claim = all.filter(isExclusiveHostReservation).find(value => value.resourceId === returned.resourceId)
      if (!fresh(current, this.now()) || current.incarnation !== host.incarnation || current.incarnationGeneration !== host.incarnationGeneration ||
        current.sequence !== host.sequence || !isDeepStrictEqual(current.frameworkHistory, host.frameworkHistory) ||
        !isDeepStrictEqual(current.frameworkStopReceipts, host.frameworkStopReceipts) || !isDeepStrictEqual(current.snapshot.resourceLifecycle, host.snapshot.resourceLifecycle) ||
        !isDeepStrictEqual(current.snapshot.resourceReservations, host.snapshot.resourceReservations))
        throw new TestRunError(409, 'Readiness graph original return changed; retain the same member')
      if (claim && (claim.id !== returned.claimId || !graphCandidateClaimMatches(pending, claim) || claim.intentSha256 !== returned.intentSha256))
        throw new TestRunError(409, 'Readiness graph return differs from its retained original claim')
      if (claim && !await this.rows.replace(current, all.filter(value => value !== claim))) continue
      const actual = await this.rows.request?.(row.requestId), original = actual?.fleetCandidatePreparation
      if (!original || !await this.rows.recordCandidateReturn?.(row.requestId, original, returned))
        throw new TestRunError(409, 'Readiness graph original member acknowledgement is pending')
      return {status: 'returned' as const, claimId: returned.claimId}
    }
    throw new TestRunError(409, 'Readiness graph authority changed; retain the same original member')
  }
  private async acquireResourceCheck(intent: ExclusiveResourceIntent, hostId: string) {
    const intentSha256 = this.resourceCheckIntentDigest(intent), unknown = {status: 'unknown' as const, intentSha256, claims: []}
    for (let attempt = 0; attempt < 3; attempt++) {
      const host = await this.host(hostId), all = hostResourceReservationsSchema.parse(host.resourceReservations ?? []),
        current = all.filter(isExclusiveHostReservation).filter(claim => claim.resourceId === intent.resourceCheck!.resourceId)
      if (!fresh(host, this.now()) || host.incarnation !== intent.controller.incarnation ||
        host.incarnationGeneration !== intent.controller.generation || host.sequence < intent.controller.sequence) return unknown
      // A committed original remains recoverable after cancellation, marker/source
      // changes or local admission. It conveys custody, not a new reader grant.
      if (current.length) return current.length === 1 && this.resourceCheckClaimMatches(current[0]!, intent, intentSha256) ?
        {status: 'reserved' as const, intentSha256, claims: current} : unknown
      if (!await this.resourceCheckTargetCurrent(host, intent)) continue
      const selected = intent.prerequisite && !intent.prerequisite.local ? await this.rows.request?.(intent.prerequisite.jobId) : null
      if (intent.prerequisite && (intent.prerequisite.candidate ? !candidatePrerequisiteRequestMatches(selected ?? null, intent, this.now()) :
        intent.prerequisite.local ? Boolean(await this.rows.request?.(intent.prerequisite.jobId)) || !localBackendIntentMatches(host, intent, this.now()) :
          !backendPrerequisiteRequestMatches(selected ?? null, intent, this.now()))) return unknown
      const queuedDependency = !intent.prerequisite ? this.queuedDependencyClaims(host, intent) : undefined,
        disjointRepair = !intent.prerequisite ? this.disjointResourceCheckRepairClaims(host, intent) ?? queuedDependency : undefined,
        disjointChecks = !intent.prerequisite ? this.disjointResourceCheckClaims(host, intent) : undefined
      const capacityBlocked = (claims: HostResourceReservation[], permitted?: Set<string>) => claims.some(claim => isExclusiveHostReservation(claim) ? Boolean(!permitted?.has(claim.id) && intent.laneId && claim.borrowerHostId === hostId && claim.laneId === intent.laneId &&
          (!intent.prerequisite || intent.prerequisite.local || !selected?.fleetExclusiveReservation?.claims.some(value => isDeepStrictEqual(value, claim)))) :
        claim.hostId === hostId && claim.laneId === intent.laneId &&
          (!intent.prerequisite || intent.prerequisite.local || !isDeepStrictEqual(claim, selected?.fleetResourceReservation)))
      if (capacityBlocked(all, disjointRepair ?? disjointChecks)) return unknown
      if (all.length >= 1000) throw new TestRunError(409, 'Resource authority is full; unresolved claims retain custody')
      const claim: ExclusiveHostReservation = {kind: 'exclusive', id: randomUUID(), resourceId: intent.resourceCheck!.resourceId,
        authorityHostId: hostId, borrowerHostId: hostId, ...(intent.laneId ? {laneId: intent.laneId} : {}), operationId: intent.operationId, intentSha256,
        inputSha256: intent.inputSha256, owner: intent.owner, resourceCheck: intent.resourceCheck,
        ...(intent.prerequisite ? {prerequisite: intent.prerequisite} : {}), controllerIncarnation: intent.controller.incarnation,
        controllerGeneration: intent.controller.generation, borrowerSequence: intent.controller.sequence, reservedAt: new Date(this.now()).toISOString()}
      if (this.now() >= intent.resourceCheck!.deadlineAt || !fresh(host, this.now())) return unknown
      const committed = intent.prerequisite ? await this.rows.replaceBackend?.(host, [...all, claim], intent, new Date(this.now())) :
        await this.rows.replace(host, [...all, claim])
      if (!committed) continue
      if (intent.prerequisite?.candidate) {
        const row = await this.rows.request?.(intent.prerequisite.jobId), pending = row?.fleetCandidatePreparation
        if (!row || !pending || !await this.rows.recordCandidateClaim?.(row.requestId, pending, claim)) return unknown
      }
      const after = await this.host(hostId)
      if (!fresh(after, this.now()) || after.incarnation !== host.incarnation || after.incarnationGeneration !== host.incarnationGeneration ||
        !hostResourceReservationsSchema.parse(after.resourceReservations ?? []).some(value => isDeepStrictEqual(value, claim))) return unknown
      if (queuedDependency && (!await this.resourceCheckTargetCurrent(after, intent) ||
        capacityBlocked(hostResourceReservationsSchema.parse(after.resourceReservations ?? []).filter(value => !isDeepStrictEqual(value, claim)), queuedDependency) ||
        !isDeepStrictEqual(this.queuedDependencyClaims(after, intent, claim), queuedDependency))) return unknown
      if (disjointChecks && (!await this.resourceCheckTargetCurrent(after, intent) ||
        capacityBlocked(hostResourceReservationsSchema.parse(after.resourceReservations ?? []).filter(value => !isDeepStrictEqual(value, claim)), disjointChecks) ||
        !isDeepStrictEqual(this.disjointResourceCheckClaims(after, intent, claim), disjointChecks))) return unknown
      return {status: 'reserved' as const, intentSha256, claims: [claim]}
    }
    return unknown
  }
  private async observeResourceCheck(intent: ExclusiveResourceIntent, host: ResourceReservationHost, controller: ExclusiveResourceIntent['controller']) {
    const intentSha256 = this.resourceCheckIntentDigest(intent), all = hostResourceReservationsSchema.parse(host.resourceReservations ?? []),
      claims = all.filter(isExclusiveHostReservation).filter(claim => claim.resourceId === intent.resourceCheck!.resourceId),
      unknown = {status: 'unknown' as const, intentSha256, claims: []}
    if (claims.length) return claims.length === 1 && this.resourceCheckClaimMatches(claims[0]!, intent, intentSha256) ?
      {status: 'reserved' as const, intentSha256, claims} : unknown
    const subject = host.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === intent.resourceCheck!.resourceId), journal = this.resourceCheckJournal(host, intent)
    const newer = controller.generation > intent.controller.generation || controller.generation === intent.controller.generation &&
      controller.incarnation === intent.controller.incarnation && controller.sequence > intent.controller.sequence
    if (!newer || !subject?.current || subject.owner !== null || subject.subject.authorityHostId !== host.hostId || journal?.state !== 'never-began' || !journal.eventId ||
      Date.parse(journal.observedAt) > Date.parse(host.snapshot.observedAt) || Date.parse(journal.observedAt) > this.now()) return unknown
    // Invalidate every older preclaim CAS before reporting authentic absence.
    if (!await this.rows.replace(host, all)) return unknown
    const after = await this.host(host.hostId), version = (host.resourceReservationVersion ?? 0) + 1,
      current = after.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === subject.subject.id)
    if (!fresh(after, this.now()) || after.incarnation !== controller.incarnation || after.incarnationGeneration !== controller.generation ||
      after.sequence !== controller.sequence || after.resourceReservationVersion !== version || !isDeepStrictEqual(after.resourceReservations, all) ||
      !current?.current || current.owner !== null || current.generation !== subject.generation || current.subject.authorityHostId !== host.hostId ||
      !isDeepStrictEqual(this.resourceCheckJournal(after, intent), journal)) return unknown
    const observation = {status: 'not-acquired' as const, intentSha256, claims: [], fence: {hostId: host.hostId, resourceId: subject.subject.id,
      controller, resourceReservationVersion: version, subjectGeneration: subject.generation}}
    if (intent.prerequisite?.candidate) {
      const row = await this.rows.request?.(intent.prerequisite.jobId), pending = row?.fleetCandidatePreparation
      if (!row || !pending || !await this.rows.recordCandidateNoAcquisition?.(row.requestId, pending, {intent, journal, observation})) return unknown
    }
    return observation
  }
  private async giveBackResourceCheck(returned: z.infer<typeof exclusiveResourceReturnSchema>, host: ResourceReservationHost, hostId: string) {
    const release = returned.release
    if (!('kind' in release)) throw new TestRunError(409, 'Resource precheck needs its original check return')
    const at = Date.parse(release.releasedAt), subject = host.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === returned.resourceId),
      proof = (({controller: _, ...value}) => value)(returned),
      historical = release.kind === 'resource-check' && !!subject && subject.generation > release.subjectGeneration
    if (!fresh(host, this.now()) || host.incarnation !== returned.controller.incarnation || host.incarnationGeneration !== returned.controller.generation ||
      host.sequence !== returned.controller.sequence || returned.authorityHostId !== hostId || !subject?.current || subject.owner !== null ||
      subject.subject.authorityHostId !== hostId || !historical && subject.generation !== release.subjectGeneration || !Number.isFinite(at) || at > this.now() ||
      at > Date.parse(host.snapshot.observedAt) || !host.snapshot.resourceReservations?.returns.some(value => isDeepStrictEqual(value, proof)))
      throw new TestRunError(409, 'Resource precheck return requires its exact original journal and current unowned subject')
    const journal = host.snapshot.resourceReservations?.resourceChecks?.find(value => value.operationId === release.operationId)
    if (!journal || journal.resourceId !== returned.resourceId || journal.intentSha256 !== returned.intentSha256 ||
      journal.intent.inputSha256 !== returned.inputSha256 || journal.intent.hostId !== hostId || journal.intent.laneId !== returned.laneId ||
      !isDeepStrictEqual(journal.intent.owner, returned.originalOwner) || this.resourceCheckIntentDigest(journal.intent) !== returned.intentSha256 ||
      historical && (release.subjectGeneration <= journal.resourceCheck.subjectGeneration || Date.parse(journal.observedAt) > at) ||
      (release.kind === 'resource-check-not-started' ? journal.state !== 'never-began' || journal.eventId !== release.eventId ||
        journal.observedAt !== release.releasedAt || !isDeepStrictEqual(journal.resourceCheck, release.resourceCheck) : journal.state !== 'began' ||
        !host.snapshot.resourceLifecycle?.history.some(event => event.id === release.eventId && event.event === 'resource-check-released' &&
          event.resourceId === returned.resourceId && event.checkOperationId === release.operationId && event.subjectGeneration === release.subjectGeneration && event.at === release.releasedAt)))
      throw new TestRunError(409, 'Resource precheck has no authentic never-began or completed local check return')
    for (let attempt = 0; attempt < 3; attempt++) {
      const authority = await this.host(hostId), all = hostResourceReservationsSchema.parse(authority.resourceReservations ?? []),
        claim = all.filter(isExclusiveHostReservation).find(value => value.resourceId === returned.resourceId)
      if (!fresh(authority, this.now()) || authority.incarnation !== host.incarnation || authority.incarnationGeneration !== host.incarnationGeneration ||
        authority.sequence !== host.sequence || !isDeepStrictEqual(authority.snapshot.resourceLifecycle, host.snapshot.resourceLifecycle) ||
        !isDeepStrictEqual(authority.snapshot.resourceReservations, host.snapshot.resourceReservations))
        throw new TestRunError(409, 'Original resource return observation changed; retain the same return')
      if (!claim) {
        if (historical) {
          // Fence every older preclaim CAS before acknowledging retained completion.
          // This retires only protocol work; it cannot renew the current baseline.
          if (authority.resourceReservationVersion !== host.resourceReservationVersion || authority.laneControlVersion !== host.laneControlVersion ||
            all.some(value => value.id === returned.claimId))
            throw new TestRunError(409, 'Historical resource return authority changed; retain the same return')
          if (!await this.rows.replace(authority, all)) continue
          const after = await this.host(hostId)
          if (!fresh(after, this.now()) || after.incarnation !== authority.incarnation || after.incarnationGeneration !== authority.incarnationGeneration ||
            after.sequence !== authority.sequence || after.laneControlVersion !== authority.laneControlVersion ||
            after.resourceReservationVersion !== (authority.resourceReservationVersion ?? 0) + 1 || !isDeepStrictEqual(after.resourceReservations, all) ||
            !isDeepStrictEqual(after.snapshot.resourceLifecycle, authority.snapshot.resourceLifecycle) ||
            !isDeepStrictEqual(after.snapshot.resourceReservations, authority.snapshot.resourceReservations))
            throw new TestRunError(409, 'Historical resource return fence changed; retain the same return')
        }
        const row = await this.rows.candidateRequest?.(hostId, returned.inputSha256)
        if (row?.fleetCandidatePreparation && !await this.rows.recordCandidateReturn?.(row.requestId, row.fleetCandidatePreparation, returned))
          throw new TestRunError(409, 'Original candidate return acknowledgement is pending')
        return {status: 'returned' as const, claimId: returned.claimId}
      }
      if (historical || !claim.resourceCheck || claim.id !== returned.claimId || claim.operationId !== release.operationId || claim.intentSha256 !== returned.intentSha256 ||
        claim.inputSha256 !== returned.inputSha256 || claim.borrowerHostId !== hostId || claim.laneId !== returned.laneId ||
        !isDeepStrictEqual(claim.owner, returned.originalOwner) || !isDeepStrictEqual(claim.resourceCheck, journal.resourceCheck) ||
        at < Date.parse(claim.reservedAt) || returned.controller.generation < claim.controllerGeneration ||
        returned.controller.generation === claim.controllerGeneration && (returned.controller.incarnation !== claim.controllerIncarnation || returned.controller.sequence <= claim.borrowerSequence))
        throw new TestRunError(409, 'Resource precheck return differs from its immutable original claim')
      if (claim.prerequisite?.candidate) {
        const row = await this.rows.request?.(claim.prerequisite.jobId), pending = row?.fleetCandidatePreparation
        if (!row || !pending || !await this.rows.recordCandidateClaim?.(row.requestId, pending, claim))
          throw new TestRunError(409, 'Original candidate claim checkpoint is pending')
      }
      if (!await this.rows.replace(authority, all.filter(value => value !== claim))) continue
      if (claim.prerequisite?.candidate) {
        const row = await this.rows.request?.(claim.prerequisite.jobId), pending = row?.fleetCandidatePreparation
        if (!row || !pending || !await this.rows.recordCandidateReturn?.(row.requestId, pending, returned))
          throw new TestRunError(409, 'Original candidate return acknowledgement is pending')
      }
      return {status: 'returned' as const, claimId: claim.id}
    }
    throw new TestRunError(409, 'Resource authority changed; retain the same original return')
  }
  private backendClaimMatches(claim: ExclusiveHostReservation, intent: ExclusiveResourceIntent, digest: string) {
    return claim.intentSha256 === digest && claim.operationId === intent.operationId && claim.inputSha256 === intent.inputSha256 &&
      claim.authorityHostId === intent.hostId && claim.borrowerHostId === intent.hostId && claim.laneId === intent.laneId &&
      claim.resourceId === intent.prerequisite!.resourceId && isDeepStrictEqual(claim.owner, intent.owner) &&
      isDeepStrictEqual(claim.prerequisite, intent.prerequisite) && !claim.origin &&
      claim.controllerIncarnation === intent.controller.incarnation && claim.controllerGeneration === intent.controller.generation &&
      claim.borrowerSequence === intent.controller.sequence
  }
  private async backendTargetCurrent(host: ResourceReservationHost, intent: ExclusiveResourceIntent,
    originalCheck?: {generation: number; owner: unknown}) {
    const purpose = intent.prerequisite!, lane = host.snapshot.lanes.find(value => value.id === intent.laneId),
      subject = host.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === purpose.resourceId)
    if (!fresh(host, this.now()) || host.incarnation !== intent.controller.incarnation ||
      host.incarnationGeneration !== intent.controller.generation || host.sequence < intent.controller.sequence ||
      !isDeepStrictEqual(host.snapshot.frameworkBinding, purpose.binding) || purpose.binding.routineApiVersion < BACKEND_CONNECTIVITY_ROUTINE_API_VERSION ||
      !lane || lane.platform !== 'android' || lane.state !== 'idle' || lane.activity || !purpose.local && lane.dispatchMode !== 'automatic' ||
      !lane.resources.some(resource => resource.id === purpose.resourceId && resource.kind === 'phone' &&
        resource.capabilities?.includes('backend-connectivity')) || !subject?.current || subject.subject.authorityHostId !== host.hostId ||
      subject.status !== 'checking' || subject.owner?.kind !== 'boundary-cleanup' || subject.owner.id !== intent.owner.id ||
      originalCheck && (subject.generation !== originalCheck.generation || !isDeepStrictEqual(subject.owner, originalCheck.owner)) ||
      subject.owner.generation === null || subject.owner.generation === undefined || subject.owner.laneId !== intent.laneId ||
      host.snapshot.resourceLifecycle?.history.some(value => value.resourceId === purpose.resourceId &&
        value.checkOperationId === intent.operationId && value.event === 'resource-check-released') ||
      intent.owner.id !== `resource-check:${requestInputDigest({operationId: intent.operationId, resourceId: purpose.resourceId})}`)
      return false
    const targets = await this.qualificationTargets(host.hostId, {jobId: purpose.jobId, laneId: lane.id,
      inputSha256: purpose.targetInputSha256, ownerId: intent.owner.id, generation: subject.owner.generation,
      binding: purpose.binding, controller: {incarnation: host.incarnation, generation: host.incarnationGeneration},
      purpose: {kind: 'backend-connectivity', resourceId: purpose.resourceId}})
    const current = await this.host(host.hostId)
    return fresh(current, this.now()) && current.incarnation === host.incarnation &&
      current.incarnationGeneration === host.incarnationGeneration && current.sequence === host.sequence &&
      current.resourceReservationVersion === host.resourceReservationVersion &&
      targets.length === 1 && targets[0]!.jobId === purpose.jobId && targets[0]!.inputSha256 === purpose.targetInputSha256 &&
      targets[0]!.hostId === host.hostId && targets[0]!.laneId === intent.laneId &&
      isDeepStrictEqual(targets[0]!.purpose, {kind: 'backend-connectivity', resourceId: purpose.resourceId}) &&
      isDeepStrictEqual(targets[0]!.acceptedBinding, purpose.binding) && isDeepStrictEqual(targets[0]!.preparing, purpose.preparing) &&
      isDeepStrictEqual(targets[0]!.local, purpose.local) && isDeepStrictEqual(targets[0]!.candidate, purpose.candidate)
  }
  private async acquireBackendPrerequisite(intent: ExclusiveResourceIntent, hostId: string) {
    const intentSha256 = this.backendIntentDigest(intent), unknown = {status: 'unknown' as const, intentSha256, claims: []}
    let originalCheck: {generation: number; owner: unknown} | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      const host = await this.host(hostId), subject = host.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === intent.prerequisite!.resourceId)
      if (!subject) return unknown
      originalCheck ??= {generation: subject.generation, owner: subject.owner}
      if (subject.generation !== originalCheck.generation || !isDeepStrictEqual(subject.owner, originalCheck.owner)) return unknown
      // The durable intent freezes identity, not the heartbeat sequence used by
      // this transaction. Revalidate a newer same-controller report in full;
      // the existing host CAS still uses that exact observed sequence/version.
      if (!await this.backendTargetCurrent(host, intent, originalCheck)) continue
      const selected = await this.rows.request?.(intent.prerequisite!.jobId)
      if (intent.prerequisite!.candidate ? !candidatePrerequisiteRequestMatches(selected ?? null, intent, this.now()) : intent.prerequisite!.local ? Boolean(selected) || !localBackendIntentMatches(host, intent, this.now()) :
        !backendPrerequisiteRequestMatches(selected ?? null, intent, this.now())) return unknown
      const claims = hostResourceReservationsSchema.parse(host.resourceReservations ?? []),
        current = claims.filter(isExclusiveHostReservation).find(claim => claim.resourceId === intent.prerequisite!.resourceId),
        blocked = claims.find(claim => isExclusiveHostReservation(claim) ?
          claim.borrowerHostId === hostId && claim.laneId === intent.laneId && claim !== current &&
            (Boolean(intent.prerequisite!.local) || !selected!.fleetExclusiveReservation?.claims.some(original => isDeepStrictEqual(original, claim))) :
          claim.hostId === hostId && claim.laneId === intent.laneId && (Boolean(intent.prerequisite!.local) || !isDeepStrictEqual(claim, selected!.fleetResourceReservation)))
      if (blocked || current && !this.backendClaimMatches(current, intent, intentSha256)) {
        const blocker = blocked ?? current!
        return {status: 'waiting' as const, intentSha256, claims: [], blocked: {
          resourceId: intent.prerequisite!.resourceId, hostId, laneId: intent.laneId,
          owner: isExclusiveHostReservation(blocker) ? blocker.owner : {kind: 'run' as const, id: blocker.requestId}}}
      }
      if (!current && host.snapshot.resourceReservations?.resourceChecks !== undefined)
        return unknown
      if (current) {
        if (intent.prerequisite!.candidate) {
          const row = await this.rows.request?.(intent.prerequisite!.jobId), pending = row?.fleetCandidatePreparation;
          if (!row || !pending || !await this.rows.recordCandidateClaim?.(row.requestId, pending, current)) return unknown;
        }
        const after = await this.host(hostId)
        return await this.backendTargetCurrent(after, intent, originalCheck) && hostResourceReservationsSchema.parse(after.resourceReservations ?? [])
          .some(value => isDeepStrictEqual(value, current)) ? {status: 'reserved' as const, intentSha256, claims: [current]} : unknown
      }
      if (claims.length >= 1000) throw new TestRunError(409, 'Resource authority is full; unresolved claims retain custody')
      const claim: ExclusiveHostReservation = {kind: 'exclusive', id: randomUUID(), resourceId: intent.prerequisite!.resourceId,
        authorityHostId: hostId, borrowerHostId: hostId, laneId: intent.laneId, operationId: intent.operationId, intentSha256,
        inputSha256: intent.inputSha256, owner: intent.owner, prerequisite: intent.prerequisite,
        controllerIncarnation: intent.controller.incarnation, controllerGeneration: intent.controller.generation,
        borrowerSequence: intent.controller.sequence, reservedAt: new Date(this.now()).toISOString()}
      if (!this.rows.replaceBackend) throw new TestRunError(503, 'Backend prerequisite admission is unavailable; no phone claim was accepted')
      if (!await this.rows.replaceBackend(host, [...claims, claim], intent, new Date(this.now()))) continue
      if (intent.prerequisite!.candidate) {
        const row = await this.rows.request?.(intent.prerequisite!.jobId), pending = row?.fleetCandidatePreparation;
        if (!row || !pending || !await this.rows.recordCandidateClaim?.(row.requestId, pending, claim)) return unknown;
      }
      // Lost or cancelled target settlement retains the committed original claim. No native reader is authorized by an uncertain answer.
      const after = await this.host(hostId)
      if (!await this.backendTargetCurrent(after, intent, originalCheck) || !hostResourceReservationsSchema.parse(after.resourceReservations ?? [])
        .some(value => isDeepStrictEqual(value, claim))) return unknown
      return {status: 'reserved' as const, intentSha256, claims: [claim]}
    }
    return unknown
  }
  private async giveBackBackendPrerequisite(returned: z.infer<typeof exclusiveResourceReturnSchema>, borrower: ResourceReservationHost, hostId: string) {
    if (!('kind' in returned.release)) throw new TestRunError(409, 'Resource check release is unavailable')
    const release = returned.release, at = Date.parse(release.releasedAt),
      subject = borrower.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === returned.resourceId),
      event = borrower.snapshot.resourceLifecycle?.history.find(value => value.id === release.eventId)
    if (!fresh(borrower, this.now()) || borrower.incarnation !== returned.controller.incarnation ||
      borrower.incarnationGeneration !== returned.controller.generation || borrower.sequence !== returned.controller.sequence ||
      returned.authorityHostId !== hostId || !subject?.current || subject.owner !== null || subject.subject.authorityHostId !== hostId ||
      subject.generation !== release.subjectGeneration || Date.parse(borrower.snapshot.observedAt) < at ||
      !event || event.resourceId !== returned.resourceId || event.subjectGeneration !== release.subjectGeneration ||
      event.at !== release.releasedAt || event.event !== 'resource-check-released' || event.checkOperationId !== release.operationId ||
      !borrower.snapshot.resourceReservations?.returns.some(receipt =>
        isDeepStrictEqual(receipt, (({controller: _, ...proof}) => proof)(returned))))
      throw new TestRunError(409, 'Resource check return requires its exact settled local resource release and current unowned generation')
    for (let attempt = 0; attempt < 3; attempt++) {
      const authority = await this.host(hostId), claims = hostResourceReservationsSchema.parse(authority.resourceReservations ?? []),
        claim = claims.filter(isExclusiveHostReservation).find(value => value.resourceId === returned.resourceId)
      if (authority.incarnation !== returned.controller.incarnation || authority.incarnationGeneration !== returned.controller.generation ||
        authority.sequence !== returned.controller.sequence || !fresh(authority, this.now()) ||
        !isDeepStrictEqual(authority.snapshot.resourceLifecycle, borrower.snapshot.resourceLifecycle) ||
        !isDeepStrictEqual(authority.snapshot.resourceReservations, borrower.snapshot.resourceReservations))
        throw new TestRunError(409, 'Resource release observation advanced; retain custody and report the same settled proof')
      if (!claim) {
        const row = await this.rows.candidateRequest?.(hostId, returned.inputSha256);
        if (row?.fleetCandidatePreparation && !await this.rows.recordCandidateReturn?.(row.requestId, row.fleetCandidatePreparation, returned))
          throw new TestRunError(409, 'Candidate normal return acknowledgement is pending');
        return {status: 'returned' as const, claimId: returned.claimId}
      }
      if (!claim.prerequisite || claim.id !== returned.claimId || claim.intentSha256 !== returned.intentSha256 ||
        claim.inputSha256 !== returned.inputSha256 || claim.operationId !== release.operationId || claim.borrowerHostId !== hostId ||
        claim.laneId !== returned.laneId || !isDeepStrictEqual(claim.owner, returned.originalOwner) || at < Date.parse(claim.reservedAt) ||
        returned.controller.generation < claim.controllerGeneration || returned.controller.generation === claim.controllerGeneration &&
        (returned.controller.incarnation !== claim.controllerIncarnation || returned.controller.sequence <= claim.borrowerSequence))
        throw new TestRunError(409, 'Resource check return differs from the retained original prerequisite claim')
      if (claim.prerequisite.candidate) {
        const row = await this.rows.request?.(claim.prerequisite.jobId), pending = row?.fleetCandidatePreparation;
        // The claim may have committed just before cancellation or a lost response.
        // Preserve that same claim before acknowledging its authentic no-start/closed return.
        if (!row || !pending || !await this.rows.recordCandidateClaim?.(row.requestId, pending, claim))
          throw new TestRunError(409, 'Original candidate claim checkpoint is pending');
      }
      if (await this.rows.replace(authority, claims.filter(value => value !== claim))) {
        if (claim.prerequisite.candidate) {
          const row = await this.rows.request?.(claim.prerequisite.jobId), pending = row?.fleetCandidatePreparation;
          if (!row || !pending || pending.targetInputSha256 !== returned.inputSha256 ||
            !isDeepStrictEqual(pending.candidate, claim.prerequisite.candidate) ||
            !await this.rows.recordCandidateReturn?.(row.requestId, pending, returned))
            throw new TestRunError(409, 'Candidate normal return acknowledgement is pending');
        }
        return {status: 'returned' as const, claimId: claim.id}
      }
    }
    throw new TestRunError(409, 'Resource authority changed; retry the same settled check release')
  }
}
