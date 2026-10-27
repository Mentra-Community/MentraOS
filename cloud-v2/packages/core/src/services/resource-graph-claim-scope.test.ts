import {test,expect} from 'bun:test'
import {routingGraphFixture} from './backend-candidate-preparation.test-support'
import {routineResourceReadinessPurpose,routineJobInputDigest} from './routine-job.service'
import {ResourceReservationsService,type ResourceReservationHost,type ResourceReservationRepository} from './resource-reservations.service'
import {requestInputDigest} from './test-request.service'
import {exclusiveResourceIntentSchema,exclusiveHostReservationSchema,type ExclusiveHostReservation} from '../types/resource-reservations.types'

// Inert CPU fixture: original producer/service shapes, no actual job/device/receipt.
function fixture(){
 const f=routingGraphFixture(),h=f.hosts[0]!,lane=h.lanes[0]!,prepared=f.row.fleetPreparation!,definition=prepared.definition
 definition.execution!.resourceKinds=['phone','app','recorder']
 definition.resourceRequirements=['phone','app','recorder'].map(kind=>({kind,capabilities:[]})) as typeof definition.resourceRequirements
 prepared.requirements={platform:'android',resources:definition.resourceRequirements}
 prepared.definitionSha256=requestInputDigest(definition);f.row.fleetSelectionSha256=requestInputDigest(f.row.fleetSelection);f.row.fleetInputSha256=routineJobInputDigest(f.row)
 for(const host of f.hosts){
  host.frameworkAcceptedAt=host.observedAt;host.frameworkProcess={pid:100,startedAt:'cpu-only-current-controller'}
  const l=host.lanes[0]!,template=host.resourceLifecycle!.subjects[0]!
  l.resources.push({id:`${host.hostId}:glasses`,kind:'glasses',capabilities:[],idleContract:{version:'glasses-baseline',maximumAgeMs:120000,conditions:['physical-baseline'],repairConfigured:true,dependencies:[],qualifiedScope:{kind:'same-controller',controllerId:host.hostId}}})
  l.glasses=[{resourceId:`${host.hostId}:glasses`,deviceId:`cpu-only-${host.hostId}-live`,model:'mentra-live',capabilities:[]}]
  host.resourceLifecycle!.subjects.push({...structuredClone(template),subject:{kind:'resource',id:`${host.hostId}:glasses`,authorityHostId:host.hostId},idle:{...template.idle,contractVersion:'glasses-baseline'},resource:{kind:'glasses',capabilities:[],memberships:[{hostId:host.hostId,laneId:l.id}],dependencies:[],placement:'installed'}})
  l.resources.find(r=>r.kind==='app')!.idleContract!.dependencies=[`${host.hostId}:phone`]
  l.resources.find(r=>r.kind==='recorder')!.idleContract!.dependencies=[`${host.hostId}:app`]
  for(const subject of host.resourceLifecycle!.subjects){subject.status='idle';subject.idle.outcome='passed';subject.idle.checkedAt=host.observedAt;subject.idle.acceptedCheck={operationId:`cpu-return:${subject.subject.id}`,subjectGeneration:subject.generation,resultSha256:'c'.repeat(64),acceptedAt:host.observedAt}}
  host.resourceReservations!.resourceChecks=[]
 }
 const intent=exclusiveResourceIntentSchema.parse({operationId:'resource-check:11111111-1111-4111-8111-111111111111',hostId:h.hostId,laneId:lane.id,controller:{incarnation:h.incarnation,generation:h.incarnationGeneration,sequence:h.sequence},owner:{id:'resource-check:independent-glasses',kind:'boundary-cleanup'},inputSha256:'d'.repeat(64),resources:[{id:'air1:glasses',capabilities:['resource-idle']}],resourceCheck:{resourceId:'air1:glasses',subjectGeneration:1,contractVersion:'glasses-baseline',deadlineAt:f.now+120000,binding:h.frameworkBinding!,controller:{incarnation:h.incarnation,generation:h.incarnationGeneration}}})
 const digest=requestInputDigest({...intent,controller:{incarnation:intent.controller.incarnation,generation:intent.controller.generation},dependencies:[{resourceId:'air1:glasses',authorityHostId:'air1',capability:'resource-idle'}]})
 const claim=exclusiveHostReservationSchema.parse({kind:'exclusive',id:'22222222-2222-4222-8222-222222222222',resourceId:'air1:glasses',authorityHostId:h.hostId,borrowerHostId:h.hostId,laneId:lane.id,operationId:intent.operationId,intentSha256:digest,inputSha256:intent.inputSha256,owner:intent.owner,controllerIncarnation:h.incarnation,controllerGeneration:h.incarnationGeneration,borrowerSequence:h.sequence,reservedAt:new Date(f.now).toISOString(),resourceCheck:intent.resourceCheck})
 const journal={intentSha256:digest,operationId:intent.operationId,resourceId:'air1:glasses',intent,resourceCheck:intent.resourceCheck!,state:'prepared' as const,observedAt:new Date(f.now).toISOString()}
 return {f,h,lane,intent,claim,journal}
}
function occupy(x:ReturnType<typeof fixture>){x.h.authorityReservations=[x.claim];x.h.resourceReservations!.claims=[x.claim];x.h.resourceReservations!.resourceChecks=[x.journal]}

