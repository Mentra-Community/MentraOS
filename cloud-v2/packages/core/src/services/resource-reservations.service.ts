import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {TestHostStateModel} from '../models/test-host-state.model'
import {testWriteConcern} from '../models/test-write-concern'
import {exclusiveResourceIntentSchema, exclusiveResourceObservationInputSchema, exclusiveResourceReturnSchema, hostResourceReservationsSchema,
  fleetExclusiveObservationSchema, fleetExclusiveReservationSchema, fleetExclusiveExecutionBindingSchema,
  isExclusiveHostReservation, type ExclusiveHostReservation, type ExclusiveResourceDependency, type ExclusiveResourceIntent,
  type FleetExclusiveReservation, type HostResourceReservation} from '../types/resource-reservations.types'
import {hostStateSchema, type TestHostState} from './test-host-state.service'
import {requestInputDigest} from './test-request.service'
import {TestRunError} from './test-result-error'
import {TestRequestModel} from '../models/test-request.model'
import {fleetResourceExecutionBinding} from './fleet-resource-binding'
import {frameworkRequestInputSchema} from '../types/framework-request.types'
import type {StoredRoutineJob} from '../types/routine-job.types'
import {preparationRejectionSchema} from '../types/routine-dispatch.types'
import {z} from 'zod'

export type ResourceReservationHost = {hostId: string; incarnation: string; incarnationGeneration: number; sequence: number;
  receivedAt: Date; snapshot: TestHostState; resourceReservationVersion?: number; resourceReservations?: unknown}
