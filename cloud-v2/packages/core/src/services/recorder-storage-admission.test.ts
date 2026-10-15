import {expect, test, spyOn} from 'bun:test'
import {routineJobRepository, reconcileRecorderHostReservations, unobservedRecorderHostReservations, compatibleRoutineLane, routinePortableRequirements} from './routine-job.service'
import {recorderStorageAvailable, STORAGE_MARGIN_BYTES} from '../types/recorder-storage.types'
import {TestRequestModel} from '../models/test-request.model'
import {TestHostStateModel} from '../models/test-host-state.model'
import {requestInputDigest} from './test-request.service'
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
function admissionFixture(options:{reportRace?:boolean;missing?:boolean;offline?:boolean;selectionFailure?:boolean}={}) {
 let host:any={hostId:'host',incarnation:'one',incarnationGeneration:1,sequence:1,receivedAt:now,resourceReservationVersion:0,resourceReservations:[],
 snapshot:{hostId:'host',incarnation:'one',incarnationGeneration:1,sequence:1,observedAt:now.toISOString(),lanes:['mac','android'].map(id=>({id,platform:'ios-on-mac',state:options.offline?'offline':'idle',dispatchMode:'automatic',resources:[{id:`${id}-rec`,kind:'recorder',storage:offer}]}))}}
 const requests=new Map<string,any>(), writes:any[]=[];let raced=false,selectionFailed=false
 const first=spyOn(TestRequestModel.collection,'findOne').mockImplementation((async(query:any)=>{
  if(!requests.has(query.requestId))requests.set(query.requestId,{...row(query.requestId),fleetResourceReservation:undefined,state:'awaiting-runner',fleetPreparation:{definition:{execution:{policy:{estimatedOutputBytes:5*gib}}},requirements:{platform:'ios-on-mac',resources:[{kind:'recorder',capabilities:[],storage:required}]}},fleetSelection:{build:{headSha:'b'.repeat(40)}}})
  return structuredClone(requests.get(query.requestId))}) as any)
 const read=spyOn(TestHostStateModel.collection,'findOne').mockImplementation((async()=>options.missing?null:structuredClone(host)) as any)
 const hostSave=spyOn(TestHostStateModel.collection,'findOneAndUpdate').mockImplementation((async(query:any,update:any)=>{
  writes.push(query)
  if(options.reportRace&&!raced){raced=true;host.sequence++;host.snapshot.sequence++;return null}
  if(query.resourceReservationVersion!==host.resourceReservationVersion||query.sequence!==host.sequence)return null
  host={...host,...update.$set,resourceReservationVersion:host.resourceReservationVersion+1};return structuredClone(host)}) as any)
 const find=spyOn(TestRequestModel.collection,'find').mockImplementation(((query:any)=>({limit(){return this},async toArray(){return query.requestId.$in.map((id:string)=>requests.get(id)).filter(Boolean)}})) as any)
 const save=spyOn(TestRequestModel.collection,'findOneAndUpdate').mockImplementation((async(query:any,update:any)=>{const request=requests.get(query.requestId);if(options.selectionFailure&&!selectionFailed){selectionFailed=true;throw Error('temporary request write failure')}if(request.fleetResourceReservation)return null;Object.assign(request,update.$set);return structuredClone(request)}) as any)
 return {writes,requests,host:()=>host,restore(){first.mockRestore();read.mockRestore();hostSave.mockRestore();find.mockRestore();save.mockRestore()}}
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