async function prepare(x: ReturnType<typeof fixture>) {
 const row = await (x.f.service as unknown as {makeGraphCandidatePreparation: (
   row: typeof x.f.row, host: typeof x.h, lane: typeof x.lane) => Promise<typeof x.f.row | undefined>})
   .makeGraphCandidatePreparation(x.f.row,x.h,x.lane)
 return row?.fleetCandidatePreparation
}
async function authorityFixture() {
 const x=fixture(),pending=await prepare(x)
 if(pending?.target.purpose?.kind!=='resource-readiness')throw Error('Expected the real graph producer')
 const purpose=pending.target.purpose,intent=exclusiveResourceIntentSchema.parse({operationId:`graph-prerequisite:${pending.targetInputSha256}`,
   hostId:x.h.hostId,laneId:x.lane.id,controller:{...pending.candidate.controller,sequence:x.h.sequence},
   owner:{id:`resource-graph:${pending.targetInputSha256}`,kind:'boundary-cleanup'},inputSha256:pending.targetInputSha256,
   prerequisite:{...purpose,jobId:x.f.row.requestId,targetInputSha256:pending.targetInputSha256,binding:pending.target.acceptedBinding,candidate:pending.candidate},
   resources:purpose.resources.map(m=>({id:m.id,capabilities:['resource-idle']}))})
 let version=0,writes=0,beforeCas: (()=>void)|undefined,afterCas: (()=>void)|undefined
 const rows: ResourceReservationRepository={
   async get(id){const snapshot=(({receivedAt:_,authorityReservations:__,resourceControlRecords:___,resourceLifecycleCursor:____,...snapshot})=>snapshot)(x.h)
     return id===x.h.hostId?{hostId:id,incarnation:x.h.incarnation,incarnationGeneration:x.h.incarnationGeneration,sequence:x.h.sequence,
       receivedAt:new Date(x.h.receivedAt),snapshot:structuredClone(snapshot),resourceReservationVersion:version,
       resourceReservations:structuredClone(x.h.authorityReservations),laneControlVersion:0,laneControls:x.h.resourceControlRecords??[]} as ResourceReservationHost:null},
   async request(id){return id===x.f.row.requestId?structuredClone(x.f.row):null},
   async replaceBackend(previous,claims,original,now){
     expect(original).toEqual(intent);expect(now.getTime()).toBe(x.f.now)
     const callback=beforeCas;beforeCas=undefined;callback?.()
     if(previous.resourceReservationVersion!==version||previous.sequence!==x.h.sequence)return false
     version++;writes++;x.h.authorityReservations=structuredClone(claims)
     const after=afterCas;afterCas=undefined;after?.();return true},
   async replace(){throw Error('Graph must use the original request/host CAS')},
   async recordCandidateClaim(_id,_pending,claim){x.f.row.fleetCandidatePreparation!.resourceClaims=[
     ...x.f.row.fleetCandidatePreparation!.resourceClaims??[],structuredClone(claim)];return true},
 }
 return {...x,intent,service:new ResourceReservationsService(rows,()=>x.f.now),get writes(){return writes},
   beforeCas(callback:()=>void){beforeCas=callback},afterCas(callback:()=>void){afterCas=callback},
   changeClaims(claims:ExclusiveHostReservation[]){version++;x.h.authorityReservations=structuredClone(claims)}}
}
function begin(x: ReturnType<typeof fixture>) {
 const subject=x.h.resourceLifecycle!.subjects.find(s=>s.subject.id==='air1:glasses')!
 subject.generation++;subject.status='checking';subject.owner={...x.claim.owner,hostId:x.h.hostId,laneId:x.lane.id,generation:1}
 x.journal.state='began' as 'prepared';Object.assign(x.journal,{eventId:`resource-check-began:${x.claim.operationId}`})
 x.h.resourceLifecycle!.history.push({id:'glasses-checking',resourceId:subject.subject.id,event:'checking',subjectGeneration:subject.generation,at:x.h.observedAt})
}
for(const state of ['prepared','began'] as const){
 test(`real producer admits complete graph beside an authentic ${state} disjoint Check without changing its claim`,async()=>{
   const x=fixture();if(state==='began')begin(x);occupy(x)
   const original=structuredClone(x.h.authorityReservations),pending=await prepare(x)
   expect(pending?.target.purpose?.kind==='resource-readiness'?pending.target.purpose.resources.map(m=>m.id).sort():undefined).toEqual(['air1:app','air1:phone','air1:recorder'])
   expect(x.f.writes).toBe(1);expect(x.h.authorityReservations).toEqual(original)
 })
 test(`real acquisition keeps authentic ${state} disjoint custody while reserving only graph members`,async()=>{
   const x=await authorityFixture();if(state==='began')begin(x);occupy(x)
   const original=structuredClone(x.claim),answer=await x.service.acquire(x.intent,x.h.hostId)
   expect(answer.status).toBe('reserved');expect(answer.claims.map(c=>c.resourceId).sort()).toEqual(['air1:app','air1:phone','air1:recorder'])
   expect(x.writes).toBe(1);expect(x.h.authorityReservations!.find(c=>c.id===original.id)).toEqual(original)
 })
}
test('an unrequested foreign capability does not expand the graph beside a real disjoint Check', async () => {
 const advertise = (x: ReturnType<typeof fixture>) => {
   const ref=x.lane.resources.find(resource=>resource.kind==='recorder')!
   ref.capabilities=['google-authentication']
   ref.exclusiveDependencies=[{resourceId:'conference-account',authorityHostId:'mini',capability:'google-authentication'}]
 }
 const producer=fixture();advertise(producer);occupy(producer)
 expect((await prepare(producer))?.target.purpose?.kind).toBe('resource-readiness')
 expect(producer.h.authorityReservations).toEqual([producer.claim])
 const authority=await authorityFixture();advertise(authority);occupy(authority)
 expect((await authority.service.acquire(authority.intent,authority.h.hostId)).status).toBe('reserved')
 expect(authority.h.authorityReservations!.find(claim=>claim.id===authority.claim.id)).toEqual(authority.claim)
 expect(authority.writes).toBe(1)
})
const refusals: Array<[string,(x: ReturnType<typeof fixture>)=>void]>=[
 ['required direct overlap',x=>{x.claim.resourceId='air1:phone';x.claim.resourceCheck=undefined}],
 ['secondary Check dependency overlap',x=>{x.lane.resources.find(r=>r.kind==='glasses')!.idleContract!.dependencies=['air1:app']}],
 ['required contract dependency overlap',x=>{x.lane.resources.find(r=>r.kind==='app')!.idleContract!.dependencies!.push('air1:glasses')}],
 ['required exclusive dependency overlap',x=>{
   x.lane.resources.find(r=>r.kind==='recorder')!.capabilities=['resource-idle']
   x.lane.resources.find(r=>r.kind==='recorder')!.exclusiveDependencies=[{resourceId:'air1:glasses',authorityHostId:'air1',capability:'resource-idle'}]
   x.f.row.fleetPreparation!.definition.resourceRequirements.find(resource=>resource.kind==='recorder')!.capabilities=['resource-idle']
   x.f.row.fleetPreparation!.definitionSha256=requestInputDigest(x.f.row.fleetPreparation!.definition)
   x.f.row.fleetInputSha256=routineJobInputDigest(x.f.row)
 }],
 ['foreign dependency authority',x=>{x.lane.resources.find(r=>r.kind==='glasses')!.capabilities=['resource-idle'];x.lane.resources.find(r=>r.kind==='glasses')!.exclusiveDependencies=[{resourceId:'air1:app',authorityHostId:'foreign',capability:'resource-idle'}]}],
 ['conflicting canonical alias',x=>{const ref=x.lane.resources.find(r=>r.kind==='glasses')!;x.h.lanes.push({...structuredClone(x.lane),id:'alias',resources:[{...structuredClone(ref),idleContract:{...ref.idleContract!,dependencies:['air1:app']}}]});x.h.resourceLifecycle!.subjects.find(s=>s.subject.id===ref.id)!.resource.memberships.push({hostId:'air1',laneId:'alias'})}],
 ['changed controller',x=>{x.claim.controllerIncarnation='foreign-controller'}],
 ['future controller sequence',x=>{x.claim.borrowerSequence=x.h.sequence+1}],
 ['changed binding',x=>{x.claim.resourceCheck!.binding={...x.claim.resourceCheck!.binding,version:1201}}],
 ['changed intent digest',x=>{x.claim.intentSha256='e'.repeat(64)}],
 ['changed input digest',x=>{x.claim.inputSha256='e'.repeat(64)}],
 ['wrong prepared generation',x=>{const s=x.h.resourceLifecycle!.subjects.find(s=>s.subject.id==='air1:glasses')!;s.generation++;s.status='unknown'}],
 ['expired Check',x=>{x.claim.resourceCheck!.deadlineAt=x.f.now}],
 ['future journal',x=>{x.journal.observedAt=new Date(x.f.now+1).toISOString()}],
 ['stale subject provenance',x=>{x.h.resourceLifecycle!.subjects.find(s=>s.subject.id==='air1:glasses')!.observedAt=new Date(x.f.now-120001).toISOString()}],
 ['closed journal',x=>{x.journal.state='never-began' as 'prepared';Object.assign(x.journal,{eventId:`resource-check-never-began:${x.claim.operationId}`})}],
 ['missing journal',x=>{x.h.resourceReservations!.resourceChecks=[]}],
 ['unknown Check custody',x=>{x.h.resourceLifecycle!.subjects.find(s=>s.subject.id==='air1:glasses')!.status='unknown';x.h.resourceLifecycle!.subjects.find(s=>s.subject.id==='air1:glasses')!.owner={id:'unknown-writer',kind:'boundary-cleanup',hostId:'air1',generation:1}}],
 ['active repair',x=>{const s=x.h.resourceLifecycle!.subjects.find(s=>s.subject.id==='air1:glasses')!;s.status='in-repair';s.repair={state:'running',configured:true,executionId:'repair-writer'}}],
 ['busy lane',x=>{x.lane.state='running' as typeof x.lane.state}],
 ['paused lane',x=>{x.lane.dispatchMode='paused'}],
 ['unknown extra lane claim',x=>{x.h.authorityReservations!.push({...x.claim,id:'33333333-3333-4333-8333-333333333333',resourceId:'air1:unused',resourceCheck:undefined})}],
 ['operator withdrawal on optional Check',x=>{x.h.resourceControlRecords=[{command:{operationId:'44444444-4444-4444-8444-444444444444',hostId:x.h.hostId,operatorId:'a'.repeat(64),expiresAt:x.f.now+120000,subject:{resourceId:'air1:glasses',subjectGeneration:1},action:'mark-out-of-service',reason:'Human withdrawal'}}]}],
 ['missing optional reader actions',x=>{x.h.resourceLifecycle!.subjects.find(s=>s.subject.id==='air1:glasses')!.supportedActions=[]}],
 ['cyclic optional dependency',x=>{x.lane.resources.find(r=>r.kind==='glasses')!.idleContract!.dependencies=['air1:glasses']}],
 ['missing optional dependency',x=>{x.lane.resources.find(r=>r.kind==='glasses')!.idleContract!.dependencies=['unreported-resource']}],
 ['began without history',x=>{begin(x);x.h.resourceLifecycle!.history=[]}],
 ['began with another owner',x=>{begin(x);x.h.resourceLifecycle!.subjects.find(s=>s.subject.id==='air1:glasses')!.owner!.id='another-owner'}],
]
for(const [name,mutate] of refusals){
 test(`${name} blocks producer and acquisition without changing custody`,async()=>{
   const producer=fixture();occupy(producer);mutate(producer);const before=structuredClone(producer.h.authorityReservations)
   expect(await prepare(producer)).toBeUndefined();expect(producer.f.writes).toBe(0);expect(producer.h.authorityReservations).toEqual(before)
   const authority=await authorityFixture();occupy(authority);mutate(authority);const retained=structuredClone(authority.h.authorityReservations)
   expect(await authority.service.acquire(authority.intent,authority.h.hostId)).toMatchObject({status:'unknown',claims:[]})
   expect(authority.writes).toBe(0);expect(authority.h.authorityReservations).toEqual(retained)
 })
}
test('a concurrent overlapping claim loses the existing host CAS and preserves both originals',async()=>{
 const x=await authorityFixture();occupy(x);const original=structuredClone(x.claim),competing={...original,id:'33333333-3333-4333-8333-333333333333',resourceId:'air1:phone',resourceCheck:undefined}
 x.beforeCas(()=>x.changeClaims([original,competing]))
 expect(await x.service.acquire(x.intent,x.h.hostId)).toMatchObject({status:'unknown',claims:[]})
 expect(x.writes).toBe(0);expect(x.h.authorityReservations).toEqual([original,competing])
})
test('post-CAS changed reader scope refuses the grant and retains committed graph custody',async()=>{
 const x=await authorityFixture();occupy(x);const original=structuredClone(x.claim)
 x.afterCas(()=>{x.journal.state='never-began' as 'prepared';Object.assign(x.journal,{eventId:`resource-check-never-began:${x.claim.operationId}`})})
 expect(await x.service.acquire(x.intent,x.h.hostId)).toMatchObject({status:'unknown',claims:[]})
 expect(x.writes).toBe(1);expect(x.h.authorityReservations!.find(c=>c.id===original.id)).toEqual(original)
 expect(x.h.authorityReservations!.filter(c=>c.id!==original.id).map(c=>'resourceId'in c?c.resourceId:'').sort()).toEqual(['air1:app','air1:phone','air1:recorder'])
})

