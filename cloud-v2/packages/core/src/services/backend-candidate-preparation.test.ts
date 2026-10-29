import {backendCandidateFixture, routingGraphFixture, legacyCandidate} from './backend-candidate-preparation.test-support'
import {expect, test, spyOn} from 'bun:test'
import {RoutineJobService, routineJobInputDigest, routineJobRepository, recorderCapacityRequirements, compatibleStructuralRoutineLane, routineLaneContext, routineLaneDescriptorRevision} from './routine-job.service'
import {candidateRequestCurrent, candidateSettlement, qualifiedCandidate, qualifiedGraphCandidate, candidatePrerequisiteRequestMatches, candidateReturnMatches, candidateRenewal, completedCandidatePreparationForHost, graphCheckOperationId, graphFinalCheckOperationId} from './backend-candidate-preparation'
import {resourceLaneBlocker} from './resource-readiness'
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures'
import {requestInputDigest, TestRequestService, type TestRequestRepository} from './test-request.service'
import type {RoutineJobRepository} from './routine-job.service'
import type {StoredRoutineJob, FleetCandidatePreparation} from '../types/routine-job.types'
import {hostStateSchema, type ReceivedTestHostState, type TestHostState} from './test-host-state.service'
import {TestRequestModel} from '../models/test-request.model'
import {type ResourceReservationHost, ResourceReservationsService, resourceReservationRepository, routineResourcesAvailable} from './resource-reservations.service'
import {mock} from 'bun:test'
import {createTestRequestsApi} from '../api/internal/test-requests.api'
import {TestHostStateModel} from '../models/test-host-state.model'
import {hostResourceReservationsSchema,isExclusiveHostReservation} from '../types/resource-reservations.types'
import type {RecorderHostReservation} from '../types/recorder-storage.types'
import {isDeepStrictEqual} from 'node:util'
import {resourceIntentDependencies, type ResourceReservationRepository} from './resource-reservations.service'

const initialNow = Date.parse('2026-10-20T12:00:00Z'), hash = (c: string) => c.repeat(64)

const fixture = backendCandidateFixture

async function advancedReturnedGraph(platform: 'android'|'ios-on-mac', outcome: 'qualified'|'unqualified' = 'qualified') {
 const f=routingGraphFixture(platform);await f.prepareLegacy('job-one');f.settleGraph(outcome);
 const pending=structuredClone(f.row.fleetCandidatePreparation!),host=f.hosts[0]!;
 host.incarnationGeneration!++;host.frameworkBinding={...host.frameworkBinding!,version:host.frameworkBinding!.version+1};
 for(const subject of host.resourceLifecycle!.subjects){subject.generation++;subject.idle.acceptedCheck={
   operationId:'later-authorized-check',subjectGeneration:subject.generation,resultSha256:hash('b'),acceptedAt:host.observedAt};}
 return {f,pending,host,receipt:host.resourceReservations!.candidatePrerequisites![0]!};
}
for(const platform of ['android','ios-on-mac'] as const)for(const outcome of ['qualified','unqualified'] as const)
test(`${platform} complete original ${outcome} graph settles after later controller and physical checks without granting execution`,async()=>{
 const {f,pending,host,receipt}=await advancedReturnedGraph(platform,outcome),original=structuredClone(pending);
 const foreign={id:'d0af6e63-513c-43d5-9392-ff2e672bab86',requestId:'foreign-caption',fleetInputSha256:hash('b'),
   hostId:host.hostId,laneId:pending.laneId,poolId:`${host.hostId}:disk`,minimumAvailableBytes:1024,reservedAt:host.observedAt};
 host.authorityReservations=[foreign];
 expect(candidateSettlement(pending,host,host.authorityReservations,f.now)).toEqual(receipt);
 expect(pending).toEqual(original);expect(f.row.fleetCandidatePreparation).toEqual(original);
 const selected={...f.row,fleetCandidatePreparation:undefined,fleetCandidatePreparations:[{...pending,settlement:receipt}],
   fleetCandidateSelection:{hostId:host.hostId,laneId:pending.laneId,targetInputSha256:pending.targetInputSha256}};
 expect(qualifiedGraphCandidate(selected,host,pending.laneId,f.now,host.receivedAt,false)).toBeUndefined();
 expect(resourceLaneBlocker(host,pending.laneId,{requestId:f.row.requestId,inputSha256:f.row.fleetInputSha256!,hostId:host.hostId})?.code).toBe('lane-resource-owned');
 expect(host.authorityReservations).toEqual([foreign]);expect(f.row.fleetBinding).toBeUndefined();expect(f.bindWrites).toBe(0);
});
for(const change of ['missing-return','duplicate-return','foreign-return','wrong-check-operation','future-return','check-before-original',
 'check-after-return','wrong-generation','wrong-contract','wrong-outcome','wrong-input','own-byte-claim','own-local-claim','active-original'] as const)
test(`complete original graph closure retains ${change} refusal after current state advances`,async()=>{
 const {f,pending,host,receipt}=await advancedReturnedGraph('ios-on-mac'),returned=pending.resourceReturns![0] as any,check=receipt.graphChecks![0]!;
 if(change==='missing-return')pending.resourceReturns!.pop();
 if(change==='duplicate-return')pending.resourceReturns![1]=structuredClone(returned);
 if(change==='foreign-return')returned.originalOwner.id='foreign';
 if(change==='wrong-check-operation')check.checkOperationId=check.checkOperationId===graphCheckOperationId(pending.targetInputSha256,check.resourceId)
   ?graphFinalCheckOperationId(pending.targetInputSha256,check.resourceId):graphCheckOperationId(pending.targetInputSha256,check.resourceId);
 if(change==='future-return')returned.release.releasedAt=new Date(f.now+1).toISOString();
 if(change==='check-before-original')check.checkedAt=new Date(Date.parse(pending.candidate.requestedAt)-1).toISOString();
 if(change==='check-after-return')check.checkedAt=new Date(Date.parse(returned.release.releasedAt)+1).toISOString();
 if(change==='wrong-generation')check.subjectGeneration++;
 if(change==='wrong-contract')check.contractVersion='foreign-contract';
 if(change==='wrong-outcome')receipt.outcome='unqualified';
 if(change==='wrong-input')pending.target.inputSha256=hash('b');
 const own={id:'d0af6e63-513c-43d5-9392-ff2e672bab86',requestId:f.row.requestId,fleetInputSha256:f.row.fleetInputSha256!,
   hostId:host.hostId,laneId:pending.laneId,poolId:`${host.hostId}:disk`,minimumAvailableBytes:1024,reservedAt:host.observedAt};
 if(change==='own-byte-claim')host.authorityReservations=[own];
 if(change==='own-local-claim')host.resourceReservations!.claims=[structuredClone(pending.resourceClaims![0]) as any];
 if(change==='active-original')host.lanes[0]!.activity={kind:'qualification',owner:{id:f.row.requestId,kind:'run'}} as any;
 expect(candidateSettlement(pending,host,host.authorityReservations??[],f.now)).toBeUndefined();
 expect(f.row.fleetBinding).toBeUndefined();expect(f.bindWrites).toBe(0);
});
for(const change of ['missing-health','foreign-source','foreign-backend','foreign-result-operation','nonfinal-operation','closed-after-deadline'] as const)
test(`complete original positive graph retains required backend ${change} refusal`,async()=>{
 const {f,pending,host,receipt}=await advancedReturnedGraph('android'),check=receipt.graphChecks!.find(check=>check.backendConnectivity)!;
 if(change==='missing-health')delete check.backendConnectivity;
 if(change==='foreign-source')check.backendConnectivity!.binding={...check.backendConnectivity!.binding,version:9999};
 if(change==='foreign-backend')check.backendConnectivity!.target={...check.backendConnectivity!.target,coreUrl:'https://foreign.example/'};
 if(change==='foreign-result-operation')check.backendConnectivity!.check.operationId='foreign-operation';
 if(change==='nonfinal-operation'){
   const operationId=graphCheckOperationId(pending.targetInputSha256,check.resourceId);
   check.checkOperationId=check.backendConnectivity!.check.operationId=operationId;
   (pending.resourceReturns!.find((returned:any)=>returned.resourceId===check.resourceId) as any).release.operationId=operationId;
 }
 if(change==='closed-after-deadline'){
   const closedAt=new Date(Date.parse(pending.target.deadline)+1).toISOString();
   check.backendConnectivity!.check.closedAt=closedAt;
   (pending.resourceReturns!.find((returned:any)=>returned.resourceId===check.resourceId) as any).release.releasedAt=closedAt;
   f.advance(300002);
 }
 expect(candidateSettlement(pending,host,host.authorityReservations??[],f.now)).toBeUndefined();
 expect(f.row.fleetBinding).toBeUndefined();expect(f.bindWrites).toBe(0);
});

test('an existing negative phone original settles and reserves a separately current-checked alternative',async()=>{
 const f=fixture();await f.prepareLegacy('job-one');expect(f.row.fleetCandidatePreparation?.hostId).toBe('air1');expect(f.bindWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined()
 const originalInput=f.row.fleetInputSha256;f.settle('unqualified');f.passCurrentBaseline('air2');f.rows.selectedLanes=async()=>[];
 await f.prepareLegacy('job-one');expect(f.row.fleetCandidatePreparations).toHaveLength(1);
 expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetResourceReservation?.hostId).toBe('air2');expect(f.bindWrites).toBe(1);
 expect(f.row.fleetInputSha256).toBe(originalInput);expect(f.row.fleetBinding).toBeUndefined()

})
for(const gap of ['raw-work','return-ack','claim','replacement'] as const)test(`candidate ${gap} never moves original custody to another phone`,async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle('unqualified',gap!=='raw-work',gap!=='return-ack');const old=structuredClone(f.row.fleetCandidatePreparation)
 if(gap==='claim')f.hosts[0]!.authorityReservations=[{...structuredClone(f.row.fleetCandidatePreparation!.claimReceipt!),prerequisite:undefined,resourceCheck:undefined,owner:{id:'other',kind:'run'}}] as any
 if(gap==='replacement')f.hosts[0]!.incarnation='other'
 await f.prepareLegacy('job-one');expect(f.row.fleetCandidatePreparation?.hostId).toBe('air1');expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0)
})

test('a delayed fully returned negative settles historically and selects a fresh alternate under the same original deadline',async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle('unqualified');
 const original=structuredClone(f.row),negative=structuredClone(f.row.fleetCandidatePreparation!),health=structuredClone(f.hosts[0]!.lanes[0]!.resources[0]!.backendConnectivity);
 f.advance(120001);f.passCurrentBaseline('air2');f.rows.selectedLanes=async()=>[];await f.prepareLegacy('job-one');
 expect(f.row.fleetCandidatePreparations).toEqual([{...negative,settlement:{targetInputSha256:negative.targetInputSha256,candidate:negative.candidate,outcome:'unqualified',hostWorkSettled:true,checkOperationId:`backend-prerequisite:${negative.targetInputSha256}`}}]);
 expect(f.hosts[0]!.lanes[0]!.resources[0]!.backendConnectivity).toEqual(health);
 expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetResourceReservation?.hostId).toBe('air2');
 expect(f.row.fleetBinding).toBeUndefined();expect(f.bindWrites).toBe(1);
 for(const field of ['requestId','fleetSelection','fleetSelectionSha256','fleetPreparation','fleetInputSha256','fleetDeadline','createdAt'] as const)expect(f.row[field]).toEqual(original[field]);
 expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetCandidatePreparations![0]).toEqual({...negative,settlement:{targetInputSha256:negative.targetInputSha256,candidate:negative.candidate,outcome:'unqualified',hostWorkSettled:true,checkOperationId:`backend-prerequisite:${negative.targetInputSha256}`}});
})
for(const gap of ['raw-work','return-ack','claim','replacement','subject-generation','binding','app','future-observation','observation-after-deadline','close-before-observation','return-before-close','stale-report'] as const)test(`delayed negative retains original custody with ${gap}`,async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle('unqualified',gap!=='raw-work',gap!=='return-ack');
 f.advance(120001);const host=f.hosts[0]!,health=host.lanes[0]!.resources[0]!.backendConnectivity!;
 if(gap==='claim')host.authorityReservations=[{...structuredClone(f.row.fleetCandidatePreparation!.claimReceipt!),prerequisite:undefined,resourceCheck:undefined,owner:{id:'other',kind:'run'}}] as any;
 if(gap==='replacement')host.incarnation='other';if(gap==='subject-generation')host.resourceLifecycle!.subjects[0]!.generation++;
 if(gap==='binding')health.binding={...health.binding,version:health.binding.version+1};if(gap==='app')health.app.archiveSha256=hash('a');
 if(gap==='future-observation')health.observedAt=new Date(f.now+1).toISOString();
 if(gap==='observation-after-deadline'){f.advance(180001);health.observedAt=health.check.closedAt=new Date(f.now).toISOString();(f.row.fleetCandidatePreparation!.returnReceipt as any).release.releasedAt=health.check.closedAt;}
 if(gap==='close-before-observation')health.check.closedAt=new Date(Date.parse(health.observedAt)-1).toISOString();
 if(gap==='return-before-close')health.check.closedAt=new Date(Date.parse(health.check.closedAt)+1).toISOString();
 if(gap==='stale-report')host.observedAt=host.receivedAt=new Date(f.now-120001).toISOString();
 const pending=structuredClone(f.row.fleetCandidatePreparation!);await f.prepareLegacy('job-one');expect(f.row.fleetCandidatePreparation).toEqual(pending);expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetCandidatePreparations).toBeUndefined();expect(f.row.fleetBinding).toBeUndefined();
})
test('delayed negative cancellation settles original history without selecting another candidate',async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle('unqualified');f.advance(120001);
 f.row={...f.row,state:'terminal',terminalStatus:'cancelled',fleetCancellation:{requestedAt:new Date(f.now).toISOString(),reason:'cancelled'}};
 await f.prepareLegacy('job-one');expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetCandidateSelection).toBeUndefined();
 expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetCandidatePreparations?.[0]?.settlement?.outcome).toBe('unqualified');
})
test('delayed negative after the original deadline records only settled history',async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle('unqualified');const deadline=structuredClone(f.row.fleetDeadline);f.advance(300001);
 await f.prepareLegacy('job-one');expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetCandidateSelection).toBeUndefined();
 expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetCandidatePreparations?.[0]?.settlement?.outcome).toBe('unqualified');expect(f.row.fleetDeadline).toEqual(deadline);
})

