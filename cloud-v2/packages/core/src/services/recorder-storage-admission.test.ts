import {expect, test, spyOn} from 'bun:test'
import {routineJobRepository, reconcileRecorderHostReservations, unobservedRecorderHostReservations, compatibleRoutineLane, routinePortableRequirements} from './routine-job.service'
import {recorderStorageAvailable, STORAGE_MARGIN_BYTES} from '../types/recorder-storage.types'
import {TestRequestModel} from '../models/test-request.model'
import {TestHostStateModel} from '../models/test-host-state.model'
import {requestInputDigest} from './test-request.service'
import {ResourceReservationsService} from './resource-reservations.service'
import type {FleetExclusiveReservation} from '../types/resource-reservations.types'
const now=new Date('2026-10-15T12:00:00Z'),gib=1024**3,required={minimumAvailableBytes:7*gib}
const offer={poolId:'host:disk:1',observedAt:now.toISOString(),availableBytes:8*gib,stagingBudgetBytes:10*gib,pendingEvidenceBytes:0,reservations:[]}
const claim=(requestId:string)=>({id: requestId==='one'?'b1f9a5d6-1f7e-4bd9-9ab1-23a5bb3bba20':'b1f9a5d6-1f7e-4bd9-9ab1-23a5bb3bba21',
 requestId,fleetInputSha256:'a'.repeat(64),hostId:'host',laneId:'mac',poolId:offer.poolId,minimumAvailableBytes:7*gib,reservedAt:now.toISOString()})
