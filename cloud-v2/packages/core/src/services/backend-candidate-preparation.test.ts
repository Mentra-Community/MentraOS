import {expect, test, spyOn} from 'bun:test'
import {RoutineJobService, routineJobInputDigest, routineJobRepository, recorderCapacityRequirements, compatibleStructuralRoutineLane, routineLaneContext, routineLaneDescriptorRevision} from './routine-job.service'
import {candidateRequestCurrent, candidateSettlement, qualifiedCandidate, candidatePrerequisiteRequestMatches, candidateReturnMatches, candidateRenewal, completedCandidatePreparationForHost} from './backend-candidate-preparation'
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures'
import {requestInputDigest, TestRequestService, type TestRequestRepository} from './test-request.service'
import type {RoutineJobRepository} from './routine-job.service'
import type {StoredRoutineJob, FleetCandidatePreparation} from '../types/routine-job.types'
import {hostStateSchema, type ReceivedTestHostState} from './test-host-state.service'
import {TestRequestModel} from '../models/test-request.model'
import {type ResourceReservationHost, ResourceReservationsService, resourceReservationRepository, routineResourcesAvailable} from './resource-reservations.service'
import {mock} from 'bun:test'
import {createTestRequestsApi} from '../api/internal/test-requests.api'
import {TestHostStateModel} from '../models/test-host-state.model'
import {hostResourceReservationsSchema,isExclusiveHostReservation} from '../types/resource-reservations.types'
import type {RecorderHostReservation} from '../types/recorder-storage.types'

const initialNow = Date.parse('2026-10-20T12:00:00Z'), hash = (c: string) => c.repeat(64)
function fixture(exclusive = false) {
  let now = initialNow, writes = 0, bindWrites = 0
  const definition = {id:'probe',minimumRoutineApiVersion:1,title:'A check',purpose:'Verify independently',platforms:['android'],entry:'home',account:'lane',requirements:[],fixtures:exclusive?[{provider:'google-authentication',description:'Use the existing test account'}]:[],
    steps:[{id:'check',instruction:'Check',expected:'Checked'}],execution:{resourceKinds:['phone','app','recorder','network',...(exclusive?['fixture-data']:[])],policy:{estimatedOutputBytes:1024}},
    resourceRequirements:[{kind:'phone',capabilities:['backend-connectivity']},{kind:'app',capabilities:[]},{kind:'recorder',capabilities:[]},{kind:'network',capabilities:['independent-uplink']},
      ...(exclusive?[{kind:'fixture-data',capabilities:['google-authentication']}]:[])],
    source:{repository:'Mentra-Community/Mentra-Automated-Testing',revision:'a'.repeat(40),path:'routines/probe/routine.ts'}}
  const source = {channel:'pr' as const,prNumber:12,buildRunId:55,publicationAttempt:1}, build = {kind:'android-apk' as const,repository:'Mentra-Community/MentraOS',channel:'pr',prNumber:12,source,headSha:'b'.repeat(40),
    archive:{name:'app.apk',size:100,sha256:hash('c'),url:'https://artifactscdn.mentraglass.com/app.apk'}, receipt:{size:10,sha256:hash('d'),url:'https://artifactscdn.mentraglass.com/receipt.json'}}
  let row = {requestId:'job-one',state:'awaiting-runner',fleetSelection:{requestId:'job-one',routineId:'probe',platform:'android',source,routineRevision:'a'.repeat(40),build},
    fleetPreparation:{routineSource:testRoutineSource(),definitionSha256:requestInputDigest(definition),definition,requirements:{platform:'android',resources:definition.resourceRequirements}},
    fleetDeadline:new Date(now+300_000),createdAt:new Date(now)} as unknown as StoredRoutineJob
  row.fleetSelectionSha256=requestInputDigest(row.fleetSelection);row.fleetInputSha256=routineJobInputDigest(row)
  const hosts = ['air1','air2'].map(hostId => ({hostId,incarnation:`${hostId}-one`,incarnationGeneration:1,sequence:1,
    observedAt:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),frameworkBinding:{...testFrameworkBinding(),version:1200,routineApiVersion:70},
    resourceReservations:{claims:[],returns:[],candidatePrerequisites:[]},authorityReservations:[],lanes:[{id:'android',platform:'android',state:'idle',dispatchMode:'automatic',resources:[
      {id:`${hostId}:phone`,kind:'phone',capabilities:['backend-connectivity']},{id:`${hostId}:app`,kind:'app'},
      {id:`${hostId}:recorder`,kind:'recorder',storage:{poolId:`${hostId}:disk`,observedAt:new Date(now).toISOString(),availableBytes:64*1024**3,stagingBudgetBytes:10*1024**3,pendingEvidenceBytes:0,reservations:[]}},
      {id:`${hostId}:network`,kind:'network',capabilities:['independent-uplink']},
      ...(exclusive?[{id:`${hostId}:fixtures`,kind:'fixture-data',capabilities:['google-authentication'],exclusiveDependencies:[{resourceId:'conference-account',authorityHostId:'air2',capability:'google-authentication'}]}]:[])]}],
      ...(exclusive?{resources:[{id:'conference-account',kind:'fixture-data',capabilities:['google-authentication']}]}:{}),resourceLifecycle:{schemaVersion:1,history:[],subjects:[{
        subject:{kind:'resource',id:`${hostId}:phone`,authorityHostId:hostId},generation:1,current:true,status:'unknown',owner:null,
        observedAt:new Date(now).toISOString(),receivedAt:null,reason:null,
        idle:{contractVersion:'phone-baseline',outcome:'not-checked',checkedAt:null,acceptedCheck:null,qualifiedScope:{kind:'same-controller',controllerId:hostId},evidenceRefs:[]},
        repair:{configured:true,state:'none'},supportedActions:[],resource:{kind:'phone',capabilities:['backend-connectivity'],memberships:[{hostId,laneId:'android'}],dependencies:[],placement:'installed'}}]}} as unknown as ReceivedTestHostState))
  const copy = <T>(v:T):T=>structuredClone(v)
  const rows = {async get(id:string){return id===row.requestId?copy(row):null},async recorderClaims(){return []},async selectedLanes(){return [{requestId:'other',hostId:'air2',laneId:'android'}]},
    async *qualificationCandidates(){yield copy(row)},
    async candidatePreparation(original:StoredRoutineJob,pending:FleetCandidatePreparation){if(row.fleetCandidatePreparation||row.fleetCandidateSelection && candidateRenewal(row,pending.hostId,pending.laneId)?.candidate.attemptId!==pending.candidate.previousAttemptId||JSON.stringify(original)!==JSON.stringify(row))return null;writes++;row={...row,fleetCandidatePreparation:copy(pending),fleetCandidateSelection:undefined};return copy(row)},
    async settleCandidatePreparation(original:StoredRoutineJob,pending:FleetCandidatePreparation){if(JSON.stringify(original)!==JSON.stringify(row))return null;row={...row,fleetCandidatePreparations:[...row.fleetCandidatePreparations??[],copy(pending)],fleetCandidatePreparation:undefined,
      ...(pending.settlement?.outcome==='qualified'&&row.state==='awaiting-runner'&&!row.fleetCancellation&&row.fleetDeadline.getTime()>now?{fleetCandidateSelection:{hostId:pending.hostId,laneId:pending.laneId,targetInputSha256:pending.targetInputSha256}}:{})};return copy(row)},
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
  return {service,rows,hosts,settle,get row(){return row},set row(v){row=v},get writes(){return writes},get bindWrites(){return bindWrites},advance(ms:number){now+=ms;for(const h of hosts){h.observedAt=h.receivedAt=new Date(now).toISOString();for(const subject of h.resourceLifecycle?.subjects??[])subject.observedAt=h.observedAt;h.lanes[0]!.resources.find(r=>r.kind==='recorder')!.storage!.observedAt=new Date(now).toISOString()}},get now(){return now}}
}

