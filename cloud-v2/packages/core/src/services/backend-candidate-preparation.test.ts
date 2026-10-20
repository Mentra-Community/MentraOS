import {expect, test} from 'bun:test'
import {RoutineJobService, routineJobInputDigest, routineJobRepository, recorderCapacityRequirements, compatibleStructuralRoutineLane, routineLaneContext} from './routine-job.service'
import {candidateRequestCurrent, candidateSettlement, qualifiedCandidate, candidatePrerequisiteRequestMatches, candidateReturnMatches, candidateRenewal} from './backend-candidate-preparation'
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures'
import {requestInputDigest} from './test-request.service'
import type {RoutineJobRepository} from './routine-job.service'
import type {StoredRoutineJob, FleetCandidatePreparation} from '../types/routine-job.types'
import type {ReceivedTestHostState} from './test-host-state.service'
import {TestRequestModel} from '../models/test-request.model'
import {ResourceReservationsService, resourceReservationRepository} from './resource-reservations.service'
import {mock} from 'bun:test'

const initialNow = Date.parse('2026-10-20T12:00:00Z'), hash = (c: string) => c.repeat(64)
function fixture() {
  let now = initialNow, writes = 0, bindWrites = 0
  const definition = {id:'probe',minimumRoutineApiVersion:1,title:'A check',purpose:'Verify independently',platforms:['android'],entry:'home',account:'lane',requirements:[],fixtures:[],
    steps:[{id:'check',instruction:'Check',expected:'Checked'}],execution:{resourceKinds:['phone','app','recorder','network'],policy:{estimatedOutputBytes:1024}},
    resourceRequirements:[{kind:'phone',capabilities:['backend-connectivity']},{kind:'app',capabilities:[]},{kind:'recorder',capabilities:[]},{kind:'network',capabilities:['independent-uplink']}],
    source:{repository:'Mentra-Community/Mentra-Automated-Testing',revision:'a'.repeat(40),path:'routines/probe/routine.ts'}}
  const source = {channel:'pr' as const,prNumber:12,buildRunId:55,publicationAttempt:1}, build = {kind:'android-apk' as const,repository:'Mentra-Community/MentraOS',channel:'pr',prNumber:12,source,headSha:'b'.repeat(40),
    archive:{name:'app.apk',size:100,sha256:hash('c'),url:'https://artifactscdn.mentraglass.com/app.apk'}, receipt:{size:10,sha256:hash('d'),url:'https://artifactscdn.mentraglass.com/receipt.json'}}
  let row = {requestId:'job-one',state:'awaiting-runner',fleetSelection:{requestId:'job-one',routineId:'probe',platform:'android',source,routineRevision:'a'.repeat(40),build},
    fleetPreparation:{routineSource:testRoutineSource(),definitionSha256:requestInputDigest(definition),definition,requirements:{platform:'android',resources:definition.resourceRequirements}},
    fleetDeadline:new Date(now+300_000),createdAt:new Date(now)} as unknown as StoredRoutineJob
  row.fleetSelectionSha256=requestInputDigest(row.fleetSelection);row.fleetInputSha256=routineJobInputDigest(row)
  const hosts = ['air1','air2'].map(hostId => ({hostId,incarnation:`${hostId}-one`,incarnationGeneration:1,sequence:1,
    observedAt:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),frameworkBinding:{...testFrameworkBinding(),version:1200,routineApiVersion:69},
    resourceReservations:{claims:[],returns:[],candidatePrerequisites:[]},authorityReservations:[],lanes:[{id:'android',platform:'android',state:'idle',dispatchMode:'automatic',resources:[
      {id:`${hostId}:phone`,kind:'phone',capabilities:['backend-connectivity']},{id:`${hostId}:app`,kind:'app'},
      {id:`${hostId}:recorder`,kind:'recorder',storage:{poolId:`${hostId}:disk`,observedAt:new Date(now).toISOString(),availableBytes:64*1024**3,stagingBudgetBytes:10*1024**3,pendingEvidenceBytes:0,reservations:[]}},
      {id:`${hostId}:network`,kind:'network',capabilities:['independent-uplink']}]}],resourceLifecycle:{schemaVersion:1,history:[],subjects:[{
        subject:{kind:'resource',id:`${hostId}:phone`,authorityHostId:hostId},generation:1,current:true,status:'idle',owner:null}]}} as unknown as ReceivedTestHostState))
  const copy = <T>(v:T):T=>structuredClone(v)
  const rows = {async get(id:string){return id===row.requestId?copy(row):null},async recorderClaims(){return []},async selectedLanes(){return [{requestId:'other',hostId:'air2',laneId:'android'}]},
    async *qualificationCandidates(){yield copy(row)},
    async candidatePreparation(original:StoredRoutineJob,pending:FleetCandidatePreparation){if(row.fleetCandidatePreparation||row.fleetCandidateSelection && candidateRenewal(row,pending.hostId,pending.laneId)?.candidate.attemptId!==pending.candidate.previousAttemptId||JSON.stringify(original)!==JSON.stringify(row))return null;writes++;row={...row,fleetCandidatePreparation:copy(pending),fleetCandidateSelection:undefined};return copy(row)},
    async settleCandidatePreparation(original:StoredRoutineJob,pending:FleetCandidatePreparation){if(JSON.stringify(original)!==JSON.stringify(row))return null;row={...row,fleetCandidatePreparations:[...row.fleetCandidatePreparations??[],copy(pending)],fleetCandidatePreparation:undefined,
      ...(pending.settlement?.outcome==='qualified'?{fleetCandidateSelection:{hostId:pending.hostId,laneId:pending.laneId,targetInputSha256:pending.targetInputSha256}}:{})};return copy(row)},
    async reserveResources(_id:string,_sha:string,hostId:string,laneId:string){bindWrites++;row={...row,fleetResourceReservation:{id:'d0af6e63-513c-43d5-9392-ff2e672bab86',requestId:row.requestId,fleetInputSha256:row.fleetInputSha256!,hostId,laneId,poolId:`${hostId}:disk`,minimumAvailableBytes:1024,reservedAt:new Date(now).toISOString()}};return copy(row)},
  } as unknown as RoutineJobRepository
  const service = new RoutineJobService(rows,undefined,undefined,undefined,{async get(id){return copy(hosts.find(h=>h.hostId===id)??null)},async list(){return copy(hosts)}},undefined,undefined,()=>now)
  function settle(outcome:'qualified'|'unqualified'|'unknown', rawClosed=true, returnAck=true) {
    const p=row.fleetCandidatePreparation!,host=hosts.find(h=>h.hostId===p.hostId)!,phone=host.lanes[0]!.resources[0]!,subject=host.resourceLifecycle!.subjects[0]!,op=`backend-prerequisite:${p.targetInputSha256}`
    p.backendTarget={schemaVersion:1,coreUrl:'https://core.example/'};subject.generation=3
    p.claimReceipt={kind:'exclusive',id:'d0af6e63-513c-43d5-9392-ff2e672bab86',authorityHostId:host.hostId,borrowerHostId:host.hostId,laneId:p.laneId,resourceId:phone.id,
      operationId:op,intentSha256:hash('e'),inputSha256:p.targetInputSha256,owner:{id:'original-check-owner',kind:'boundary-cleanup'},
      controllerIncarnation:host.incarnation,controllerGeneration:1,borrowerSequence:1,reservedAt:new Date(now).toISOString(),prerequisite:{kind:'backend-connectivity',
        jobId:row.requestId,targetInputSha256:p.targetInputSha256,resourceId:phone.id,binding:p.target.acceptedBinding,candidate:p.candidate,target:p.backendTarget}}
    phone.backendConnectivity={schemaVersion:1,capability:'backend-connectivity',outcome,observedAt:new Date(now).toISOString(),phoneResourceId:phone.id,binding:host.frameworkBinding!,controller:p.candidate.controller,
      app:{headSha:build.headSha,archiveSha256:build.archive.sha256,receiptSha256:build.receipt.sha256},target:p.backendTarget,targetSource:'verified-apk-configuration',
      qualification:{jobId:row.requestId,targetInputSha256:p.targetInputSha256,inputSha256:requestInputDigest(p.target.proposedInput),candidate:p.candidate},bootId:'0c9af811-d3ad-4f91-a21e-31505b6014b2',
      tool:{path:'/trusted/python',sha256:hash('e')},check:{operationId:op,resultSha256:hash('f'),readersSha256:hash('a'),closedAt:new Date(now).toISOString()},releasedGeneration:3,appRouteVerified:false}
    if(returnAck)p.returnReceipt={claimId:'d0af6e63-513c-43d5-9392-ff2e672bab86',authorityHostId:host.hostId,resourceId:phone.id,intentSha256:hash('e'),inputSha256:p.targetInputSha256,
      originalOwner:{id:'original-check-owner',kind:'boundary-cleanup'},laneId:'android',controller:{incarnation:host.incarnation,generation:1,sequence:2},release:{kind:'resource-check',operationId:op,subjectGeneration:3,releasedAt:new Date(now).toISOString(),eventId:'released'}}
    if(rawClosed)host.resourceReservations!.candidatePrerequisites=[{targetInputSha256:p.targetInputSha256,candidate:p.candidate,outcome,hostWorkSettled:true,checkOperationId:op}]
  }
  return {service,rows,hosts,settle,get row(){return row},set row(v){row=v},get writes(){return writes},get bindWrites(){return bindWrites},advance(ms:number){now+=ms;for(const h of hosts){h.observedAt=h.receivedAt=new Date(now).toISOString();h.lanes[0]!.resources.find(r=>r.kind==='recorder')!.storage!.observedAt=new Date(now).toISOString()}},get now(){return now}}
}

