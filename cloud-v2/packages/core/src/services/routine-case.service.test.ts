import {expect, test} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {RoutineCaseService, type CaseDetailArchive} from './routine-case.service'
import type {CaseWriteFence, RoutineCaseRepository} from './routine-case.repository'
import {routineCaseSchema, type CaseActivity, type CaseOccurrence, type RoutineCase} from '../types/routine-case.types'

const occurrence = (id='original'): CaseOccurrence => ({occurrenceId:`tfo_${id}`,rootKey:(id==='original'?'a':'b').repeat(64),anchorRunId:id,
  original:{requestId:id,memberId:id,routineId:'ota-roundtrip-mac',platform:'ios-on-mac',channel:'dev',repository:'Mentra-Community/MentraOS',
    environment:'dev',branch:'dev',headSha:'a'.repeat(40),branchKey:'c'.repeat(64)},verificationRequestIds:[]})
function fixture() {
 let now=Date.parse('2026-10-12T20:00:00Z'), failArchive=false, beforeCommit: (()=>void)|undefined
 const rows=new Map<string,RoutineCase>(), events:CaseActivity[]=[], bodies:unknown[]=[]
 const store:RoutineCaseRepository={async get(id){return structuredClone(rows.get(id)??null)},async byRoots(keys){return structuredClone([...rows.values()].filter(row=>row.occurrences.some(o=>keys.includes(o.rootKey))))},
  async operation(id){return events.find(e=>e.mutationId===id)??null},async activity(id,before,limit){return events.filter(e=>e.caseId===id&&e.revision<before).sort((a,b)=>b.revision-a.revision).slice(0,limit)},
  async commit(previous,next,event,fence?:CaseWriteFence){beforeCommit?.();beforeCommit=undefined;
   if(events.some(e=>e.mutationId===event.mutationId))return false
   const current=rows.get(next.caseId)
   if(previous ? !current||current.revision!==previous.revision||current.generation!==previous.generation : current)return false
   if(fence&&(!current?.claim||current.claim.owner!==fence.owner||current.claim.generation!==fence.generation||current.claim.tokenSha256!==fence.tokenSha256
    ||current.claim.branchKey!==fence.branchKey||current.claim.anchorRunId!==fence.anchorRunId||!fence.allowExpired&&(current.claim.state!=='running'||Date.parse(current.claim.expiresAt)<=fence.now)))return false
   if([...rows.values()].some(r=>r.caseId!==next.caseId&&r.occurrences.some(o=>next.occurrences.some(n=>n.rootKey===o.rootKey))))return false
   rows.set(next.caseId,structuredClone(routineCaseSchema.parse(next)));events.push(structuredClone(event));return true},}
 const archive:CaseDetailArchive={async write(body){if(failArchive)throw Error('R2 unavailable');bodies.push(structuredClone(body));return{key:'testing/case.json',sha256:'d'.repeat(64),sizeBytes:100}}}
 const prReads:any[]=[],prs={async observe(pr:any,options?:any){prReads.push({pr,options});return{...pr,headSha:'b'.repeat(40),state:'open' as const,review:'approved' as const,mergedAt:null,observedAt:new Date(now).toISOString()}}}
 const service=new RoutineCaseService(store,archive,{async verify(_o,id){return{passed:id==='passing'}}},()=>now,()=>true,prs,{async recordedInputs(){return[]}})
 return {service,rows,events,bodies,prReads,advance:(ms:number)=>now+=ms,failArchive:()=>failArchive=true,beforeCommit:(run:()=>void)=>beforeCommit=run}
}
const operator={kind:'operator' as const,id:'employee'}
const update = (revision:number, value={}) => ({mutationId:randomUUID(),revision,...value})
test('one original has one canonical case under concurrent create, while mutation retry is idempotent',async()=>{
 const f=fixture(),id=randomUUID(),a=await f.service.create(occurrence(),id,operator),b=await f.service.create(occurrence(),id,operator)
 expect(a.case.caseId).toBe(b.case.caseId);expect(f.events).toHaveLength(1)
 await expect(f.service.create(occurrence('other'),id,operator)).rejects.toThrow('different inputs')
 const races=await Promise.allSettled([f.service.create(occurrence('other'),randomUUID(),operator),f.service.create(occurrence('other'),randomUUID(),operator)])
 expect(races.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.rows.size).toBe(2)
})
test('attaching an intended PR to the same case keeps its create mutation receipt and no executable inbox',async()=>{
 const f=fixture(),a=await f.service.create(occurrence(),randomUUID(),operator),id=randomUUID(),pr={repository:'Mentra-Community/MentraOS' as const,number:4710}
 const b=await f.service.create(occurrence(),id,operator,undefined,pr),c=await f.service.create(occurrence(),id,operator,undefined,pr)
 expect(b.case.caseId).toBe(a.case.caseId);expect(c.case.revision).toBe(1);expect(b.case.classification).toBe('undetermined');expect(b.case.intendedFixes).toEqual([pr])
 expect(b.case.prObservations[0]!.review).toBe('approved');expect(b.case.execution).toBeNull();expect(f.events).toHaveLength(2)
})
test('revision fence prevents lost updates, archive failure commits neither metadata nor history',async()=>{
 const f=fixture(),a=await f.service.create(occurrence(),randomUUID(),operator)
 const races=await Promise.allSettled([f.service.update(a.case.caseId,update(0,{nextAction:'Inspect screenshot'}),operator),f.service.update(a.case.caseId,update(0,{nextAction:'Inspect incident logs'}),operator)])
 expect(races.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.events).toHaveLength(2)
 f.failArchive();await expect(f.service.update(a.case.caseId,update(1,{nextAction:'Fix'}),operator)).rejects.toThrow('R2');expect(f.events).toHaveLength(2);expect(f.rows.get(a.case.caseId)!.revision).toBe(1)
})
test('grouping is explicit and stale/current owner checks keep independent original occurrences',async()=>{
 const f=fixture(),a=await f.service.create(occurrence(),randomUUID(),operator)
 await expect(f.service.create(occurrence('other'),randomUUID(),operator,{caseId:a.case.caseId,revision:1,explanation:'Same demonstrated cause'})).rejects.toThrow('current')
 await f.service.update(a.case.caseId,update(0,{classification:'app',diagnosis:'Same native interface error',evidence:[{kind:'run',id:'original'}]}),operator)
 const b=await f.service.create(occurrence('other'),randomUUID(),operator,{caseId:a.case.caseId,revision:1,explanation:'Same demonstrated native Wi-Fi error'})
 expect(b.case.occurrences).toHaveLength(2);expect(b.case.classification).toBe('app');expect(f.bodies.at(-1)).toHaveProperty('grouping')
})
test('verified closure requires a demonstrated cause and complete linked pass for every occurrence',async()=>{
 const f=fixture(),a=await f.service.create(occurrence(),randomUUID(),operator),id=a.case.caseId
 await expect(f.service.update(id,update(0,{classification:'app'}),operator)).rejects.toThrow('evidence')
 await expect(f.service.update(id,update(0,{stage:'needs-input'}),operator)).rejects.toThrow('question')
 const diagnosed=await f.service.update(id,update(0,{classification:'app',diagnosis:'Native interface selection failed',evidence:[{kind:'run',id:'original'}]}),operator)
 await expect(f.service.update(id,update(1,{stage:'verified',close:{occurrenceId:'tfo_original',kind:'verified',reason:'Native interface fixed',requestId:'failed'}}),operator)).rejects.toThrow('passing')
 const done=await f.service.update(id,update(diagnosed.case.revision,{stage:'verified',close:{occurrenceId:'tfo_original',kind:'verified',reason:'Native interface fixed',requestId:'passing'}}),operator)
 expect(done.case.occurrences[0]!.closure?.kind).toBe('verified')
})
test('single generation claim refuses expiry takeover and stale mutation; explicit exact-owner settlement allows replacement',async()=>{
 const f=fixture(),a=await f.service.create(occurrence(),randomUUID(),operator),id=a.case.caseId,token='T'.repeat(40),branchKey='c'.repeat(64)
 const claimed=await f.service.claim(id,{action:'acquire',mutationId:randomUUID(),revision:0,generation:1,token,branchKey,anchorRunId:'original',ttlSeconds:30},'mini')
 const actor={kind:'agent' as const,id:'mini',token,branchKey,anchorRunId:'original',generation:1}
 expect(claimed.case.execution?.state).toBe('running');expect(JSON.stringify(claimed)).not.toContain(token)
 f.advance(31000)
 await expect(f.service.update(id,update(1,{nextAction:'Fix'}),actor)).rejects.toThrow('stale')
 await expect(f.service.claim(id,{action:'acquire',mutationId:randomUUID(),revision:1,generation:2,token:'N'.repeat(40),branchKey,anchorRunId:'original',ttlSeconds:30},'air')).rejects.toThrow('retained')
 const released=await f.service.claim(id,{action:'release',mutationId:randomUUID(),revision:1,generation:1,token,branchKey,anchorRunId:'original',reason:'Stopped and settled'},'mini')
 await f.service.claim(id,{action:'acquire',mutationId:randomUUID(),revision:released.case.revision,generation:2,token:'N'.repeat(40),branchKey,anchorRunId:'original',ttlSeconds:30},'air')
 await expect(f.service.update(id,update(3,{nextAction:'Old owner'}),actor)).rejects.toThrow('stale');expect(f.events.map(e=>e.kind)).toEqual(['create','claim','release','claim'])
})
test('claim expiry during verified archive work cannot commit an agent update',async()=>{
 const f=fixture(),a=await f.service.create(occurrence(),randomUUID(),operator),id=a.case.caseId,token='T'.repeat(40),branchKey='c'.repeat(64)
 await f.service.claim(id,{action:'acquire',mutationId:randomUUID(),revision:0,generation:1,token,branchKey,anchorRunId:'original',ttlSeconds:30},'mini')
 f.beforeCommit(()=>{const row=f.rows.get(id)!;row.claim!.expiresAt='2026-10-12T19:00:00Z'})
 await expect(f.service.update(id,update(1,{nextAction:'Stale write'}),{kind:'agent',id:'mini',token,branchKey,anchorRunId:'original',generation:1})).rejects.toThrow('changed')
 expect(f.rows.get(id)!.revision).toBe(1)
})
test('default unavailable service does not access the old store or infer it was converted',async()=>{
 const f=fixture(),service=new RoutineCaseService({get(){throw Error('must not read')} } as any,{} as any)
 await expect(service.detail('mfc_'+'a'.repeat(64))).rejects.toThrow('old-writer drain')
})