test('unknown first phone is probed unbound; settled negative falls back within the same original request, positive permits resource selection',async()=>{
 const f=fixture();await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation?.hostId).toBe('air1');expect(f.bindWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined()
 const originalInput=f.row.fleetInputSha256;f.settle('unqualified');await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparations).toHaveLength(1);expect(f.row.fleetCandidatePreparation?.hostId).toBe('air2');expect(f.bindWrites).toBe(0)
 f.settle('qualified');await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetCandidateSelection?.hostId).toBe('air2');expect(f.row.fleetResourceReservation?.hostId).toBe('air2');expect(f.row.fleetInputSha256).toBe(originalInput);expect(f.row.fleetBinding).toBeUndefined()
})
for(const gap of ['raw-work','return-ack','claim','replacement'] as const)test(`candidate ${gap} never moves original custody to another phone`,async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('unqualified',gap!=='raw-work',gap!=='return-ack');const old=structuredClone(f.row.fleetCandidatePreparation)
 if(gap==='claim')f.hosts[0]!.authorityReservations=[{...structuredClone(f.row.fleetCandidatePreparation!.claimReceipt!),prerequisite:undefined,resourceCheck:undefined,owner:{id:'other',kind:'run'}}] as any
 if(gap==='replacement')f.hosts[0]!.incarnation='other'
 await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation?.hostId).toBe('air1');expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0)
})

test('a delayed fully returned negative settles historically and selects a fresh alternate under the same original deadline',async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('unqualified');
 const original=structuredClone(f.row),negative=structuredClone(f.row.fleetCandidatePreparation!),health=structuredClone(f.hosts[0]!.lanes[0]!.resources[0]!.backendConnectivity);
 f.advance(120001);await f.service.preparation('job-one');
 expect(f.row.fleetCandidatePreparations).toEqual([{...negative,settlement:{targetInputSha256:negative.targetInputSha256,candidate:negative.candidate,outcome:'unqualified',hostWorkSettled:true,checkOperationId:`backend-prerequisite:${negative.targetInputSha256}`}}]);
 expect(f.hosts[0]!.lanes[0]!.resources[0]!.backendConnectivity).toEqual(health);
 expect(f.row.fleetCandidatePreparation?.hostId).toBe('air2');expect(f.row.fleetCandidatePreparation?.candidate.attemptId).not.toBe(negative.candidate.attemptId);
 expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetResourceReservation).toBeUndefined();expect(f.bindWrites).toBe(0);
 f.settle('qualified');await f.service.preparation('job-one');
 expect(f.row.fleetCandidateSelection?.hostId).toBe('air2');expect(f.row.fleetResourceReservation?.hostId).toBe('air2');
 for(const field of ['requestId','fleetSelection','fleetSelectionSha256','fleetPreparation','fleetInputSha256','fleetDeadline','createdAt'] as const)expect(f.row[field]).toEqual(original[field]);
 expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetCandidatePreparations![0]).toEqual({...negative,settlement:{targetInputSha256:negative.targetInputSha256,candidate:negative.candidate,outcome:'unqualified',hostWorkSettled:true,checkOperationId:`backend-prerequisite:${negative.targetInputSha256}`}});
})
for(const gap of ['raw-work','return-ack','claim','replacement','subject-generation','binding','app','future-observation','observation-after-deadline','close-before-observation','return-before-close','stale-report'] as const)test(`delayed negative retains original custody with ${gap}`,async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('unqualified',gap!=='raw-work',gap!=='return-ack');
 f.advance(120001);const host=f.hosts[0]!,health=host.lanes[0]!.resources[0]!.backendConnectivity!;
 if(gap==='claim')host.authorityReservations=[{...structuredClone(f.row.fleetCandidatePreparation!.claimReceipt!),prerequisite:undefined,resourceCheck:undefined,owner:{id:'other',kind:'run'}}] as any;
 if(gap==='replacement')host.incarnation='other';if(gap==='subject-generation')host.resourceLifecycle!.subjects[0]!.generation++;
 if(gap==='binding')health.binding={...health.binding,version:health.binding.version+1};if(gap==='app')health.app.archiveSha256=hash('a');
 if(gap==='future-observation')health.observedAt=new Date(f.now+1).toISOString();
 if(gap==='observation-after-deadline'){f.advance(180001);health.observedAt=health.check.closedAt=new Date(f.now).toISOString();(f.row.fleetCandidatePreparation!.returnReceipt as any).release.releasedAt=health.check.closedAt;}
 if(gap==='close-before-observation')health.check.closedAt=new Date(Date.parse(health.observedAt)-1).toISOString();
 if(gap==='return-before-close')health.check.closedAt=new Date(Date.parse(health.check.closedAt)+1).toISOString();
 if(gap==='stale-report')host.observedAt=host.receivedAt=new Date(f.now-120001).toISOString();
 const pending=structuredClone(f.row.fleetCandidatePreparation!);await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation).toEqual(pending);expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetCandidatePreparations).toBeUndefined();expect(f.row.fleetBinding).toBeUndefined();
})
test('delayed negative cancellation settles original history without selecting another candidate',async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('unqualified');f.advance(120001);
 f.row={...f.row,state:'terminal',terminalStatus:'cancelled',fleetCancellation:{requestedAt:new Date(f.now).toISOString(),reason:'cancelled'}};
 await f.service.preparation('job-one');expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetCandidateSelection).toBeUndefined();
 expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetCandidatePreparations?.[0]?.settlement?.outcome).toBe('unqualified');
})
test('delayed negative after the original deadline records only settled history',async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('unqualified');const deadline=structuredClone(f.row.fleetDeadline);f.advance(300001);
 await f.service.preparation('job-one');expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetCandidateSelection).toBeUndefined();
 expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetCandidatePreparations?.[0]?.settlement?.outcome).toBe('unqualified');expect(f.row.fleetDeadline).toEqual(deadline);
})

