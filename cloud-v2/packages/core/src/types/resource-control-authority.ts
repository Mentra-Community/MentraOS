import type {ResourceControlRecord} from './lane-control.types'
import type {ResourceLifecycleSubject} from './resource-lifecycle.types'

type ReservationObservation = {id: string; generation: number; state: 'waiting' | 'granted' | 'returning' | 'released' | 'cancelled'; purpose: string; requestedAt: string}
/** Generation fences effects; it is not a new identity when an original waiting reservation is granted. */
export function resourceReservationIdentity(authority: {hostId: string; operatorId?: string; subject: {resourceId: string} | {laneId: string}}, reservation: Pick<ReservationObservation, 'id' | 'purpose' | 'requestedAt'>) {
  return JSON.stringify([authority.hostId, authority.operatorId ?? null, authority.subject, reservation.id, reservation.purpose, reservation.requestedAt])
}
/** Retain the nonzero observation separately from signed zero receipts used by exact return acknowledgements. */
export function resourceReservationGenerationConstraint(retained: number | undefined, ...values: ReservationObservation[]): number | undefined {
  let constraint = retained
  for (const value of values) if (value.generation !== 0) {
    if (constraint !== undefined && constraint !== value.generation) throw new Error('Resource reservation nonzero generation changed')
    constraint = value.generation
  }
  return constraint
}
/** Zero is schema-legal in every state; exact release input still fences effects. Nonzero contradictions and terminal reversals refuse. */
export function advanceResourceReservation<T extends ReservationObservation>(prior: T, next: T): T | undefined {
  const rank = {waiting: 0, granted: 1, returning: 2, released: 3, cancelled: 3}
  if (prior.generation !== 0 && next.generation !== 0 && prior.generation !== next.generation) return undefined
  if (rank[prior.state] === 3 && rank[next.state] === 3 && prior.state !== next.state) return undefined
  // A delayed same-state zero observation cannot discard an already observed effect fence.
  if (rank[prior.state] === rank[next.state] && prior.generation !== 0 && next.generation === 0) return prior
  return rank[next.state] >= rank[prior.state] ? next : prior
}

/** A delivered manual withdrawal stays restrictive until its later accepted baseline restores the exact subject. */
export function manualWithdrawalNeedsRestoration(row: ResourceControlRecord, subject: ResourceLifecycleSubject | undefined,
  hostId: string, hostCurrent: boolean, now: number) {
  if (row.command.action !== 'mark-out-of-service' || row.receipt?.result.status !== 'accepted' || !row.receipt.result.resource) return false
  const marked = row.receipt.result.resource, observed = Date.parse(subject?.observedAt ?? ''),
    accepted = Date.parse(subject?.idle.acceptedCheck?.acceptedAt ?? '')
  return row.command.hostId !== hostId || row.receipt.hostId !== hostId || row.command.subject.resourceId !== marked.resourceId ||
    !subject?.current || subject.subject.id !== marked.resourceId || subject.subject.authorityHostId !== hostId ||
    subject.status !== 'idle' || subject.owner !== null || subject.generation <= marked.generation || subject.idle.outcome !== 'passed' ||
    subject.idle.acceptedCheck?.subjectGeneration !== subject.generation || subject.idle.qualifiedScope.kind === 'unqualified' ||
    !hostCurrent || !Number.isFinite(observed) || observed > now || now - observed > 120_000 || !Number.isFinite(accepted) ||
    accepted < Date.parse(row.receipt.completedAt) || accepted > now
}