test('an in-window negative may deliver authentic raw closure and return after expiry without renewing the request',async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle('unqualified');const deadline=structuredClone(f.row.fleetDeadline),health=f.hosts[0]!.lanes[0]!.resources[0]!.backendConnectivity!;
 f.advance(300001);health.check.closedAt=new Date(f.now).toISOString();(f.row.fleetCandidatePreparation!.returnReceipt as any).release.releasedAt=health.check.closedAt;
 const original=structuredClone(f.row.fleetCandidatePreparation!);await f.prepareLegacy('job-one');
 expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetCandidatePreparations?.[0]).toEqual({...original,settlement:{targetInputSha256:original.targetInputSha256,candidate:original.candidate,outcome:'unqualified',hostWorkSettled:true,checkOperationId:`backend-prerequisite:${original.targetInputSha256}`}});
 expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetDeadline).toEqual(deadline);expect(f.row.fleetCandidateSelection).toBeUndefined();expect(f.row.fleetBinding).toBeUndefined();
})

test('completed candidate metadata survives a lost read reply and alternate binding without reader or execution authority',async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle('unqualified');f.advance(120001);await f.prepareLegacy('job-one');
 const original=structuredClone(f.row),closed=structuredClone(f.row.fleetCandidatePreparations![0]!);
 const unexpected=async():Promise<never>=>{throw Error('Unexpected metadata mutation')};let reads=0;
 const requests=new TestRequestService({get:async()=>{reads++;return structuredClone(f.row) as unknown as import('./test-request.service').StoredRequest},insert:unexpected,accept:unexpected,reject:unexpected,cancel:unexpected,acknowledgeCancellation:unexpected,queued:unexpected,cancellations:unexpected});
 const token='synthetic-candidate-old-host-'+'x'.repeat(32),otherToken='synthetic-candidate-foreign-host-'+'y'.repeat(32),headers={authorization:`Bearer ${token}`},otherHeaders={authorization:`Bearer ${otherToken}`};
 const api=createTestRequestsApi(requests,()=>JSON.stringify({air1:token,foreign:otherToken}));
 expect((await api.request('/job-one/preparation')).status).toBe(401);expect(reads).toBe(0);
 const first=await api.request('/job-one/preparation',{headers});expect(first.status).toBe(200);await first.arrayBuffer();
 const again=await api.request('/job-one/preparation',{headers});expect(again.status).toBe(200);expect((await again.json() as any).request.fleetCandidatePreparations[0]).toEqual(JSON.parse(JSON.stringify(closed)));
 expect((await api.request('/job-one/preparation',{headers:otherHeaders})).status).toBe(404);
 f.row={...f.row,state:'preparing',hostId:'air2',fleetBinding:{hostId:'air2'} as any};
 expect((await api.request('/job-one/preparation',{headers})).status).toBe(200);
 expect((await api.request('/job-one/routine-source/inventory',{headers})).status).toBe(404);
 expect((await api.request('/job-one/prepared',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'})).status).not.toBe(200);
 f.row={...f.row,state:'terminal',terminalStatus:'cancelled'};expect((await api.request('/job-one/preparation',{headers})).status).toBe(200);
 expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations);expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);
})
for(const changed of ['job','deadline','selection','input','history-budget','duplicate-attempt','host','target','definition','settlement','return-ack','matching-pending'] as const)test(`historical candidate metadata refuses ${changed}`,async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle('unqualified');f.advance(120001);await f.prepareLegacy('job-one');
 const row=structuredClone(f.row),entry=row.fleetCandidatePreparations![0]!;
 if(changed==='job')row.requestId='other';if(changed==='deadline')row.fleetDeadline=new Date(row.fleetDeadline.getTime()+1);
 if(changed==='selection')row.fleetSelectionSha256=hash('f');if(changed==='input')row.fleetInputSha256=hash('f');
 if(changed==='history-budget')row.fleetCandidatePreparations=Array.from({length:21},()=>structuredClone(entry));
 if(changed==='duplicate-attempt')row.fleetCandidatePreparations=[entry,structuredClone(entry)];
 if(changed==='host')entry.hostId='foreign';if(changed==='target')entry.targetInputSha256=hash('f');
 if(changed==='definition')entry.target.definitionSha256=hash('f');if(changed==='settlement')entry.settlement!.candidate.attemptId='other';
 if(changed==='return-ack')delete entry.returnReceipt;if(changed==='matching-pending')row.fleetCandidatePreparation=structuredClone(entry);
 expect(completedCandidatePreparationForHost(row,'air1')).toBe(false);expect(f.bindWrites).toBe(0);
})

test('one pending candidate survives concurrent routing and a lost preparation reply without a second target',async()=>{
 const f=fixture();await Promise.all([f.prepareLegacy('job-one'),f.prepareLegacy('job-one')]);expect(f.writes).toBe(1);const first=structuredClone(f.row.fleetCandidatePreparation)
 await f.prepareLegacy('job-one');expect(f.row.fleetCandidatePreparation).toEqual(first);expect(f.bindWrites).toBe(0)
})
test('cancellation settles only the original returned candidate and never starts an alternate',async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle('unqualified');f.row={...f.row,state:'terminal',terminalStatus:'cancelled',fleetCancellation:{requestedAt:new Date(f.now).toISOString(),reason:'cancelled'}}
 await f.prepareLegacy('job-one');expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined()
})
test('candidate metadata retains declared fixtures/source and refuses changed origin, endpoint and deadline',async()=>{
 const f=fixture();await f.prepareLegacy('job-one');const row=structuredClone(f.row),p=row.fleetCandidatePreparation!
 expect(candidateRequestCurrent(row,p,f.now)).toBe(true);expect(p.target.definition).toEqual(row.fleetPreparation!.definition)
 const intent={operationId:`backend-prerequisite:${p.targetInputSha256}`,hostId:p.hostId,laneId:p.laneId,controller:{...p.candidate.controller,sequence:1},
   owner:{id:'original-owner',kind:'boundary-cleanup'},inputSha256:p.targetInputSha256,resources:[{id:p.target.purpose!.resourceId,capabilities:['backend-connectivity']}],
   prerequisite:{kind:'backend-connectivity',jobId:row.requestId,resourceId:p.target.purpose!.resourceId,targetInputSha256:p.targetInputSha256,binding:p.target.acceptedBinding,candidate:p.candidate,target:{schemaVersion:1,coreUrl:'https://core.example/'}}} as any
 expect(candidatePrerequisiteRequestMatches(row,intent,f.now)).toBe(true)
 for(const mutate of [(r:StoredRoutineJob)=>r.fleetDeadline=new Date(f.now),(r:StoredRoutineJob)=>r.fleetSelectionSha256=hash('f'),(r:StoredRoutineJob)=>r.fleetCandidatePreparation!.target.definitionSha256=hash('f'),
   (r:StoredRoutineJob)=>r.fleetCandidatePreparation!.candidate.controller.incarnation='replacement']){const changed=structuredClone(row);mutate(changed);expect(candidatePrerequisiteRequestMatches(changed,intent,f.now)).toBe(false)}
 row.fleetCandidatePreparation!.backendTarget={schemaVersion:1,coreUrl:'https://other.example/'};expect(candidatePrerequisiteRequestMatches(row,intent,f.now)).toBe(false)
})
test('staged run admission and recorder reservation refuse the pending probe before any authority side effect',async()=>{
 const f=fixture();await f.prepareLegacy('job-one');let hostReads=0
 const service=new ResourceReservationsService({async request(){return f.row},async get(){hostReads++;throw Error('No host acquisition before pending check')}} as any,()=>f.now)
 expect(await service.reserveFleet('job-one',f.row.fleetInputSha256!,'air1','android')).toBeNull();expect(hostReads).toBe(0)
})

test('request-row candidate CAS rejects a staged run and freezes the original history before any pending write',async()=>{
 const f=fixture();await f.prepareLegacy('job-one');const value=f.row.fleetCandidatePreparation!,original={...f.row,fleetCandidatePreparation:undefined};delete original.fleetCandidatePreparation
 const find=TestRequestModel.collection.findOneAndUpdate;let writes=0;let filter:any
 TestRequestModel.collection.findOneAndUpdate=mock(async(f:any)=>{writes++;filter=f;return null}) as any
 try {await routineJobRepository.candidatePreparation!(original,value,new Date(f.now));expect(writes).toBe(1);expect(filter).toMatchObject({fleetResourceAdmission:{$exists:false},fleetResourceReservation:{$exists:false},fleetCandidateSelection:{$exists:false},fleetCandidatePreparation:{$exists:false},state:'awaiting-runner'})
  await routineJobRepository.candidatePreparation!({...original,fleetBinding:{} as any},value,new Date(f.now));expect(writes).toBe(1)
 }finally{TestRequestModel.collection.findOneAndUpdate=find}
})
test('same candidate settlement CAS preserves cancelled/expired cleanup and exact original history',async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle('unqualified');const row=structuredClone(f.row),pending=row.fleetCandidatePreparation!,host=f.hosts[0]!,settlement=candidateSettlement(pending,host,[],f.now)!
 const find=TestRequestModel.collection.findOneAndUpdate;let update:any,filter:any
 TestRequestModel.collection.findOneAndUpdate=mock(async(f:any,u:any)=>{filter=f;update=u;return {...row,fleetCandidatePreparation:undefined,fleetCandidatePreparations:[{...pending,settlement}]}}) as any
 try{await routineJobRepository.settleCandidatePreparation!({...row,fleetCancellation:{requestedAt:new Date(f.now).toISOString(),reason:'cancelled'}},{...pending,settlement},new Date(f.now+400000))
 expect(filter.fleetCandidatePreparation).toEqual(pending);expect(filter.fleetDeadline).toBeUndefined();expect(update.$set.fleetCandidatePreparations).toEqual([{...pending,settlement}]);expect(update.$set.fleetCandidateSelection).toBeUndefined()
 }finally{TestRequestModel.collection.findOneAndUpdate=find}
})

for (const field of ['claimId','intentSha256','originalOwner','resourceId','controller','operationId'] as const) test(`candidate return refuses substituted ${field} despite an unowned phone`, async () => {
 const f=fixture();await f.prepareLegacy('job-one');f.settle('qualified');const pending=f.row.fleetCandidatePreparation!,r=structuredClone(pending.returnReceipt) as any;
 if(field==='claimId')r.claimId='fe8b194f-5f52-4f24-8731-a5b5eaf14e83';
 if(field==='intentSha256')r.intentSha256=hash('a');if(field==='originalOwner')r.originalOwner.id='foreign';if(field==='resourceId')r.resourceId='foreign';
 if(field==='controller')r.controller.incarnation='replacement';if(field==='operationId')r.release.operationId='foreign';
 expect(candidateReturnMatches(pending,r)).toBe(false);pending.returnReceipt=r;expect(candidateSettlement(pending,f.hosts[0]!,[],f.now)).toBeUndefined();
 await f.prepareLegacy('job-one');expect(f.row.fleetCandidatePreparation).toBeDefined();expect(f.bindWrites).toBe(0)
})
test('claim and return checkpoint use the exact original pending CAS and tolerate only an identical lost ACK',async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle('qualified');const pending=structuredClone(f.row.fleetCandidatePreparation!),claim=pending.claimReceipt as any;
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
 const f=fixture();await f.prepareLegacy('job-one');f.settle('qualified');await f.prepareLegacy('job-one');delete f.row.fleetResourceReservation;
 const old=structuredClone(f.row);f.advance(120001);const value=legacyCandidate(old,f.hosts[0]!,f.now);
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
 const f=fixture();await f.prepareLegacy('job-one');f.settle('qualified');const row=structuredClone(f.row),pending=row.fleetCandidatePreparation!,settlement=candidateSettlement(pending,f.hosts[0]!,[],f.now)!;
 const find=TestRequestModel.collection.findOneAndUpdate,calls:Array<{filter:any,update:any}>=[];
 TestRequestModel.collection.findOneAndUpdate=mock(async(filter:any,update:any)=>{calls.push({filter,update});return calls.length===1?null:{...row,state:'terminal',fleetCancellation:{reason:'cancelled'}}}) as any;
 try {await routineJobRepository.settleCandidatePreparation!(row,{...pending,settlement},new Date(f.now));expect(calls).toHaveLength(2);
  expect(calls[0]!.filter).toMatchObject({state:'awaiting-runner',fleetCancellation:{$exists:false},fleetDeadline:{$gt:new Date(f.now)}});
  expect(calls[1]!.filter.$or).toContainEqual({fleetCancellation:{$exists:true}});expect(calls[1]!.update.$set.fleetCandidateSelection).toBeUndefined();
  expect(calls[1]!.update.$set.fleetCandidatePreparations).toEqual([{...pending,settlement}])
 }finally{TestRequestModel.collection.findOneAndUpdate=find}
})