test('an in-window negative may deliver authentic raw closure and return after expiry without renewing the request',async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('unqualified');const deadline=structuredClone(f.row.fleetDeadline),health=f.hosts[0]!.lanes[0]!.resources[0]!.backendConnectivity!;
 f.advance(300001);health.check.closedAt=new Date(f.now).toISOString();(f.row.fleetCandidatePreparation!.returnReceipt as any).release.releasedAt=health.check.closedAt;
 const original=structuredClone(f.row.fleetCandidatePreparation!);await f.service.preparation('job-one');
 expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetCandidatePreparations?.[0]).toEqual({...original,settlement:{targetInputSha256:original.targetInputSha256,candidate:original.candidate,outcome:'unqualified',hostWorkSettled:true,checkOperationId:`backend-prerequisite:${original.targetInputSha256}`}});
 expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetDeadline).toEqual(deadline);expect(f.row.fleetCandidateSelection).toBeUndefined();expect(f.row.fleetBinding).toBeUndefined();
})

test('completed candidate metadata survives a lost read reply and alternate binding without reader or execution authority',async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('unqualified');f.advance(120001);await f.service.preparation('job-one');
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
 expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations);expect(f.writes).toBe(2);expect(f.bindWrites).toBe(0);
})
for(const changed of ['job','deadline','selection','input','history-budget','duplicate-attempt','host','target','definition','settlement','return-ack','matching-pending'] as const)test(`historical candidate metadata refuses ${changed}`,async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle('unqualified');f.advance(120001);await f.service.preparation('job-one');
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
 const f=fixture(exclusive);await f.service.preparation('job-one');f.settle('qualified');await f.service.preparation('job-one');
 f.row.fleetResourceReservation!.minimumAvailableBytes=recorderCapacityRequirements(f.row.fleetPreparation!).resources.find(r=>r.kind==='recorder')!.storage!.minimumAvailableBytes;
 return f;
}
for(const phase of ['recorder-read','request-read','host-cas'] as const)for(const elapsed of [1,2])test(`ordinary backend binding ${phase} ${elapsed===1?'keeps exact-age proof':'refuses expired proof despite a newer physical baseline'}`,async()=>{
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
  expect(filter.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations);expect(filter.fleetDeadline).toEqual({$gt:new Date(f.now)});
  f.row={...f.row,...structuredClone(update.$set)};return structuredClone(f.row);
 }) as never;
 try{
  const bound=await routineJobRepository.bind(original.requestId,original.fleetInputSha256!,{jobId:original.requestId,requestId:original.requestId,
   hostId:'air1',laneId:'android',descriptorRevision:routineLaneDescriptorRevision(host.snapshot.lanes[0]!),actionsRunId:'1',actionsJobId:'2',boundAt:new Date(bindingNow).toISOString()}, {},new Date(bindingNow));
  expect(qualifiedCandidate(original,host.snapshot,'android',f.now,host.receivedAt)!==undefined).toBe(elapsed===1);
  expect(host.snapshot.resourceLifecycle!.subjects[0]!.idle.checkedAt).toBe(new Date(bindingNow).toISOString());
  expect(f.now-Date.parse(host.snapshot.lanes[0]!.resources[0]!.backendConnectivity!.observedAt)).toBe(119999+elapsed);
  expect(bindingWrites).toBe(elapsed===1?1:0);expect(hostCas).toBe(elapsed===1||phase==='host-cas'?1:0);
  if(elapsed===1){expect(bound?.state).toBe('preparing');expect(bound?.fleetBinding?.hostId).toBe('air1')}
  else{expect(bound).toBeNull();expect(f.row).toEqual(original)}
  expect(host.resourceReservations).toEqual([claim]);expect(f.row.fleetResourceReservation).toEqual(claim);
  expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations);expect(f.row.fleetDeadline).toEqual(original.fleetDeadline);
 }finally{TestRequestModel.collection.findOne=find;TestRequestModel.collection.findOneAndUpdate=write;resourceReservationRepository.get=read;
  resourceReservationRepository.recorderClaims=claims;resourceReservationRepository.replace=replace;clock.mockRestore()}
});
for(const elapsed of [1,2])test(`ordinary backend staging after recorder read ${elapsed===1?'keeps exact-age proof':'refuses expired proof despite a newer physical baseline'}`,async()=>{
 const f=await returnedFixture();f.advance(119999);
 const host=repositoryEnvelope(f),claim=structuredClone(f.row.fleetResourceReservation!),original=structuredClone(f.row);let stages=0;
 const service=new ResourceReservationsService({async request(){return structuredClone(f.row)},async get(){return structuredClone(host)},
  async recorderClaims(){f.advance(elapsed);return [claim]},async stageBackend(_id,_digest,value){stages++;f.row.fleetResourceAdmission=structuredClone(value);return structuredClone(f.row)},
  async claimedHosts(){return []},async replace(){throw Error('Unexpected dependency claim')}},()=>f.now);
 const admitted=await service.reserveFleet(f.row.requestId,f.row.fleetInputSha256!,'air1','android');
 expect(qualifiedCandidate(original,host.snapshot,'android',f.now,host.receivedAt)!==undefined).toBe(elapsed===1);
 expect(stages).toBe(elapsed===1?1:0);expect(host.resourceReservations).toEqual([claim]);
 if(elapsed===1)expect(admitted).toBeUndefined();else{expect(admitted).toBeNull();expect(f.row).toEqual(original)}
});
for(const phase of ['stage-request','stage-recorder','stage-host','final-stage-request','final-stage-host'] as const)for(const elapsed of [1,2])test(`ordinary backend repository staging ${phase} ${elapsed===1?'keeps exact-age proof':'refuses expired proof despite a newer physical baseline'}`,async()=>{
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
 TestRequestModel.collection.findOneAndUpdate=mock(async(filter:any,update:any)=>{stages++;expect(filter.fleetCandidateSelection).toEqual(original.fleetCandidateSelection);
  stagedDeadline=filter.fleetDeadline;f.row={...f.row,...structuredClone(update.$set)};return structuredClone(f.row)}) as never;
 try{
  const staged=await resourceReservationRepository.stageBackend!(f.row.requestId,f.row.fleetInputSha256!,admission,host,new Date(stageNow));
  expect(qualifiedCandidate(original,host.snapshot,'android',f.now,host.receivedAt)!==undefined).toBe(elapsed===1);
  expect(stages).toBe(elapsed===1?1:0);if(elapsed===1){expect(staged?.fleetResourceAdmission).toEqual(admission);expect(stagedDeadline).toEqual({$gt:new Date(f.now)})}else{expect(staged).toBeNull();expect(f.row).toEqual(original)}
  expect(host.resourceReservations).toEqual([claim]);expect(f.row.fleetResourceReservation).toEqual(claim);expect(f.row.fleetDeadline).toEqual(original.fleetDeadline);
 }finally{resourceReservationRepository.request=request;resourceReservationRepository.recorderClaims=recorder;resourceReservationRepository.get=get;
  TestRequestModel.collection.findOneAndUpdate=write;clock.mockRestore()}
});
for(const phase of ['stage-return','retained-read','claim-request','claim-host','post-cas'] as const)for(const elapsed of [1,2])test(`ordinary backend exclusive admission ${phase} ${elapsed===1?'keeps exact-age proof':'refuses expired proof and retains any original committed custody'}`,async()=>{
 const f=await returnedFixture(true);f.advance(119999);
 const host=repositoryEnvelope(f),claim=structuredClone(f.row.fleetResourceReservation!),{receivedAt,authorityReservations,...snapshot}=structuredClone(f.hosts[1]!);
 snapshot.frameworkAcceptedAt=snapshot.observedAt;snapshot.frameworkProcess={pid:124,startedAt:snapshot.observedAt};
 const authority={...structuredClone(host),hostId:'air2',incarnation:'air2-one',resourceReservations:[] as unknown[],receivedAt:new Date(receivedAt),
  snapshot:hostStateSchema.parse(snapshot)},original=structuredClone(f.row);let requestReads=0,writes=0;
 const service=new ResourceReservationsService({async request(){if(++requestReads===2&&phase==='claim-request')f.advance(elapsed);return structuredClone(f.row)},
  async get(id){if(id==='air2'&&phase==='claim-host')f.advance(elapsed);return structuredClone(id==='air1'?host:authority)},async recorderClaims(){return [claim]},
  async stageBackend(_id,_digest,value){f.row.fleetResourceAdmission=structuredClone(value);if(phase==='stage-return')f.advance(elapsed);return structuredClone(f.row)},
  async claimedHosts(){if(phase==='retained-read')f.advance(elapsed);return []},
  async replace(_host,next){writes++;authority.resourceReservations=structuredClone(next);if(phase==='post-cas')f.advance(elapsed);return true}},()=>f.now);
 const admitted=await service.reserveFleet(f.row.requestId,f.row.fleetInputSha256!,'air1','android');
 expect(qualifiedCandidate(original,host.snapshot,'android',f.now,host.receivedAt)!==undefined).toBe(elapsed===1);
 expect(writes).toBe(elapsed===1||phase==='post-cas'?1:0);expect(authority.resourceReservations).toHaveLength(writes);
 if(elapsed===1){expect(admitted?.claims).toEqual(hostResourceReservationsSchema.parse(authority.resourceReservations).filter(isExclusiveHostReservation));expect(admitted?.intent.owner).toEqual({id:original.requestId,kind:'run'})}else expect(admitted).toBeNull();
 expect(host.resourceReservations).toEqual([claim]);expect(f.row.fleetResourceReservation).toEqual(claim);expect(f.row.fleetResourceAdmission?.intent.hostId).toBe('air1');
 expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations);expect(f.row.fleetDeadline).toEqual(original.fleetDeadline);
});
test('an existing ordinary admission never substitutes fresh physical readiness for expired backend proof; unassigned candidate and offline checks remain available',async()=>{
 const f=await returnedFixture(),claim=structuredClone(f.row.fleetResourceReservation!);let host=repositoryEnvelope(f);
 const service=new ResourceReservationsService({async request(){return structuredClone(f.row)},async get(){return structuredClone(host)},async recorderClaims(){return [claim]},
  async stageBackend(_id,_digest,value){f.row.fleetResourceAdmission=structuredClone(value);return structuredClone(f.row)},async claimedHosts(){return []},async replace(){throw Error('Unexpected dependency claim')}},()=>f.now);
 expect(await service.reserveFleet(f.row.requestId,f.row.fleetInputSha256!,'air1','android')).toBeUndefined();
 f.advance(120001);host=repositoryEnvelope(f);const original=structuredClone(f.row);
 expect(routineResourcesAvailable(host,f.row,'android',f.now)).toBe(false);
 expect(await service.reserveFleet(f.row.requestId,f.row.fleetInputSha256!,'air1','android')).toBeNull();expect(f.row).toEqual(original);expect(host.resourceReservations).toEqual([claim]);
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
 f.advance(120001);await f.service.preparation(f.row.requestId);const pending=structuredClone(f.row.fleetCandidatePreparation!);f.row=structuredClone(original);
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
test('expiry after provisional claims stays unbound through exact return, negative renewal and a ready alternate',async()=>{
 const f=await returnedFixture(),original=structuredClone(f.row.fleetCandidatePreparations![0]!),claim=structuredClone(f.row.fleetResourceReservation!);
 const host=repositoryEnvelope(f);f.hosts[0]!.authorityReservations=[claim];f.advance(120001);host.receivedAt=new Date(f.now);host.snapshot.observedAt=new Date(f.now).toISOString();host.snapshot.lanes[0]!.resources.find(r=>r.kind==='recorder')!.storage!.observedAt=host.snapshot.observedAt;
 await f.service.preparation('job-one');const pending=structuredClone(f.row.fleetCandidatePreparation!);
 expect(pending?.provisionalReturn?.recorder).toEqual(claim);expect(candidateRequestCurrent(f.row,pending,f.now)).toBe(false);expect(f.row.fleetBinding).toBeUndefined();expect(f.writes).toBe(2);
 const get=routineJobRepository.get,read=resourceReservationRepository.get,replace=resourceReservationRepository.replace,write=TestRequestModel.collection.findOneAndUpdate;let removals=0,loss=true;
 routineJobRepository.get=async()=>structuredClone(f.row);resourceReservationRepository.get=async()=>structuredClone(host);
 resourceReservationRepository.replace=async(_host,claims)=>{removals++;host.resourceReservations=structuredClone(claims);if(loss){loss=false;throw Error('Original claim return response lost')}return true};
 TestRequestModel.collection.findOneAndUpdate=mock(async(filter:any,update:any)=>{expect(filter.fleetCandidatePreparation).toEqual(pending);for(const key of Object.keys(update.$unset??{}))delete (f.row as any)[key];f.row={...f.row,...update.$set};return structuredClone(f.row)}) as any;
 try {
  await expect(routineJobRepository.releaseCandidateProvisional!(f.row,new Date(f.now))).rejects.toThrow('return response lost');expect(f.row.fleetCandidatePreparation).toEqual(pending);expect(f.row.fleetResourceReservation).toEqual(claim);
  expect(await routineJobRepository.releaseCandidateProvisional!(f.row,new Date(f.now))).toMatchObject({fleetCandidatePreparation:{provisionalReturn:{releasedAt:new Date(f.now).toISOString()}}});expect(removals).toBe(1);expect(f.row.fleetResourceReservation).toBeUndefined();
 }finally{routineJobRepository.get=get;resourceReservationRepository.get=read;resourceReservationRepository.replace=replace;TestRequestModel.collection.findOneAndUpdate=write}
 f.hosts[0]!.authorityReservations=[];expect(candidateRequestCurrent(f.row,f.row.fleetCandidatePreparation,f.now)).toBe(true);
 f.settle('unqualified');await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation?.hostId).toBe('air2');expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetCandidatePreparations![0]).toEqual(original);
 f.settle('qualified');await f.service.preparation('job-one');expect(f.row.fleetResourceReservation?.hostId).toBe('air2');expect(f.row.fleetCandidateSelection?.hostId).toBe('air2');expect(f.row.fleetDeadline.getTime()).toBe(initialNow+300000);
})
for(const condition of ['local-consumer','foreign-byte','stale-storage','replacement','invalid-received','invalid-observed'] as const)test(`provisional return retains all authority when ${condition} appears`,async()=>{
 const f=await returnedFixture(),host=repositoryEnvelope(f);f.hosts[0]!.authorityReservations=[f.row.fleetResourceReservation!];f.advance(120001);await f.service.preparation('job-one');const pending=structuredClone(f.row.fleetCandidatePreparation!);
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
 f.advance(120001);await f.service.preparation('job-one');const pending=structuredClone(f.row.fleetCandidatePreparation!);expect(pending.provisionalReturn?.exclusive?.claims).toEqual([exclusive]);
 const borrower=repositoryEnvelope(f);borrower.resourceReservations=[claim];borrower.receivedAt=new Date(f.now);borrower.snapshot.observedAt=new Date(f.now).toISOString();borrower.snapshot.lanes[0]!.resources.find(r=>r.kind==='recorder')!.storage!.observedAt=borrower.snapshot.observedAt;
 const authority:ResourceReservationHost={...structuredClone(borrower),hostId:'air2',incarnation:'air2-one',resourceReservations:[exclusive],snapshot:{...structuredClone(borrower.snapshot),hostId:'air2',incarnation:'air2-one',lanes:[{id:'account',platform:'ios-on-mac',dispatchMode:'automatic',state:'idle',resources:[{id:'shared-account',kind:'fixture-data',capabilities:['google-authentication']}]}],resourceLifecycle:{schemaVersion:1,history:[],subjects:[{...structuredClone(borrower.snapshot.resourceLifecycle!.subjects[0]!),subject:{kind:'resource',id:'shared-account',authorityHostId:'air2'},observedAt:new Date(f.now).toISOString()}]}}};
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
   claimed=resourceReservationRepository.claimedHosts,request=resourceReservationRepository.request,get=routineJobRepository.get;
 let hostWrites=0,checkpointWrites=0,admissionWrites=0;const clock=spyOn(Date,'now').mockImplementation(()=>f.now);
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
 TestHostStateModel.collection.findOneAndUpdate=mock(async()=>{hostWrites++;throw Error('The original host claim must not be repeated')}) as never;
 TestRequestModel.collection.findOneAndUpdate=mock(async(filter:any,update:any)=>{
  if(!matches(filter))return null;
  if(update.$set.fleetResourceAdmission)admissionWrites++;
  if(update.$set.fleetResourceReservation&&!f.row.fleetResourceAdmission)checkpointWrites++;
  f.row={...f.row,...update.$set};return structuredClone(f.row);
 }) as never;
 f.rows.recorderClaims=async()=>[structuredClone(claim)];f.rows.checkpointBackendRecorder=(row,original,now)=>routineJobRepository.checkpointBackendRecorder!(row,original,now);
 f.rows.reserveResources=(...args)=>routineJobRepository.reserveResources!(...args);
 const currentRow=():StoredRoutineJob=>f.row;
 try{
  expect(qualifiedCandidate(f.row,f.hosts[0]!,'android',f.now,f.hosts[0]!.receivedAt)).toBeDefined();
  await f.service.preparation('job-one');
  expect(admissionWrites).toBe(expiry?0:1);expect(checkpointWrites).toBe(0);expect(hostWrites).toBe(0);
  if(expiry){
   expect(f.row.fleetResourceReservation).toBeUndefined();expect(f.row.fleetResourceAdmission).toBeUndefined();
   expect(host.resourceReservations).toEqual([claim]);
   const fresh=repositoryEnvelope(f);host.receivedAt=fresh.receivedAt;host.snapshot=fresh.snapshot;
   await f.service.preparation('job-one');expect(checkpointWrites).toBe(1);expect(admissionWrites).toBe(0);
   expect(f.row.fleetCandidatePreparation!.provisionalReturn!.recorder).toEqual(claim);
  }else{
   expect(currentRow().fleetResourceReservation).toEqual(claim);expect(currentRow().fleetResourceAdmission?.intent.hostId).toBe('air1');
   expect(f.row.fleetCandidatePreparation).toBeUndefined();
  }
  expect(f.row.fleetCandidatePreparations).toHaveLength(1);
  expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetDeadline.getTime()).toBe(initialNow+300000);
 }finally{TestRequestModel.collection.findOne=requestRead;TestRequestModel.collection.find=requestList;TestRequestModel.collection.findOneAndUpdate=requestWrite;TestHostStateModel.collection.findOne=hostRead;TestHostStateModel.collection.findOneAndUpdate=hostWrite;
  resourceReservationRepository.recorderClaims=originals;resourceReservationRepository.get=read;resourceReservationRepository.claimedHosts=claimed;resourceReservationRepository.request=request;routineJobRepository.get=get;reserveClock.mockRestore();clock.mockRestore()}
});

