import {createHash} from 'node:crypto'
import {z} from 'zod'
import {TestRequestModel} from '../models/test-request.model'
import {TestRunModel} from '../models/test-run.model'
import {caseOccurrenceSchema, type CaseOccurrence} from '../types/routine-case.types'
import {recordedFrameworkRequestInputSchema} from '../types/framework-request.types'
import {portableRoutineSelectionSchema} from '../types/routine-job.types'
import {routineDispatchIntentSchema} from '../types/routine-dispatch.types'
import {TestRerunService, rerunRootKey} from './test-rerun.service'
import {FrameworkResultService} from './framework-result.service'
import {TestRunError} from './test-result-error'
import {requestInputDigest} from './test-request.service'
import type {CaseVerificationReader} from './routine-case.service'

const requestSchema = z.object({requestId: z.string(), runId: z.string().optional(), input: z.unknown().optional(), inputSha256: z.string().optional(),
  fleetSelection: z.unknown().optional(), fleetSelectionSha256: z.string().optional(), dispatchIntent: z.unknown().optional(), dispatchIntentSha256: z.string().optional()})
/** Resolve the existing original lineage first; a successor never becomes a new standalone occurrence. */
export class RoutineCaseOriginalService implements CaseVerificationReader {
  constructor(private readonly reruns = new TestRerunService(), private readonly results = new FrameworkResultService(),
    private readonly environment = () => process.env.CLOUD_CORE_ENVIRONMENT) {}
  private async request(id: string) {
    let row = await TestRequestModel.findOne({requestId: id}).read('primary').readConcern('majority').setOptions({maxTimeMS: 5000}).lean()
    if (!row) {
      const run = await TestRunModel.findOne({runId: id}).select({requestId: 1}).read('primary').readConcern('majority').setOptions({maxTimeMS: 5000}).lean()
      if (run) row = await TestRequestModel.findOne({requestId: run.requestId}).read('primary').readConcern('majority').setOptions({maxTimeMS: 5000}).lean()
    }
    if (!row) throw new TestRunError(404, 'Original request was not found')
    return requestSchema.parse(row)
  }
  async original(id: string): Promise<CaseOccurrence> {
    const incoming = await this.request(id), lineage = await this.reruns.lineage(incoming.requestId)
    const parent = lineage.lineage?.parent ?? (lineage.original ? {suiteId: lineage.original.suiteId} : {requestId: incoming.requestId})
    const memberId = lineage.lineage?.memberId ?? lineage.original?.memberId ?? incoming.requestId
    const member = (await this.reruns.originalMembers(parent)).find(value => value.memberId === memberId)
    if (!member?.requestId || !['failed', 'setup-failed', 'teardown-failed'].includes(member.status))
      throw new TestRunError(409, 'Follow-up requires the failed original occurrence')
    const request = await this.request(member.requestId)
    const selected = request.fleetSelection !== undefined ? portableRoutineSelectionSchema.parse(request.fleetSelection)
      : request.input !== undefined ? recordedFrameworkRequestInputSchema.parse(request.input) : routineDispatchIntentSchema.parse(request.dispatchIntent)
    const expected = request.fleetSelection !== undefined ? request.fleetSelectionSha256 : request.input !== undefined ? request.inputSha256 : request.dispatchIntentSha256
    if (requestInputDigest(selected) !== expected) throw new TestRunError(503, 'Original source integrity is unavailable')
    const branch = selected.build.channel === 'pr' ? `pull/${selected.build.prNumber}` : selected.build.channel
    const environment = z.string().min(1).max(30).parse(this.environment())
    const branchKey = requestInputDigest([environment, selected.build.repository, selected.build.channel, branch,
      selected.build.prNumber ?? null, selected.build.channel === 'pr' ? selected.build.repository : null,
      typeof selected.build.baseBranch === 'string' ? selected.build.baseBranch : null])
    const rootKey = rerunRootKey(parent, memberId)
    return caseOccurrenceSchema.parse({occurrenceId: `tfo_${createHash('sha256').update(`framework-v1:${member.requestId}`).digest('hex')}`,
      rootKey, anchorRunId: member.requestId, verificationRequestIds: [], original: {requestId: member.requestId, memberId,
        ...('suiteId' in parent ? {suiteId: parent.suiteId} : {}), ...(member.runId ? {runId: member.runId} : {}),
        routineId: member.routineId, platform: member.platform, repository: selected.build.repository, channel: selected.build.channel,
        branch, branchKey, environment, headSha: selected.build.headSha}})
  }
  async verify(occurrence: CaseOccurrence, id: string) {
    const row = await this.request(id), lineage = await this.reruns.lineage(row.requestId)
    if (!lineage.lineage || rerunRootKey(lineage.lineage.parent, lineage.lineage.memberId) !== occurrence.rootKey)
      throw new TestRunError(409, 'Verification belongs to a different original occurrence')
    if (this.environment() !== occurrence.original.environment) throw new TestRunError(409, 'Verification belongs to a different backend environment')
    const summary = await this.results.summary(row.requestId)
    if (!summary || summary.routineId !== occurrence.original.routineId || summary.platform !== occurrence.original.platform)
      throw new TestRunError(409, 'Verification has no matching published routine result')
    return {passed: summary.outcome === 'pass' && summary.uploadsComplete && summary.evidenceStatus === 'complete'}
  }
}