export interface ResourceReservationRepository {
  get(hostId: string): Promise<ResourceReservationHost | null>
  replace(host: ResourceReservationHost, claims: HostResourceReservation[]): Promise<boolean>
  request?(requestId: string): Promise<(StoredRoutineJob & {input?: unknown}) | null>
  claimedHosts?(requestId: string): Promise<ResourceReservationHost[]>
}
const repository: ResourceReservationRepository = {
  async get(hostId) {
    return await TestHostStateModel.findOne({hostId}).select({hostId: 1, incarnation: 1, incarnationGeneration: 1,
      sequence: 1, receivedAt: 1, 'snapshot.hostId': 1, 'snapshot.incarnation': 1, 'snapshot.incarnationGeneration': 1,
      'snapshot.sequence': 1, 'snapshot.observedAt': 1, 'snapshot.lanes.id': 1, 'snapshot.lanes.platform': 1,
      'snapshot.lanes.dispatchMode': 1, 'snapshot.lanes.state': 1, 'snapshot.lanes.activity': 1,
      'snapshot.lanes.resources': 1, 'snapshot.lanes.glasses': 1, 'snapshot.resourceReservations': 1, resourceReservationVersion: 1, resourceReservations: 1})
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
  async claimedHosts(requestId) {
    return await TestHostStateModel.find({resourceReservations: {$elemMatch: {kind: 'exclusive', 'owner.id': requestId, 'owner.kind': 'run', 'origin.kind': 'fleet'}}})
      .limit(2).read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean() as unknown as ResourceReservationHost[]
  },
}
const fresh = (host: ResourceReservationHost, now: number) => [host.receivedAt.getTime(), Date.parse(host.snapshot.observedAt)]
  .every(at => Number.isFinite(at) && at <= now && now - at <= 120_000)
const dependencies = (host: ResourceReservationHost, intent: ExclusiveResourceIntent): ExclusiveResourceDependency[] => {
  const lane = host.snapshot.lanes.find(value => value.id === intent.laneId)
  if (!lane || !['idle', 'running', 'reserved'].includes(lane.state) ||
    lane.dispatchMode === 'paused' ||
    lane.activity && !isDeepStrictEqual({id: lane.activity.owner.id, kind: lane.activity.owner.kind}, intent.owner))
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
  constructor(private rows: ResourceReservationRepository = repository, private now = Date.now) {}
  private async host(hostId: string) {
    const host = await this.rows.get(hostId)
    if (!host || host.hostId !== hostId) throw new TestRunError(404, 'Resource authority host was not found')
    host.snapshot = hostStateSchema.parse(host.snapshot)
    return host
  }
  /** The original winner is committed on one existing authority row before any Actions device binding.
   * Request and byte receipts only adopt this winner; their losing writes never create another exclusive owner.
   */
  async reserveFleet(requestId: string, digest: string, hostId: string, laneId: string): Promise<FleetExclusiveReservation | null | undefined> {
    const row = await this.rows.request?.(requestId), borrower = await this.host(hostId), lane = borrower.snapshot.lanes.find(value => value.id === laneId)
    if (!row?.fleetPreparation || row.fleetInputSha256 !== digest || row.state !== 'awaiting-runner' || row.fleetBinding || row.fleetCancellation ||
      row.hostId || row.inputSha256 || row.input || row.fleetDeadline.getTime() <= this.now() || !fresh(borrower, this.now()) ||
      !lane || lane.state !== 'idle' || lane.activity || lane.dispatchMode !== 'automatic') return null
    const resources = row.fleetPreparation.requirements.resources.map(required => {
      const resource = lane.resources.find(value => value.kind === required.kind)
      return resource ? {id: resource.id, capabilities: [...required.capabilities]} : null
    })
    if (resources.some(value => value === null)) return null
    const intent: ExclusiveResourceIntent = {operationId: `run:${requestId}`, hostId, laneId, inputSha256: digest,
      owner: {id: requestId, kind: 'run'}, resources: resources as ExclusiveResourceIntent['resources'],
      controller: {incarnation: borrower.incarnation, generation: borrower.incarnationGeneration, sequence: borrower.sequence}},
      selected = dependencies(borrower, intent), origin = {kind: 'fleet' as const, fleetInputSha256: digest}
    if (!selected.length) return undefined
    if (new Set(selected.map(value => value.authorityHostId)).size !== 1) return null
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.rows.request?.(requestId)
      if (!current || current.fleetInputSha256 !== digest || current.fleetBinding || current.fleetCancellation || current.hostId || current.input ||
        current.inputSha256 || current.state !== 'awaiting-runner' || current.fleetDeadline.getTime() <= this.now()) return null
      const authority = await this.host(selected[0]!.authorityHostId)
      if (!fresh(authority, this.now()) || selected.some(dependency => !authority.snapshot.lanes.some(value => value.resources.some(resource =>
        resource.exclusiveDependencies?.some(enrolled => enrolled.resourceId === dependency.resourceId && enrolled.authorityHostId === authority.hostId))))) return null
      const claims = hostResourceReservationsSchema.parse(authority.resourceReservations ?? []),
        existing = claims.filter(isExclusiveHostReservation).filter(claim => selected.some(value => value.resourceId === claim.resourceId))
      if (existing.length) {
        if (existing.length !== selected.length || existing.some(claim => !claim.origin || claim.origin.fleetInputSha256 !== digest ||
          claim.owner.id !== requestId || claim.owner.kind !== 'run' || claim.borrowerHostId !== hostId || claim.laneId !== laneId ||
          claim.operationId !== intent.operationId || claim.controllerGeneration !== existing[0]!.controllerGeneration ||
          claim.controllerIncarnation !== existing[0]!.controllerIncarnation || claim.borrowerSequence !== existing[0]!.borrowerSequence)) return null
        const originalIntent = {...intent, controller: {incarnation: existing[0]!.controllerIncarnation,
          generation: existing[0]!.controllerGeneration, sequence: existing[0]!.borrowerSequence}},
          intentSha256 = requestInputDigest({...originalIntent, controller: {incarnation: originalIntent.controller.incarnation,
            generation: originalIntent.controller.generation}, origin, dependencies: selected})
        if (existing.some(claim => claim.intentSha256 !== intentSha256)) return null
        return fleetExclusiveReservationSchema.parse({origin, intent: originalIntent, intentSha256, claims: existing})
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
          after.state !== 'awaiting-runner' || after.fleetInputSha256 !== digest) return null
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
          (!bound || claim.borrowerHostId === row.hostId && claim.laneId === row.fleetBinding!.laneId))
      if (!own.length) break
      if (await this.rows.replace(authority, claims.filter(value => !own.some(claim => claim.id === value.id)))) break
      if (attempt === 2) throw new TestRunError(409, 'Resource authority changed during terminal pre-execution reconciliation')
    }
  }
  async acquire(value: unknown, hostId: string) {
    const intent = exclusiveResourceIntentSchema.parse(value)
    if (intent.hostId !== hostId) throw new TestRunError(409, 'Resource intent differs from authenticated controller')
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
  /** Read the exact old claim after lost transport or restart; this operation can neither acquire nor release anything. */
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
    const selected = dependencies(borrower, intent), intentSha256 = requestInputDigest({...intent,
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
      claim.controllerIncarnation === intent.controller.incarnation && claim.controllerGeneration === intent.controller.generation)
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
    if (!row?.fleetExclusiveReservation || !row.fleetExclusiveExecutionBinding || row.fleetInputSha256 !== reservation.origin.fleetInputSha256 ||
      row.hostId !== hostId || row.fleetBinding?.laneId !== intent.laneId || row.dispatchIntentSha256 !== input.fleetExclusive.binding.dispatchIntentSha256 ||
      row.inputSha256 !== input.fleetExclusive.binding.executionInputSha256 || !row.input ||
      !isDeepStrictEqual(fleetExclusiveReservationSchema.parse(row.fleetExclusiveReservation), reservation) ||
      !isDeepStrictEqual(fleetExclusiveExecutionBindingSchema.parse(row.fleetExclusiveExecutionBinding), input.fleetExclusive.binding)) return unknown
    const executable = frameworkRequestInputSchema.parse(row.input)
    if (requestInputDigest(executable) !== row.inputSha256 || !isDeepStrictEqual(fleetResourceExecutionBinding(reservation,
      row.requestId, hostId, row.dispatchIntentSha256!, executable, row.inputSha256), input.fleetExclusive.binding)) return unknown
    const selected = dependencies(borrower, intent)
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
      if (claim.id !== returned.claimId || claim.intentSha256 !== returned.intentSha256 || claim.inputSha256 !== returned.inputSha256 ||
        claim.borrowerHostId !== hostId || claim.laneId !== returned.laneId || !isDeepStrictEqual(claim.owner, returned.originalOwner) ||
        returned.release.neverStarted && claim.operationId !== `run:${returned.release.neverStarted.requestId}` ||
        releasedAt < Date.parse(claim.reservedAt) || returned.controller.generation < claim.controllerGeneration ||
        returned.controller.generation === claim.controllerGeneration && (returned.controller.incarnation !== claim.controllerIncarnation ||
          returned.controller.sequence <= claim.borrowerSequence))
        throw new TestRunError(409, 'Return proof differs from the retained original resource authority')
      if (claim.origin) {
        const row = await this.rows.request?.(claim.owner.id)
        if (!row?.fleetExclusiveReservation || !row.fleetExclusiveExecutionBinding || !row.input || !row.inputSha256 ||
          row.fleetInputSha256 !== claim.origin.fleetInputSha256 || row.hostId !== hostId || row.fleetBinding?.laneId !== claim.laneId ||
          !row.fleetExclusiveReservation.claims.some(value => isDeepStrictEqual(value, claim)) ||
          !isDeepStrictEqual(fleetResourceExecutionBinding(row.fleetExclusiveReservation, row.requestId, hostId,
            row.dispatchIntentSha256!, frameworkRequestInputSchema.parse(row.input), row.inputSha256), row.fleetExclusiveExecutionBinding))
          throw new TestRunError(409, 'Portable resource return requires its original committed executable binding')
        if (returned.release.neverStarted && !(row.hostCancellation || row.fleetCancellation || row.state === 'terminal' && row.terminalStatus === 'cancelled'))
          throw new TestRunError(409, 'Never-started portable resource return requires the matching Core cancellation')
      }
      if (await this.rows.replace(authority, claims.filter(value => value !== claim)))
        return {status: 'returned' as const, claimId: claim.id}
    }
    throw new TestRunError(409, 'Resource authority changed; retry the same normal return proof')
  }
}