test('lost recorder host-CAS reply is recovered as cleanup custody after health expires, returned once, then falls back',async()=>{
 const f=await returnedFixture(),currentRow=():StoredRoutineJob=>f.row;delete f.row.fleetResourceReservation;
 const host=repositoryEnvelope(f);host.resourceReservations=[];
 const requestRead=TestRequestModel.collection.findOne,requestWrite=TestRequestModel.collection.findOneAndUpdate,
   hostRead=TestHostStateModel.collection.findOne,hostWrite=TestHostStateModel.collection.findOneAndUpdate,
   claims=resourceReservationRepository.recorderClaims,read=resourceReservationRepository.get,replace=resourceReservationRepository.replace,
   get=routineJobRepository.get;
 let claimWrites=0,returnWrites=0,checkpointLoss=true;const clock=spyOn(Date,'now').mockImplementation(()=>f.now);
 const originals=()=>hostResourceReservationsSchema.parse(host.resourceReservations??[]).filter((value):value is RecorderHostReservation=>!isExclusiveHostReservation(value));
 resourceReservationRepository.recorderClaims=async()=>structuredClone(originals());resourceReservationRepository.get=async()=>structuredClone(host);
 routineJobRepository.get=async()=>structuredClone(f.row);
 TestRequestModel.collection.findOne=mock(async()=>structuredClone(f.row)) as never;
 TestHostStateModel.collection.findOne=mock(async()=>structuredClone(host)) as never;
 TestHostStateModel.collection.findOneAndUpdate=mock(async(_filter:any,update:any)=>{claimWrites++;host.resourceReservations=structuredClone(update.$set.resourceReservations);throw Error('Committed recorder reply lost')}) as never;
 TestRequestModel.collection.findOneAndUpdate=mock(async(filter:any,update:any)=>{
   if(update.$set.fleetResourceReservation){expect(filter).toMatchObject({fleetCandidatePreparation:{$exists:false},fleetResourceAdmission:{$exists:false},fleetResourceReservation:{$exists:false},fleetCandidateSelection:f.row.fleetCandidateSelection});
    f.row={...f.row,...update.$set};if(checkpointLoss){checkpointLoss=false;throw Error('Committed cleanup checkpoint reply lost')}return structuredClone(f.row)}
   expect(filter.fleetCandidatePreparation).toEqual(f.row.fleetCandidatePreparation);for(const key of Object.keys(update.$unset??{}))delete (f.row as any)[key];f.row={...f.row,...update.$set};return structuredClone(f.row)
 }) as never;
 f.rows.recorderClaims=async()=>structuredClone(originals());f.rows.checkpointBackendRecorder=(row,claim,now)=>routineJobRepository.checkpointBackendRecorder!(row,claim,now);
 f.rows.releaseCandidateProvisional=(row,now)=>routineJobRepository.releaseCandidateProvisional!(row,now);
 resourceReservationRepository.replace=async(_host,values)=>{returnWrites++;host.resourceReservations=structuredClone(values);return true};
 try{
  await expect(routineJobRepository.reserveResources!('job-one',f.row.fleetInputSha256!,'air1','android',new Date(f.now))).rejects.toThrow('Committed recorder reply lost');
  expect(claimWrites).toBe(1);expect(originals()).toHaveLength(1);expect(f.row.fleetResourceReservation).toBeUndefined();const claim=structuredClone(originals()[0]!);
  f.hosts[0]!.authorityReservations=[claim];f.advance(120001);host.receivedAt=new Date(f.now);host.snapshot.observedAt=new Date(f.now).toISOString();host.snapshot.lanes[0]!.resources.find(value=>value.kind==='recorder')!.storage!.observedAt=host.snapshot.observedAt;
  await expect(f.service.preparation('job-one')).rejects.toThrow('Committed cleanup checkpoint reply lost');expect(currentRow().fleetResourceReservation).toEqual(claim);expect(returnWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined();
  await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation!.provisionalReturn!.recorder).toEqual(claim);expect(candidateRequestCurrent(f.row,f.row.fleetCandidatePreparation,f.now)).toBe(false);
  await f.service.preparation('job-one');expect(returnWrites).toBe(1);expect(originals()).toEqual([]);expect(f.row.fleetResourceReservation).toBeUndefined();expect(f.row.fleetCandidatePreparation!.provisionalReturn!.releasedAt).toBeDefined();
  f.hosts[0]!.authorityReservations=[];f.settle('unqualified');await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation?.hostId).toBe('air2');expect(f.row.fleetBinding).toBeUndefined();expect(claimWrites).toBe(1);
  f.settle('qualified');await f.service.preparation('job-one');expect(currentRow().fleetResourceReservation?.hostId).toBe('air2');expect(f.row.fleetDeadline.getTime()).toBe(initialNow+300000);
 }finally{TestRequestModel.collection.findOne=requestRead;TestRequestModel.collection.findOneAndUpdate=requestWrite;TestHostStateModel.collection.findOne=hostRead;TestHostStateModel.collection.findOneAndUpdate=hostWrite;
  resourceReservationRepository.recorderClaims=claims;resourceReservationRepository.get=read;resourceReservationRepository.replace=replace;routineJobRepository.get=get;clock.mockRestore()}
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
 await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation?.hostId).toBe('air1');expect(f.bindWrites).toBe(0);
 f.settle('qualified');await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetCandidateSelection?.hostId).toBe('air1');
 const host=repositoryEnvelope(f);expect(await new ResourceReservationsService({async request(){return structuredClone(f.row)},async get(){return structuredClone(host)},async replace(){throw Error('Unexpected claim')},async recorderClaims(){return []}},()=>f.now).reserveFleet('job-one',f.row.fleetInputSha256!,'air1','android')).toBeNull();
});
for(const status of ['out-of-service','in-repair','reserved'] as const)test(`phone candidate intake refuses ${status} and selects a ready alternate without weakening its original return`,async()=>{
 const f=fixture(),subject=f.hosts[0]!.resourceLifecycle!.subjects[0]!;subject.status=status;
 if(status==='in-repair')subject.repair.state='queued';if(status==='reserved')subject.owner={id:'manual',kind:'authoring',generation:1,hostId:'air1'};
 await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation?.hostId).toBe('air2');expect(f.bindWrites).toBe(0);expect(f.row.fleetResourceReservation).toBeUndefined();
});


