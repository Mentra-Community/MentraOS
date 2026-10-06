import {RoutineWorkModel} from '../models/routine-work.model'
import {candidateVerificationSchema, type CandidateVerification} from '../types/candidate-verification.types'
import {authoringJobViewSchema, type AuthoringWork} from '../types/routine-work.types'
import {requestInputDigest} from './test-request.service'
import {TestRunError} from './test-result-error'

export interface CandidateWorkRecord {
  hostId: string
  inputSha256: string
  work: AuthoringWork
  acceptance?: {hostId: string; inputSha256: string}
  status?: {details: unknown}
}
export interface CandidateAuthorization {
  authorize(binding: CandidateVerification, hostId: string, selected: {
    routineId: string; platform: string; definitionRevision: string; laneId?: string; build?: unknown
  }): Promise<void>
}

/** The authenticated supervisor observes GitHub; Core checks its accepted current attempt. */
export class CandidateVerificationService implements CandidateAuthorization {
  constructor(private readonly get: (workId: string) => Promise<CandidateWorkRecord | null> = async workId =>
    await RoutineWorkModel.findOne({workId}).read('primary').readConcern('majority').lean() as CandidateWorkRecord | null) {}

  async authorize(binding: CandidateVerification, hostId: string, selected: {
    routineId: string; platform: string; definitionRevision: string; laneId?: string; build?: unknown
  }) {
    const parsed = candidateVerificationSchema.safeParse(binding)
    const row = parsed.success ? await this.get(parsed.data.workId) : null
    const view = authoringJobViewSchema.safeParse(row?.status?.details)
    if (!parsed.success || !row?.acceptance || !view.success || row.hostId !== hostId ||
        row.acceptance.hostId !== hostId || row.acceptance.inputSha256 !== row.inputSha256 ||
        row.work.workId !== binding.workId || view.data.workId !== binding.workId ||
        requestInputDigest(row.work) !== row.inputSha256 || view.data.inputSha256 !== row.inputSha256 ||
        requestInputDigest(view.data.work) !== row.inputSha256 || view.data.hostId !== hostId ||
        view.data.attemptId !== binding.attemptId || !['awaiting-installation', 'verifying'].includes(view.data.state) ||
        view.data.details.sourceRevision !== binding.sourceRevision || selected.definitionRevision !== binding.sourceRevision ||
        row.work.routineId !== selected.routineId || row.work.target.hostId !== hostId ||
        (row.work.requirements.platform === 'mac' ? 'ios-on-mac' : 'android') !== selected.platform ||
        selected.laneId !== undefined && row.work.target.laneId !== selected.laneId ||
        selected.build !== undefined && requestInputDigest(selected.build) !== requestInputDigest(row.work.build))
      throw new TestRunError(409, 'Candidate verification requires its accepted current host, attempt, source and build')
    const review = view.data.details.review
    if (!review || review.verdict !== 'APPROVED' || review.sourceRevision !== binding.sourceRevision ||
        review.prUrl !== view.data.details.prUrl)
      throw new TestRunError(409, 'Candidate verification requires its current exact-source independent review')
  }
}