test('unknown first phone is probed unbound; settled negative falls back within the same original request, positive permits resource selection',async()=>{
 const f=fixture();await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation?.hostId).toBe('air1');expect(f.bindWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined()
 const originalInput=f.row.fleetInputSha256;f.settle('unqualified');await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparations).toHaveLength(1);expect(f.row.fleetCandidatePreparation?.hostId).toBe('air2');expect(f.bindWrites).toBe(0)
 f.settle('qualified');await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetCandidateSelection?.hostId).toBe('air2');expect(f.row.fleetResourceReservation?.hostId).toBe('air2');expect(f.row.fleetInputSha256).toBe(originalInput);expect(f.row.fleetBinding).toBeUndefined()
})
for(const gap of ['raw-work','return-ack','unknown','claim','replacement','stale'] as const)test(`candidate ${gap} never moves original custody to another phone`,async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle(gap==='unknown'?'unknown':'unqualified',gap!=='raw-work',gap!=='return-ack');const old=structuredClone(f.row.fleetCandidatePreparation)
 if(gap==='claim')f.hosts[0]!.authorityReservations=[{kind:'exclusive',resourceId:'air1:phone',borrowerHostId:'air1',laneId:'android',owner:{id:'other',kind:'run'}}] as any
 if(gap==='replacement')f.hosts[0]!.incarnation='other'
 if(gap==='stale')f.advance(120001)
 await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation?.hostId).toBe('air1');expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0)
})