/** Production repositories keep authenticated receive time outside the worker snapshot. */
function repositoryEnvelope(f: ReturnType<typeof fixture>): ResourceReservationHost {
 const h=structuredClone(f.hosts[0]!),{receivedAt,authorityReservations,...snapshot}=h,subject=snapshot.resourceLifecycle!.subjects[0]!;
 snapshot.frameworkAcceptedAt=h.observedAt;snapshot.frameworkProcess={pid:123,startedAt:h.observedAt};
 snapshot.lanes[0]!.resources[0]!.idleContract={version:'phone-baseline',maximumAgeMs:120000,conditions:['synthetic-network'],repairConfigured:true,qualifiedScope:{kind:'same-controller',controllerId:h.hostId}};
 snapshot.resourceLifecycle!.subjects=[{...subject,status:'idle',observedAt:h.observedAt,receivedAt:null,reason:null,
   idle:{contractVersion:'phone-baseline',outcome:'passed',checkedAt:h.observedAt,acceptedCheck:{operationId:'baseline',subjectGeneration:subject.generation,resultSha256:hash('a'),acceptedAt:h.observedAt},qualifiedScope:{kind:'same-controller',controllerId:h.hostId},evidenceRefs:[]},
   repair:{configured:false,state:'none'},supportedActions:[],resource:{kind:'phone',capabilities:['backend-connectivity'],memberships:[{hostId:h.hostId,laneId:'android'}],dependencies:[],placement:'installed'}},...snapshot.resourceLifecycle!.subjects.filter(value=>value.subject.id!==subject.subject.id)];
 return {hostId:h.hostId,incarnation:h.incarnation!,incarnationGeneration:h.incarnationGeneration!,sequence:h.sequence!,receivedAt:new Date(receivedAt),snapshot:hostStateSchema.parse(snapshot),resourceReservations:[structuredClone(f.row.fleetResourceReservation!)]};
}
async function returnedFixture(exclusive = false) {
 const f=fixture(exclusive);await f.prepareLegacy('job-one');f.settle('qualified');f.passCurrentBaseline('air1');await f.prepareLegacy('job-one');
 f.row.fleetResourceReservation!.minimumAvailableBytes=recorderCapacityRequirements(f.row.fleetPreparation!).resources.find(r=>r.kind==='recorder')!.storage!.minimumAvailableBytes;
 return f;
}
for(const phase of ['recorder-read','request-read','host-cas'] as const)for(const elapsed of [1,2])test(`ordinary backend binding ${phase} ignores historical backend age ${119999+elapsed} with a current physical baseline`,async()=>{
 const f=await returnedFixture();f.advance(119999);
 const host=repositoryEnvelope(f),claim=structuredClone(f.row.fleetResourceReservation!),bindingNow=f.now;
 const admission=new ResourceReservationsService({async request(){return structuredClone(f.row)},async get(){return structuredClone(host)},async recorderClaims(){return [claim]},
  async stageBackend(_id,_digest,value){f.row.fleetResourceAdmission=structuredClone(value);return structuredClone(f.row)},async claimedHosts(){return []},async replace(){throw Error('Unexpected dependency claim')}},()=>f.now);
 expect(await admission.reserveFleet(f.row.requestId,f.row.fleetInputSha256!,'air1','android')).toBeUndefined();
 const original=structuredClone(f.row),find=TestRequestModel.collection.findOne,write=TestRequestModel.collection.findOneAndUpdate,
  read=resourceReservationRepository.get,claims=resourceReservationRepository.recorderClaims,replace=resourceReservationRepository.replace,
  clock=spyOn(Date,'now').mockImplementation(()=>f.now);
 let requestReads=0,recorderReads=0,hostCas=0,bindingWrites=0;
 TestRequestModel.collection.findOne=mock(async()=>{if(++requestReads===2&&phase==='request-read')f.advance(elapsed);return structuredClone(f.row)}) as never;
 resourceReservationRepository.get=async()=>structuredClone(host);
 resourceReservationRepository.recorderClaims=async()=>{if(++recorderReads===1&&phase==='recorder-read')f.advance(elapsed);return [structuredClone(claim)]};
 resourceReservationRepository.replace=async(_host,next)=>{hostCas++;expect(next).toEqual([claim]);host.resourceReservationVersion=(host.resourceReservationVersion??0)+1;if(phase==='host-cas')f.advance(elapsed);return true};
 TestRequestModel.collection.findOneAndUpdate=mock(async(filter:any,update:any)=>{
  bindingWrites++;expect(filter.fleetResourceReservation).toEqual(claim);expect(filter.fleetResourceAdmission).toEqual(original.fleetResourceAdmission);
  expect(filter.fleetCandidatePreparations).toBeUndefined();expect(filter.fleetDeadline).toEqual({$gt:new Date(f.now)});
  f.row={...f.row,...structuredClone(update.$set)};return structuredClone(f.row);
 }) as never;
 try{
  const bound=await routineJobRepository.bind(original.requestId,original.fleetInputSha256!,{jobId:original.requestId,requestId:original.requestId,
   hostId:'air1',laneId:'android',descriptorRevision:routineLaneDescriptorRevision(host.snapshot.lanes[0]!),actionsRunId:'1',actionsJobId:'2',boundAt:new Date(bindingNow).toISOString()}, {},new Date(bindingNow));
  expect(qualifiedCandidate(original,host.snapshot,'android',f.now,host.receivedAt)!==undefined).toBe(elapsed===1);
  expect(host.snapshot.resourceLifecycle!.subjects[0]!.idle.checkedAt).toBe(new Date(bindingNow).toISOString());
  expect(f.now-Date.parse(host.snapshot.lanes[0]!.resources[0]!.backendConnectivity!.observedAt)).toBe(119999+elapsed);
  expect(bindingWrites).toBe(1);expect(hostCas).toBe(1);
  expect(bound?.state).toBe('preparing');expect(bound?.fleetBinding?.hostId).toBe('air1')
  expect(host.resourceReservations).toEqual([claim]);expect(f.row.fleetResourceReservation).toEqual(claim);
  expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations);expect(f.row.fleetDeadline).toEqual(original.fleetDeadline);
 }finally{TestRequestModel.collection.findOne=find;TestRequestModel.collection.findOneAndUpdate=write;resourceReservationRepository.get=read;
  resourceReservationRepository.recorderClaims=claims;resourceReservationRepository.replace=replace;clock.mockRestore()}
});
for(const phase of ['stage-request','stage-recorder','stage-host','final-stage-request','final-stage-host'] as const)for(const elapsed of [1,2])test(`ordinary backend repository staging ${phase} ignores historical backend age ${119999+elapsed} with a current physical baseline`,async()=>{
 const f=await returnedFixture();f.advance(119999);
 const host=repositoryEnvelope(f),claim=structuredClone(f.row.fleetResourceReservation!),original=structuredClone(f.row),stageNow=f.now;
 const admission={intent:{operationId:`run:${f.row.requestId}`,hostId:'air1',laneId:'android',inputSha256:f.row.fleetInputSha256!,owner:{id:f.row.requestId,kind:'run' as const},
  resources:host.snapshot.lanes[0]!.resources.map(resource=>({id:resource.id,capabilities:resource.capabilities??[]})),controller:{incarnation:host.incarnation,generation:host.incarnationGeneration,sequence:host.sequence}},dependencies:[]};
 const request=resourceReservationRepository.request,recorder=resourceReservationRepository.recorderClaims,get=resourceReservationRepository.get,
  write=TestRequestModel.collection.findOneAndUpdate,clock=spyOn(Date,'now').mockImplementation(()=>f.now);
 let requestReads=0,hostReads=0,stages=0,stagedDeadline:unknown;
 resourceReservationRepository.request=async()=>{requestReads++;if(phase===(requestReads===1?'stage-request':'final-stage-request'))f.advance(elapsed);return structuredClone(f.row)};
 resourceReservationRepository.recorderClaims=async()=>{if(phase==='stage-recorder')f.advance(elapsed);return [structuredClone(claim)]};
 resourceReservationRepository.get=async()=>{hostReads++;if(phase===(hostReads===1?'stage-host':'final-stage-host'))f.advance(elapsed);return structuredClone(host)};
 TestRequestModel.collection.findOneAndUpdate=mock(async(filter:any,update:any)=>{stages++;expect(filter.fleetCandidateSelection).toBeUndefined();
  stagedDeadline=filter.fleetDeadline;f.row={...f.row,...structuredClone(update.$set)};return structuredClone(f.row)}) as never;
 try{
  const staged=await resourceReservationRepository.stageBackend!(f.row.requestId,f.row.fleetInputSha256!,admission,host,new Date(stageNow));
  expect(qualifiedCandidate(original,host.snapshot,'android',f.now,host.receivedAt)!==undefined).toBe(elapsed===1);
  expect(stages).toBe(1);expect(staged?.fleetResourceAdmission).toEqual(admission);expect(stagedDeadline).toEqual({$gt:new Date(f.now)})
  expect(host.resourceReservations).toEqual([claim]);expect(f.row.fleetResourceReservation).toEqual(claim);expect(f.row.fleetDeadline).toEqual(original.fleetDeadline);
 }finally{resourceReservationRepository.request=request;resourceReservationRepository.recorderClaims=recorder;resourceReservationRepository.get=get;
  TestRequestModel.collection.findOneAndUpdate=write;clock.mockRestore()}
});
test('current physical baseline permits the same admission without historical APK-backend evidence',async()=>{
 const f=await returnedFixture(),claim=structuredClone(f.row.fleetResourceReservation!);let host=repositoryEnvelope(f);
 const service=new ResourceReservationsService({async request(){return structuredClone(f.row)},async get(){return structuredClone(host)},async recorderClaims(){return [claim]},
  async stageBackend(_id,_digest,value){f.row.fleetResourceAdmission=structuredClone(value);return structuredClone(f.row)},async claimedHosts(){return []},async replace(){throw Error('Unexpected dependency claim')}},()=>f.now);
 expect(await service.reserveFleet(f.row.requestId,f.row.fleetInputSha256!,'air1','android')).toBeUndefined();
 f.advance(120001);host=repositoryEnvelope(f);const original=structuredClone(f.row);
 expect(routineResourcesAvailable(host,f.row,'android',f.now)).toBe(true);
 expect(await service.reserveFleet(f.row.requestId,f.row.fleetInputSha256!,'air1','android')).toBeUndefined();expect(f.row).toEqual(original);expect(host.resourceReservations).toEqual([claim]);
 const unassigned=fixture(),candidateHost=repositoryEnvelope(unassigned);candidateHost.resourceReservations=[];
 delete candidateHost.snapshot.lanes[0]!.resources[0]!.idleContract;candidateHost.snapshot.resourceLifecycle!.subjects[0]!.status='unknown';
 candidateHost.snapshot.resourceLifecycle!.subjects[0]!.idle.outcome='not-checked';candidateHost.snapshot.resourceLifecycle!.subjects[0]!.idle.checkedAt=null;candidateHost.snapshot.resourceLifecycle!.subjects[0]!.idle.acceptedCheck=null;
 expect(routineResourcesAvailable(candidateHost,unassigned.row,'android',unassigned.now,true)).toBe(true);
 expect(routineResourcesAvailable(candidateHost,unassigned.row,'android',unassigned.now)).toBe(false);
 const offline=structuredClone(f.row);offline.fleetPreparation!.requirements.resources.find(value=>value.kind==='phone')!.capabilities=[];
 expect(routineResourcesAvailable(host,offline,'android',f.now)).toBe(true);
});
for (const winner of ['renewal','binding'] as const) test(`final binding and readiness renewal serialize when ${winner} wins`,async()=>{
 const f=await returnedFixture(),host=repositoryEnvelope(f),claim=structuredClone(f.row.fleetResourceReservation!);
 const admission=new ResourceReservationsService({async request(){return structuredClone(f.row)},async get(){return structuredClone(host)},async recorderClaims(){return [claim]},
   async stageBackend(_id,_digest,value){f.row.fleetResourceAdmission=structuredClone(value);return structuredClone(f.row)},async claimedHosts(){return []},async replace(){throw Error('Unexpected dependency')}} ,()=>f.now);
 await admission.reserveFleet(f.row.requestId,f.row.fleetInputSha256!,'air1','android');
 const original=structuredClone(f.row),bindingNow=f.now;
 f.advance(120001);const pending=structuredClone(historicalPendingReturn(f));f.row=structuredClone(original);
 const find=TestRequestModel.collection.findOne,write=TestRequestModel.collection.findOneAndUpdate,read=resourceReservationRepository.get,claims=resourceReservationRepository.recorderClaims,replace=resourceReservationRepository.replace;
 const clock=spyOn(Date,'now').mockReturnValue(bindingNow);resourceReservationRepository.replace=async()=>true;
 let bindingArrived!:()=>void,renewalArrived!:()=>void,releaseBinding!:()=>void,releaseRenewal!:()=>void;
 const bindingReady=new Promise<void>(resolve=>bindingArrived=resolve),renewalReady=new Promise<void>(resolve=>renewalArrived=resolve),
   bindingGate=new Promise<void>(resolve=>releaseBinding=resolve),renewalGate=new Promise<void>(resolve=>releaseRenewal=resolve);
 TestRequestModel.collection.findOne=mock(async()=>structuredClone(original)) as any;
 resourceReservationRepository.get=async()=>structuredClone(host);resourceReservationRepository.recorderClaims=async()=>[structuredClone(claim)];
 TestRequestModel.collection.findOneAndUpdate=mock(async(filter:any,update:any)=>{
  const binding=update.$set.state==='preparing';if(binding){bindingArrived();await bindingGate}else{renewalArrived();await renewalGate}
  for(const [key,expected] of Object.entries(filter)){
   const actual=key.split('.').reduce((value:any,part)=>value?.[part],f.row);
   if(expected&&typeof expected==='object'&&'$exists' in expected){if((actual!==undefined)!==(expected as any).$exists)return null}
   else if(expected&&typeof expected==='object'&&'$gt' in expected){if(!(actual>(expected as any).$gt))return null}
   else if(requestInputDigest(actual??null)!==requestInputDigest(expected??null))return null;
  }
  for(const key of Object.keys(update.$unset??{}))delete (f.row as any)[key];f.row={...f.row,...structuredClone(update.$set)};return structuredClone(f.row);
 }) as any;
 try{
  const bound=routineJobRepository.bind(original.requestId,original.fleetInputSha256!,{jobId:original.requestId,requestId:original.requestId,hostId:'air1',laneId:'android',descriptorRevision:'b'.repeat(64),actionsRunId:'1',actionsJobId:'2',boundAt:new Date(bindingNow).toISOString()}, {},new Date(bindingNow)),
    renewed=routineJobRepository.candidatePreparation!(original,pending,new Date(f.now));
  await Promise.all([bindingReady,renewalReady]);
  if(winner==='renewal'){releaseRenewal();expect(await renewed).toBeDefined();releaseBinding();expect(await bound).toBeNull();expect(f.row.fleetCandidatePreparation).toEqual(pending);expect(f.row.fleetBinding).toBeUndefined()}
  else{releaseBinding();expect(await bound).toBeDefined();releaseRenewal();expect(await renewed).toBeNull();expect(f.row.state).toBe('preparing');expect(f.row.fleetCandidatePreparation).toBeUndefined()}
  expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations);expect(f.row.fleetResourceReservation).toEqual(claim);
 }finally{releaseBinding();releaseRenewal();TestRequestModel.collection.findOne=find;TestRequestModel.collection.findOneAndUpdate=write;resourceReservationRepository.get=read;resourceReservationRepository.recorderClaims=claims;resourceReservationRepository.replace=replace;clock.mockRestore()}
})
test('actual resource admission consumes authenticated repository receive time, not snapshot metadata',async()=>{
 const f=await returnedFixture(),host=repositoryEnvelope(f),claim=f.row.fleetResourceReservation!;let stages=0;
 expect('receivedAt' in host.snapshot).toBe(false);
 const service=new ResourceReservationsService({async request(){return structuredClone(f.row)},async get(){return structuredClone(host)},async recorderClaims(){return [structuredClone(claim)]},
   async stageBackend(_id,_digest,admission){stages++;f.row.fleetResourceAdmission=structuredClone(admission);return structuredClone(f.row)},async claimedHosts(){return []},async replace(){throw Error('No exclusive dependency expected')}} ,()=>f.now);
 expect(await service.reserveFleet(f.row.requestId,f.row.fleetInputSha256!,'air1','android')).toBeUndefined();expect(stages).toBe(1);
 expect(qualifiedCandidate(f.row,host.snapshot,'android',f.now,host.receivedAt)).toBeDefined();
 for(const received of [new Date(f.now-120001),new Date(f.now+1),new Date(NaN)])expect(qualifiedCandidate(f.row,host.snapshot,'android',f.now,received)).toBeUndefined();
})
/** Graph renewal must return only the original unused reservation before any
 * replacement check can acquire the graph. This uses the real cleanup and bind
 * repositories with an isolated in-memory CAS; it never touches a device. */
