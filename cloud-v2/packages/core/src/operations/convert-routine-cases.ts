import {createHash, randomUUID} from 'node:crypto'
import {z} from 'zod'
import {caseIdSchema, routineCaseSchema, type RoutineCase} from '../types/routine-case.types'
import type {CaseDetailArchive} from '../services/routine-case.service'
import {requestInputDigest} from '../services/test-request.service'

const id = z.string().min(1).max(240), digest = z.string().regex(/^[a-f0-9]{64}$/)
const source = z.object({repository: z.string(), channel: z.enum(['dev','staging','pr','local']), branch: z.string(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/).optional()}).passthrough()
const intake = z.object({occurrenceId: id, environment: z.string(), testRunId: id, source}).passthrough()
const branch = z.object({runId: id, intake, status: z.string(), observedOccurrenceRunIds: z.array(id),
  execution: z.object({launched: z.boolean().optional()}).passthrough().optional()}).passthrough()
const legacyCase = z.object({caseId: caseIdSchema, version: z.literal(1), revision: z.number().int().nonnegative(), generation: z.number().int().nonnegative(),
  branches: z.record(branch), lease: z.object({owner:id,generation:z.number().int().positive(),branchKey:digest}).passthrough().optional(),
  workerFailurePending:z.boolean().optional(),workerFailureOutbox:z.array(z.unknown()).optional(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).passthrough()
const legacyRun = z.object({runId:id,miniCase:z.object({caseId:caseIdSchema,branchKey:digest,anchorRunId:id}).passthrough().optional(),
  routineFailure:z.object({intake:intake.extend({source:source.nullable()})}).passthrough().optional()}).passthrough()
export const caseConversionInventorySchema = z.object({database:z.string(),observedAt:z.string(),cases:z.array(legacyCase).max(10000),occurrences:z.array(legacyRun).max(10000)})
const drainSchema = z.object({schemaVersion:z.literal(1), observedAt:z.string(),
  controller:z.object({effectiveValue:z.literal(false),cronSuspended:z.literal(true),activeWorkerJobs:z.literal(0)}).passthrough(),
  mini:z.object({services:z.array(z.object({loaded:z.literal(false)}).passthrough()).length(3),liveConsumerProcesses:z.array(z.unknown()).length(0),
    caseId:caseIdSchema,anchorRunId:id,expectedRevision:z.number().int(),generation:z.number().int(),owner:id,guardianSha256:digest,
    guardian:z.object({state:z.literal('quiescent')}).passthrough(),caseReconcile:z.object({caseId:caseIdSchema,anchorRunId:id,branchKey:digest,
      revision:z.number().int(),status:z.literal('mini_running'),execution:z.object({launched:z.literal(false)}).passthrough(),
      heldLease:z.object({generation:z.number().int(),ownedByThisHost:z.literal(true),thisBranch:z.literal(true)}),
      guardianReceipt:z.object({state:z.literal('quiescent'),sha256:digest})}).passthrough(),mutated:z.literal(false)}).passthrough(),
  caseMutation:z.literal(false),databaseDeletion:z.literal(false)}).passthrough()
export interface CaseConversionTarget {read(id:string):Promise<RoutineCase|null>; insert(row:RoutineCase,event:{mutationId:string;digest:string;detail:{key:string;sha256:string;sizeBytes:number}}):Promise<void>}
/** Finite, operator-reviewed conversion only. All old documents and exact settlement evidence are preserved in R2. */
export async function convertRoutineCases(raw:unknown, rawDrain:unknown, archive:CaseDetailArchive, target?:CaseConversionTarget) {
  const input=caseConversionInventorySchema.parse(raw),drain=drainSchema.parse(rawDrain),cases:RoutineCase[]=[],retained=new Set<string>()
  const consumed=new Set<string>()
  const sourceCases=new Map((raw as {cases:Array<{caseId:string}>}).cases.map(row=>[row.caseId,row]))
  const sourceRuns=new Map((raw as {occurrences:Array<{runId:string}>}).occurrences.map(row=>[row.runId,row]))
  const byRun=new Map(input.occurrences.map(run=>[run.runId,run])), linked=input.occurrences.filter(run=>run.miniCase)
  if(byRun.size!==input.occurrences.length||new Set(input.cases.map(row=>row.caseId)).size!==input.cases.length)throw Error('Duplicate canonical identity in conversion inventory')
  for(const old of input.cases) {
    if(old.workerFailurePending||old.workerFailureOutbox?.length)throw Error('Old case has unsettled mutation outbox')
    if(old.lease) {
      const proof=drain.mini,match=proof.caseReconcile,b=old.branches[old.lease.branchKey]
      if(old.caseId!==proof.caseId||old.revision!==proof.expectedRevision||old.generation!==proof.generation||old.lease.owner!==proof.owner
        ||old.lease.generation!==proof.generation||old.lease.branchKey!==match.branchKey||b?.runId!==proof.anchorRunId||b.status!=='mini_running'
        ||b.execution?.launched!==false||match.caseId!==old.caseId||match.anchorRunId!==b.runId||match.revision!==old.revision
        ||match.heldLease.generation!==old.generation||proof.guardianSha256!==match.guardianReceipt.sha256)throw Error('Retained claim lacks exact same-owner stopped/unlaunched settlement proof')
      retained.add(old.caseId)
    }
    const occurrences=[]
    for(const [branchKey,b] of Object.entries(old.branches)) {
      const references=linked.filter(run=>run.miniCase!.caseId===old.caseId&&run.miniCase!.branchKey===branchKey)
      for(const runId of b.observedOccurrenceRunIds) {
        const run=byRun.get(runId)
        if(!run?.miniCase||run.miniCase.caseId!==old.caseId||run.miniCase.branchKey!==branchKey||run.miniCase.anchorRunId!==b.runId)
          throw Error('Canonical occurrence/branch reference is missing or contradictory')
      }
      if(!references.length)throw Error('Canonical branch has no retained occurrence reference')
      for(const run of references) {
        if(consumed.has(run.runId))throw Error('Canonical occurrence is attached more than once')
        consumed.add(run.runId)
        if(run.miniCase!.anchorRunId!==b.runId||!run.routineFailure)throw Error('Occurrence anchor/intake is contradictory')
        const i=run.routineFailure.intake,s=i.source
        if(!s)throw Error('Linked original source is unavailable; conversion requires its retained source correction')
        occurrences.push({occurrenceId:i.occurrenceId,rootKey:requestInputDigest({legacyEnvironment:i.environment,occurrenceId:i.occurrenceId}),anchorRunId:b.runId,
          original:{runId:i.testRunId,environment:i.environment,repository:s.repository,channel:s.channel,branch:s.branch,branchKey,...(s.headSha?{headSha:s.headSha}:{})},verificationRequestIds:[]})
      }
    }
    const full=await archive.write({schemaVersion:1,oldCase:sourceCases.get(old.caseId),linkedInbox:input.occurrences.filter(run=>run.miniCase?.caseId===old.caseId).map(run=>sourceRuns.get(run.runId)),
      drain:rawDrain, ...(retained.has(old.caseId)?{claimSettlement:{reason:'Same owner guardian verified stopped before launch',drain:rawDrain}}:{})})
    const converted=routineCaseSchema.parse({version:2,caseId:old.caseId,revision:old.revision+1,generation:old.generation,classification:'undetermined',diagnosis:'',evidence:[],
      stage:'investigating',nextAction:'Historical case retained; current diagnosis has not been recorded',owner:null,occurrences,intendedFixes:[],prObservations:[],
      createdAt:old.createdAt,updatedAt:new Date(drain.observedAt).toISOString(),archive:full})
    cases.push(converted)
  }
  if(linked.some(run=>!consumed.has(run.runId)))throw Error('Occurrence points to absent canonical case')
  const unassigned=await archive.write({schemaVersion:1,inbox:input.occurrences.filter(run=>!run.miniCase).map(run=>sourceRuns.get(run.runId)),drain:rawDrain})
  // Validate the entire finite graph before any target write. No partial write can be caused by a later malformed reference.
  for(const converted of cases) {
    const existing=await target?.read(converted.caseId)
    if(existing&&requestInputDigest(existing)!==requestInputDigest(converted))throw Error('Target case differs; never overwrite canonical ownership')
  }
  if(target)for(const converted of cases)if(!await target.read(converted.caseId)) {
    const old=input.cases.find(c=>c.caseId===converted.caseId)!
    await target.insert(converted,{mutationId:randomUUID(),digest:requestInputDigest({old,converted,drain}),detail:converted.archive!})
  }
  return {sourceDatabase:input.database,sourceSha256:createHash('sha256').update(JSON.stringify(raw)).digest('hex'),cases,unassignedInboxArchive:unassigned,
    caseCount:cases.length,occurrenceCount:cases.reduce((n,c)=>n+c.occurrences.length,0),inboxCount:input.occurrences.length,settledClaimIds:[...retained]}
}
