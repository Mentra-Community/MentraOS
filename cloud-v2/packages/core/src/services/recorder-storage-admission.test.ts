import {expect, test, spyOn} from 'bun:test'
import {routineJobRepository, unobservedRecorderReservations, compatibleRoutineLane, routinePortableRequirements} from './routine-job.service'
import {recorderStorageAvailable, STORAGE_MARGIN_BYTES} from '../types/recorder-storage.types'
import {TestRequestModel} from '../models/test-request.model'
import {TestHostStateModel} from '../models/test-host-state.model'
import * as mongo from '../connections/mongo.connection'
const now=new Date('2026-10-15T12:00:00Z'),gib=1024**3,required={minimumAvailableBytes:7*gib}
const offer={poolId:'host:disk:1',observedAt:now.toISOString(),availableBytes:8*gib,stagingBudgetBytes:10*gib,pendingEvidenceBytes:0,reservations:[]}
const claim=(id:string)=>({requestId:id,fleetDeadline:new Date(now.getTime()+3600000),fleetResourceReservation:{hostId:'host',laneId:'mac',poolId:offer.poolId,minimumAvailableBytes:7*gib,reservedAt:now.toISOString()}} as any)
test('unobserved claims count across lanes and match exact accepted input only once',()=>{
 const row={...claim('one'),fleetBinding:{hostId:'host'},inputSha256:'a'.repeat(64)}
 expect(unobservedRecorderReservations([row],offer,now.getTime())).toBe(5*gib)
 const measured={...offer,reservations:[{requestId:'one',inputSha256:'a'.repeat(64),remainingOutputBytes:3*gib}]}
 expect(unobservedRecorderReservations([row],measured,now.getTime())).toBe(0)
 expect(recorderStorageAvailable(measured,required,now.getTime())).toBe(false)
 expect(unobservedRecorderReservations([{...row,inputSha256:'b'.repeat(64)}],measured,now.getTime())).toBe(5*gib)
})
test('cancellation does not release delivered work; actual completed cleanup needs a later capacity observation',()=>{
 const cancelled={...claim('one'),fleetCancellation:{requestedAt:now.toISOString()}}
 expect(unobservedRecorderReservations([cancelled],offer,now.getTime())).toBe(0)
 expect(unobservedRecorderReservations([{...cancelled,fleetBinding:{hostId:'host'}}],offer,now.getTime())).toBe(5*gib)
 expect(unobservedRecorderReservations([{...cancelled,fleetBinding:{hostId:'host'},dispatchCompletion:{completedAt:new Date(now.getTime()+1).toISOString()}}],offer,now.getTime())).toBe(5*gib)
 expect(unobservedRecorderReservations([{...cancelled,fleetBinding:{hostId:'host'},dispatchCompletion:{completedAt:now.toISOString()}}],offer,now.getTime())).toBe(0)
})
test('unknown, stale capacity and evidence staging pressure reject the existing recorder requirement',()=>{
 const lane={id:'mac',platform:'ios-on-mac' as const,state:'idle' as const,dispatchMode:'automatic' as const,resources:[{id:'rec',kind:'recorder' as const,storage:offer}]}
 const requirements={platform:'ios-on-mac' as const,resources:[{kind:'recorder' as const,capabilities:[],storage:required}]}
 expect(compatibleRoutineLane(requirements,lane,undefined,now.getTime())).toBe(true)
 expect(compatibleRoutineLane(requirements,{...lane,resources:[{id:'rec',kind:'recorder'}]},undefined,now.getTime())).toBe(false)
 expect(compatibleRoutineLane(requirements,{...lane,resources:[{...lane.resources[0]!,storage:{...offer,observedAt:new Date(now.getTime()-120001).toISOString()}}]},undefined,now.getTime())).toBe(false)
 expect(recorderStorageAvailable({...offer,pendingEvidenceBytes:6*gib},required,now.getTime())).toBe(false)
})
test('job requirement derives from exact recording policy and preserves the existing disk margin',()=>{
 const row={platform:'ios-on-mac',definition:{execution:{resourceKinds:['recorder'],policy:{estimatedOutputBytes:5*gib}},resourceRequirements:[{kind:'recorder',capabilities:[]}]}} as any
 expect(routinePortableRequirements(row).resources[0]!.storage).toEqual({minimumAvailableBytes:5*gib+STORAGE_MARGIN_BYTES})
 expect(()=>routinePortableRequirements({...row,definition:{...row.definition,execution:{resourceKinds:['recorder']}}})).toThrow('finite estimatedOutputBytes')
})
test('two simultaneous lane claims serialize on the existing host record and cannot spend the same bytes',async()=>{
 let chain=Promise.resolve(),claims:any[]=[]
 const transaction=spyOn(mongo,'withTransaction').mockImplementation(((fn:any)=>{const result=chain.then(()=>fn('session'));chain=result.then(()=>undefined,()=>undefined);return result}) as any)
 const first=spyOn(TestRequestModel.collection,'findOne').mockImplementation((async(query:any)=>({...claim(query.requestId),fleetResourceReservation:undefined,fleetInputSha256:'a'.repeat(64),state:'awaiting-runner',fleetPreparation:{requirements:{platform:'ios-on-mac',resources:[{kind:'recorder',capabilities:[],storage:required}]}},fleetSelection:{build:{headSha:'b'.repeat(40)}}})) as any)
 const host=spyOn(TestHostStateModel.collection,'findOneAndUpdate').mockImplementation((async()=>({receivedAt:now,snapshot:{hostId:'host',incarnation:'one',incarnationGeneration:1,sequence:1,observedAt:now.toISOString(),lanes:[{id:'mac',platform:'ios-on-mac',state:'idle',dispatchMode:'automatic',resources:[{id:'rec',kind:'recorder',storage:offer}]}]}})) as any)
 const find=spyOn(TestRequestModel.collection,'find').mockImplementation((()=>({limit(){return this},async toArray(){return claims}})) as any)
 const save=spyOn(TestRequestModel.collection,'findOneAndUpdate').mockImplementation((async(query:any,update:any)=>{const row={...claim(query.requestId),...update.$set};claims.push(row);return row}) as any)
 try{
  const results=await Promise.all([routineJobRepository.reserveResources!('one','a'.repeat(64),'host','mac',now),routineJobRepository.reserveResources!('two','a'.repeat(64),'host','mac',now)])
  expect(results.filter(Boolean)).toHaveLength(1);expect(claims).toHaveLength(1)
  expect(host.mock.calls[0]![1]).toEqual({$inc:{resourceReservationVersion:1}})
  expect((save.mock.calls[0] as unknown as unknown[])[2]).toMatchObject({session:'session'})
 }finally{transaction.mockRestore();first.mockRestore();host.mockRestore();find.mockRestore();save.mockRestore()}
})
