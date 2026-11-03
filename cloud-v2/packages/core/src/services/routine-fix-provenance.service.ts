import {z} from 'zod'
import {TestRequestModel} from '../models/test-request.model'
import {FrameworkResultService} from './framework-result.service'
import {TestRerunService} from './test-rerun.service'
import {readAcceptedRoutineRequest} from './routine-request-input'
import type {StoredRequest} from './test-request.service'
import {routineFixDelta,routineFixInclusions,type RoutineFixInput,type CaseFollowUpSummary} from '../types/routine-fix-provenance.types'
import {requestInputDigest} from './test-request.service'
import {TestRunError} from './test-result-error'
import type {CaseOccurrence} from '../types/routine-case.types'

/** Read a bounded page of accepted linked attempts. Never search for the latest pass or infer fixing PR causality. */
export class RoutineFixProvenanceService {
 constructor(private readonly reruns:Pick<TestRerunService,'history'>=new TestRerunService(),private readonly results:Pick<FrameworkResultService,'summary'>=new FrameworkResultService()){}
 private async input(requestId:string):Promise<RoutineFixInput> {
  const row=await TestRequestModel.findOne({requestId}).read('primary').readConcern('majority').setOptions({maxTimeMS:5000,timeoutMS:5000}).lean()
  if(!row)throw new TestRunError(404,'Verification input was not found')
  const accepted=readAcceptedRoutineRequest(row as unknown as StoredRequest), selected=accepted.input
  let observed:Awaited<ReturnType<FrameworkResultService['summary']>>|null=null
  try{observed=await this.results.summary(requestId)}catch(error){if(!(error instanceof TestRunError&&error.status===404))throw error}
  if(observed&&(!accepted.ready || observed.hostId!==row.hostId || observed.laneId!==accepted.input.laneId || observed.routineId!==selected.routineId || observed.platform!==selected.platform
   || observed.definitionRevision!==('definitionRevision'in selected?selected.definitionRevision:selected.routineRevision) || requestInputDigest(observed.routineSource ?? null)!==requestInputDigest(selected.routineSource ?? null)
   || requestInputDigest(observed.build)!==requestInputDigest(selected.build)))
   throw new TestRunError(503,'Observed verification differs from its accepted inputs')
  const archiveSchema=z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/)})
  const selectedArchive=archiveSchema.safeParse(selected.build.archive), observedArchive=archiveSchema.safeParse(observed?.build.archive)
  const binding=observed?.frameworkBinding,archive=observed?observedArchive:selectedArchive
  const producer=z.object({buildRunId:z.number().int().positive(),publicationAttempt:z.number().int().positive(),prNumber:z.number().int().positive().optional()}).safeParse(selected.build.source)
  return{requestId,observed:observed!==null,app:{repository:selected.build.repository,headSha:selected.build.headSha,...(archive.success?{artifactSha256:archive.data.sha256}:{}),...(producer.success?{producer:producer.data}:{})},
   routine:{revision:'definitionRevision'in selected?selected.definitionRevision:selected.routineRevision,...(selected.routineSource?{repository:selected.routineSource.repository,bundleSha256:selected.routineSource.bundle.sha256}:{})},
   framework:binding?{...(binding.repository?{repository:binding.repository}:{}),revision:binding.revision,version:binding.version,runtimeSha256:binding.runtimeSha256,apiVersion:binding.routineApiVersion}:null,
   glasses:selected.build.manifestSha256?{manifestSha256:selected.build.manifestSha256}:null,
   execution:observed?{hostId:observed.hostId,laneId:observed.laneId}:null,backend:null}
 }
 /** Explicit PR refresh uses at most the ten most recent recorded verification identities. History reads never call GitHub. */
 async recordedInputs(occurrences:CaseOccurrence[]):Promise<RoutineFixInput[]> {
  const ids=[...new Set(occurrences.flatMap(value=>[...value.verificationRequestIds,...(value.closure?.requestId?[value.closure.requestId]:[])]))]
  if(!ids.length)return[]
  const latest=await TestRequestModel.find({requestId:{$in:ids}}).select({requestId:1,_id:0}).sort({createdAt:-1,requestId:-1}).limit(10)
   .read('primary').readConcern('majority').setOptions({maxTimeMS:5000,timeoutMS:5000}).lean()
  const inputs=await Promise.all(latest.map(async row=>{try{const input=await this.input(row.requestId);return input.observed?input:null}
   catch{return null /* Unavailable or changed evidence cannot establish inclusion. */}}))
  return inputs.filter((input):input is RoutineFixInput=>input!==null)
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
