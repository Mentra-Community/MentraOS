import type {ResourceControlRecord} from './lane-control.types'
import type {ResourceLifecycleSubject} from './resource-lifecycle.types'

type ReservationObservation = {id: string; generation: number; state: 'waiting' | 'granted' | 'returning' | 'released' | 'cancelled'; purpose: string; requestedAt: string}
/** Generation fences effects; it is not a new identity when an original waiting reservation is granted. */
export function resourceReservationIdentity(authority: {hostId: string; operatorId?: string; subject: {resourceId: string} | {laneId: string}}, reservation: Pick<ReservationObservation, 'id' | 'purpose' | 'requestedAt'>) {
  return JSON.stringify([authority.hostId, authority.operatorId ?? null, authority.subject, reservation.id, reservation.purpose, reservation.requestedAt])
}
/** Undefined means two observations contradict the original generation or terminal decision. */
export function advanceResourceReservation<T extends ReservationObservation>(prior: T, next: T): T | undefined {
  const rank = {waiting: 0, granted: 1, returning: 2, released: 3, cancelled: 3}
  if (prior.generation !== 0 && next.generation !== 0 && prior.generation !== next.generation) return undefined
  if ((prior.generation === 0 && !['waiting', 'released', 'cancelled'].includes(prior.state)) ||
    (next.generation === 0 && !['waiting', 'released', 'cancelled'].includes(next.state))) return undefined
  if (rank[prior.state] === 3 && rank[next.state] === 3 && prior.state !== next.state) return undefined
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
