import type {ResourceControlRecord} from './lane-control.types'
import type {ResourceLifecycleSubject} from './resource-lifecycle.types'

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