for(const phase of ['stage-return','retained-read','claim-request','claim-host','post-cas'] as const)for(const boundary of ['baseline-exact','baseline-expired','deadline'] as const)test(`ordinary offline exclusive admission ${phase} ${boundary} retains committed custody without a false receipt`,async()=>{
 const f=await returnedFixture(true),host=repositoryEnvelope(f),claim=structuredClone(f.row.fleetResourceReservation!);
 f.row.fleetPreparation!.requirements.resources.find(required=>required.kind==='phone')!.capabilities=[];
 host.snapshot.lanes[0]!.resources[0]!.idleContract!.maximumAgeMs=1;
 const {receivedAt,authorityReservations,...snapshot}=structuredClone(f.hosts[1]!);snapshot.frameworkAcceptedAt=snapshot.observedAt;snapshot.frameworkProcess={pid:124,startedAt:snapshot.observedAt};
 const authority={...structuredClone(host),hostId:'air2',incarnation:'air2-one',resourceReservations:[] as unknown[],receivedAt:new Date(receivedAt),snapshot:hostStateSchema.parse(snapshot)},original=structuredClone(f.row);
 let requestReads=0,writes=0,delayed=false;
 const delay=()=>{if(delayed)return;delayed=true;f.advance(boundary==='deadline'?original.fleetDeadline.getTime()-f.now:boundary==='baseline-exact'?1:2)};
 const service=new ResourceReservationsService({async request(){if(++requestReads===2&&phase==='claim-request')delay();return structuredClone(f.row)},
  async get(id){if(id==='air2'&&phase==='claim-host')delay();return structuredClone(id==='air1'?host:authority)},async recorderClaims(){return [claim]},
  async stageBackend(_id,_digest,value){f.row.fleetResourceAdmission=structuredClone(value);if(phase==='stage-return')delay();return structuredClone(f.row)},
  async claimedHosts(){if(phase==='retained-read')delay();return []},async replace(_host,next){writes++;authority.resourceReservations=structuredClone(next);if(phase==='post-cas')delay();return true}},()=>f.now);
 const admitted=await service.reserveFleet(f.row.requestId,f.row.fleetInputSha256!,'air1','android');
 expect(writes).toBe(boundary==='baseline-exact'||phase==='post-cas'?1:0);expect(authority.resourceReservations).toHaveLength(writes);
 if(boundary==='baseline-exact')expect(admitted?.claims).toEqual(hostResourceReservationsSchema.parse(authority.resourceReservations).filter(isExclusiveHostReservation));else expect(admitted).toBeNull();
 expect(host.resourceReservations).toEqual([claim]);expect(f.row.fleetResourceReservation).toEqual(claim);expect(f.row.fleetResourceAdmission?.intent.hostId).toBe('air1');
 expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetSelection).toEqual(original.fleetSelection);expect(f.row.fleetPreparation).toEqual(original.fleetPreparation);expect(f.row.fleetDeadline).toEqual(original.fleetDeadline);
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
 await f.service.preparation('job-one');
 const original = structuredClone(f.row), outcome = scenario === 'returned-unknown' ? 'unknown' : scenario === 'expired-returned-positive' ? 'qualified' : 'unqualified';
 f.settle(outcome);
 const closed = structuredClone(f.row.fleetCandidatePreparation!), health = structuredClone(f.hosts[0]!.lanes[0]!.resources[0]!.backendConnectivity),
   receipt = structuredClone(f.hosts[0]!.resourceReservations!.candidatePrerequisites![0]!);
 expect(candidateReturnMatches(closed, closed.returnReceipt)).toBe(true);
 expect((closed.returnReceipt as import('../types/resource-reservations.types').ExclusiveResourceReturn).release).toMatchObject({kind: 'resource-check', operationId: receipt.checkOperationId, subjectGeneration: 3});
 expect(f.hosts[0]!.authorityReservations).toEqual([]);
 expect(f.hosts[0]!.resourceLifecycle!.subjects[0]!.owner).toBeNull();
 if (scenario === 'expired-returned-positive') f.advance(120001);
 await f.service.preparation('job-one');
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
 const f=fixture();await f.service.preparation('job-one');f.settle(outcome,gap!=='raw-work',gap!=='return-ack');f.advance(120001);
 const host=f.hosts[0]!,health=host.lanes[0]!.resources[0]!.backendConnectivity!;
 if(gap==='claim')host.authorityReservations=[{...structuredClone(f.row.fleetCandidatePreparation!.claimReceipt!),prerequisite:undefined,resourceCheck:undefined,owner:{id:'other',kind:'run'}}] as any;
 if(gap==='replacement')host.incarnation='other';if(gap==='subject-generation')host.resourceLifecycle!.subjects[0]!.generation++;
 if(gap==='binding')health.binding={...health.binding,version:health.binding.version+1};if(gap==='app')health.app.archiveSha256=hash('a');
 if(gap==='future-observation')health.observedAt=new Date(f.now+1).toISOString();
 if(gap==='observation-after-deadline'){f.advance(180001);health.observedAt=health.check.closedAt=new Date(f.now).toISOString();(f.row.fleetCandidatePreparation!.returnReceipt as any).release.releasedAt=health.check.closedAt;}
 if(gap==='close-before-observation')health.check.closedAt=new Date(Date.parse(health.observedAt)-1).toISOString();
 if(gap==='return-before-close')health.check.closedAt=new Date(Date.parse(health.check.closedAt)+1).toISOString();
 if(gap==='stale-report')host.observedAt=host.receivedAt=new Date(f.now-120001).toISOString();
 const pending=structuredClone(f.row.fleetCandidatePreparation!);await f.service.preparation('job-one');
 expect(f.row.fleetCandidatePreparation).toEqual(pending);expect(f.row.fleetCandidatePreparations).toBeUndefined();expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined();
})
for(const outcome of ['unknown','qualified'] as const)for(const boundary of ['cancelled','deadline'] as const)
test(`historical returned ${outcome} after ${boundary} records only immutable consumed history`,async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle(outcome);const closed=structuredClone(f.row.fleetCandidatePreparation!),original=structuredClone(f.row);
 if(boundary==='deadline')f.advance(300001);else{f.advance(120001);f.row={...f.row,state:'terminal',terminalStatus:'cancelled',fleetCancellation:{requestedAt:new Date(f.now).toISOString(),reason:'cancelled'}};}
 await f.service.preparation('job-one');expect(f.row.fleetCandidatePreparation).toBeUndefined();expect(f.row.fleetCandidatePreparations).toEqual([{...closed,settlement:{targetInputSha256:closed.targetInputSha256,candidate:closed.candidate,outcome,hostWorkSettled:true,checkOperationId:`backend-prerequisite:${closed.targetInputSha256}`}}]);
 expect(f.row.fleetCandidateSelection).toBeUndefined();expect(f.writes).toBe(1);expect(f.bindWrites).toBe(0);expect(f.row.fleetBinding).toBeUndefined();expect(f.row.fleetDeadline).toEqual(original.fleetDeadline);expect(f.row.fleetInputSha256).toEqual(original.fleetInputSha256);
})

for(const outcome of ['unknown','qualified'] as const)for(const boundary of ['cancelled','deadline','lost-cas'] as const)
test(`historical ${outcome} repository ${boundary} preserves exact original settlement CAS`,async()=>{
 const f=fixture();await f.service.preparation('job-one');f.settle(outcome);f.advance(120001);
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