function graphRepositoryEnvelope(f: ReturnType<typeof routingGraphFixture>): ResourceReservationHost {
 const h=structuredClone(f.hosts[0]!),{receivedAt,authorityReservations,...snapshot}=h;
 snapshot.frameworkAcceptedAt=h.observedAt;snapshot.frameworkProcess={pid:123,startedAt:h.observedAt};
 return {hostId:h.hostId,incarnation:h.incarnation!,incarnationGeneration:h.incarnationGeneration!,sequence:h.sequence!,
   receivedAt:new Date(receivedAt),snapshot:hostStateSchema.parse(snapshot),resourceReservations:structuredClone(authorityReservations??[])};
}
async function returnedGraphFixture(platform: 'android'|'ios-on-mac') {
 const f=routingGraphFixture(platform);await f.prepareLegacy('job-one');f.settleGraph('qualified');await f.prepareLegacy('job-one');
 f.row.fleetResourceReservation!.minimumAvailableBytes=recorderCapacityRequirements(f.row.fleetPreparation!).resources.find(ref=>ref.kind==='recorder')!.storage!.minimumAvailableBytes;
 f.hosts[0]!.authorityReservations=[structuredClone(f.row.fleetResourceReservation!)];return f;
}
/** Explicit withdrawal, rather than elapsed time, requires another graph check. */
function withdrawGraphCheck(f: ReturnType<typeof routingGraphFixture>) {
 const subject=f.hosts[0]!.resourceLifecycle!.subjects[0]!;
 subject.status='unknown';subject.reason={code:'idle-check-required',message:'Accepted physical proof was withdrawn'};
 subject.idle.outcome='not-checked';subject.idle.checkedAt=null;subject.idle.acceptedCheck=null;
}
/** Saved pre-migration return work; it is never produced by current preparation. */
function historicalPendingReturn(f: ReturnType<typeof fixture>) {
 const pending=legacyCandidate(f.row,f.hosts[0]!,f.now)
 pending.provisionalReturn={recorder:structuredClone(f.row.fleetResourceReservation!),
   ...(f.row.fleetResourceAdmission?{admission:structuredClone(f.row.fleetResourceAdmission)}:{}),
   ...(f.row.fleetExclusiveReservation?{exclusive:structuredClone(f.row.fleetExclusiveReservation)}:{})}
 f.row.fleetCandidatePreparation=pending;f.row.fleetCandidateSelection=undefined
 return pending
}
/** The returned graph's byte receipt was committed together with its admission. */
function claimedGraphAdmission(f: {row: StoredRoutineJob}, host: ResourceReservationHost) {
 const receipt=f.row.fleetResourceReservation!;
 expect(hostResourceReservationsSchema.parse(host.resourceReservations).some(claim=>isDeepStrictEqual(claim,receipt))).toBe(true);
 const lane=host.snapshot.lanes.find(lane=>lane.id===receipt.laneId)!,intent={operationId:`run:${f.row.requestId}`,hostId:host.hostId,
  laneId:lane.id,inputSha256:f.row.fleetInputSha256!,owner:{id:f.row.requestId,kind:'run' as const},
  resources:f.row.fleetPreparation!.requirements.resources.map(required=>({id:lane.resources.find(resource=>resource.kind===required.kind)!.id,capabilities:[...required.capabilities]})),
  controller:{incarnation:host.incarnation,generation:host.incarnationGeneration,sequence:host.sequence}};
 f.row.fleetResourceAdmission={intent,dependencies:resourceIntentDependencies(host,intent)};
}
/** Isolated repositories commit the request winner and its current claims together. */
function graphClaimFleet(f: {row: StoredRoutineJob; readonly now: number}, hosts: ResourceReservationHost[], committed?:()=>void): NonNullable<ResourceReservationRepository['claimFleet']> {
 return async(expected,observed,claims,admission,receipts,_at,borrower)=>{
  const authority=hosts.find(host=>host.hostId===observed.hostId)!,currentBorrower=borrower&&hosts.find(host=>host.hostId===borrower.hostId);
  const current=(value:ResourceReservationHost,prior:ResourceReservationHost)=>['incarnation','incarnationGeneration','sequence','laneControlVersion','resourceReservationVersion'].every(key=>isDeepStrictEqual(value[key as keyof ResourceReservationHost],prior[key as keyof ResourceReservationHost]));
  if(!isDeepStrictEqual(f.row,expected)||f.row.fleetDeadline.getTime()<=f.now||!current(authority,observed)||borrower&&(!currentBorrower||!current(currentBorrower,borrower)))return null;
  f.row={...f.row,fleetResourceAdmission:structuredClone(admission),...structuredClone(receipts)};
  authority.resourceReservations=structuredClone(claims);authority.resourceReservationVersion=(authority.resourceReservationVersion??0)+1;
  if(currentBorrower&&currentBorrower!==authority)currentBorrower.resourceReservationVersion=(currentBorrower.resourceReservationVersion??0)+1;
  committed?.();return structuredClone(f.row);
 };
}
async function returnedSecondaryGraphFixture(platform: 'android'|'ios-on-mac', exclusive: boolean, logicalWorkspace = false) {
 const f=routingGraphFixture(platform);
 for(const host of f.hosts){
  const lane=host.lanes[0]!,app=lane.resources.find(ref=>ref.kind==='app')!,recorder=lane.resources.find(ref=>ref.kind==='recorder')!,
    browser={id:`${host.hostId}:secondary-browser`,kind:'browser' as const,capabilities:['relaunch'],
      idleContract:{...structuredClone(app.idleContract!),version:'browser-baseline'}};
  host.resources=[browser];recorder.idleContract!.dependencies=[browser.id];
  host.resourceLifecycle!.subjects.find(subject=>subject.subject.id===recorder.id)!.resource!.dependencies=[browser.id];
  const subject=structuredClone(host.resourceLifecycle!.subjects.find(subject=>subject.subject.id===app.id)!);
  subject.subject.id=browser.id;subject.idle.contractVersion=browser.idleContract.version;
  subject.resource={kind:'browser',capabilities:browser.capabilities,memberships:[],dependencies:[],placement:'installed'};
  host.resourceLifecycle!.subjects.push(subject);
  if(exclusive){app.capabilities=['relaunch'];app.exclusiveDependencies=[{resourceId:browser.id,authorityHostId:host.hostId,capability:'relaunch'}]}
  if(logicalWorkspace)lane.resources.push({id:`${host.hostId}:workspace`,kind:'workspace',capabilities:[]});
 }
 if(logicalWorkspace){const prepared=f.row.fleetPreparation!,required={kind:'workspace' as const,capabilities:[]};
  prepared.requirements.resources=[...prepared.requirements.resources,required];prepared.definition.resourceRequirements=[...prepared.definition.resourceRequirements!,required];
  prepared.definition.execution!.resourceKinds.push('workspace')}
 if(exclusive){
  f.row.fleetPreparation!.definition.resourceRequirements!.find(required=>required.kind==='app')!.capabilities=['relaunch'];
 }
 if(exclusive||logicalWorkspace){
  f.row.fleetPreparation!.definitionSha256=requestInputDigest(f.row.fleetPreparation!.definition);
  f.row.fleetInputSha256=routineJobInputDigest(f.row);
 }
 await f.prepareLegacy('job-one');
 const purpose=f.row.fleetCandidatePreparation!.target.purpose;
 expect(purpose?.kind).toBe('resource-readiness');
 if(purpose?.kind!=='resource-readiness')throw Error('Expected graph fixture');
 expect(purpose.resources.find(member=>member.id==='air1:secondary-browser')).toEqual({id:'air1:secondary-browser',
  kind:'browser',authorityHostId:'air1',subjectGeneration:1,contractVersion:'browser-baseline',capabilities:['relaunch']});
 f.settleGraph('qualified');await f.prepareLegacy('job-one');
 f.row.fleetResourceReservation!.minimumAvailableBytes=recorderCapacityRequirements(f.row.fleetPreparation!).resources.find(ref=>ref.kind==='recorder')!.storage!.minimumAvailableBytes;
 f.hosts[0]!.authorityReservations=[structuredClone(f.row.fleetResourceReservation!)];claimedGraphAdmission(f,graphRepositoryEnvelope(f));return f;
}
const logicalConditions = ['bare', 'metadata', 'contract-only', 'lifecycle-only', 'owner', 'cursor', 'control', 'claim'] as const;
function logicalCondition(host: ResourceReservationHost, kind: 'network'|'workspace', condition: typeof logicalConditions[number], now: number) {
 const resource=host.snapshot.lanes[0]!.resources.find(ref=>ref.kind===kind)!,at=new Date(now).toISOString(),
   previous=structuredClone(host.snapshot.resourceLifecycle!.subjects[0]!),subject={...previous,
    subject:{kind:'resource' as const,id:resource.id,authorityHostId:host.hostId},status:'idle' as const,owner:null,observedAt:at,
    idle:{...previous.idle,contractVersion:`${kind}-baseline`,outcome:'passed' as const,checkedAt:at,
     acceptedCheck:{operationId:`logical:${resource.id}`,subjectGeneration:previous.generation,resultSha256:hash('a'),acceptedAt:at}},
    supportedActions:[],resource:{kind,capabilities:resource.capabilities??[],memberships:[{hostId:host.hostId,laneId:host.snapshot.lanes[0]!.id}],dependencies:[],placement:'installed' as const}};
 host.snapshot.laneControls={schemaVersion:1,receipts:[],resourceControls:true};
 if(condition==='metadata'||condition==='contract-only')resource.idleContract={...structuredClone(host.snapshot.lanes[0]!.resources.find(ref=>ref.kind==='app')!.idleContract!),version:subject.idle.contractVersion};
 if(condition==='metadata'||condition==='lifecycle-only')host.snapshot.resourceLifecycle!.subjects.push(subject);
 if(condition==='owner')host.snapshot.resourceLifecycle!.subjects.push({...subject,status:'reserved',owner:{id:'other-owner',kind:'fixer',generation:8,hostId:host.hostId}});
 if(condition==='cursor')host.resourceLifecycleCursor={...structuredClone(host.snapshot.resourceLifecycle!),subjects:[...structuredClone(host.snapshot.resourceLifecycle!.subjects),subject]};
 if(condition==='control')host.laneControls=[{command:{operationId:'10000000-0000-4000-8000-000000000001',hostId:host.hostId,
  subject:{resourceId:resource.id,subjectGeneration:subject.generation},expiresAt:now+60000,action:'reserve',purpose:'Operator logical resource work',operatorId:hash('a')}}];
 if(condition==='claim')host.resourceReservations=[...hostResourceReservationsSchema.parse(host.resourceReservations??[]),{
  kind:'exclusive',id:'10000000-0000-4000-8000-000000000001',resourceId:resource.id,authorityHostId:host.hostId,
  borrowerHostId:'other-host',laneId:'other-lane',operationId:'run:other-job',intentSha256:hash('e'),inputSha256:hash('f'),
  owner:{id:'other-job',kind:'run'},controllerIncarnation:host.incarnation,controllerGeneration:host.incarnationGeneration,
  borrowerSequence:host.sequence,reservedAt:at}];
}
for(const platform of ['android','ios-on-mac'] as const)for(const kind of ['network','workspace'] as const)for(const condition of logicalConditions)
 test(`${platform} logical ${kind} ${condition} uses ordinary eligibility outside the physical graph`,async()=>{
  const f=routingGraphFixture(platform),prepared=f.row.fleetPreparation!,required={kind:'workspace' as const,capabilities:[]};
  if(kind==='workspace'){
   prepared.requirements.resources=[...prepared.requirements.resources,required];prepared.definition.resourceRequirements=[...prepared.definition.resourceRequirements!,required];prepared.definition.execution!.resourceKinds.push('workspace');
   prepared.definitionSha256=requestInputDigest(prepared.definition);f.row.fleetInputSha256=routineJobInputDigest(f.row);
  }
  f.hosts.splice(1)
  if(kind==='workspace')f.hosts[0]!.lanes[0]!.resources.push({id:'air1:workspace',kind,capabilities:[]})
  await f.prepareLegacy('job-one'); f.settleGraph('qualified')
  for(const native of f.hosts){
   const host={hostId:native.hostId,incarnation:native.incarnation!,incarnationGeneration:native.incarnationGeneration!,sequence:native.sequence!,
    receivedAt:new Date(native.receivedAt),snapshot:native as TestHostState,resourceReservations:native.authorityReservations} as ResourceReservationHost;
   logicalCondition(host,kind,condition,f.now);native.authorityReservations=host.resourceReservations as never;
   native.resourceControlRecords=host.laneControls;native.resourceLifecycleCursor=host.resourceLifecycleCursor;
  }
  await f.prepareLegacy('job-one');
  expect(f.row.fleetCandidatePreparation).toBeUndefined()
  if(condition==='bare'||condition==='metadata') {
   expect(f.row.fleetResourceReservation?.hostId).toBe('air1');expect(f.bindWrites).toBe(1)
  } else {expect(f.row.fleetResourceReservation).toBeUndefined();expect(f.bindWrites).toBe(0)}
  expect(f.writes).toBe(1);expect(f.row.fleetBinding).toBeUndefined()
 });