const row=(requestId:string)=>({requestId,fleetDeadline:new Date(now.getTime()+3600000),fleetInputSha256:'a'.repeat(64),fleetResourceReservation:claim(requestId)} as any)
test('unobserved host claims count across lanes and exact accepted input only once',()=>{
 const request={...row('one'),fleetBinding:{hostId:'host'},inputSha256:'a'.repeat(64)}
 expect(unobservedRecorderHostReservations([claim('one')],[request],offer)).toBe(5*gib)
 const measured={...offer,reservations:[{requestId:'one',inputSha256:'a'.repeat(64),remainingOutputBytes:3*gib}]}
 expect(unobservedRecorderHostReservations([claim('one')],[request],measured)).toBe(0)
 expect(recorderStorageAvailable(measured,required,now.getTime())).toBe(false)
 expect(unobservedRecorderHostReservations([claim('one')],[{...request,inputSha256:'b'.repeat(64)}],measured)).toBe(5*gib)
 expect(unobservedRecorderHostReservations([claim('one')],[{...request,fleetInputSha256:'b'.repeat(64)}],measured)).toBe(5*gib)
})
test('cancellation cannot release delivered work; cleanup requires a later capacity observation',()=>{
 const cancelled={...row('one'),fleetCancellation:{requestedAt:now.toISOString()}}
 expect(reconcileRecorderHostReservations([claim('one')],[cancelled],offer)).toEqual([])
 expect(reconcileRecorderHostReservations([claim('one')],[{...cancelled,fleetBinding:{hostId:'host'}}],offer)).toHaveLength(1)
 expect(reconcileRecorderHostReservations([claim('one')],[{...cancelled,fleetBinding:{hostId:'host'},dispatchCompletion:{completedAt:new Date(now.getTime()+1).toISOString()}}],offer)).toHaveLength(1)
 expect(reconcileRecorderHostReservations([claim('one')],[{...cancelled,fleetBinding:{hostId:'host'},dispatchCompletion:{completedAt:now.toISOString()}}],offer)).toEqual([])
 expect(reconcileRecorderHostReservations([claim('one')],[{...cancelled,fleetBinding:{hostId:'host'},dispatchCompletion:{completedAt:now.toISOString()}}],
  {...offer,reservations:[{requestId:'one',inputSha256:'a'.repeat(64),remainingOutputBytes:0}]})).toHaveLength(1)
 expect(reconcileRecorderHostReservations([claim('one')],[],offer)).toHaveLength(1)
 expect(reconcileRecorderHostReservations([claim('one')],[{...row('one'),fleetInputSha256:'b'.repeat(64),fleetCancellation:{}}],offer)).toHaveLength(1)
})
test('unknown, stale capacity and evidence staging pressure reject the existing recorder requirement',()=>{
 const lane={id:'mac',platform:'ios-on-mac' as const,state:'idle' as const,dispatchMode:'automatic' as const,resources:[{id:'rec',kind:'recorder' as const,storage:offer}]}
 const requirements={platform:'ios-on-mac' as const,resources:[{kind:'recorder' as const,capabilities:[],storage:required}]}
 expect(compatibleRoutineLane(requirements,lane,undefined,now.getTime())).toBe(true)
 expect(compatibleRoutineLane(requirements,{...lane,resources:[{id:'rec',kind:'recorder'}]},undefined,now.getTime())).toBe(false)
 expect(compatibleRoutineLane(requirements,{...lane,resources:[{...lane.resources[0]!,storage:{...offer,observedAt:new Date(now.getTime()-120001).toISOString()}}]},undefined,now.getTime())).toBe(false)
 expect(recorderStorageAvailable({...offer,pendingEvidenceBytes:6*gib},required,now.getTime())).toBe(false)
})
test('authenticated pre-executable preparation refusals release only after their fence and a later empty host offer',()=>{
 const intent={requestId:'one',laneId:'mac'},digest=requestInputDigest(intent)
 const base={...row('one'),hostId:'host',fleetBinding:{hostId:'host',laneId:'mac'},state:'terminal',dispatchIntent:intent,dispatchIntentSha256:digest}
 const rejected={...base,preparationRejection:{dispatchIntentSha256:digest,code:'not-applicable',reason:'Unsupported source',rejectedAt:now.toISOString(),disposition:'not-applicable'}}
 const cancelled={...base,preparationCancellation:{requestedAt:now.toISOString(),reason:'Stopped before executable commit'}}
 for(const stopped of [rejected,cancelled]){
  expect(reconcileRecorderHostReservations([claim('one')],[stopped],offer)).toEqual([])
  expect(reconcileRecorderHostReservations([claim('one')],[stopped],{...offer,observedAt:new Date(now.getTime()-1).toISOString()})).toHaveLength(1)
  expect(reconcileRecorderHostReservations([claim('one')],[stopped],{...offer,reservations:[{requestId:'one',inputSha256:'a'.repeat(64),remainingOutputBytes:0}]})).toHaveLength(1)
  expect(reconcileRecorderHostReservations([claim('one')],[{...stopped,inputSha256:'c'.repeat(64)}],offer)).toHaveLength(1)
  expect(reconcileRecorderHostReservations([claim('one')],[{...stopped,dispatchIntentSha256:'c'.repeat(64)}],offer)).toHaveLength(1)
 }
 expect(reconcileRecorderHostReservations([claim('one')],[{...base,fleetCancellation:{requestedAt:now.toISOString(),reason:'Canceled but no host preparation fence'}}],offer)).toHaveLength(1)
 expect(reconcileRecorderHostReservations([claim('one')],[{...rejected,preparationRejection:{...rejected.preparationRejection,dispatchIntentSha256:'c'.repeat(64)}}],offer)).toHaveLength(1)
})
test('job requirement derives from exact recording policy and preserves the existing disk margin',()=>{
 const row={platform:'ios-on-mac',definition:{execution:{resourceKinds:['recorder'],policy:{estimatedOutputBytes:5*gib}},resourceRequirements:[{kind:'recorder',capabilities:[]}]}} as any
 expect(routinePortableRequirements(row).resources[0]!.storage).toEqual({minimumAvailableBytes:5*gib+STORAGE_MARGIN_BYTES})
 expect(routinePortableRequirements({...row,definition:{...row.definition,resourceRequirements:[{kind:'recorder',capabilities:[],storage:{minimumAvailableBytes:9*gib}}]}}).resources[0]!.storage)
  .toEqual({minimumAvailableBytes:9*gib})
 expect(()=>routinePortableRequirements({...row,definition:{...row.definition,execution:{resourceKinds:['recorder']}}})).toThrow('finite estimatedOutputBytes')
})
function admissionFixture(options:{reportRace?:boolean;missing?:boolean;offline?:boolean;selectionFailure?:boolean;exclusive?:boolean;exclusiveAnswerLost?:boolean}={}) {
 const hosts=new Map<string,any>(['host','other'].map(hostId=>[hostId,{hostId,incarnation:'one',incarnationGeneration:1,sequence:1,receivedAt:now,resourceReservationVersion:0,resourceReservations:[],
 snapshot:{hostId,incarnation:'one',incarnationGeneration:1,sequence:1,observedAt:now.toISOString(),lanes:['mac','android'].map(id=>({id,platform:'ios-on-mac',state:options.offline?'offline':'idle',dispatchMode:'automatic',resources:[{id:`${id}-rec`,kind:'recorder',storage:{...offer,poolId:`${hostId}:disk:1`}}]}))}}]))
 const requests=new Map<string,any>(), writes:any[]=[];let raced=false,selectionFailed=false
 const dependency={resourceId:'conference-account',authorityHostId:'host',capability:'google-authentication'}, exclusiveCalls:string[]=[]
 let portable: FleetExclusiveReservation|undefined, answerLost=false
 if(options.exclusive)for(const host of hosts.values())for(const lane of host.snapshot.lanes)lane.resources.push({id:`${lane.id}-fixture`,kind:'fixture-data',capabilities:['google-authentication'],exclusiveDependencies:[dependency]})
 const first=spyOn(TestRequestModel.collection,'findOne').mockImplementation((async(query:any)=>{
  if(!requests.has(query.requestId))requests.set(query.requestId,{...row(query.requestId),fleetResourceReservation:undefined,state:'awaiting-runner',fleetPreparation:{definition:{execution:{policy:{estimatedOutputBytes:5*gib}}},requirements:{platform:'ios-on-mac',resources:[{kind:'recorder',capabilities:[],storage:required}]}},fleetSelection:{build:{headSha:'b'.repeat(40)}}})
  const request=requests.get(query.requestId)
  if(options.exclusive&&!request.fleetPreparation.requirements.resources.some((value:any)=>value.kind==='fixture-data'))
   request.fleetPreparation.requirements.resources.push({kind:'fixture-data',capabilities:['google-authentication']})
  return structuredClone(request)}) as any)
 const read=spyOn(TestHostStateModel.collection,'findOne').mockImplementation((async(query:any)=>options.missing?null:structuredClone(hosts.get(query.hostId))) as any)
 const hostSave=spyOn(TestHostStateModel.collection,'findOneAndUpdate').mockImplementation((async(query:any,update:any)=>{
  const host=hosts.get(query.hostId)
  writes.push(query)
  if(options.reportRace&&!raced){raced=true;host.sequence++;host.snapshot.sequence++;return null}
  if(query.resourceReservationVersion!==host.resourceReservationVersion||query.sequence!==host.sequence)return null
  const saved={...host,...update.$set,resourceReservationVersion:host.resourceReservationVersion+1};hosts.set(query.hostId,saved);return structuredClone(saved)}) as any)
 const find=spyOn(TestRequestModel.collection,'find').mockImplementation(((query:any)=>({limit(){return this},async toArray(){return query.requestId.$in.map((id:string)=>requests.get(id)).filter(Boolean)}})) as any)
 const save=spyOn(TestRequestModel.collection,'findOneAndUpdate').mockImplementation((async(query:any,update:any)=>{
  const request=requests.get(query.requestId)
  if(update.$set.fleetBinding){
   if(request.state!=='awaiting-runner'||request.fleetBinding||request.fleetCancellation||request.fleetResourceReservation?.hostId!==query['fleetResourceReservation.hostId']||request.fleetResourceReservation?.laneId!==query['fleetResourceReservation.laneId'])return null
  }else{
   if(options.selectionFailure&&!selectionFailed){selectionFailed=true;throw Error('temporary request write failure')}
   if(request.fleetResourceReservation)return null
  }
  Object.assign(request,update.$set);return structuredClone(request)
 }) as any)
 const exclusive=spyOn(ResourceReservationsService.prototype,'reserveFleet').mockImplementation(async(requestId,digest,hostId,laneId)=>{
  exclusiveCalls.push(requestId)
  if(portable)return portable.intent.owner.id===requestId&&portable.intent.hostId===hostId&&portable.intent.laneId===laneId?structuredClone(portable):null
  const host=hosts.get('host'), borrower=hosts.get(hostId), origin={kind:'fleet' as const,fleetInputSha256:digest}, intent={operationId:`run:${requestId}`,hostId,laneId,
   inputSha256:digest,owner:{id:requestId,kind:'run' as const},controller:{incarnation:borrower.incarnation,generation:borrower.incarnationGeneration,sequence:borrower.sequence},
   resources:borrower.snapshot.lanes.find((lane:any)=>lane.id===laneId).resources.map((value:any)=>({id:value.id,capabilities:value.kind==='fixture-data'?['google-authentication']:[]}))},
   intentSha256=requestInputDigest({...intent,controller:{incarnation:intent.controller.incarnation,generation:intent.controller.generation},origin,dependencies:[dependency]}),
   claim={kind:'exclusive' as const,id:'3e684af3-a53e-4da3-a4f8-4856dd1af72b',resourceId:dependency.resourceId,authorityHostId:'host',borrowerHostId:hostId,laneId,
    owner:intent.owner,operationId:intent.operationId,origin,inputSha256:digest,intentSha256,controllerIncarnation:intent.controller.incarnation,
    controllerGeneration:intent.controller.generation,borrowerSequence:intent.controller.sequence,reservedAt:now.toISOString()}
  portable={origin,intent,intentSha256,claims:[claim]};host.resourceReservations.push(claim);host.resourceReservationVersion++
  if(options.exclusiveAnswerLost&&!answerLost){answerLost=true;throw Error('exclusive answer lost after authority commit')}
  return structuredClone(portable)
 })
 return {writes,requests,exclusiveCalls,host:(hostId='host')=>hosts.get(hostId),restore(){first.mockRestore();read.mockRestore();hostSave.mockRestore();find.mockRestore();save.mockRestore();exclusive.mockRestore()}}
}
test('two simultaneous lane claims atomically fence the existing host record and cannot spend the same bytes',async()=>{
 const f=admissionFixture()
 try{
  const results=await Promise.all([routineJobRepository.reserveResources!('one','a'.repeat(64),'host','mac',now),routineJobRepository.reserveResources!('two','a'.repeat(64),'host','android',now)])
  expect(results.filter(Boolean)).toHaveLength(1);expect(f.host().resourceReservations).toHaveLength(1)
  expect(f.writes[0]).toMatchObject({hostId:'host',sequence:1,resourceReservationVersion:0})
 }finally{f.restore()}
})
test('a host report racing admission requires a fresh snapshot CAS before retaining the receipt',async()=>{
 const f=admissionFixture({reportRace:true})
 try{expect(await routineJobRepository.reserveResources!('one','a'.repeat(64),'host','mac',now)).not.toBeNull();expect(f.writes.map(value=>value.sequence)).toEqual([1,2])}finally{f.restore()}
})
test('offline or missing hosts cannot reserve recorder capacity',async()=>{
 for(const options of [{missing:true},{offline:true}]){const f=admissionFixture(options)
  try{expect(await routineJobRepository.reserveResources!('one','a'.repeat(64),'host','mac',now)).toBeNull();expect(f.writes).toEqual([])}finally{f.restore()}}
})
test('a failed target receipt write converges on the same authoritative host claim without leaking another reservation',async()=>{
 const f=admissionFixture({selectionFailure:true})
 try{
  await expect(routineJobRepository.reserveResources!('one','a'.repeat(64),'host','mac',now)).rejects.toThrow('temporary request write failure')
  const original=f.host().resourceReservations[0]
  expect(await routineJobRepository.reserveResources!('one','a'.repeat(64),'host','mac',now)).not.toBeNull()
  expect(f.host().resourceReservations).toEqual([original]);expect(f.requests.get('one').fleetResourceReservation.id).toBe(original.id)
 }finally{f.restore()}
})
test('same-host exclusive commitment advances the existing authority CAS, then recorder admission preserves both original claims',async()=>{
 const f=admissionFixture({exclusive:true})
 try{
  const selected=await routineJobRepository.reserveResources!('one','a'.repeat(64),'host','mac',now)
  expect(selected!.fleetExclusiveReservation!.claims).toHaveLength(1)
  expect(f.writes.map(value=>value.resourceReservationVersion)).toEqual([0,1])
  expect(f.host().resourceReservations).toHaveLength(2)
  expect(f.host().resourceReservations.find((value:any)=>value.kind==='exclusive')).toEqual(selected!.fleetExclusiveReservation!.claims[0])
  expect(f.host().resourceReservations.find((value:any)=>!value.kind)).toEqual(selected!.fleetResourceReservation)
  const before=structuredClone(f.host().resourceReservations)
  expect(await routineJobRepository.reserveResources!('two','a'.repeat(64),'other','mac',now)).toBeNull()
  expect(f.host().resourceReservations).toEqual(before);expect(f.host('other').resourceReservations).toEqual([])
 }finally{f.restore()}
})
test('lost exclusive response or failed request receipt adopts its original winner without spending another host capacity claim',async()=>{
 for(const options of [{exclusiveAnswerLost:true},{selectionFailure:true}]){
  const f=admissionFixture({exclusive:true,...options})
  try{
   await expect(routineJobRepository.reserveResources!('one','a'.repeat(64),'host','mac',now)).rejects.toThrow()
   const original=structuredClone(f.host().resourceReservations)
   const selected=await routineJobRepository.reserveResources!('one','a'.repeat(64),'host','mac',now)
   expect(selected!.fleetExclusiveReservation!.claims[0]).toEqual(original.find((value:any)=>value.kind==='exclusive'))
   expect(f.host().resourceReservations).toHaveLength(2)
   expect(new Set(f.host().resourceReservations.map((value:any)=>value.id)).size).toBe(2)
   expect(await routineJobRepository.reserveResources!('one','a'.repeat(64),'other','mac',now)).toBeNull()
   expect(f.host('other').resourceReservations).toEqual([])
  }finally{f.restore()}
 }
})
test('a losing host claim converges after another host wins, binds and refuses input-free preparation',async()=>{
 for(const disposition of ['rejected','cancelled']){
  const f=admissionFixture({selectionFailure:true})
  try{
   await expect(routineJobRepository.reserveResources!('one','a'.repeat(64),'host','mac',now)).rejects.toThrow('temporary request write failure')
   const losing=f.host().resourceReservations[0]
   const winner=await routineJobRepository.reserveResources!('one','a'.repeat(64),'other','mac',now)
   expect(winner!.fleetResourceReservation!.id).not.toBe(losing.id)
   const intent={requestId:'one',laneId:'mac'},digest=requestInputDigest(intent)
   const bound=await routineJobRepository.bind('one','a'.repeat(64),{hostId:'other',laneId:'mac'} as any,intent,now)
   expect(bound).toMatchObject({state:'preparing',hostId:'other',fleetBinding:{hostId:'other',laneId:'mac'},dispatchIntentSha256:digest})
   Object.assign(f.requests.get('one'),{state:'terminal',
    ...(disposition==='rejected'?{preparationRejection:{dispatchIntentSha256:digest,code:'not-applicable',reason:'Unsupported source',rejectedAt:now.toISOString(),disposition:'not-applicable'}}
     :{preparationCancellation:{requestedAt:now.toISOString(),reason:'Cancelled before executable input'}})})
   expect(f.requests.get('one')).not.toHaveProperty('inputSha256')
   expect(reconcileRecorderHostReservations([losing],[f.requests.get('one')],{...offer,reservations:[{requestId:'one',inputSha256:'b'.repeat(64),remainingOutputBytes:0}]})).toEqual([losing])
   expect(await routineJobRepository.reserveResources!('two','a'.repeat(64),'host','android',now)).not.toBeNull()
   expect(f.host().resourceReservations.map((value:any)=>value.requestId)).toEqual(['two'])
  }finally{f.restore()}
 }
})
test('losing claim release requires a valid immutable winner and binding target; unknown ownership stays charged',()=>{
 const losing=claim('one'),winner={...losing,id:'b1f9a5d6-1f7e-4bd9-9ab1-23a5bb3bba21',hostId:'other',poolId:'other:disk:1'}
 const selected={...row('one'),fleetResourceReservation:winner,fleetBinding:{hostId:'other',laneId:'mac'}}
 expect(reconcileRecorderHostReservations([losing],[selected],offer)).toEqual([])
 for(const changed of [{...selected,fleetResourceReservation:{...winner,requestId:'wrong'}},{...selected,fleetResourceReservation:{...winner,fleetInputSha256:'b'.repeat(64)}},
  {...selected,fleetResourceReservation:{...winner,id:'invalid'}},{...selected,fleetBinding:{hostId:'host',laneId:'mac'}}]){
  expect(reconcileRecorderHostReservations([losing],[changed],offer)).toEqual([losing])
 }
})
