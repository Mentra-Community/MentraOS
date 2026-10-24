import {RoutineWorkModel} from '../models/routine-work.model'
import {candidateVerificationSchema, type CandidateVerification} from '../types/candidate-verification.types'
import {authoringJobViewSchema, routineWorkVerificationIdentitySchema, type AuthoringWork} from '../types/routine-work.types'
import {requestInputDigest} from './test-request.service'
import {TestRunError} from './test-result-error'
import {frameworkExecutableBuild, type FrameworkRequestDisplay} from '../types/framework-request.types'
import {testingTarget, type TestingRepository} from '../types/testing-source.types'

export interface CandidateWorkRecord {
  hostId: string
  inputSha256: string
  work: AuthoringWork
  acceptance?: {hostId: string; inputSha256: string}
  status?: {details: unknown}
  verification?: {identity:unknown;status:{details:unknown}}
  fleetCancellation?:unknown
}
export interface CandidateAuthorization {
  authorize(binding: CandidateVerification, hostId: string, selected: {
    routineId: string; platform: string; definitionRevision: string; routineSource?: {repository: TestingRepository}; laneId?: string; build?: unknown; requestId?:string; admissionExpiresAt?:number; glassesModel?: 'nimo'
  }): Promise<void>
}

/** The authenticated supervisor observes GitHub; Core checks its accepted current attempt. */
export class CandidateVerificationService implements CandidateAuthorization {
  constructor(private readonly get: (workId: string) => Promise<CandidateWorkRecord | null> = async workId =>
    await RoutineWorkModel.findOne({workId}).read('primary').readConcern('majority').lean() as CandidateWorkRecord | null,
    private readonly now:()=>number=Date.now) {}

  async authorize(binding: CandidateVerification, hostId: string, selected: {
    routineId: string; platform: string; definitionRevision: string; routineSource?: {repository: TestingRepository}; laneId?: string; build?: unknown; requestId?:string; admissionExpiresAt?:number; glassesModel?: 'nimo'
  }) {
    const parsed = candidateVerificationSchema.safeParse(binding)
    const row = parsed.success ? await this.get(parsed.data.workId) : null
    const retry=routineWorkVerificationIdentitySchema.safeParse(row?.verification?.identity)
    const original=authoringJobViewSchema.safeParse(row?.status?.details)
    const at=this.now(),retryCurrent=Boolean(retry.success&&retry.data.previousFailure.code==='permission-required'&&original.success&&
      original.data.state==='failed'&&!row?.fleetCancellation&&
      (original.data.details.requestId===undefined||retry.data.admission?.requestId===original.data.details.requestId)&&
      Date.parse(retry.data.acceptedAt)<=at&&at<Date.parse(retry.data.deadline))
    const view = authoringJobViewSchema.safeParse(retryCurrent?row?.verification?.status.details:row?.status?.details)
    if (selected.admissionExpiresAt !== undefined) {
      const epoch = /^local:([0-9]{13}):([A-Za-z0-9_-]{1,120})$/.exec(selected.requestId ?? '')?.[1]
      if (!epoch || selected.admissionExpiresAt !== (retryCurrent ? Date.parse(retry.data!.deadline) : Number(epoch)) ||
        retryCurrent && (retry.data!.admission?.requestId !== selected.requestId || retry.data!.admission?.originalAdmissionExpiresAt !== Number(epoch)))
        throw new TestRunError(409, 'Local candidate deadline differs from its original admission or accepted completion retry')
    }
    if(retryCurrent&&view.success&&(selected.requestId!==undefined&&selected.requestId!==retry.data!.admission!.requestId||
      view.data.details.requestId!==retry.data!.admission!.requestId||
      !original.success||view.data.attemptId!==original.data.attemptId||view.data.details.sourceRevision!==original.data.details.sourceRevision||
      requestInputDigest(view.data.details.review)!==requestInputDigest(original.data.details.review)))
      throw new TestRunError(409,'Candidate completion retry differs from the retained original source, request or review')
    const glasses = row?.work.requirements.resources.find(value => value.kind === 'glasses')
    if (selected.build !== undefined && row?.work.requirements.glasses.length === 1 && row.work.requirements.glasses[0] === 'nimo' && selected.glassesModel !== 'nimo')
      throw new TestRunError(409, 'NIMO candidate differs from its accepted model and connection requirement')
    if (selected.glassesModel && (row?.work.requirements.platform !== 'android' || !row.work.requirements.glasses.includes('nimo') ||
      glasses?.capabilities.length !== 1 || glasses.capabilities[0] !== 'connection'))
      throw new TestRunError(409, 'NIMO candidate differs from its accepted model and connection requirement')
    if (!parsed.success || !row?.acceptance || row.fleetCancellation || !view.success || row.hostId !== hostId ||
        row.acceptance.hostId !== hostId || row.acceptance.inputSha256 !== row.inputSha256 ||
        row.work.workId !== binding.workId || view.data.workId !== binding.workId ||
        requestInputDigest(row.work) !== row.inputSha256 || view.data.inputSha256 !== row.inputSha256 ||
        requestInputDigest(view.data.work) !== row.inputSha256 || view.data.hostId !== hostId ||
        view.data.attemptId !== binding.attemptId || !['awaiting-installation', 'verifying'].includes(view.data.state) ||
        view.data.details.sourceRevision !== binding.sourceRevision || selected.definitionRevision !== binding.sourceRevision ||
        row.work.source.repository !== (selected.routineSource?.repository ?? testingTarget().repository) ||
        row.work.routineId !== selected.routineId || row.work.target.hostId !== hostId ||
        (row.work.requirements.platform === 'mac' ? 'ios-on-mac' : 'android') !== selected.platform ||
        selected.laneId !== undefined && row.work.target.laneId !== selected.laneId ||
        selected.build !== undefined && requestInputDigest(selected.build) !== requestInputDigest(frameworkExecutableBuild(row.work.build as FrameworkRequestDisplay['build'], selected.glassesModel)))
      throw new TestRunError(409, 'Candidate verification requires its accepted current host, attempt, source and build')
    const review = view.data.details.review
    if (!review || review.verdict !== 'APPROVED' || review.sourceRevision !== binding.sourceRevision ||
        review.prUrl !== view.data.details.prUrl || !review.prUrl.startsWith(`https://github.com/${row.work.source.repository}/pull/`))
      throw new TestRunError(409, 'Candidate verification requires its current exact-source independent review')
  }
}