for(const platform of ['android','ios-on-mac'] as const)for(const kind of ['network','workspace'] as const)for(const condition of logicalConditions)
 for(const timing of ['admission','binding'] as const)test(`${platform} returned physical graph honors logical ${kind} ${condition} at ${timing}`,async()=>{
  const f=await returnedSecondaryGraphFixture(platform,false,true),host=graphRepositoryEnvelope(f),laneId=host.snapshot.lanes[0]!.id,
   positive=condition==='bare'||condition==='metadata';let stages=0,claims=0,bindings=0;
  host.snapshot.laneControls={schemaVersion:1,receipts:[],resourceControls:true};
  if(timing==='admission')logicalCondition(host,kind,condition,f.now);
  const originals=async()=>hostResourceReservationsSchema.parse(host.resourceReservations).filter((claim):claim is RecorderHostReservation=>!isExclusiveHostReservation(claim)),
   admission=new ResourceReservationsService({async request(){return structuredClone(f.row)},async get(){return structuredClone(host)},recorderClaims:originals,
    async stage(_id,_digest,value){stages++;f.row.fleetResourceAdmission=structuredClone(value);return structuredClone(f.row)},
    async stageBackend(_id,_digest,value){stages++;f.row.fleetResourceAdmission=structuredClone(value);return structuredClone(f.row)},
    async claimedHosts(){return []},async replace(){claims++;return true}},()=>f.now),beforeAdmission=structuredClone(f.row),
   reserved=await admission.reserveFleet(f.row.requestId,f.row.fleetInputSha256!,host.hostId,laneId);
  if(timing==='admission'&&!positive){expect(reserved).toBeNull();expect(stages).toBe(0);expect(claims).toBe(0);expect(f.row).toEqual(beforeAdmission);return}
  expect(reserved).toBeUndefined();expect(stages).toBe(0);expect(f.row).toEqual(beforeAdmission);
  if(timing==='binding')logicalCondition(host,kind,condition,f.now);
  const before=structuredClone(f.row),snapshot=structuredClone(host.snapshot),retained=structuredClone(host.resourceReservations),
   read=resourceReservationRepository.get,readClaims=resourceReservationRepository.recorderClaims,replace=resourceReservationRepository.replace,
   find=TestRequestModel.collection.findOne,write=TestRequestModel.collection.findOneAndUpdate,clock=spyOn(Date,'now').mockImplementation(()=>f.now);
  resourceReservationRepository.get=async()=>structuredClone(host);resourceReservationRepository.recorderClaims=originals;
  resourceReservationRepository.replace=async()=>{claims++;return true};TestRequestModel.collection.findOne=mock(async()=>structuredClone(f.row)) as never;
  TestRequestModel.collection.findOneAndUpdate=mock(async(_filter:any,update:any)=>{bindings++;f.row={...f.row,...structuredClone(update.$set)};return structuredClone(f.row)}) as never;
  try{
   const bound=await routineJobRepository.bind(f.row.requestId,f.row.fleetInputSha256!,{jobId:f.row.requestId,requestId:f.row.requestId,hostId:host.hostId,laneId,
    descriptorRevision:routineLaneDescriptorRevision(host.snapshot.lanes[0]!),actionsRunId:'1',actionsJobId:'2',boundAt:new Date(f.now).toISOString()}, {},new Date(f.now));
   if(positive){expect(bound?.state).toBe('preparing');expect(bindings).toBe(1);expect(claims).toBe(1)}
   else{expect(bound).toBeNull();expect(bindings).toBe(0);expect(claims).toBe(0);expect(f.row).toEqual(before)}
   expect(host.snapshot).toEqual(snapshot);expect(host.resourceReservations).toEqual(retained);
  }finally{resourceReservationRepository.get=read;resourceReservationRepository.recorderClaims=readClaims;resourceReservationRepository.replace=replace;
   TestRequestModel.collection.findOne=find;TestRequestModel.collection.findOneAndUpdate=write;clock.mockRestore()}
 });
for(const platform of ['android','ios-on-mac'] as const)for(const condition of ['admission-control','admission-claim','binding-control','binding-claim','own-claim',
 'admission-missing-subject','admission-missing-ref','admission-new-owner','admission-missing-check','admission-changed-dependency',
 'binding-missing-subject','binding-missing-ref','binding-new-owner','binding-missing-check','binding-changed-dependency','graph-valid'] as const)
 test(`${platform} returned secondary graph honors ${condition} through reservation and binding`,async()=>{
  const admissionBlocked=condition.startsWith('admission'),exclusive=condition==='binding-control'||condition==='own-claim',
    f=await returnedSecondaryGraphFixture(platform,exclusive,condition==='graph-valid'),host=graphRepositoryEnvelope(f),
    laneId=host.snapshot.lanes[0]!.id,browser=host.snapshot.resources![0]!,positive=condition==='own-claim'||condition==='graph-valid';
  if(positive)host.snapshot.laneControls={schemaVersion:1,receipts:[],resourceControls:true};
  let stageWrites=0,claimWrites=0,bindingWrites=0;
  const restrict=()=>{
   if(condition.endsWith('control'))host.laneControls=[{command:{operationId:'10000000-0000-4000-8000-000000000001',hostId:host.hostId,
    subject:{resourceId:browser.id,subjectGeneration:host.snapshot.resourceLifecycle!.subjects.find(subject=>subject.subject.id===browser.id)!.generation},
    expiresAt:f.now+60000,action:'reserve',purpose:'Operator browser work',operatorId:hash('a')}}];
   else if(condition.endsWith('claim'))host.resourceReservations=[...hostResourceReservationsSchema.parse(host.resourceReservations),{kind:'exclusive',id:'10000000-0000-4000-8000-000000000001',
    resourceId:browser.id,authorityHostId:host.hostId,borrowerHostId:'air2',laneId:'other-lane',operationId:'run:foreign-job',intentSha256:hash('e'),
    inputSha256:hash('f'),owner:{id:'foreign-job',kind:'run'},controllerIncarnation:'air2-one',controllerGeneration:1,borrowerSequence:1,reservedAt:new Date(f.now).toISOString()}];
   else if(condition.endsWith('missing-subject'))host.snapshot.resourceLifecycle!.subjects=host.snapshot.resourceLifecycle!.subjects.filter(subject=>subject.subject.id!==browser.id);
   else if(condition.endsWith('missing-ref'))host.snapshot.resources=[];
   else if(condition.endsWith('new-owner')){const subject=host.snapshot.resourceLifecycle!.subjects.find(subject=>subject.subject.id===browser.id)!;
    subject.status='reserved';subject.owner={kind:'fixer',id:'foreign-owner',generation:8,hostId:host.hostId}}
   else if(condition.endsWith('missing-check')){const subject=host.snapshot.resourceLifecycle!.subjects.find(subject=>subject.subject.id===browser.id)!;
    subject.idle.outcome='not-checked';subject.idle.checkedAt=null;subject.idle.acceptedCheck=null;subject.status='unknown'}
   else if(condition.endsWith('changed-dependency'))host.snapshot.lanes[0]!.resources.find(ref=>ref.kind==='recorder')!.idleContract!.dependencies!.push('unchecked-member');
  };
  if(admissionBlocked)restrict();
  const beforeAdmission=structuredClone(f.row);
  const recorderClaims=async()=>hostResourceReservationsSchema.parse(host.resourceReservations).filter((claim):claim is RecorderHostReservation=>!isExclusiveHostReservation(claim)),
    admission=new ResourceReservationsService({async request(){return structuredClone(f.row)},async get(){return structuredClone(host)},recorderClaims,
      async stage(_id,_digest,value){stageWrites++;f.row.fleetResourceAdmission=structuredClone(value);return structuredClone(f.row)},
      async stageBackend(_id,_digest,value){stageWrites++;f.row.fleetResourceAdmission=structuredClone(value);return structuredClone(f.row)},
      async claimedHosts(){return hostResourceReservationsSchema.parse(host.resourceReservations).some(claim=>isExclusiveHostReservation(claim)&&claim.owner.id===f.row.requestId)?[structuredClone(host)]:[]},
      async replace(){throw Error('Atomic graph admission must not split its authority write')},
      claimFleet:graphClaimFleet(f,[host],()=>{stageWrites++;claimWrites++})},()=>f.now);
  const reserved=await admission.reserveFleet(f.row.requestId,f.row.fleetInputSha256!,host.hostId,laneId);
  if(admissionBlocked){expect(reserved).toBeNull();expect(stageWrites).toBe(0);expect(claimWrites).toBe(0);expect(f.row).toEqual(beforeAdmission);return}
  if(exclusive){expect(reserved?.claims).toHaveLength(1);expect(f.row.fleetExclusiveReservation).toEqual(reserved!)}else expect(reserved).toBeUndefined();
  if(!positive)restrict();
  const before=structuredClone(f.row),claimsBefore=structuredClone(host.resourceReservations),
    snapshot=structuredClone(host.snapshot),
    read=resourceReservationRepository.get,claims=resourceReservationRepository.recorderClaims,replace=resourceReservationRepository.replace,
    find=TestRequestModel.collection.findOne,write=TestRequestModel.collection.findOneAndUpdate,clock=spyOn(Date,'now').mockImplementation(()=>f.now);
  resourceReservationRepository.get=async()=>structuredClone(host);resourceReservationRepository.recorderClaims=recorderClaims;
  resourceReservationRepository.replace=async()=>{claimWrites++;return true};
  TestRequestModel.collection.findOne=mock(async()=>structuredClone(f.row)) as never;
  TestRequestModel.collection.findOneAndUpdate=mock(async(_filter:any,update:any)=>{bindingWrites++;f.row={...f.row,...structuredClone(update.$set)};return structuredClone(f.row)}) as never;
  try{
   const bound=await routineJobRepository.bind(f.row.requestId,f.row.fleetInputSha256!,{jobId:f.row.requestId,requestId:f.row.requestId,hostId:host.hostId,laneId,
    descriptorRevision:routineLaneDescriptorRevision(host.snapshot.lanes[0]!),actionsRunId:'1',actionsJobId:'2',boundAt:new Date(f.now).toISOString()}, {},new Date(f.now));
   if(positive){expect(bound?.state).toBe('preparing');expect(bindingWrites).toBe(1);expect(claimWrites).toBe(exclusive?2:1)}
   else{expect(bound).toBeNull();expect(bindingWrites).toBe(0);expect(claimWrites).toBe(exclusive?1:0);expect(f.row).toEqual(before)}
   expect(host.resourceReservations).toEqual(claimsBefore);expect(host.snapshot).toEqual(snapshot);
  }finally{resourceReservationRepository.get=read;resourceReservationRepository.recorderClaims=claims;resourceReservationRepository.replace=replace;
   TestRequestModel.collection.findOne=find;TestRequestModel.collection.findOneAndUpdate=write;clock.mockRestore()}
 });
for(const platform of ['android','ios-on-mac'] as const)for(const custody of ['dependency','exclusive'] as const)test(`${platform} current-source graph renewal preserves retained ${custody} custody across controller changes`,async()=>{
 const f=await returnedGraphFixture(platform),host=f.hosts[0]!,laneId=host.lanes[0]!.id,dependency={resourceId:'shared-account',authorityHostId:'air2',capability:'google-authentication'};
 const intent={operationId:'run:job-one',hostId:'air1',laneId,inputSha256:f.row.fleetInputSha256!,owner:{kind:'run' as const,id:'job-one'},
  controller:{incarnation:host.incarnation!,generation:host.incarnationGeneration!,sequence:host.sequence!},resources:[{id:'fixtures',capabilities:['google-authentication']}]},
  origin={kind:'fleet' as const,fleetInputSha256:f.row.fleetInputSha256!},digest=requestInputDigest({...intent,controller:{incarnation:host.incarnation,generation:host.incarnationGeneration},origin,dependencies:[dependency]});
 if(custody==='dependency')f.row.fleetResourceAdmission={intent,dependencies:[dependency]};
 else f.row.fleetExclusiveReservation={intent,origin,intentSha256:digest,claims:[{kind:'exclusive',id:'fe8b194f-5f52-4f24-8731-a5b5eaf14e83',
  authorityHostId:'air2',borrowerHostId:'air1',laneId,resourceId:'shared-account',operationId:intent.operationId,inputSha256:f.row.fleetInputSha256!,
  intentSha256:digest,owner:intent.owner,origin,controllerIncarnation:host.incarnation!,controllerGeneration:host.incarnationGeneration!,borrowerSequence:host.sequence!,reservedAt:new Date(f.now).toISOString()}]};
 const original=structuredClone(f.row),writes=f.writes;f.advance(120001);host.incarnation='air1-next';host.incarnationGeneration=host.incarnationGeneration!+1;
 host.frameworkBinding={...host.frameworkBinding!,version:host.frameworkBinding!.version+1,revision:'d'.repeat(40),installationId:`framework:${'d'.repeat(40)}`};
 expect(candidateRenewal(f.row,'air1',laneId)).toBeDefined();expect(qualifiedCandidate(f.row,host,laneId,f.now,host.receivedAt)).toBeUndefined();
 await f.prepareLegacy('job-one');expect(f.row).toEqual(original);expect(f.writes).toBe(writes);expect(f.row.fleetBinding).toBeUndefined();
});
for(const gap of ['missing-historical-return','owned-static-member','local-consumer','foreign-recorder','changed-controller','old-admission-controller'] as const)test(`whole-graph renewal cleanup retains original authority with ${gap}`,async()=>{
 const f=await returnedGraphFixture('android');f.advance(120001);withdrawGraphCheck(f);historicalPendingReturn(f);const pending=structuredClone(f.row.fleetCandidatePreparation!),host=graphRepositoryEnvelope(f);
 if(gap==='missing-historical-return')f.row.fleetCandidatePreparations![0]!.resourceReturns!.pop();
 if(gap==='owned-static-member')host.snapshot.resourceLifecycle!.subjects.find(subject=>subject.resource.kind==='app')!.owner={kind:'run',id:'foreign',generation:8,hostId:'air1',laneId:'android'};
 if(gap==='local-consumer')host.snapshot.lanes[0]!.resources.find(ref=>ref.kind==='recorder')!.storage!.reservations=[{requestId:f.row.requestId,inputSha256:f.row.fleetInputSha256!,remainingOutputBytes:1}];
 if(gap==='foreign-recorder')host.resourceReservations=[{...hostResourceReservationsSchema.parse(host.resourceReservations)[0]!,id:'10000000-0000-4000-8000-000000000001'}];
 if(gap==='changed-controller')host.incarnation='replacement';
 if(gap==='old-admission-controller'){
  const admission={intent:{operationId:'run:job-one',hostId:'air1',laneId:'android',inputSha256:f.row.fleetInputSha256!,owner:{kind:'run' as const,id:'job-one'},
   controller:{incarnation:'foreign-controller',generation:1,sequence:1},resources:pending.target.proposedInput!.resources.map(ref=>({id:ref.id,capabilities:[]}))},dependencies:[]};
  f.row.fleetResourceAdmission=admission;pending.provisionalReturn!.admission=structuredClone(admission);f.row.fleetCandidatePreparation=structuredClone(pending);
 }
 const get=routineJobRepository.get,read=resourceReservationRepository.get,replace=resourceReservationRepository.replace;let writes=0;
 routineJobRepository.get=async()=>structuredClone(f.row);resourceReservationRepository.get=async()=>structuredClone(host);resourceReservationRepository.replace=async()=>{writes++;return true};
 try{expect(await routineJobRepository.releaseCandidateProvisional!(f.row,new Date(f.now))).toBeNull();expect(writes).toBe(0);
  expect(f.row.fleetCandidatePreparation).toEqual(pending);expect(candidateRequestCurrent(f.row,pending,f.now)).toBe(false);expect(f.row.fleetBinding).toBeUndefined()}
 finally{routineJobRepository.get=get;resourceReservationRepository.get=read;resourceReservationRepository.replace=replace}
});

