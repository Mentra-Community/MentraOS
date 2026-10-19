import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {TestHostStateModel} from '../models/test-host-state.model'
import {testWriteConcern} from '../models/test-write-concern'
import {exclusiveResourceIntentSchema, exclusiveResourceObservationInputSchema, exclusiveResourceReturnSchema, hostResourceReservationsSchema,
  fleetExclusiveObservationSchema, fleetExclusiveReservationSchema, fleetExclusiveExecutionBindingSchema, fleetResourceAdmissionSchema,
  isExclusiveHostReservation, type ExclusiveHostReservation, type ExclusiveResourceDependency, type ExclusiveResourceIntent,
  type FleetExclusiveReservation, type FleetResourceAdmission, type HostResourceReservation} from '../types/resource-reservations.types'
import {hostStateSchema, type TestHostState} from './test-host-state.service'
import {requestInputDigest} from './test-request.service'
import {TestRunError} from './test-result-error'
import {TestRequestModel} from '../models/test-request.model'
import {assertFleetResourceAdmission, fleetResourceExecutionBinding} from './fleet-resource-binding'
import {frameworkRequestInputSchema} from '../types/framework-request.types'
import type {StoredRoutineJob, OwnedRoutineQualification, RoutineQualificationTarget} from '../types/routine-job.types'
import {preparationRejectionSchema} from '../types/routine-dispatch.types'
import {z} from 'zod'
import {BACKEND_CONNECTIVITY_ROUTINE_API_VERSION} from '../types/backend-connectivity.types'
import type {RecorderHostReservation} from '../types/recorder-storage.types'

export type ResourceReservationHost = {hostId: string; incarnation: string; incarnationGeneration: number; sequence: number;
  receivedAt: Date; snapshot: TestHostState; resourceReservationVersion?: number; resourceReservations?: unknown}
