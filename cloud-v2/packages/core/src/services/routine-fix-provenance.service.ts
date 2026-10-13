import {z} from 'zod'
import {TestRequestModel} from '../models/test-request.model'
import {FrameworkResultService} from './framework-result.service'
import {TestRerunService} from './test-rerun.service'
import {recordedFrameworkRequestInputSchema} from '../types/framework-request.types'
import {portableRoutineSelectionSchema} from '../types/routine-job.types'
import {routineDispatchIntentSchema} from '../types/routine-dispatch.types'
import {routineFixDelta,routineFixInclusions,type RoutineFixInput,type CaseFollowUpSummary} from '../types/routine-fix-provenance.types'
import {requestInputDigest} from './test-request.service'
import {TestRunError} from './test-result-error'
import type {CaseOccurrence} from '../types/routine-case.types'

/** Read a bounded page of accepted linked attempts. Never search for the latest pass or infer fixing PR causality. */
export class RoutineFixProvenanceService {
 constructor(private readonly reruns:Pick<TestRerunService,'history'>=new TestRerunService(),private readonly results:Pick<FrameworkResultService,'summary'>=new FrameworkResultService()){}
 private async input(requestId:string):Promise<RoutineFixInput> {
  const row=await TestRequestModel.findOne({requestId}).read('primary').readConcern('majority').setOptions({maxTimeMS:5000}).lean()
  if(!row)throw new TestRunError(404,'Verification input was not found')
  const selected=row.fleetSelection!==undefined?portableRoutineSelectionSchema.parse(row.fleetSelection):row.input!==undefined?recordedFrameworkRequestInputSchema.parse(row.input):routineDispatchIntentSchema.parse(row.dispatchIntent)
  const digest=row.fleetSelection!==undefined?row.fleetSelectionSha256:row.input!==undefined?row.inputSha256:row.dispatchIntentSha256
  if(requestInputDigest(selected)!==digest)throw new TestRunError(503,'Verification input integrity unavailable')
  let observed:Awaited<ReturnType<FrameworkResultService['summary']>>|null=null
  try{observed=await this.results.summary(requestId)}catch(error){if(!(error instanceof TestRunError&&error.status===404))throw error}
  if(observed&&(observed.build.repository!==selected.build.repository||observed.build.headSha!==selected.build.headSha||observed.routineId!==selected.routineId||observed.platform!==selected.platform || observed.definitionRevision!==('definitionRevision'in selected?selected.definitionRevision:selected.routineRevision) || requestInputDigest(observed.routineSource ?? null)!==requestInputDigest(selected.routineSource ?? null)))
   throw new TestRunError(503,'Observed verification differs from its accepted inputs')
  const archiveSchema=z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/)})
  const selectedArchive=archiveSchema.safeParse(selected.build.archive), observedArchive=archiveSchema.safeParse(observed?.build.archive)
  if(observed && (selectedArchive.success!==observedArchive.success || selectedArchive.success&&observedArchive.success&&selectedArchive.data.sha256!==observedArchive.data.sha256 || selected.build.manifestSha256!==observed.build.manifestSha256))
   throw new TestRunError(503,'Observed verification artifact or glasses manifest differs from its accepted inputs')
  const binding=observed?.frameworkBinding,archive=observed?observedArchive:selectedArchive
  const producer=z.object({buildRunId:z.number().int().positive(),publicationAttempt:z.number().int().positive(),prNumber:z.number().int().positive().optional()}).safeParse(selected.build.source)
  return{requestId,observed:observed!==null,app:{repository:selected.build.repository,headSha:selected.build.headSha,...(archive.success?{artifactSha256:archive.data.sha256}:{}),...(producer.success?{producer:producer.data}:{})},
   routine:{revision:'definitionRevision'in selected?selected.definitionRevision:selected.routineRevision,...(selected.routineSource?{bundleSha256:selected.routineSource.bundle.sha256}:{})},
   framework:binding?{revision:binding.revision,version:binding.version,runtimeSha256:binding.runtimeSha256,apiVersion:binding.routineApiVersion}:null,
   glasses:selected.build.manifestSha256?{manifestSha256:selected.build.manifestSha256}:null,
   execution:observed?{hostId:observed.hostId,laneId:observed.laneId}:null,backend:null}
 }
 async history(occurrence:CaseOccurrence,before?:number,fixes:CaseFollowUpSummary['intendedFixes']=[]) {
  const original=occurrence.original
  if(!original.requestId||!original.memberId)return{unavailable:'Historical original request/member was not recorded',attempts:[],nextBefore:null}
  const parent=original.suiteId?{suiteId:original.suiteId}:{requestId:original.requestId}
  const history=await this.reruns.history(parent,original.memberId,before,10),baseline=await this.input(original.requestId)
  const attempts=[]
  for(const attempt of history.attempts){try{if(!attempt.requestId)throw new TestRunError(503,'Attempt request is unavailable')
   const observed=await this.input(attempt.requestId)
   attempts.push({...attempt,delta:routineFixDelta(baseline,observed),inclusions:routineFixInclusions(observed,fixes)})}
   catch(error){attempts.push({...attempt,delta:null,provenanceUnavailable:error instanceof TestRunError?error.message:'Verification provenance unavailable'})}}
  return{original:baseline,attempts,nextBefore:history.nextBefore}
 }
}