for(const condition of ['local-consumer','foreign-byte','stale-storage','replacement','invalid-received','invalid-observed'] as const)test(`provisional return retains all authority when ${condition} appears`,async()=>{
 const f=await returnedFixture(),host=repositoryEnvelope(f);f.hosts[0]!.authorityReservations=[f.row.fleetResourceReservation!];f.advance(120001);historicalPendingReturn(f);const pending=structuredClone(f.row.fleetCandidatePreparation!);
 host.receivedAt=new Date(f.now);host.snapshot.observedAt=new Date(f.now).toISOString();host.snapshot.lanes[0]!.resources.find(r=>r.kind==='recorder')!.storage!.observedAt=host.snapshot.observedAt;
 if(condition==='local-consumer')host.snapshot.lanes[0]!.resources.find(r=>r.kind==='recorder')!.storage!.reservations=[{requestId:'job-one',inputSha256:hash('c'),remainingOutputBytes:1024}];
 if(condition==='foreign-byte')host.resourceReservations=[{...f.row.fleetResourceReservation!,id:'44d4ae24-3b1a-4131-8ef4-ae4ded2c269b'}];if(condition==='stale-storage')host.snapshot.lanes[0]!.resources.find(r=>r.kind==='recorder')!.storage!.observedAt=new Date(f.now-120001).toISOString();if(condition==='replacement')host.incarnation='different';
 if(condition==='invalid-received')host.receivedAt=new Date(NaN);if(condition==='invalid-observed')host.snapshot.observedAt='not-a-timestamp';
 const get=routineJobRepository.get,read=resourceReservationRepository.get,replace=resourceReservationRepository.replace;let writes=0;routineJobRepository.get=async()=>structuredClone(f.row);resourceReservationRepository.get=async()=>structuredClone(host);resourceReservationRepository.replace=async()=>{writes++;return true};
 try{expect(await routineJobRepository.releaseCandidateProvisional!(f.row,new Date(f.now))).toBeNull();expect(writes).toBe(0);expect(f.row.fleetCandidatePreparation).toEqual(pending);expect(f.row.fleetBinding).toBeUndefined()}
 finally{routineJobRepository.get=get;resourceReservationRepository.get=read;resourceReservationRepository.replace=replace}
})
for(const condition of ['valid','missing-membership','future-subject','owned-subject'] as const)test(`provisional dependency return checks ${condition} before clearing its original receipt`,async()=>{
 const f=await returnedFixture(),claim=structuredClone(f.row.fleetResourceReservation!),dependency={resourceId:'shared-account',authorityHostId:'air2',capability:'google-authentication'};
 const intent={operationId:'run:job-one',hostId:'air1',laneId:'android',inputSha256:f.row.fleetInputSha256!,owner:{kind:'run' as const,id:'job-one'},controller:{incarnation:'air1-one',generation:1,sequence:1},resources:[{id:'fixtures',capabilities:['google-authentication']}]},origin={kind:'fleet' as const,fleetInputSha256:f.row.fleetInputSha256!},digest=requestInputDigest({...intent,controller:{incarnation:'air1-one',generation:1},origin,dependencies:[dependency]});
 const exclusive={kind:'exclusive' as const,id:'fe8b194f-5f52-4f24-8731-a5b5eaf14e83',authorityHostId:'air2',borrowerHostId:'air1',laneId:'android',resourceId:'shared-account',operationId:intent.operationId,inputSha256:f.row.fleetInputSha256!,intentSha256:digest,owner:intent.owner,origin,controllerIncarnation:'air1-one',controllerGeneration:1,borrowerSequence:1,reservedAt:new Date(f.now).toISOString()};
 f.row.fleetResourceAdmission={intent,dependencies:[dependency]};f.row.fleetExclusiveReservation={intent,origin,intentSha256:digest,claims:[exclusive]};f.hosts[0]!.authorityReservations=[claim,exclusive];
 f.advance(120001);historicalPendingReturn(f);const pending=structuredClone(f.row.fleetCandidatePreparation!);expect(pending.provisionalReturn?.exclusive?.claims).toEqual([exclusive]);
 const borrower=repositoryEnvelope(f);borrower.resourceReservations=[claim];borrower.receivedAt=new Date(f.now);borrower.snapshot.observedAt=new Date(f.now).toISOString();borrower.snapshot.lanes[0]!.resources.find(r=>r.kind==='recorder')!.storage!.observedAt=borrower.snapshot.observedAt;
 const authority:ResourceReservationHost={...structuredClone(borrower),hostId:'air2',incarnation:'air2-one',resourceReservations:[exclusive],snapshot:{...structuredClone(borrower.snapshot),hostId:'air2',incarnation:'air2-one',lanes:[{id:'account',platform:'ios-on-mac',dispatchMode:'automatic',state:'idle',resources:[{id:'shared-account',kind:'fixture-data',capabilities:['google-authentication']}]}],resourceLifecycle:{schemaVersion:1,subjects:[{...structuredClone(borrower.snapshot.resourceLifecycle!.subjects[0]!),subject:{kind:'resource',id:'shared-account',authorityHostId:'air2'},observedAt:new Date(f.now).toISOString()}]}}};
 if(condition==='missing-membership')authority.snapshot.lanes[0]!.resources=[];
 if(condition==='future-subject')authority.snapshot.resourceLifecycle!.subjects[0]!.observedAt=new Date(f.now+1).toISOString();
 if(condition==='owned-subject')authority.snapshot.resourceLifecycle!.subjects[0]!.owner={kind:'run',id:'other-run',hostId:'air2',laneId:'account',generation:1};
 const get=routineJobRepository.get,read=resourceReservationRepository.get,replace=resourceReservationRepository.replace,write=TestRequestModel.collection.findOneAndUpdate;const removed:string[]=[];
 routineJobRepository.get=async()=>structuredClone(f.row);resourceReservationRepository.get=async id=>structuredClone(id==='air1'?borrower:authority);
 resourceReservationRepository.replace=async(host,claims)=>{removed.push(host.hostId);(host.hostId==='air1'?borrower:authority).resourceReservations=structuredClone(claims);if(removed.length===1)f.row.fleetCancellation={requestedAt:new Date(f.now).toISOString(),reason:'Cancelled during original return'};return true};
 TestRequestModel.collection.findOneAndUpdate=mock(async(filter:any,update:any)=>{expect(filter.fleetCancellation).toEqual(f.row.fleetCancellation);for(const key of Object.keys(update.$unset))delete (f.row as any)[key];f.row={...f.row,...update.$set};return structuredClone(f.row)}) as any;
 try{const result=await routineJobRepository.releaseCandidateProvisional!(f.row,new Date(f.now));
  if(condition==='valid'){expect(result).toBeDefined();expect(removed).toEqual(['air1','air2']);expect(authority.resourceReservations).toEqual([])}
  else{expect(result).toBeNull();expect(removed).toEqual(['air1']);expect(authority.resourceReservations).toEqual([exclusive]);expect(f.row.fleetCandidatePreparation!.provisionalReturn!.releasedAt).toBeUndefined()}
  expect(f.row.fleetCandidatePreparation!.provisionalReturn!.exclusive).toEqual(pending.provisionalReturn!.exclusive);expect(candidateRequestCurrent(f.row,f.row.fleetCandidatePreparation,f.now)).toBe(false);expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetCancellation).toBeDefined()}
 finally{routineJobRepository.get=get;resourceReservationRepository.get=read;resourceReservationRepository.replace=replace;TestRequestModel.collection.findOneAndUpdate=write}
})

for(const expiry of [false,true])test(`a live orphan recorder claim ${expiry?'retains custody if proof expires during authority read':'completes the same admission without cleanup-only custody'}`,async()=>{
 const f=await returnedFixture(),claim=structuredClone(f.row.fleetResourceReservation!),host=repositoryEnvelope(f);delete f.row.fleetResourceReservation;
 f.hosts[0]!.authorityReservations=[claim];
 const requestRead=TestRequestModel.collection.findOne,requestList=TestRequestModel.collection.find,requestWrite=TestRequestModel.collection.findOneAndUpdate,
   hostRead=TestHostStateModel.collection.findOne,hostWrite=TestHostStateModel.collection.findOneAndUpdate,
   originals=resourceReservationRepository.recorderClaims,read=resourceReservationRepository.get,
   claimed=resourceReservationRepository.claimedHosts,request=resourceReservationRepository.request,get=routineJobRepository.get,atomic=resourceReservationRepository.claimFleet;
 const frozen=structuredClone({selection:f.row.fleetSelection,preparation:f.row.fleetPreparation,inputSha256:f.row.fleetInputSha256,deadline:f.row.fleetDeadline}),clock=spyOn(Date,'now').mockImplementation(()=>f.now);
 const reserveFleet=ResourceReservationsService.prototype.reserveFleet,
   reserveClock=spyOn(ResourceReservationsService.prototype,'reserveFleet').mockImplementation(async function(...args){
    return reserveFleet.apply(new ResourceReservationsService(resourceReservationRepository,()=>f.now),args);
   });
 const matches=(filter:Record<string,unknown>)=>Object.entries(filter).every(([key,wanted])=>{
  const value=key.split('.').reduce((v:any,part)=>v?.[part],f.row);
  if(wanted&&typeof wanted==='object'&&'$exists' in wanted)return (value!==undefined)===(wanted as {$exists:boolean}).$exists;
  if(wanted&&typeof wanted==='object'&&'$gt' in wanted)return value>(wanted as {$gt:Date}).$gt;
  return requestInputDigest(value??null)===requestInputDigest(wanted??null);
 });
 resourceReservationRepository.recorderClaims=async()=>[structuredClone(claim)];resourceReservationRepository.get=async()=>structuredClone(host);
 resourceReservationRepository.claimedHosts=async()=>[];resourceReservationRepository.request=async()=>structuredClone(f.row);routineJobRepository.get=async()=>structuredClone(f.row);
 TestRequestModel.collection.findOne=mock(async()=>structuredClone(f.row)) as never;
 TestRequestModel.collection.find=mock(()=>({limit:()=>({toArray:async()=>[structuredClone(f.row)]})})) as never;
 TestHostStateModel.collection.findOne=mock(async()=>{if(expiry&&f.now===initialNow)f.advance(120001);return structuredClone(host)}) as never;
 TestHostStateModel.collection.findOneAndUpdate=mock(async()=>{throw Error('The original byte claim must not be repeated through a split write')}) as never;
 resourceReservationRepository.claimFleet=async(...args)=>{expect(args[2]).toEqual([claim]);expect(args[4].fleetResourceReservation).toEqual(claim);return graphClaimFleet(f,[host])(...args)};
 TestRequestModel.collection.findOneAndUpdate=mock(async(filter:any,update:any)=>{
  if(!matches(filter))return null;
  f.row={...f.row,...update.$set};return structuredClone(f.row);
 }) as never;
 f.rows.recorderClaims=async()=>[structuredClone(claim)];
 f.rows.reserveResources=(...args)=>routineJobRepository.reserveResources!(...args);
 const currentRow=():StoredRoutineJob=>f.row;
 try{
  expect(qualifiedCandidate(f.row,f.hosts[0]!,'android',f.now,f.hosts[0]!.receivedAt)).toBeDefined();
  await f.prepareLegacy('job-one');
  if(expiry){
   expect(f.row.fleetResourceReservation).toBeUndefined();expect(f.row.fleetResourceAdmission).toBeUndefined();
   expect(host.resourceReservations).toEqual([claim]);
   const fresh=repositoryEnvelope(f);host.receivedAt=fresh.receivedAt;host.snapshot=fresh.snapshot;
   await f.prepareLegacy('job-one');
   expect(currentRow().fleetResourceAdmission?.intent.hostId).toBe('air1');
   expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(currentRow().fleetResourceReservation).toEqual(claim);
  }else{
   expect(currentRow().fleetResourceReservation).toEqual(claim);expect(currentRow().fleetResourceAdmission?.intent.hostId).toBe('air1');
   expect(f.row.fleetCandidatePreparation).toBeUndefined();
  }
  expect(f.row.fleetCandidatePreparations).toHaveLength(1);
  expect(f.row.fleetBinding).toBeUndefined();expect(host.resourceReservations).toEqual([claim]);
  expect({selection:f.row.fleetSelection,preparation:f.row.fleetPreparation,inputSha256:f.row.fleetInputSha256,deadline:f.row.fleetDeadline}).toEqual(frozen);
 }finally{TestRequestModel.collection.findOne=requestRead;TestRequestModel.collection.find=requestList;TestRequestModel.collection.findOneAndUpdate=requestWrite;TestHostStateModel.collection.findOne=hostRead;TestHostStateModel.collection.findOneAndUpdate=hostWrite;
  resourceReservationRepository.recorderClaims=originals;resourceReservationRepository.get=read;resourceReservationRepository.claimedHosts=claimed;resourceReservationRepository.request=request;routineJobRepository.get=get;resourceReservationRepository.claimFleet=atomic;reserveClock.mockRestore();clock.mockRestore()}
});

