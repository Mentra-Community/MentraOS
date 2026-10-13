import {TestRequestModel} from '../models/test-request.model'
import {TestRunModel} from '../models/test-run.model'
import {TestSuiteModel} from '../models/test-suite.model'
import {matchesLabelReference, compactPrRerunLabel, parsePrRerunLabel, type LabelReference, type PrLinkedTarget} from '../types/pr-rerun-label.types'
import {rerunTerminalStatuses} from '../types/test-rerun.types'
import {TestRerunService} from './test-rerun.service'
import {TestRunError} from './test-result-error'

const predicate = ({value, prefix}: LabelReference) => prefix ? {$regex: `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`} : value
export interface RerunReferenceRepository {
  suites(reference: LabelReference): Promise<string[]>
  requests(reference: LabelReference): Promise<string[]>
}
export const rerunReferenceRepository: RerunReferenceRepository = {
  async suites(reference) {
    return (await TestSuiteModel.find({suiteId: predicate(reference)}).select({suiteId: 1}).limit(2)
      .read('primary').readConcern('majority').setOptions({maxTimeMS: 5000}).lean()).map(row => row.suiteId)
  },
  async requests(reference) {
    const [requests, runs] = await Promise.all([
      TestRequestModel.find({requestId: predicate(reference)}).select({requestId: 1}).limit(2)
        .read('primary').readConcern('majority').setOptions({maxTimeMS: 5000}).lean(),
      TestRunModel.find({runId: predicate(reference)}).select({requestId: 1}).limit(2)
        .read('primary').readConcern('majority').setOptions({maxTimeMS: 5000}).lean(),
    ])
    return [...new Set([...requests, ...runs].map(row => row.requestId))]
  },
}

/** Labels reference existing IDs. Accepted checks retain the resolved full lineage, never an alias. */
export class PrRerunReferenceService {
  constructor(private readonly repository: RerunReferenceRepository = rerunReferenceRepository,
    private readonly reruns: Pick<TestRerunService, 'lineage' | 'originalMembers'> = new TestRerunService()) {}
  async resolve(label: string) {
    let parsed
    try {parsed = parsePrRerunLabel(label)} catch {throw new TestRunError(400, 'Invalid rerun label; copy a fresh label from the original run')}
    const ids = await (parsed.kind === 's' ? this.repository.suites(parsed.target) : this.repository.requests(parsed.target))
    if (ids.length !== 1) throw new TestRunError(422, ids.length ? 'Rerun reference is ambiguous; copy a fresh label' : 'Referenced original run or suite was not found')
    let parent: PrLinkedTarget['parent'], memberId: string | undefined
    if (parsed.kind === 's') parent = {suiteId: ids[0]!}
    else {
      const lineage = await this.reruns.lineage(ids[0]!)
      parent = lineage.lineage?.parent ?? (lineage.original ? {suiteId: lineage.original.suiteId} : {requestId: ids[0]!})
      memberId = lineage.lineage?.memberId ?? lineage.original?.memberId ?? ids[0]!
    }
    const members = (await this.reruns.originalMembers(parent)).filter(member =>
      (!memberId || member.memberId === memberId) && matchesLabelReference(parsed.routine, member.routineId))
    if (members.length !== 1) throw new TestRunError(422, members.length ? 'Routine has several occurrences; copy the individual run label' : 'Routine does not match the referenced original')
    const member = members[0]!
    if (!(rerunTerminalStatuses as readonly string[]).includes(member.status)) throw new TestRunError(409, 'Original run is still active; linked verification is waiting')
    return {target: {parent, memberId: member.memberId, originalRequestId: member.requestId,
      ...(parsed.kind === 'r' ? {requestedRunId: ids[0]} : {}), labels: [label]} satisfies PrLinkedTarget, member}
  }
  async copy(routineId: string, kind: 's' | 'r', targetId: string) {
    for (let length = Math.min(8, targetId.length); length <= targetId.length; length++) {
      let label: string
      try {label = compactPrRerunLabel(routineId, kind, targetId, length)} catch {break}
      try {
        const value = await this.resolve(label)
        if (value.member.routineId === routineId) return {label, target: value.target}
      } catch (error) {if (!(error instanceof TestRunError && error.status === 422)) throw error}
    }
    throw new TestRunError(422, 'A unique rerun label does not fit; use the manual rerun controls')
  }
}