test('one pending candidate survives concurrent routing and a lost preparation reply without a second target',async()=>{
 const f=fixture();await Promise.all([f.service.preparation('job-one'),f.service.preparation('job-one')]);expect(f.writes).toBe(1);const first=structuredClone(f.row.fleetCandidatePreparation)
 await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation).toEqual(first);expect(f.bindWrites).toBe(0)
})
test('cancellation settles only the original returned candidate and never starts an alternate',async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('unqualified');f.row={...f.row,state:'terminal',terminalStatus:'cancelled',fleetCancellation:{requestedAt:new Date(f.now).toISOString(),reason:'cancelled'}}
 await f.service.preparation('job-one');expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined()
})
test('expired completed positive permits only a distinct same-phone renewal under the original deadline',async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('qualified');await f.service.preparation('job-one');const selected=f.row.fleetCandidateSelection
 const previous=structuredClone(f.row.fleetCandidatePreparations![0]);delete f.row.fleetResourceReservation;f.advance(120001);await f.service.preparation('job-one');expect(f.row.fleetCandidateSelection).toBeUndefined();expect(f.writes).toBe(2)
 expect(f.row.fleetCandidatePreparation?.hostId).toBe(selected!.hostId);expect(f.row.fleetCandidatePreparation?.candidate.previousAttemptId).toBe(previous.candidate.attemptId)
 expect(f.row.fleetCandidatePreparation?.targetInputSha256).not.toBe(previous.targetInputSha256);expect(f.row.fleetCandidatePreparations![0]).toEqual(previous)
 expect(f.row.fleetCandidatePreparation?.target.deadline).toBe(f.row.fleetDeadline.toISOString())
})
test('candidate metadata retains declared fixtures/source and refuses changed origin, endpoint and deadline',async()=>{
 const f=fixture();await f.service.preparation('job-one');const row=structuredClone(f.row),p=row.fleetCandidatePreparation!
 expect(candidateRequestCurrent(row,p,f.now)).toBe(true);expect(p.target.definition).toEqual(row.fleetPreparation!.definition)
 const intent={operationId:`backend-prerequisite:${p.targetInputSha256}`,hostId:p.hostId,laneId:p.laneId,controller:{...p.candidate.controller,sequence:1},
   owner:{id:'original-owner',kind:'boundary-cleanup'},inputSha256:p.targetInputSha256,resources:[{id:p.target.purpose!.resourceId,capabilities:['backend-connectivity']}],
   prerequisite:{kind:'backend-connectivity',jobId:row.requestId,resourceId:p.target.purpose!.resourceId,targetInputSha256:p.targetInputSha256,binding:p.target.acceptedBinding,candidate:p.candidate,target:{schemaVersion:1,coreUrl:'https://core.example/'}}} as any
 expect(candidatePrerequisiteRequestMatches(row,intent,f.now)).toBe(true)
 for(const mutate of [(r:StoredRoutineJob)=>r.fleetDeadline=new Date(f.now),(r:StoredRoutineJob)=>r.fleetSelectionSha256=hash('f'),(r:StoredRoutineJob)=>r.fleetCandidatePreparation!.target.definitionSha256=hash('f'),
   (r:StoredRoutineJob)=>r.fleetCandidatePreparation!.candidate.controller.incarnation='replacement']){const changed=structuredClone(row);mutate(changed);expect(candidatePrerequisiteRequestMatches(changed,intent,f.now)).toBe(false)}
 row.fleetCandidatePreparation!.backendTarget={schemaVersion:1,coreUrl:'https://other.example/'};expect(candidatePrerequisiteRequestMatches(row,intent,f.now)).toBe(false)
})
test('candidate budget and each negative host/lane are finite under the original deadline',async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('unqualified');await f.service.preparation('job-one');f.settle('unqualified');await f.service.preparation('job-one');expect(f.writes).toBe(2);expect(f.bindWrites).toBe(0)
 await f.service.preparation('job-one');expect(f.writes).toBe(2);expect(f.row.fleetCandidatePreparations).toHaveLength(2)
})
test('staged run admission and recorder reservation refuse the pending probe before any authority side effect',async()=>{
 const f=fixture();await f.service.preparation('job-one');let hostReads=0
 const service=new ResourceReservationsService({async request(){return f.row},async get(){hostReads++;throw Error('No host acquisition before pending check')}} as any,()=>f.now)
 expect(await service.reserveFleet('job-one',f.row.fleetInputSha256!,'air1','android')).toBeNull();expect(hostReads).toBe(0)
})