for(const gap of ['foreign','multiple','owned-phone','local-consumer','stale-storage','replacement','cancelled','changed-selection'] as const)test(`orphan recorder checkpoint refuses ${gap} without adoption or a new grant`,async()=>{
 const f=await returnedFixture(),claim=structuredClone(f.row.fleetResourceReservation!),host=repositoryEnvelope(f);delete f.row.fleetResourceReservation;
 const list=[claim];if(gap==='foreign')list[0]!.fleetInputSha256=hash('f');if(gap==='multiple')list.push({...claim,id:'4ebdc74d-05ad-4c14-8d81-cb232ba43f2c'});
 if(gap==='owned-phone')host.snapshot.resourceLifecycle!.subjects[0]!.owner={id:'foreign',kind:'run',hostId:'air1',laneId:'android',generation:1};
 if(gap==='local-consumer')host.snapshot.lanes[0]!.resources.find(value=>value.kind==='recorder')!.storage!.reservations=[{requestId:'job-one',inputSha256:hash('c'),remainingOutputBytes:1}];
 if(gap==='stale-storage')host.snapshot.lanes[0]!.resources.find(value=>value.kind==='recorder')!.storage!.observedAt=new Date(f.now-120001).toISOString();
 if(gap==='replacement')host.incarnation='changed';if(gap==='cancelled')f.row.fleetCancellation={requestedAt:new Date(f.now).toISOString(),reason:'cancelled'};
 if(gap==='changed-selection')f.row.fleetCandidateSelection!.targetInputSha256=hash('f');
 const claims=resourceReservationRepository.recorderClaims,read=resourceReservationRepository.get,write=TestRequestModel.collection.findOneAndUpdate;let writes=0;
 resourceReservationRepository.recorderClaims=async()=>structuredClone(list);resourceReservationRepository.get=async()=>structuredClone(host);TestRequestModel.collection.findOneAndUpdate=mock(async()=>{writes++;return null}) as never;
 try{expect(await routineJobRepository.checkpointBackendRecorder!(f.row,claim,new Date(f.now))).toBeNull();expect(writes).toBe(0);expect(f.row.fleetResourceReservation).toBeUndefined();expect(f.row.fleetBinding).toBeUndefined()}
 finally{resourceReservationRepository.recorderClaims=claims;resourceReservationRepository.get=read;TestRequestModel.collection.findOneAndUpdate=write}
});
test('phone-only candidate may inspect unknown app structurally but ordinary assignment still requires app baseline',async()=>{
 const f=fixture();for(const host of f.hosts){host.resourceLifecycle!.subjects.push({
  subject:{kind:'resource',id:`${host.hostId}:app`,authorityHostId:host.hostId},generation:1,current:true,status:'unknown',owner:null,observedAt:host.observedAt,receivedAt:null,reason:null,
  idle:{contractVersion:'app-baseline',outcome:'not-checked',checkedAt:null,acceptedCheck:null,qualifiedScope:{kind:'same-controller',controllerId:host.hostId},evidenceRefs:[]},repair:{configured:true,state:'none'},supportedActions:[],resource:{kind:'app',capabilities:[],memberships:[{hostId:host.hostId,laneId:'android'}],dependencies:[],placement:'installed'}});
  host.lanes[0]!.resources.find(r=>r.kind==='app')!.idleContract={version:'app-baseline',maximumAgeMs:120000,conditions:['synthetic-app-absent'],repairConfigured:true,qualifiedScope:{kind:'same-controller',controllerId:host.hostId}};
 }
 await f.prepareLegacy('job-one');expect(f.row.fleetCandidatePreparation?.hostId).toBe('air1');expect(f.bindWrites).toBe(0);
 f.settle('qualified');await f.prepareLegacy('job-one');expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetCandidateSelection?.hostId).toBe('air1');
 const host=repositoryEnvelope(f);host.resourceReservations=[];expect(await new ResourceReservationsService({async request(){return structuredClone(f.row)},async get(){return structuredClone(host)},async replace(){throw Error('Unexpected claim')},async recorderClaims(){return []}},()=>f.now).reserveFleet('job-one',f.row.fleetInputSha256!,'air1','android')).toBeNull();
});
for(const status of ['out-of-service','in-repair','reserved'] as const)test(`fresh current matching refuses ${status} and reserves only a separately checked alternative`,async()=>{
 const f=fixture(),subject=f.hosts[0]!.resourceLifecycle!.subjects[0]!;subject.status=status;
 if(status==='in-repair')subject.repair.state='queued';if(status==='reserved')subject.owner={id:'manual',kind:'authoring',generation:1,hostId:'air1'};
 f.passCurrentBaseline('air2');f.rows.selectedLanes=async()=>[];await f.service.preparation('job-one');
 expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.bindWrites).toBe(1);expect(f.row.fleetResourceReservation?.hostId).toBe('air2');
});


for(const state of ['running','in-repair','out-of-service'] as const)test(`ordinary fleet staging refuses a current ${state} lane even when each resource baseline is passed`,async()=>{
 const f=await returnedFixture(),host=repositoryEnvelope(f),row=structuredClone(f.row),claim=structuredClone(row.fleetResourceReservation!),get=resourceReservationRepository.get,request=resourceReservationRepository.request,write=TestRequestModel.collection.findOneAndUpdate;
 f.row.fleetPreparation!.requirements.resources.find(required=>required.kind==='phone')!.capabilities=[];host.snapshot.lanes[0]!.state=state;
 const admission={intent:{operationId:`run:${row.requestId}`,hostId:'air1',laneId:'android',inputSha256:row.fleetInputSha256!,owner:{id:row.requestId,kind:'run' as const},controller:{incarnation:host.incarnation,generation:host.incarnationGeneration,sequence:host.sequence},resources:[]},dependencies:[]};let writes=0;
 resourceReservationRepository.request=async()=>structuredClone(f.row);resourceReservationRepository.get=async()=>structuredClone(host);TestRequestModel.collection.findOneAndUpdate=mock(async()=>{writes++;return null}) as never;
 try{expect(await resourceReservationRepository.stage!(row.requestId,row.fleetInputSha256!,admission,new Date(f.now))).toBeNull();expect(writes).toBe(0);expect(host.resourceReservations).toEqual([claim]);expect(f.row.fleetResourceAdmission).toBeUndefined()}
 finally{resourceReservationRepository.get=get;resourceReservationRepository.request=request;TestRequestModel.collection.findOneAndUpdate=write}
});

for (const scenario of ['returned-unknown', 'expired-returned-positive', 'returned-unqualified-control'] as const)
test(`historical consumption liveness: ${scenario} consumes the exact returned attempt without executable admission`, async () => {
 const f = fixture(); f.hosts.splice(1);
 await f.prepareLegacy('job-one');
 const original = structuredClone(f.row), outcome = scenario === 'returned-unknown' ? 'unknown' : scenario === 'expired-returned-positive' ? 'qualified' : 'unqualified';
 f.settle(outcome);
 const closed = structuredClone(f.row.fleetCandidatePreparation!), health = structuredClone(f.hosts[0]!.lanes[0]!.resources[0]!.backendConnectivity),
   receipt = structuredClone(f.hosts[0]!.resourceReservations!.candidatePrerequisites![0]!);
 expect(candidateReturnMatches(closed, closed.returnReceipt)).toBe(true);
 expect((closed.returnReceipt as import('../types/resource-reservations.types').ExclusiveResourceReturn).release).toMatchObject({kind: 'resource-check', operationId: receipt.checkOperationId, subjectGeneration: 3});
 expect(f.hosts[0]!.authorityReservations).toEqual([]);
 expect(f.hosts[0]!.resourceLifecycle!.subjects[0]!.owner).toBeNull();
 if (scenario === 'expired-returned-positive') f.advance(120001);
 await f.prepareLegacy('job-one');
 expect(f.row.fleetCandidatePreparations, 'the original closed and strictly returned attempt must become consumed immutable history').toEqual([{...closed, settlement: receipt}]);
 expect(f.row.fleetCandidatePreparation?.targetInputSha256).not.toBe(closed.targetInputSha256);
 expect(completedCandidatePreparationForHost(f.row, 'air1')).toBe(true);
 expect(qualifiedCandidate(f.row, f.hosts[0]!, 'android', f.now, f.hosts[0]!.receivedAt)).toBeUndefined();
 expect(f.hosts[0]!.lanes[0]!.resources[0]!.backendConnectivity).toEqual(health);
 expect(f.bindWrites).toBe(0); expect(f.row.fleetBinding).toBeUndefined(); expect(f.row.hostReceipt).toBeUndefined(); expect(f.row.runId).toBeUndefined();
 for (const field of ['requestId', 'fleetSelection', 'fleetSelectionSha256', 'fleetPreparation', 'fleetInputSha256', 'fleetDeadline', 'createdAt'] as const) expect(f.row[field]).toEqual(original[field]);
})

for(const outcome of ['unknown','qualified'] as const)for(const gap of ['raw-work','return-ack','claim','replacement','subject-generation','binding','app','future-observation','observation-after-deadline','close-before-observation','return-before-close','stale-report'] as const)
test(`historical returned ${outcome} refuses ${gap} without consumption, alternate or executable admission`,async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle(outcome,gap!=='raw-work',gap!=='return-ack');f.advance(120001);
 const host=f.hosts[0]!,health=host.lanes[0]!.resources[0]!.backendConnectivity!;
 if(gap==='claim')host.authorityReservations=[{...structuredClone(f.row.fleetCandidatePreparation!.claimReceipt!),prerequisite:undefined,resourceCheck:undefined,owner:{id:'other',kind:'run'}}] as any;
 if(gap==='replacement')host.incarnation='other';if(gap==='subject-generation')host.resourceLifecycle!.subjects[0]!.generation++;
 if(gap==='binding')health.binding={...health.binding,version:health.binding.version+1};if(gap==='app')health.app.archiveSha256=hash('a');
 if(gap==='future-observation')health.observedAt=new Date(f.now+1).toISOString();
 if(gap==='observation-after-deadline'){f.advance(180001);health.observedAt=health.check.closedAt=new Date(f.now).toISOString();(f.row.fleetCandidatePreparation!.returnReceipt as any).release.releasedAt=health.check.closedAt;}
 if(gap==='close-before-observation')health.check.closedAt=new Date(Date.parse(health.observedAt)-1).toISOString();
 if(gap==='return-before-close')health.check.closedAt=new Date(Date.parse(health.check.closedAt)+1).toISOString();
 if(gap==='stale-report')host.observedAt=host.receivedAt=new Date(f.now-120001).toISOString();
 const pending=structuredClone(f.row.fleetCandidatePreparation!);await f.prepareLegacy('job-one');
 expect(f.row.fleetCandidatePreparation).toEqual(pending);expect(f.row.fleetCandidatePreparations).toBeUndefined();expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined();
})
for(const outcome of ['unknown','qualified'] as const)for(const boundary of ['cancelled','deadline'] as const)
test(`historical returned ${outcome} after ${boundary} records only immutable consumed history`,async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle(outcome);const closed=structuredClone(f.row.fleetCandidatePreparation!),original=structuredClone(f.row);
 if(boundary==='deadline')f.advance(300001);else{f.advance(120001);f.row={...f.row,state:'terminal',terminalStatus:'cancelled',fleetCancellation:{requestedAt:new Date(f.now).toISOString(),reason:'cancelled'}};}
 await f.prepareLegacy('job-one');expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetCandidatePreparations).toEqual([{...closed,settlement:{targetInputSha256:closed.targetInputSha256,candidate:closed.candidate,outcome,hostWorkSettled:true,checkOperationId:`backend-prerequisite:${closed.targetInputSha256}`}}]);
 expect(f.row.fleetCandidateSelection).toBeUndefined();expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetDeadline).toEqual(original.fleetDeadline);expect(f.row.fleetInputSha256).toEqual(original.fleetInputSha256);
})

for(const outcome of ['unknown','qualified'] as const)for(const boundary of ['cancelled','deadline','lost-cas'] as const)
test(`historical ${outcome} repository ${boundary} preserves exact original settlement CAS`,async()=>{
 const f=fixture();await f.prepareLegacy('job-one');f.settle(outcome);f.advance(120001);
 const original=structuredClone(f.row),pending=original.fleetCandidatePreparation!,receipt=candidateSettlement(pending,f.hosts[0]!,[],f.now)!,
   find=TestRequestModel.collection.findOneAndUpdate,calls:Array<{filter:any,update:any}>=[];
 expect(receipt).toBeDefined();
 TestRequestModel.collection.findOneAndUpdate=mock(async(filter:any,update:any)=>{calls.push({filter:structuredClone(filter),update:structuredClone(update)});
  if(boundary==='lost-cas'||outcome==='qualified'&&calls.length===1)return null;
  return {...original,...structuredClone(update.$set),fleetCandidatePreparation:undefined};
 }) as any;
 try{
  const settled=await routineJobRepository.settleCandidatePreparation!(original,{...pending,settlement:receipt},new Date(f.now));
  expect(calls).toHaveLength(outcome==='qualified'?2:1);
  for(const {filter,update} of calls){expect(filter.requestId).toBe(original.requestId);expect(filter.fleetInputSha256).toBe(original.fleetInputSha256);
   expect(filter.fleetCandidatePreparation).toEqual(pending);expect(filter.fleetCandidatePreparations).toEqual({$exists:false});
   expect(filter.fleetBinding).toEqual({$exists:false});expect(filter.hostId).toEqual({$exists:false});expect(filter.fleetResourceAdmission).toEqual({$exists:false});
   expect(update.$unset.fleetCandidatePreparation).toBe('');expect(update.$set.fleetCandidatePreparations).toEqual([{...pending,settlement:receipt}]);
  }
  const last=calls.at(-1)!;expect(last.update.$set.fleetCandidateSelection).toBeUndefined();
  if(outcome==='qualified'){expect(calls[0]!.filter.fleetCancellation).toEqual({$exists:false});expect(calls[0]!.filter.fleetDeadline).toEqual({$gt:new Date(f.now)});
   expect(last.filter.$or).toContainEqual(boundary==='deadline'?{fleetDeadline:{$lte:new Date(f.now)}}:{fleetCancellation:{$exists:true}});}
  if(boundary==='lost-cas')expect(settled).toBeNull();else expect(settled?.fleetCandidatePreparations).toEqual([{...pending,settlement:receipt}]);
  const writes=calls.length,changed=structuredClone(pending);(changed.returnReceipt as import('../types/resource-reservations.types').ExclusiveResourceReturn).release.releasedAt=new Date(f.now).toISOString();
  expect(await routineJobRepository.settleCandidatePreparation!(original,{...changed,settlement:receipt},new Date(f.now))).toBeNull();expect(calls).toHaveLength(writes);
  expect(f.row).toEqual(original);
 }finally{TestRequestModel.collection.findOneAndUpdate=find;}
})