for(const [name,mutate] of [
 ['foreign claim authority',(x:ReturnType<typeof fixture>)=>{x.claim.authorityHostId='foreign'}],
 ['duplicate original journal',(x:ReturnType<typeof fixture>)=>{x.h.resourceReservations!.resourceChecks!.push(structuredClone(x.journal))}],
] as const){
 test(`malformed ${name} is rejected without any claim write`,async()=>{
   const x=await authorityFixture();occupy(x);mutate(x);const before=structuredClone(x.h.authorityReservations)
   await expect(x.service.acquire(x.intent,x.h.hostId)).rejects.toThrow()
   expect(x.writes).toBe(0);expect(x.h.authorityReservations).toEqual(before)
 })
}
test('changed optional proof on the producer current reread cannot create a candidate',async()=>{
 const x=fixture();occupy(x)
 const hosts=(x.f.service as unknown as {hosts:{get(id:string):Promise<typeof x.h|null>}}).hosts,original=hosts.get.bind(hosts)
 hosts.get=async id=>{x.journal.state='never-began' as 'prepared';Object.assign(x.journal,{eventId:`resource-check-never-began:${x.claim.operationId}`});return original(id)}
 expect(await prepare(x)).toBeUndefined();expect(x.f.writes).toBe(0);expect(x.h.authorityReservations).toEqual([x.claim])
})