test('request-row candidate CAS rejects a staged run and freezes the original history before any pending write',async()=>{
 const f=fixture();await f.service.preparation('job-one');const value=f.row.fleetCandidatePreparation!,original={...f.row,fleetCandidatePreparation:undefined};delete original.fleetCandidatePreparation
 const find=TestRequestModel.collection.findOneAndUpdate;let writes=0;let filter:any
 TestRequestModel.collection.findOneAndUpdate=mock(async(f:any)=>{writes++;filter=f;return null}) as any
 try {await routineJobRepository.candidatePreparation!(original,value,new Date(f.now));expect(writes).toBe(1);expect(filter).toMatchObject({fleetResourceAdmission:{$exists:false},fleetResourceReservation:{$exists:false},fleetCandidateSelection:{$exists:false},fleetCandidatePreparation:{$exists:false},state:'awaiting-runner'})
  await routineJobRepository.candidatePreparation!({...original,fleetBinding:{} as any},value,new Date(f.now));expect(writes).toBe(1)
 }finally{TestRequestModel.collection.findOneAndUpdate=find}
})
test('same candidate settlement CAS preserves cancelled/expired cleanup and exact original history',async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('unqualified');const row=structuredClone(f.row),pending=row.fleetCandidatePreparation!,host=f.hosts[0]!,settlement=candidateSettlement(pending,host,[],f.now)!
 const find=TestRequestModel.collection.findOneAndUpdate;let update:any,filter:any
 TestRequestModel.collection.findOneAndUpdate=mock(async(f:any,u:any)=>{filter=f;update=u;return {...row,fleetCandidatePreparation:undefined,fleetCandidatePreparations:[{...pending,settlement}]}}) as any
 try{await routineJobRepository.settleCandidatePreparation!({...row,fleetCancellation:{requestedAt:new Date(f.now).toISOString(),reason:'cancelled'}},{...pending,settlement},new Date(f.now+400000))
 expect(filter.fleetCandidatePreparation).toEqual(pending);expect(filter.fleetDeadline).toBeUndefined();expect(update.$set.fleetCandidatePreparations).toEqual([{...pending,settlement}]);expect(update.$set.fleetCandidateSelection).toBeUndefined()
 }finally{TestRequestModel.collection.findOneAndUpdate=find}
})