export type ExclusiveResourceBlocker = {resourceId: string; hostId: string; laneId: string; owner: ExclusiveHostReservation['owner']}
export interface ResourceReservationRepository {
  get(hostId: string): Promise<ResourceReservationHost | null>
  replace(host: ResourceReservationHost, claims: HostResourceReservation[]): Promise<boolean>
  request?(requestId: string): Promise<(StoredRoutineJob & {input?: unknown}) | null>
  stage?(requestId: string, digest: string, admission: FleetResourceAdmission, now: Date): Promise<StoredRoutineJob | null>
  stageBackend?(requestId: string, digest: string, admission: FleetResourceAdmission, host: ResourceReservationHost, now: Date): Promise<StoredRoutineJob | null>
  replaceBackend?(host: ResourceReservationHost, claims: HostResourceReservation[], intent: ExclusiveResourceIntent, now: Date): Promise<boolean>
  claimedHosts?(requestId: string): Promise<ResourceReservationHost[]>
  recorderClaims?(requestId: string): Promise<RecorderHostReservation[]>
}
const stageFilter = (requestId: string, digest: string, now: Date) => ({requestId, fleetInputSha256: digest, state: 'awaiting-runner',
  fleetResourceAdmission: {$exists: false}, fleetBinding: {$exists: false}, fleetResourceReservation: {$exists: false},
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
  if (!purpose || !row?.fleetPreparation || row.requestId !== purpose.jobId || row.state !== 'preparing' ||
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
export const resourceReservationRepository: ResourceReservationRepository = {
  async get(hostId) {
    return await TestHostStateModel.findOne({hostId}).select({hostId: 1, incarnation: 1, incarnationGeneration: 1,
      sequence: 1, receivedAt: 1, 'snapshot.hostId': 1, 'snapshot.incarnation': 1, 'snapshot.incarnationGeneration': 1,
      'snapshot.sequence': 1, 'snapshot.observedAt': 1, 'snapshot.lanes.id': 1, 'snapshot.lanes.platform': 1,
      'snapshot.lanes.dispatchMode': 1, 'snapshot.lanes.state': 1, 'snapshot.lanes.activity': 1,
      'snapshot.lanes.resources': 1, 'snapshot.lanes.glasses': 1, 'snapshot.resourceReservations': 1,
      'snapshot.frameworkBinding': 1, 'snapshot.frameworkAcceptedAt': 1, 'snapshot.frameworkProcess': 1,
      'snapshot.resourceLifecycle': 1, resourceReservationVersion: 1, resourceReservations: 1})
      .read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean() as ResourceReservationHost | null
  },
  async replace(host, claims) {
    const row = await TestHostStateModel.findOneAndUpdate({hostId: host.hostId, incarnation: host.incarnation,
      incarnationGeneration: host.incarnationGeneration, sequence: host.sequence,
      resourceReservationVersion: host.resourceReservationVersion ?? {$exists: false}},
      {$set: {resourceReservations: claims}, $inc: {resourceReservationVersion: 1}},
      {new: true, writeConcern: testWriteConcern}).select({hostId: 1}).setOptions({timeoutMS: 5000}).lean()
    return Boolean(row)
  },
  async request(requestId) {return await TestRequestModel.findOne({requestId}).read('primary').readConcern('majority')
    .setOptions({timeoutMS: 5000}).lean() as unknown as (StoredRoutineJob & {input?: unknown}) | null},
  async stage(requestId, digest, fleetResourceAdmission, now) {
    return await TestRequestModel.collection.findOneAndUpdate(stageFilter(requestId, digest, now),
      {$set: {fleetResourceAdmission}}, {returnDocument: 'after', writeConcern: testWriteConcern, timeoutMS: 5000}) as unknown as StoredRoutineJob | null
  },
  async stageBackend(requestId, digest, fleetResourceAdmission, host, now) {
    const original = await this.request!(requestId), claims = await this.recorderClaims!(requestId),
      current = await this.get(host.hostId), laneId = fleetResourceAdmission.intent.laneId
    if (!current || !backendRecorderClaimMatches(claims, requestId, digest, host.hostId, laneId) ||
      current.incarnation !== host.incarnation || current.incarnationGeneration !== host.incarnationGeneration || current.sequence !== host.sequence ||
      !hostResourceReservationsSchema.parse(current.resourceReservations ?? []).some(claim => isDeepStrictEqual(claim, claims[0])) ||
      hasBackendProbe(hostResourceReservationsSchema.parse(current.resourceReservations ?? []), host.hostId, laneId) ||
      !fresh(current, now.getTime())) return null
    // The retained byte claim already won the same host CAS as phone probes. It survives
    // failed/lost staging replies; this request CAS selects only that original candidate.
    return this.stage!(requestId, digest, fleetResourceAdmission, now)
  },
  async replaceBackend(host, claims, intent, now) {
    if (!backendPrerequisiteRequestMatches(await this.request!(intent.prerequisite!.jobId), intent, now.getTime())) return false
    // A recorder claim is retained before any backend run stage. The ordinary host-row
    // CAS makes a competing byte/probe write lose without a cross-collection transaction.
    return this.replace(host, claims)
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
    private qualificationTargets: (hostId: string, owned: OwnedRoutineQualification) => Promise<RoutineQualificationTarget[]> =
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
    if (!row?.fleetPreparation || row.fleetInputSha256 !== digest || row.state !== 'awaiting-runner' || row.fleetBinding || row.fleetCancellation ||
      row.hostId || row.inputSha256 || row.input || row.fleetDeadline.getTime() <= this.now()) return null
    if (row.fleetResourceAdmission && (row.fleetResourceAdmission.intent.hostId !== hostId || row.fleetResourceAdmission.intent.laneId !== laneId)) return null
    const borrower = await this.host(hostId), lane = borrower.snapshot.lanes.find(value => value.id === laneId)
    if (!fresh(borrower, this.now()) ||
      !lane || lane.state !== 'idle' || lane.activity || lane.dispatchMode !== 'automatic') return null
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
    const backendRequired = requiresBackendConnectivity(row)
    if (backendRequired) {
      const originals = await this.rows.recorderClaims?.(requestId)
      if (!originals || !backendRecorderClaimMatches(originals, requestId, digest, hostId, laneId) ||
        !hostResourceReservationsSchema.parse(borrower.resourceReservations ?? []).some(value => isDeepStrictEqual(value, originals[0]))) return null
    }
    if (!row.fleetResourceAdmission) row = await (backendRequired
      ? this.rows.stageBackend?.(requestId, digest, candidate, borrower, new Date(this.now()))
      : this.rows.stage?.(requestId, digest, candidate, new Date(this.now()))) ?? await this.rows.request?.(requestId)
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
    if (!selected.length) return retained.length ? null : undefined
    if (retained.length && (retained.length !== selected.length || selected.some(dependency => !retained.some(claim =>
      claim.resourceId === dependency.resourceId && claim.authorityHostId === dependency.authorityHostId)))) return null
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.rows.request?.(requestId)
      if (!current || current.fleetInputSha256 !== digest || current.fleetBinding || current.fleetCancellation || current.hostId || current.input ||
        current.inputSha256 || current.state !== 'awaiting-runner' || current.fleetDeadline.getTime() <= this.now() ||
        !isDeepStrictEqual(current.fleetResourceAdmission, admission)) return null
      const authority = await this.host(selected[0]!.authorityHostId)
      if (!fresh(authority, this.now()) || selected.some(dependency => !authority.snapshot.lanes.some(value => value.resources.some(resource =>
        resource.exclusiveDependencies?.some(enrolled => enrolled.resourceId === dependency.resourceId && enrolled.authorityHostId === authority.hostId))))) return null
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
        return row.fleetExclusiveReservation && !isDeepStrictEqual(row.fleetExclusiveReservation, receipt) ? null : receipt
      }
      if (claims.length + selected.length > 1000) return null
      const intentSha256 = requestInputDigest({...intent, controller: {incarnation: intent.controller.incarnation,
        generation: intent.controller.generation}, origin, dependencies: selected}),
        next: ExclusiveHostReservation[] = selected.map(dependency => ({kind: 'exclusive', id: randomUUID(), resourceId: dependency.resourceId,
          authorityHostId: authority.hostId, borrowerHostId: hostId, laneId, operationId: intent.operationId, intentSha256,
          inputSha256: digest, owner: intent.owner, origin, controllerIncarnation: intent.controller.incarnation,
          controllerGeneration: intent.controller.generation, borrowerSequence: intent.controller.sequence, reservedAt: new Date(this.now()).toISOString()}))
      if (await this.rows.replace(authority, [...claims, ...next])) {
        const after = await this.rows.request?.(requestId)
        if (after?.fleetCancellation) await this.reconcileFleetCancellation(requestId)
        if (!after || after.fleetCancellation || after.fleetBinding || after.hostId || after.input || after.inputSha256 ||
          after.state !== 'awaiting-runner' || after.fleetInputSha256 !== digest || !isDeepStrictEqual(after.fleetResourceAdmission, admission)) return null
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
    if (intent.prerequisite) return this.acquireBackendPrerequisite(intent, hostId)
    const borrower = await this.host(hostId)
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
      if (selected.some(dependency => !authority.snapshot.lanes.some(lane => lane.resources.some(resource =>
        resource.exclusiveDependencies?.some(value => value.resourceId === dependency.resourceId && value.authorityHostId === authority.hostId)))))
        throw new TestRunError(409, 'Selected authority has not enrolled this canonical resource dependency')
      const claims = hostResourceReservationsSchema.parse(authority.resourceReservations ?? []),
        current = claims.filter(isExclusiveHostReservation).filter(claim => selected.some(value => value.resourceId === claim.resourceId)),
        blocked = current.find(claim => claim.intentSha256 !== intentSha256 || claim.borrowerHostId !== hostId || claim.operationId !== intent.operationId)
      if (blocked) return {status: 'waiting' as const, intentSha256, claims: [],
        blocked: {resourceId: blocked.resourceId, hostId: blocked.borrowerHostId, laneId: blocked.laneId, owner: blocked.owner}}
      const missing = selected.filter(dependency => !current.some(claim => claim.resourceId === dependency.resourceId))
      if (!missing.length) return {status: 'reserved' as const, intentSha256, claims: current}
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
    if (intent.prerequisite) {
      const intentSha256 = this.backendIntentDigest(intent), all = hostResourceReservationsSchema.parse(borrower.resourceReservations ?? []),
        claims = all.filter(isExclusiveHostReservation).filter(claim => claim.resourceId === intent.prerequisite!.resourceId),
        unknown = {status: 'unknown' as const, intentSha256, claims: []}
      if (claims.length) return claims.length === 1 && this.backendClaimMatches(claims[0]!, intent, intentSha256) ?
        {status: 'reserved' as const, intentSha256, claims} : unknown
      const newer = input.controller.generation > intent.controller.generation ||
        input.controller.generation === intent.controller.generation && input.controller.sequence > intent.controller.sequence,
        subject = borrower.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === intent.prerequisite!.resourceId)
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
    const matches = selected.every(dependency => authority.snapshot.lanes.some(lane => lane.resources.some(resource =>
      resource.exclusiveDependencies?.some(value => value.resourceId === dependency.resourceId && value.authorityHostId === authority.hostId)))) &&
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
    const enrolled = selected.every(dependency => authority.snapshot.lanes.some(lane => lane.resources.some(resource =>
      resource.exclusiveDependencies?.some(value => value.resourceId === dependency.resourceId && value.authorityHostId === authority.hostId))))
    return enrolled && reservation.claims.every(claim => claims.some(value => isDeepStrictEqual(value, claim))) ?
      {status: 'reserved' as const, intentSha256: reservation.intentSha256, claims: reservation.claims} : unknown
  }
  async giveBack(value: unknown, hostId: string) {
    const returned = exclusiveResourceReturnSchema.parse(value), borrower = await this.host(hostId)
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
      const claim = claims.filter(isExclusiveHostReservation).find(value => value.resourceId === returned.resourceId)
      if (!claim) return {status: 'returned' as const, claimId: returned.claimId}
      if (claim.prerequisite || claim.id !== returned.claimId || claim.intentSha256 !== returned.intentSha256 || claim.inputSha256 !== returned.inputSha256 ||
        claim.borrowerHostId !== hostId || claim.laneId !== returned.laneId || !isDeepStrictEqual(claim.owner, returned.originalOwner) ||
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
  private backendClaimMatches(claim: ExclusiveHostReservation, intent: ExclusiveResourceIntent, digest: string) {
    return claim.intentSha256 === digest && claim.operationId === intent.operationId && claim.inputSha256 === intent.inputSha256 &&
      claim.authorityHostId === intent.hostId && claim.borrowerHostId === intent.hostId && claim.laneId === intent.laneId &&
      claim.resourceId === intent.prerequisite!.resourceId && isDeepStrictEqual(claim.owner, intent.owner) &&
      isDeepStrictEqual(claim.prerequisite, intent.prerequisite) && !claim.origin &&
      claim.controllerIncarnation === intent.controller.incarnation && claim.controllerGeneration === intent.controller.generation &&
      claim.borrowerSequence === intent.controller.sequence
  }
  private async backendTargetCurrent(host: ResourceReservationHost, intent: ExclusiveResourceIntent) {
    const purpose = intent.prerequisite!, lane = host.snapshot.lanes.find(value => value.id === intent.laneId),
      subject = host.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === purpose.resourceId)
    if (!fresh(host, this.now()) || host.incarnation !== intent.controller.incarnation ||
      host.incarnationGeneration !== intent.controller.generation || host.sequence !== intent.controller.sequence ||
      !isDeepStrictEqual(host.snapshot.frameworkBinding, purpose.binding) || purpose.binding.routineApiVersion < BACKEND_CONNECTIVITY_ROUTINE_API_VERSION ||
      !lane || lane.platform !== 'android' || lane.state !== 'idle' || lane.activity || lane.dispatchMode !== 'automatic' ||
      !lane.resources.some(resource => resource.id === purpose.resourceId && resource.kind === 'phone' &&
        resource.capabilities?.includes('backend-connectivity')) || !subject?.current || subject.subject.authorityHostId !== host.hostId ||
      subject.status !== 'checking' || subject.owner?.kind !== 'boundary-cleanup' || subject.owner.id !== intent.owner.id ||
      subject.owner.generation === null || subject.owner.generation === undefined || subject.owner.laneId !== intent.laneId ||
      intent.owner.id !== `resource-check:${requestInputDigest({operationId: intent.operationId, resourceId: purpose.resourceId})}`)
      return false
    const targets = await this.qualificationTargets(host.hostId, {jobId: purpose.jobId, laneId: intent.laneId,
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
      isDeepStrictEqual(targets[0]!.acceptedBinding, purpose.binding) && isDeepStrictEqual(targets[0]!.preparing, purpose.preparing)
  }
  private async acquireBackendPrerequisite(intent: ExclusiveResourceIntent, hostId: string) {
    const intentSha256 = this.backendIntentDigest(intent), unknown = {status: 'unknown' as const, intentSha256, claims: []}
    for (let attempt = 0; attempt < 3; attempt++) {
      const host = await this.host(hostId)
      if (!await this.backendTargetCurrent(host, intent)) return unknown
      const selected = await this.rows.request?.(intent.prerequisite!.jobId)
      if (!backendPrerequisiteRequestMatches(selected ?? null, intent, this.now())) return unknown
      const claims = hostResourceReservationsSchema.parse(host.resourceReservations ?? []),
        current = claims.filter(isExclusiveHostReservation).find(claim => claim.resourceId === intent.prerequisite!.resourceId),
        blocked = claims.find(claim => isExclusiveHostReservation(claim) ?
          claim.borrowerHostId === hostId && claim.laneId === intent.laneId && claim !== current &&
            !selected!.fleetExclusiveReservation?.claims.some(original => isDeepStrictEqual(original, claim)) :
          claim.hostId === hostId && claim.laneId === intent.laneId && !isDeepStrictEqual(claim, selected!.fleetResourceReservation))
      if (blocked || current && !this.backendClaimMatches(current, intent, intentSha256)) {
        const blocker = blocked ?? current!
        return {status: 'waiting' as const, intentSha256, claims: [], blocked: {
          resourceId: intent.prerequisite!.resourceId, hostId, laneId: intent.laneId,
          owner: isExclusiveHostReservation(blocker) ? blocker.owner : {kind: 'run' as const, id: blocker.requestId}}}
      }
      if (current) {
        const after = await this.host(hostId)
        return await this.backendTargetCurrent(after, intent) && hostResourceReservationsSchema.parse(after.resourceReservations ?? [])
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
      // Lost or cancelled target settlement retains the committed original claim. No native reader is authorized by an uncertain answer.
      const after = await this.host(hostId)
      if (!await this.backendTargetCurrent(after, intent) || !hostResourceReservationsSchema.parse(after.resourceReservations ?? [])
        .some(value => isDeepStrictEqual(value, claim))) return unknown
      return {status: 'reserved' as const, intentSha256, claims: [claim]}
    }
    throw new TestRunError(409, 'Resource authority changed; observe the unchanged prerequisite intent')
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
      if (!claim) return {status: 'returned' as const, claimId: returned.claimId}
      if (!claim.prerequisite || claim.id !== returned.claimId || claim.intentSha256 !== returned.intentSha256 ||
        claim.inputSha256 !== returned.inputSha256 || claim.operationId !== release.operationId || claim.borrowerHostId !== hostId ||
        claim.laneId !== returned.laneId || !isDeepStrictEqual(claim.owner, returned.originalOwner) || at < Date.parse(claim.reservedAt) ||
        returned.controller.generation < claim.controllerGeneration || returned.controller.generation === claim.controllerGeneration &&
        (returned.controller.incarnation !== claim.controllerIncarnation || returned.controller.sequence <= claim.borrowerSequence))
        throw new TestRunError(409, 'Resource check return differs from the retained original prerequisite claim')
      if (await this.rows.replace(authority, claims.filter(value => value !== claim))) return {status: 'returned' as const, claimId: claim.id}
    }
    throw new TestRunError(409, 'Resource authority changed; retry the same settled check release')
  }
}