test('replacing intended PRs filters current observations and validates the final stored payload',async()=>{
 const f=fixture(),a=await f.service.create(occurrence(),randomUUID(),operator),id=a.case.caseId
 const references=(start:number)=>Array.from({length:20},(_,i)=>({repository:'Mentra-Community/MentraOS' as const,number:start+i}))
 const first=await f.service.update(id,update(0,{intendedFixes:references(1)}),operator)
 expect(first.case.prObservations).toHaveLength(20)
 const second=await f.service.update(id,update(1,{intendedFixes:references(21)}),operator)
 expect(second.case.prObservations).toHaveLength(20);expect(second.case.prObservations.every(pr=>pr.number>=21)).toBe(true)
 expect(routineCaseSchema.safeParse(f.rows.get(id)).success).toBe(true)
})

test('explicit PR refresh shares one comparison budget and leaves recorded owner stage unchanged',async()=>{
 const f=fixture(),created=await f.service.create(occurrence(),randomUUID(),operator,undefined,{repository:'Mentra-Community/MentraOS',number:4710})
 const next=await f.service.update(created.case.caseId,update(created.case.revision,{stage:'verifying',owner:'employee'}),operator)
 const refreshed=await f.service.reconcilePrs(next.case.caseId,update(next.case.revision),operator)
 expect(refreshed.case.stage).toBe('verifying');expect(refreshed.case.owner).toBe('employee')
 expect(f.prReads.at(-1).options).toMatchObject({inputs:[],comparisonBudget:{remaining:20},previous:{number:4710}})
})
