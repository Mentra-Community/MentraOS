import type {RerunAttempt} from './test-rerun.types'

export type ObservedTestStatus = {status: string; publicationComplete: boolean}
export type TestStatusCounts = {failed: number; total: number; skipped: number; pending: number; incomplete: number}
const failures = ['failed', 'setup-failed', 'teardown-failed', 'evidence-failed']
/** A published execution pass is distinct from an accepted job still publishing its evidence. */
export function observedTestStatus(value: ObservedTestStatus) {
  return ['pass', 'passed'].includes(value.status) && !value.publicationComplete ? 'publishing' : value.status
}
export function testStatusCounts(members: ObservedTestStatus[]): TestStatusCounts {
  let failed = 0, skipped = 0, pending = 0, incomplete = 0
  for (const member of members) {
    const status = observedTestStatus(member)
    if (failures.includes(status)) failed++
    else if (status === 'not-run') skipped++
    else if (['incomplete', 'cancelled', 'aborted', 'unavailable'].includes(status)) incomplete++
    else if (!['pass', 'passed'].includes(status)) pending++
  }
  return {failed, total: members.length - skipped, skipped, pending, incomplete}
}
export function comparedSuiteCounts(members: (ObservedTestStatus & {memberId: string})[], latest: Map<string, RerunAttempt>) {
  return {original: testStatusCounts(members), latest: testStatusCounts(members.map(member => latest.get(member.memberId) ?? member)),
    hasReruns: members.some(member => latest.has(member.memberId))}
}