for (const field of ['claimId','intentSha256','originalOwner','resourceId','controller','operationId'] as const) test(`candidate return refuses substituted ${field} despite an unowned phone`, async () => {
 const f=fixture();await f.service.preparation('job-one');f.settle('qualified');const pending=f.row.fleetCandidatePreparation!,r=structuredClone(pending.returnReceipt) as any;
 if(field==='claimId')r.claimId='fe8b194f-5f52-4f24-8731-a5b5eaf14e83';
 if(field==='intentSha256')r.intentSha256=hash('a');if(field==='originalOwner')r.originalOwner.id='foreign';if(field==='resourceId')r.resourceId='foreign';
 if(field==='controller')r.controller.incarnation='replacement';if(field==='operationId')r.release.operationId='foreign';
 expect(candidateReturnMatches(pending,r)).toBe(false);pending.returnReceipt=r;expect(candidateSettlement(pending,f.hosts[0]!,[],f.now)).toBeUndefined();
 await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation).toBeDefined();expect(f.bindWrites).toBe(0)
})
test('claim and return checkpoint use the exact original pending CAS and tolerate only an identical lost ACK',async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('qualified');const pending=structuredClone(f.row.fleetCandidatePreparation!),claim=pending.claimReceipt as any;
 const find=TestRequestModel.collection.findOneAndUpdate;let writes=0,filter:any;
 TestRequestModel.collection.findOneAndUpdate=mock(async(value:any)=>{writes++;filter=value;return {}}) as any;
 try {const before={...pending,claimReceipt:undefined};expect(await resourceReservationRepository.recordCandidateClaim!('job-one',before,claim)).toBe(true);expect(filter.fleetCandidatePreparation).toEqual(before);
  expect(await resourceReservationRepository.recordCandidateClaim!('job-one',pending,claim)).toBe(true);expect(writes).toBe(1);
  expect(await resourceReservationRepository.recordCandidateClaim!('job-one',pending,{...claim,id:'fe8b194f-5f52-4f24-8731-a5b5eaf14e83'})).toBe(false);
  const beforeReturn={...pending,returnReceipt:undefined};expect(await resourceReservationRepository.recordCandidateReturn!('job-one',beforeReturn,pending.returnReceipt)).toBe(true);expect(filter.fleetCandidatePreparation).toEqual(beforeReturn);
  expect(await resourceReservationRepository.recordCandidateReturn!('job-one',pending,pending.returnReceipt)).toBe(true);expect(writes).toBe(2)
 }finally{TestRequestModel.collection.findOneAndUpdate=find}
})
test('positive renewal CAS loses to staged admission and forbids negative or foreign predecessor identity',async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('qualified');await f.service.preparation('job-one');delete f.row.fleetResourceReservation;
 const old=structuredClone(f.row);f.advance(120001);await f.service.preparation('job-one');const value=structuredClone(f.row.fleetCandidatePreparation!);
 const find=TestRequestModel.collection.findOneAndUpdate;let writes=0,filter:any,update:any;
 TestRequestModel.collection.findOneAndUpdate=mock(async(a:any,b:any)=>{writes++;filter=a;update=b;return null}) as any;
 try {await routineJobRepository.candidatePreparation!(old,value,new Date(f.now));expect(writes).toBe(1);expect(filter.fleetCandidateSelection).toEqual(old.fleetCandidateSelection);expect(update.$unset.fleetCandidateSelection).toBe('');
  expect(filter.fleetResourceAdmission).toEqual({$exists:false});expect(filter.fleetResourceReservation).toEqual({$exists:false});
  await routineJobRepository.candidatePreparation!({...old,fleetResourceAdmission:{} as any},value,new Date(f.now));expect(writes).toBe(1);
  const changed=structuredClone(value);changed.candidate.previousAttemptId='foreign';await routineJobRepository.candidatePreparation!(old,changed,new Date(f.now));expect(writes).toBe(1);
  const negative=structuredClone(old);negative.fleetCandidatePreparations![0]!.settlement!.outcome='unqualified';await routineJobRepository.candidatePreparation!(negative,value,new Date(f.now));expect(writes).toBe(1)
 }finally{TestRequestModel.collection.findOneAndUpdate=find}
})
test('cancellation winning after a positive read permits only cleanup settlement, never positive selection',async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('qualified');const row=structuredClone(f.row),pending=row.fleetCandidatePreparation!,settlement=candidateSettlement(pending,f.hosts[0]!,[],f.now)!;
 const find=TestRequestModel.collection.findOneAndUpdate,calls:Array<{filter:any,update:any}>=[];
 TestRequestModel.collection.findOneAndUpdate=mock(async(filter:any,update:any)=>{calls.push({filter,update});return calls.length===1?null:{...row,state:'terminal',fleetCancellation:{reason:'cancelled'}}}) as any;
 try {await routineJobRepository.settleCandidatePreparation!(row,{...pending,settlement},new Date(f.now));expect(calls).toHaveLength(2);
  expect(calls[0]!.filter).toMatchObject({state:'awaiting-runner',fleetCancellation:{$exists:false},fleetDeadline:{$gt:new Date(f.now)}});
  expect(calls[1]!.filter.$or).toContainEqual({fleetCancellation:{$exists:true}});expect(calls[1]!.update.$set.fleetCandidateSelection).toBeUndefined();
  expect(calls[1]!.update.$set.fleetCandidatePreparations).toEqual([{...pending,settlement}])
 }finally{TestRequestModel.collection.findOneAndUpdate=find}
})