for(const gap of ['none','reappeared-original-claim','changed-input','local-consumer','changed-controller'] as const)test(`interrupted original byte return retries metadata beside a later Check with ${gap}`,async()=>{
 const f=await returnedGraphFixture('android'),original=structuredClone(f.row),claim=structuredClone(f.row.fleetResourceReservation!);
 f.advance(120001);withdrawGraphCheck(f);historicalPendingReturn(f);const pending=structuredClone(f.row.fleetCandidatePreparation!);
 let host=graphRepositoryEnvelope(f),hostWrites=0,ackWrites=0,lost=true;
 const template=host.snapshot.resourceLifecycle!.subjects[0]!,lane=host.snapshot.lanes[0]!;
 lane.resources.push({id:'air1:glasses',kind:'glasses',capabilities:[],idleContract:{version:'glasses-baseline',maximumAgeMs:120000,conditions:['physical-baseline'],repairConfigured:true,dependencies:[],qualifiedScope:{kind:'same-controller',controllerId:'air1'}}});
 host.snapshot.resourceLifecycle!.subjects.push({...structuredClone(template),subject:{kind:'resource',id:'air1:glasses',authorityHostId:'air1'},generation:1,status:'idle',owner:null,idle:{...structuredClone(template.idle),outcome:'passed',checkedAt:host.snapshot.observedAt,contractVersion:'glasses-baseline'},resource:{kind:'glasses',capabilities:[],memberships:[{hostId:'air1',laneId:'android'}],dependencies:[],placement:'installed'}});
 lane.glasses=[{resourceId:'air1:glasses',deviceId:'cpu-only-glasses',model:'mentra-live',capabilities:[]}];const glass=host.snapshot.resourceLifecycle!.subjects.at(-1)!;glass.idle.acceptedCheck={operationId:'cpu-return:glasses',subjectGeneration:1,resultSha256:'c'.repeat(64),acceptedAt:host.snapshot.observedAt};
 const saved={get:routineJobRepository.get,read:resourceReservationRepository.get,replace:resourceReservationRepository.replace,write:TestRequestModel.collection.findOneAndUpdate};
 routineJobRepository.get=async()=>structuredClone(f.row);resourceReservationRepository.get=async()=>structuredClone(host);
 resourceReservationRepository.replace=async(_host,next)=>{hostWrites++;host.resourceReservations=structuredClone(next);return true};
 TestRequestModel.collection.findOneAndUpdate=mock(async(_filter:any,update:any)=>{ackWrites++;if(lost){lost=false;return null}for(const key of Object.keys(update.$unset??{}))delete (f.row as any)[key];f.row={...f.row,...structuredClone(update.$set)};return structuredClone(f.row)}) as never;
 try{
  const intent={operationId:'resource-check:11111111-1111-4111-8111-111111111111',hostId:'air1',laneId:'android',controller:{incarnation:host.incarnation,generation:host.incarnationGeneration,sequence:host.sequence},owner:{id:'resource-check:independent-glasses',kind:'boundary-cleanup' as const},inputSha256:'d'.repeat(64),resources:[{id:'air1:glasses',capabilities:['resource-idle']}],resourceCheck:{resourceId:'air1:glasses',subjectGeneration:1,contractVersion:'glasses-baseline',deadlineAt:f.now+120000,binding:host.snapshot.frameworkBinding!,controller:{incarnation:host.incarnation,generation:host.incarnationGeneration}}};
  const check=new ResourceReservationsService({async get(){return structuredClone(host)},async replace(_host,next){hostWrites++;host.resourceReservations=structuredClone(next);return true}},()=>f.now);
  intent.owner.id=`resource-check:${requestInputDigest({operationId:intent.operationId,resourceId:intent.resourceCheck.resourceId})}`;const digest=requestInputDigest({...intent,controller:{incarnation:intent.controller.incarnation,generation:intent.controller.generation},dependencies:[{resourceId:'air1:glasses',authorityHostId:'air1',capability:'resource-idle'}]});host.snapshot.resourceReservations!.resourceChecks=[{intentSha256:digest,operationId:intent.operationId,resourceId:'air1:glasses',intent,resourceCheck:intent.resourceCheck,state:'prepared',observedAt:host.snapshot.observedAt}];
  expect(await check.acquire(intent,'air1')).toMatchObject({status:'unknown',claims:[]});expect(hostWrites).toBe(0);
  expect(await routineJobRepository.releaseCandidateProvisional!(f.row,new Date(f.now))).toBeNull();expect(hostWrites).toBe(1);expect(host.resourceReservations).toEqual([]);expect(ackWrites).toBe(1);
  expect(f.row.fleetCandidatePreparation!.provisionalReturn!.releasedAt).toBeUndefined();expect(f.row.fleetResourceReservation).toEqual(claim);
  const answer=await check.acquire(intent,'air1');expect(answer.status).toBe('reserved');expect(answer.claims).toHaveLength(1);const checkClaims=structuredClone(host.resourceReservations);
  if(gap==='reappeared-original-claim')host.resourceReservations=[...hostResourceReservationsSchema.parse(host.resourceReservations),claim];
  if(gap==='changed-input')f.row.fleetInputSha256='e'.repeat(64);
  if(gap==='local-consumer')lane.resources.find(ref=>ref.kind==='recorder')!.storage!.reservations=[{requestId:f.row.requestId,inputSha256:f.row.fleetInputSha256!,remainingOutputBytes:1}];
  if(gap==='changed-controller')host.incarnation='replacement-controller';
  const retained=structuredClone(host.resourceReservations),result=await routineJobRepository.releaseCandidateProvisional!(f.row,new Date(f.now));
  if(gap==='none'){expect(result).not.toBeNull();expect(ackWrites).toBe(2);expect(f.row.fleetCandidatePreparation!.provisionalReturn!.releasedAt).toBe(new Date(f.now).toISOString());expect(f.row.fleetResourceReservation).toBeUndefined()}
  else{expect(result).toBeNull();expect(ackWrites).toBe(1);expect(f.row.fleetCandidatePreparation!.provisionalReturn!.releasedAt).toBeUndefined();expect(f.row.fleetResourceReservation).toEqual(claim)}
  expect(hostWrites).toBe(2);expect(host.resourceReservations).toEqual(retained);expect(checkClaims).toHaveLength(1);expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations);expect(f.row.fleetDeadline).toEqual(original.fleetDeadline);expect(f.row.fleetBinding).toBeUndefined();
 }finally{routineJobRepository.get=saved.get;resourceReservationRepository.get=saved.read;resourceReservationRepository.replace=saved.replace;TestRequestModel.collection.findOneAndUpdate=saved.write}
})

for (const kind of ['phone', 'graph'] as const) for (const availability of ['pending', 'missing-host'] as const)
test(`pending ${kind} candidate ${availability} returns its wait without unrelated recorder queries`, async () => {
 const f = kind === 'graph' ? routingGraphFixture() : fixture();
 await f.prepareLegacy('job-one');
 const original = structuredClone(f.row);
 expect(original.fleetCandidatePreparation).toBeDefined();
 if (availability === 'missing-host') f.hosts.splice(0, 1);
 for (const host of f.hosts) host.authorityReservations = [{id: 'd0af6e63-513c-43d5-9392-ff2e672bab86',
   requestId: 'unrelated-job', fleetInputSha256: hash('e'), hostId: host.hostId, laneId: 'android',
   poolId: `${host.hostId}:disk`, minimumAvailableBytes: 1024, reservedAt: new Date(f.now).toISOString()}];
 let queries = 0;
 f.rows.reconcileRecorderHost = async () => {queries++; throw Error('Unrelated recorder query timed out');};
 const phases: string[] = [];
 const waiting = await f.prepareLegacy('job-one', phase => phases.push(phase));
 expect(queries).toBe(0);
 expect(phases).toContain('candidate-host-read');
 expect(phases).toContain('candidate-return-reconciliation');
 expect(phases).not.toContain('recorder-return-reconciliation');
 expect(waiting.waitingReason).toContain(kind === 'graph' ? 'complete required resource graph' : 'selected phone');
 expect((waiting as {resourceTarget?: unknown}).resourceTarget).toBeUndefined();
 expect(f.row).toEqual(original);
 expect(f.bindWrites).toBe(0);
});

for (const kind of ['phone', 'graph'] as const)
test(`settled ${kind} candidate still reconciles recorder custody before allocation`, async () => {
 const graph = kind === 'graph' ? routingGraphFixture() : undefined, f = graph ?? fixture();
 await f.prepareLegacy('job-one');
 const original = structuredClone(f.row);
 if (graph) graph.settleGraph('qualified'); else {f.settle('qualified');f.passCurrentBaseline('air1')}
 for (const host of f.hosts) host.authorityReservations = [{id: 'd0af6e63-513c-43d5-9392-ff2e672bab86',
   requestId: 'unrelated-job', fleetInputSha256: hash('e'), hostId: host.hostId, laneId: 'android',
   poolId: `${host.hostId}:disk`, minimumAvailableBytes: 1024, reservedAt: new Date(f.now).toISOString()}];
 let queries = 0;
 f.rows.reconcileRecorderHost = async (hostId, _now, _phase, onReturned) => {queries++;
   expect(f.row.fleetCandidatePreparation).toBeUndefined(); expect(f.bindWrites).toBe(0);
   f.hosts.find(host => host.hostId === hostId)!.authorityReservations = []; onReturned?.(); return true;};
 await f.prepareLegacy('job-one');
 expect(queries).toBe(2);
 expect(f.row.fleetCandidatePreparation).toBeUndefined();
 expect(f.row.fleetCandidatePreparations).toHaveLength(1);
 expect(f.bindWrites).toBe(1);
 expect(f.row.fleetSelection).toEqual(original.fleetSelection);
 expect(f.row.fleetInputSha256).toBe(original.fleetInputSha256);
 expect(f.row.fleetDeadline).toEqual(original.fleetDeadline);
 expect(f.row.fleetBinding).toBeUndefined();
});

for (const kind of ['phone', 'graph'] as const)
test(`pending ${kind} candidate reads only its exact host before returning`, async () => {
 const f = kind === 'graph' ? routingGraphFixture() : fixture();
 await f.prepareLegacy('job-one'); const original = structuredClone(f.row);
 const hosts = (f.service as unknown as {hosts: {get: (id: string) => Promise<ReceivedTestHostState | null>; list: () => Promise<ReceivedTestHostState[]>}}).hosts;
 const list = spyOn(hosts, 'list').mockRejectedValue(Error('Unrelated fleet lookup timed out'));
 const get = spyOn(hosts, 'get');
 try {
  const phases: string[] = [], waiting = await f.prepareLegacy('job-one', phase => phases.push(phase));
  expect(list).not.toHaveBeenCalled(); expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0]).toEqual([original.fleetCandidatePreparation!.hostId]);
  expect(phases).not.toContain('initial-host-read');
  expect(waiting.waitingReason).toBeDefined(); expect(waiting.fleetCandidatePreparation).toEqual(original.fleetCandidatePreparation);
  expect((waiting as {resourceTarget?: unknown}).resourceTarget).toBeUndefined(); expect(f.row).toEqual(original); expect(f.bindWrites).toBe(0);
 } finally {list.mockRestore(); get.mockRestore();}
});

for (const changed of ['controller', 'binding']) test(`pending candidate reads only current exact host for changed ${changed}`, async () => {
 const f = routingGraphFixture(); await f.prepareLegacy('job-one'); const original = structuredClone(f.row);
 const host = f.hosts.find(value => value.hostId === original.fleetCandidatePreparation!.hostId)!;
 if (changed === 'controller') {host.incarnation = 'replacement'; host.incarnationGeneration!++;}
 else host.frameworkBinding = {...host.frameworkBinding!, version: host.frameworkBinding!.version + 1};
 const hosts = (f.service as unknown as {hosts: {get: (id: string) => Promise<ReceivedTestHostState | null>; list: () => Promise<ReceivedTestHostState[]>}}).hosts;
 const list = spyOn(hosts, 'list').mockRejectedValue(Error('Unrelated fleet lookup')); const get = spyOn(hosts, 'get');
 try {
  await f.prepareLegacy('job-one'); expect(list).not.toHaveBeenCalled(); expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls).toEqual([[host.hostId]]);
  expect(f.row).toEqual(original); expect(f.bindWrites).toBe(0);
 } finally {list.mockRestore(); get.mockRestore();}
});

for (const kind of ['phone', 'graph'] as const)
test(`pending ${kind} candidate retains custody when the current report omits framework binding`, async () => {
 const f = kind === 'graph' ? routingGraphFixture() : fixture();
 await f.prepareLegacy('job-one'); const original = structuredClone(f.row);
 const host = f.hosts.find(value => value.hostId === original.fleetCandidatePreparation!.hostId)!;
 delete host.frameworkBinding; delete host.frameworkAcceptedAt; delete host.frameworkProcess;
 const hosts = (f.service as unknown as {hosts: {get: (id: string) => Promise<ReceivedTestHostState | null>; list: () => Promise<ReceivedTestHostState[]>}}).hosts;
 const list = spyOn(hosts, 'list').mockRejectedValue(Error('Unrelated fleet lookup')); const get = spyOn(hosts, 'get');
 try {
  const waiting = await f.prepareLegacy('job-one');
  expect(list).not.toHaveBeenCalled(); expect(get.mock.calls).toEqual([[host.hostId]]);
  expect(waiting.waitingReason).toBeDefined(); expect(waiting.fleetCandidatePreparation).toEqual(original.fleetCandidatePreparation);
  expect((waiting as {resourceTarget?: unknown}).resourceTarget).toBeUndefined(); expect(f.row).toEqual(original); expect(f.bindWrites).toBe(0);
 } finally {list.mockRestore(); get.mockRestore();}
});
