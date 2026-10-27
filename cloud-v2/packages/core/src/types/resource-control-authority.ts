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

/** Completion belongs to this withdrawal; subsequent checks cannot reopen it. */
export function acceptedManualRestoration(row: ResourceControlRecord, subject: ResourceLifecycleSubject | undefined,
  hostId: string, hostCurrent: boolean, now: number): ResourceControlRecord['restoredBy'] {
  if (row.command.action !== 'mark-out-of-service' || row.receipt?.result.status !== 'accepted' || !row.receipt.result.resource) return
  const marked = row.receipt.result.resource, receipt = row.receipt,
    matches = (proof: NonNullable<ResourceControlRecord['restoredBy']>) =>
      row.command.hostId === hostId && receipt.hostId === hostId && row.command.subject.resourceId === marked.resourceId &&
      proof.hostId === hostId && proof.resourceId === marked.resourceId && proof.subjectGeneration > marked.generation &&
      Date.parse(proof.acceptedAt) >= Date.parse(receipt.completedAt) && Date.parse(proof.acceptedAt) <= now
  if (row.restoredBy && matches(row.restoredBy)) return row.restoredBy
  const check = subject?.idle.acceptedCheck, observed = Date.parse(subject?.observedAt ?? ''), report = subject?.idle.report,
    passed = subject?.status === 'idle' && subject.idle.outcome === 'passed',
    retainedPass = subject?.status === 'unknown' && subject.reason?.code === 'idle-check-required' &&
      report?.outcome === 'passed' && report.reportedOutcome === 'passed' && report.resourceId === marked.resourceId &&
      report.authorityHostId === hostId && report.operationId === check?.operationId && report.resultSha256 === check?.resultSha256 &&
      report.contractVersion === subject.idle.contractVersion && report.checkedAt === subject.idle.checkedAt
  if (!hostCurrent || !subject?.current || subject.subject.id !== marked.resourceId || subject.subject.authorityHostId !== hostId ||
    subject.owner !== null || subject.repair.state !== 'none' || !check || check.subjectGeneration !== subject.generation ||
    subject.idle.qualifiedScope.kind === 'unqualified' || (!passed && !retainedPass) ||
    !Number.isFinite(observed) || observed > now || Date.parse(check.acceptedAt) > observed) return
  const proof = {hostId, resourceId: marked.resourceId, ...check}
  return matches(proof) ? proof : undefined
}

/** A delivered withdrawal stays restrictive until its authenticated restoration is accepted. */
export function manualWithdrawalNeedsRestoration(row: ResourceControlRecord, subject: ResourceLifecycleSubject | undefined,
  hostId: string, hostCurrent: boolean, now: number) {
  if (row.command.action !== 'mark-out-of-service' || row.receipt?.result.status !== 'accepted' || !row.receipt.result.resource) return false
  return !acceptedManualRestoration(row, subject, hostId, hostCurrent, now)
}
