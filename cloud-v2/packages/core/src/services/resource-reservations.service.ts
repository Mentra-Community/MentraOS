import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {TestHostStateModel} from '../models/test-host-state.model'
import {testWriteConcern} from '../models/test-write-concern'
import {exclusiveResourceIntentSchema, exclusiveResourceReturnSchema, hostResourceReservationsSchema,
  isExclusiveHostReservation, type ExclusiveHostReservation, type ExclusiveResourceDependency, type ExclusiveResourceIntent,
  type HostResourceReservation} from '../types/resource-reservations.types'
import {hostStateSchema, type TestHostState} from './test-host-state.service'
import {requestInputDigest} from './test-request.service'
import {TestRunError} from './test-result-error'

export type ResourceReservationHost = {hostId: string; incarnation: string; incarnationGeneration: number; sequence: number;
  receivedAt: Date; snapshot: TestHostState; resourceReservationVersion?: number; resourceReservations?: unknown}
export interface ResourceReservationRepository {
  get(hostId: string): Promise<ResourceReservationHost | null>
  replace(host: ResourceReservationHost, claims: HostResourceReservation[]): Promise<boolean>
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
      returned.release.lineage.some((owner, index, lineage) => index > 0 && owner.generation <= lineage[index - 1]!.generation))
      throw new TestRunError(409, 'Return requires fresh idle custody and its exact recorded normal local release lineage')
    for (let attempt = 0; attempt < 3; attempt++) {
      const authority = await this.host(returned.authorityHostId), claims = hostResourceReservationsSchema.parse(authority.resourceReservations ?? [])
      const claim = claims.filter(isExclusiveHostReservation).find(value => value.resourceId === returned.resourceId)
      if (!claim) return {status: 'returned' as const, claimId: returned.claimId}
      if (claim.id !== returned.claimId || claim.intentSha256 !== returned.intentSha256 || claim.inputSha256 !== returned.inputSha256 ||
        claim.borrowerHostId !== hostId || claim.laneId !== returned.laneId || !isDeepStrictEqual(claim.owner, returned.originalOwner) ||
        releasedAt < Date.parse(claim.reservedAt) || returned.controller.generation < claim.controllerGeneration ||
        returned.controller.generation === claim.controllerGeneration && (returned.controller.incarnation !== claim.controllerIncarnation ||
          returned.controller.sequence <= claim.borrowerSequence))
        throw new TestRunError(409, 'Return proof differs from the retained original resource authority')
      if (await this.rows.replace(authority, claims.filter(value => value !== claim)))
        return {status: 'returned' as const, claimId: claim.id}
    }
    throw new TestRunError(409, 'Resource authority changed; retry the same normal return proof')
  }
}
