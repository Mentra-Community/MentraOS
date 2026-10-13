import {expect,test} from 'bun:test'
import {convertRoutineCases} from './convert-routine-cases'
import type {RoutineCase} from '../types/routine-case.types'
const id='mfc_'+'a'.repeat(64),key='b'.repeat(64),anchor='anchor',at='2026-10-12T00:00:00Z'
const source={repository:'Mentra-Community/MentraOS',channel:'dev',branch:'dev',headSha:'c'.repeat(40)}
const intake={occurrenceId:'tfo_'+'d'.repeat(64),environment:'dev',testRunId:'old-run',source}
const original={caseId:id,version:1,revision:6,generation:1,branches:{[key]:{runId:anchor,intake,status:'mini_running',observedOccurrenceRunIds:[anchor],execution:{launched:false,checkpoints:[{diagnostic:'preserve'}]}}},
  lease:{owner:'mini',generation:1,branchKey:key,token:'old-private-token',expiresAt:at},createdAt:at,updatedAt:at,reservations:[]}
const inventory={database:'old-case-authority',observedAt:at,cases:[original],occurrences:[{runId:anchor,miniCase:{caseId:id,branchKey:key,anchorRunId:anchor},routineFailure:{intake},miniExecution:{attempt:1}}]}
const drain={schemaVersion:1,observedAt:at,controller:{effectiveValue:false,cronSuspended:true,activeWorkerJobs:0},mini:{services:[{loaded:false},{loaded:false},{loaded:false}],liveConsumerProcesses:[],
  caseId:id,anchorRunId:anchor,expectedRevision:6,generation:1,owner:'mini',guardianSha256:'e'.repeat(64),guardian:{state:'quiescent'},mutated:false,
  caseReconcile:{caseId:id,anchorRunId:anchor,branchKey:key,revision:6,status:'mini_running',execution:{launched:false},heldLease:{generation:1,ownedByThisHost:true,thisBranch:true},guardianReceipt:{state:'quiescent',sha256:'e'.repeat(64)}}},caseMutation:false,databaseDeletion:false}
function archive(){const saved:unknown[]=[];return{saved,async write(body:unknown){saved.push(structuredClone(body));return{key:'testing/old-history',sha256:'f'.repeat(64),sizeBytes:100}}}}
test('finite same-owner stopped/unlaunched conversion retains case occurrence anchors and full legacy lease/history',async()=>{
 const store=archive(),out=await convertRoutineCases(inventory,drain,store)
 expect(out.caseCount).toBe(1);expect(out.occurrenceCount).toBe(1);expect(out.settledClaimIds).toEqual([id]);expect(out.cases[0]!.caseId).toBe(id)
 expect(out.cases[0]!.occurrences[0]!.occurrenceId).toBe(intake.occurrenceId);expect(out.cases[0]!.occurrences[0]!.anchorRunId).toBe(anchor)
 expect(out.cases[0]!.claim).toBeUndefined();expect(out.cases[0]!.generation).toBe(1);expect(out.cases[0]!.revision).toBe(7)
 expect(store.saved[0]).toHaveProperty('oldCase.lease.token','old-private-token');expect(store.saved[0]).toHaveProperty('claimSettlement.drain')
 expect(JSON.stringify(out.cases)).not.toContain('old-private-token')
})
test('expired lease alone, owner/generation/revision mismatch or launched child cannot authorize conversion',async()=>{
 for(const mutate of [(x:any)=>x.mini.owner='other',(x:any)=>x.mini.expectedRevision=7,(x:any)=>x.mini.generation=2,
   (x:any)=>x.mini.caseReconcile.guardianReceipt.sha256='0'.repeat(64),(x:any)=>x.mini.guardian.state='active']){
  const proof=structuredClone(drain);mutate(proof);await expect(convertRoutineCases(inventory,proof,archive())).rejects.toThrow()
 }
 const input=structuredClone(inventory);input.cases[0]!.branches[key]!.execution.launched=true
 await expect(convertRoutineCases(input,drain,archive())).rejects.toThrow('settlement proof')
})
test('bad graph refuses all target writes; exact conversion retries do not overwrite newer canonical ownership',async()=>{
 const writes:RoutineCase[]=[],target={async read(){return null},async insert(row:RoutineCase){writes.push(row)}}
 const bad=structuredClone(inventory);bad.occurrences[0]!.miniCase.anchorRunId='different'
 await expect(convertRoutineCases(bad,drain,archive(),target)).rejects.toThrow('contradictory');expect(writes).toHaveLength(0)
 const out=await convertRoutineCases(inventory,drain,archive(),target);expect(writes).toHaveLength(1)
 const next={...out.cases[0]!,revision:8,owner:'new-current-owner'}
 await expect(convertRoutineCases(inventory,drain,archive(),{async read(){return next},async insert(){throw Error('must not overwrite')}})).rejects.toThrow('never overwrite')
})
