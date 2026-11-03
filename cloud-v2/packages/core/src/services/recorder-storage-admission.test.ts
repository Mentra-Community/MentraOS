import {expect, test} from 'bun:test'
import {reconcileRecorderHostReservations, unobservedRecorderHostReservations, compatibleRoutineLane, routinePortableRequirements} from './routine-job.service'
import {recorderStorageAvailable, STORAGE_MARGIN_BYTES} from '../types/recorder-storage.types'
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
test('losing claim release requires a valid immutable winner and binding target; unknown ownership stays charged',()=>{
 const losing=claim('one'),winner={...losing,id:'b1f9a5d6-1f7e-4bd9-9ab1-23a5bb3bba21',hostId:'other',poolId:'other:disk:1'}
 const selected={...row('one'),fleetResourceReservation:winner,fleetBinding:{hostId:'other',laneId:'mac'}}
 expect(reconcileRecorderHostReservations([losing],[selected],offer)).toEqual([])
 for(const changed of [{...selected,fleetResourceReservation:{...winner,requestId:'wrong'}},{...selected,fleetResourceReservation:{...winner,fleetInputSha256:'b'.repeat(64)}},
  {...selected,fleetResourceReservation:{...winner,id:'invalid'}},{...selected,fleetBinding:{hostId:'host',laneId:'mac'}}]){
  expect(reconcileRecorderHostReservations([losing],[changed],offer)).toEqual([losing])
 }
})
