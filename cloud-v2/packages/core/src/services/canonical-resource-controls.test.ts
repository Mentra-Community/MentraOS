import {expect,test,mock} from 'bun:test'
import {createHash} from 'node:crypto'
import {randomUUID} from 'node:crypto'
import {hostStateSchema} from './test-host-state.service'
import {ResourceLifecycleService} from './resource-lifecycle.service'
import {LaneControlsService,type LaneControlRepository,type LaneControlHost} from './lane-controls.service'
import {ResourceReservationsService,resourceReservationRepository,type ResourceReservationHost} from './resource-reservations.service'
import {TestHostStateModel} from '../models/test-host-state.model'
import {resourceLifecycleSubjectSchema} from '../types/resource-lifecycle.types'
import {requestInputDigest} from './test-request.service'
import type {ResourceControlRecord} from '../types/lane-control.types'

const now=Date.parse('2026-10-20T20:00:00Z'),at=new Date(now).toISOString(),id='google-account-canonical',authority='mini',capability='google-authentication';
function subject(){return resourceLifecycleSubjectSchema.parse({subject:{kind:'resource',id,authorityHostId:authority},generation:7,status:'idle',observedAt:at,receivedAt:null,current:true,reason:null,owner:null,
 idle:{contractVersion:'google-credential-baseline-v1',outcome:'passed',checkedAt:at,acceptedCheck:{operationId:'baseline',subjectGeneration:7,resultSha256:'a'.repeat(64),acceptedAt:at},qualifiedScope:{kind:'fleet'},evidenceRefs:['private-baseline']},repair:{configured:true,state:'none'},supportedActions:['reserve','release','check','mark-out-of-service'],resource:{kind:'fixture-data',capabilities:[capability],memberships:[],dependencies:[],placement:'fleet'}})}
function hosts(){const dependency={resourceId:id,authorityHostId:authority,capability};return new Map<string,ResourceReservationHost>([
 [authority,{hostId:authority,incarnation:'mini-one',incarnationGeneration:1,sequence:1,receivedAt:new Date(now),resourceReservationVersion:0,laneControlVersion:0,laneControls:[],resourceReservations:[],snapshot:hostStateSchema.parse({hostId:authority,incarnation:'mini-one',incarnationGeneration:1,sequence:1,observedAt:at,resources:[{id,kind:'fixture-data',capabilities:[capability],idleContract:{version:'google-credential-baseline-v1',maximumAgeMs:120000,qualifiedScope:{kind:'fleet'},conditions:['credential-baseline'],repairConfigured:true}}],lanes:[],laneControls:{schemaVersion:1,receipts:[],resourceControls:true},resourceLifecycle:{schemaVersion:1,subjects:[subject()],history:[]}})}],
 ['air',{hostId:'air',incarnation:'air-one',incarnationGeneration:1,sequence:1,receivedAt:new Date(now),resourceReservationVersion:0,resourceReservations:[],snapshot:hostStateSchema.parse({hostId:'air',incarnation:'air-one',incarnationGeneration:1,sequence:1,observedAt:at,lanes:[{id:'mac',platform:'ios-on-mac',state:'idle',dispatchMode:'automatic',resources:[{id:'fixture',kind:'fixture-data',capabilities:[capability],exclusiveDependencies:[dependency]}]}]})}]
])}
const intent={operationId:'run:original',hostId:'air',laneId:'mac',controller:{incarnation:'air-one',generation:1,sequence:1},owner:{id:'original',kind:'run'},inputSha256:'b'.repeat(64),resources:[{id:'fixture',capabilities:[capability]}]};
function fixture(){const rows=hosts();let writes=0;const service=new ResourceReservationsService({get:async host=>structuredClone(rows.get(host)??null),replace:async(previous,claims)=>{const current=rows.get(previous.hostId)!;if(previous.laneControlVersion!==current.laneControlVersion||previous.resourceReservationVersion!==current.resourceReservationVersion)return false;current.resourceReservations=structuredClone(claims);current.resourceReservationVersion=(current.resourceReservationVersion??0)+1;writes++;return true}},()=>now);return {rows,service,writes:()=>writes}}

test('independent ResourceRef catalog retains canonical authority without inventing a lane',()=>{
 const f=hosts().get(authority)!.snapshot;expect(f.lanes).toEqual([]);expect(f.resources?.[0]?.id).toBe(id);expect(f.resourceLifecycle?.subjects[0]?.resource.memberships).toEqual([]);
 for(const resources of [[...f.resources!,...f.resources!],[{...f.resources![0],laneId:'invented'}]])expect(hostStateSchema.safeParse({...f,resources}).success).toBe(false);
 expect(hostStateSchema.safeParse({...f,lanes:[{id:'mac',platform:'ios-on-mac',state:'idle',dispatchMode:'automatic',resources:f.resources}]}).success).toBe(false);
});

test('shared Google subject uses existing delivery for reserve/release/check/manual restriction with no representative lane',async()=>{
 const rows=hosts(),core=rows.get(authority)!;let controlRows:ResourceControlRecord[]=[];
 const repository:LaneControlRepository={get:async host=>host===authority?{hostId:authority,receivedAt:core.receivedAt,observedAt:new Date(now),snapshot:core.snapshot,laneControlVersion:core.laneControlVersion,laneControls:structuredClone(controlRows)} as LaneControlHost:null,replace:async(_host,version,values)=>{if(version!==core.laneControlVersion)return false;core.laneControlVersion!++;controlRows=structuredClone(values) as ResourceControlRecord[];return true}};
 const resources=new ResourceLifecycleService();resources.detail=async()=>({generatedAt:at,subject:subject(),coverage:'actual canonical authority'});
 const service=new LaneControlsService(repository,()=>now,resources),input=(action:'reserve'|'release'|'check'|'mark-out-of-service')=>({operationId:randomUUID(),hostId:authority,subject:{resourceId:id,subjectGeneration:7},expiresAt:now+120000,action,...(action==='reserve'?{purpose:'Reserve original Google capability'}:{}),...(action==='release'?{reservation:{id:'manual',generation:8}}:{}),...(action==='mark-out-of-service'?{reason:'Operator unavailable'}:{})});
 const ack=async(command:ReturnType<typeof input>,result:unknown)=>service.exchange(authority,{schemaVersion:1,resourceControls:true,receipts:[{operationId:command.operationId,hostId:authority,subject:command.subject,inputSha256:requestInputDigest(controlRows.find(row=>row.command.operationId===command.operationId)!.command),completedAt:at,result}]});
 const reserve=input('reserve');expect(await service.submit(reserve,'alice')).not.toHaveProperty('laneId');await ack(reserve,{status:'accepted',reservation:{id:'manual',resourceId:id,generation:8,state:'granted',purpose:reserve.purpose,requestedAt:at}});
 await expect(service.submit(input('release'),'bob')).rejects.toThrow('your current');const release=input('release');await service.submit(release,'alice');await ack(release,{status:'accepted',reservation:{id:'manual',resourceId:id,generation:8,state:'released',purpose:reserve.purpose,requestedAt:at}});
 const check=input('check');await service.submit(check,'alice');await ack(check,{status:'accepted',check:{operationId:check.operationId,resourceId:id,generation:7,state:'settled'}});
 const mark=input('mark-out-of-service');await service.submit(mark,'alice');await ack(mark,{status:'accepted',resource:{resourceId:id,generation:8,status:'out-of-service'}});
 expect((await service.listResource(id,'alice')).controls).toHaveLength(4);expect(core.snapshot.lanes).toEqual([]);
});

for(const unavailable of ['missing','failed','manual-reserve','manual-check','out-of-service'] as const)test(`new shared dependency grant refuses ${unavailable} authority`,async()=>{
 const f=fixture(),host=f.rows.get(authority)!;
 if(unavailable==='missing')host.snapshot.resourceLifecycle!.subjects=[];
 if(unavailable==='failed'){host.snapshot.resourceLifecycle!.subjects[0]!.status='unknown';host.snapshot.resourceLifecycle!.subjects[0]!.idle.outcome='failed'}
 if(unavailable==='out-of-service')host.snapshot.resourceLifecycle!.subjects[0]!.status='out-of-service';
 if(unavailable==='manual-reserve'||unavailable==='manual-check')host.laneControls=[{command:{operationId:randomUUID(),hostId:authority,subject:{resourceId:id,subjectGeneration:7},operatorId:'c'.repeat(64),expiresAt:now+120000,action:unavailable==='manual-reserve'?'reserve':'check',...(unavailable==='manual-reserve'?{purpose:'Operator reserve'}:{})}}];
 expect((await f.service.acquire(intent,'air')).status).toBe('waiting');expect(f.writes()).toBe(0);expect(host.resourceReservations).toEqual([]);
});

test('exact existing dependency claim remains recoverable after new grants are withdrawn',async()=>{
 const f=fixture(),first=await f.service.acquire(intent,'air');expect(first.status).toBe('reserved');expect(f.writes()).toBe(1);
 f.rows.get(authority)!.snapshot.resourceLifecycle!.subjects[0]!.status='out-of-service';
 expect(await f.service.acquire(intent,'air')).toEqual(first);expect(f.writes()).toBe(1);
});

for(const state of ['unacknowledged','waiting','granted','returning','intended','active','unknown'] as const)test(`capability rollback retains original ${state} resource control and refuses a conflicting claim`,async()=>{
 const f=fixture(),host=f.rows.get(authority)!,operationId=randomUUID(),reservation=['waiting','granted','returning'].includes(state);
 host.snapshot.laneControls={schemaVersion:1,receipts:[]};
 const command={operationId,hostId:authority,subject:{resourceId:id,subjectGeneration:7},operatorId:'c'.repeat(64),expiresAt:now-1,
  action:reservation?'reserve' as const:'check' as const,...(reservation?{purpose:'Original operator reservation'}:{})};
 const result=reservation?{status:'accepted' as const,reservation:{id:'original',resourceId:id,generation:8,state:state as 'waiting'|'granted'|'returning',purpose:'Original operator reservation',requestedAt:at}}
  :{status:'accepted' as const,check:{operationId,resourceId:id,generation:7,state:state as 'intended'|'active'|'unknown'}};
 host.laneControls=[{command,...(state==='unacknowledged'?{}:{receipt:{operationId,hostId:authority,subject:command.subject,inputSha256:requestInputDigest(command),completedAt:at,result}})}];
 expect((await f.service.acquire(intent,'air')).status).toBe('waiting');expect(f.writes()).toBe(0);
 expect(host.resourceReservations).toEqual([]);expect((host.laneControls as ResourceControlRecord[])[0]!.command.operationId).toBe(operationId);
});

for(const state of ['released','cancelled','settled','refused'] as const)test(`capability rollback preserves ${state} history without blocking unrelated new custody`,async()=>{
 const f=fixture(),host=f.rows.get(authority)!,operationId=randomUUID(),reservation=state==='released'||state==='cancelled';host.snapshot.laneControls={schemaVersion:1,receipts:[]};
 const command={operationId,hostId:authority,subject:{resourceId:id,subjectGeneration:7},operatorId:'c'.repeat(64),expiresAt:now-1,
  action:reservation?'reserve' as const:'check' as const,...(reservation?{purpose:'Original operator reservation'}:{})};
 const result=state==='refused'?{status:'refused' as const,code:'not-supported',reason:'The installed controller refused the original'}:reservation?
  {status:'accepted' as const,reservation:{id:'original',resourceId:id,generation:8,state:state as 'released'|'cancelled',purpose:'Original operator reservation',requestedAt:at}}:
  {status:'accepted' as const,check:{operationId,resourceId:id,generation:7,state:'settled' as const}};
 host.laneControls=[{command,receipt:{operationId,hostId:authority,subject:command.subject,inputSha256:requestInputDigest(command),completedAt:at,result}}];
 expect((await f.service.acquire(intent,'air')).status).toBe('reserved');expect(f.writes()).toBe(1);expect(host.laneControls).toHaveLength(1);
});

for(const baseline of ['out-of-service','missing','unknown','fresh-restored'] as const)test(`an accepted manual marker cannot regain allocation after rollback with ${baseline} baseline`,async()=>{
 const f=fixture(),host=f.rows.get(authority)!,operationId=randomUUID();host.snapshot.laneControls={schemaVersion:1,receipts:[]};
 const command={operationId,hostId:authority,subject:{resourceId:id,subjectGeneration:7},operatorId:'c'.repeat(64),expiresAt:now-1,action:'mark-out-of-service' as const,reason:'Operator withdrew this resource'};
 host.laneControls=[{command,receipt:{operationId,hostId:authority,subject:command.subject,inputSha256:requestInputDigest(command),completedAt:at,
  result:{status:'accepted',resource:{resourceId:id,generation:8,status:'out-of-service'}}}}];
 const value=host.snapshot.resourceLifecycle!.subjects[0]!;
 if(baseline==='missing')host.snapshot.resourceLifecycle!.subjects=[];
 if(baseline==='out-of-service')value.status='out-of-service';
 if(baseline==='unknown'){value.status='unknown';value.idle.outcome='unknown'}
 // Only an independently accepted fresh baseline can make the later subject idle.
 if(baseline==='fresh-restored'){value.generation=9;value.idle.acceptedCheck!.subjectGeneration=9}
 const result=await f.service.acquire(intent,'air');expect(result.status).toBe(baseline==='fresh-restored'?'reserved':'waiting');expect(f.writes()).toBe(baseline==='fresh-restored'?1:0);
 expect(host.laneControls).toHaveLength(1);
});

for(const baseline of ['older-generation','marked-generation','predates-withdrawal','future-check','different-authority','restored'] as const)test(`accepted withdrawal requires later authentic restoration rather than ${baseline} readiness`,async()=>{
 const f=fixture(),host=f.rows.get(authority)!,operationId=randomUUID(),command={operationId,hostId:authority,subject:{resourceId:id,subjectGeneration:7},operatorId:'c'.repeat(64),expiresAt:now-1,action:'mark-out-of-service' as const,reason:'Operator withdrew'};
 host.snapshot.laneControls={schemaVersion:1,receipts:[]};host.laneControls=[{command,receipt:{operationId,hostId:authority,subject:command.subject,inputSha256:requestInputDigest(command),completedAt:at,result:{status:'accepted',resource:{resourceId:id,generation:8,status:'out-of-service'}}}}];
 const value=host.snapshot.resourceLifecycle!.subjects[0]!;value.generation=baseline==='older-generation'?7:baseline==='marked-generation'?8:9;value.idle.acceptedCheck!.subjectGeneration=value.generation;
 if(baseline==='predates-withdrawal')value.idle.acceptedCheck!.acceptedAt=new Date(now-1).toISOString();
 if(baseline==='future-check')value.idle.acceptedCheck!.acceptedAt=new Date(now+1).toISOString();
 if(baseline==='different-authority'){value.subject.authorityHostId='foreign';await expect(f.service.acquire(intent,'air')).rejects.toThrow('Resource lifecycle must be reported by its authority host');expect(f.writes()).toBe(0);return}
 expect((await f.service.acquire(intent,'air')).status).toBe(baseline==='restored'?'reserved':'waiting');expect(f.writes()).toBe(baseline==='restored'?1:0);
});

for(const omission of ['envelope','subject','older-current'] as const)test(`retained commissioning cursor refuses legacy fallback after ${omission} omission`,async()=>{
 const f=fixture(),host=f.rows.get(authority)!;host.resourceLifecycleCursor=structuredClone(host.snapshot.resourceLifecycle);
 host.snapshot.laneControls={schemaVersion:1,receipts:[]};host.laneControls=[];
 if(omission==='envelope')delete host.snapshot.resourceLifecycle;
 else if(omission==='subject')host.snapshot.resourceLifecycle!.subjects=[];
 else{const prior=(host.resourceLifecycleCursor as NonNullable<ResourceReservationHost['snapshot']['resourceLifecycle']>).subjects[0]!;prior.generation=8;prior.idle.acceptedCheck!.subjectGeneration=8}
 expect((await f.service.acquire(intent,'air')).status).toBe('waiting');expect(f.writes()).toBe(0);expect(host.resourceReservations).toEqual([]);
});

test('canonical authority reader retains the existing lifecycle cursor with its exact host report',async()=>{
 const host=hosts().get(authority)!,original=TestHostStateModel.findOne;let projection:Record<string,unknown>|undefined;
 const query={select(value:Record<string,unknown>){projection=value;return query},read(){return query},readConcern(){return query},setOptions(){return query},lean:async()=>host};
 TestHostStateModel.findOne=mock(()=>query) as never;
 try{expect(await resourceReservationRepository.get(authority)).toEqual(host);expect(projection).toMatchObject({'resourceLifecycleCursor.subjects':1,'snapshot.resourceLifecycle.subjects':1,laneControls:1,sequence:1,receivedAt:1});expect(projection).not.toHaveProperty('resourceLifecycleCursor');expect(projection).not.toHaveProperty('snapshot.resourceLifecycle')}finally{TestHostStateModel.findOne=original}
});

for(const order of ['grant-first','cancel-first'] as const)test(`waiting cancellation and granted generation reconcile one original in ${order} receipt order`,async()=>{
 const core=hosts().get(authority)!;let records:ResourceControlRecord[]=[];
 const repository:LaneControlRepository={get:async()=>({hostId:authority,laneControlVersion:0,receivedAt:core.receivedAt,observedAt:new Date(now),snapshot:core.snapshot,laneControls:structuredClone(records)}),replace:async(_id,_v,next)=>{records=structuredClone(next) as ResourceControlRecord[];return true}};
 const service=new LaneControlsService(repository,()=>now,{detail:async()=>({generatedAt:at,subject:subject(),coverage:'canonical current'})}),input=(action:'reserve'|'release')=>({operationId:randomUUID(),hostId:authority,subject:{resourceId:id,subjectGeneration:7},expiresAt:now+120000,action,...(action==='reserve'?{purpose:'Original reservation'}:{reservation:{id:'waiting-original',generation:0}})});
 const reserve=input('reserve');await service.submit(reserve,'alice');
 const reservation=(state:'waiting'|'granted'|'released',generation:number)=>({id:'waiting-original',resourceId:id,generation,state,purpose:'Original reservation',requestedAt:at});
 const ack=(command:ReturnType<typeof input>,state:'waiting'|'granted'|'released',generation:number)=>({operationId:command.operationId,hostId:authority,subject:command.subject,inputSha256:requestInputDigest(records.find(row=>row.command.operationId===command.operationId)!.command),completedAt:at,result:{status:'accepted' as const,reservation:reservation(state,generation)}});
 const waiting=ack(reserve,'waiting',0);await service.exchange(authority,{schemaVersion:1,resourceControls:true,receipts:[waiting]});
 const release=input('release');await service.submit(release,'alice');const granted=ack(reserve,'granted',9),returned=ack(release,'released',0);
 await expect(service.exchange(authority,{schemaVersion:1,resourceControls:true,receipts:[ack(release,'released',9)]})).rejects.toThrow('requested action');
 for(const receipt of order==='grant-first'?[granted,returned]:[returned,granted])await service.exchange(authority,{schemaVersion:1,resourceControls:true,receipts:[receipt]});
 await service.exchange(authority,{schemaVersion:1,resourceControls:true,receipts:[waiting,granted]});
 const controls=(await service.listResource(id,'alice')).controls;
 expect(controls).toHaveLength(2);expect(controls.every(row=>row.receipt?.result.status==='accepted'&&row.receipt.result.reservation?.state==='released')).toBe(true);
 core.laneControls=records;const rows=hosts();rows.set(authority,core);
 const claim=new ResourceReservationsService({get:async host=>structuredClone(rows.get(host)??null),replace:async()=>true},()=>now);
 expect((await claim.acquire(intent,'air')).status).toBe('reserved');
 await service.submit(input('reserve'),'alice');expect(records).toHaveLength(3);
});

test('nonzero generation collisions remain unknown instead of reconciling another reservation',async()=>{
 const core=hosts().get(authority)!,operator=createHash('sha256').update('admin-lane:alice').digest('hex'),make=(state:'granted'|'released',generation:number)=>{
  const command={operationId:randomUUID(),hostId:authority,subject:{resourceId:id,subjectGeneration:7},operatorId:operator,expiresAt:now+120000,action:'reserve' as const,purpose:'Original reserve'};
  return {command,receipt:{operationId:command.operationId,hostId:authority,subject:command.subject,inputSha256:requestInputDigest(command),completedAt:at,result:{status:'accepted' as const,reservation:{id:'same-original',resourceId:id,generation,state,purpose:command.purpose,requestedAt:at}}}};
 };
 const service=new LaneControlsService({get:async()=>({hostId:authority,receivedAt:core.receivedAt,observedAt:new Date(now),snapshot:core.snapshot,laneControls:[make('granted',9),make('released',10)]}),replace:async()=>{throw Error('No writes')}},()=>now,{detail:async()=>({generatedAt:at,subject:subject(),coverage:'current'})});
 await expect(service.listResource(id,'alice')).rejects.toThrow('generation or terminal decision');
});

test('resource authority CAS includes manual control version so a concurrent operator intent wins before a new claim',async()=>{
 const host=hosts().get(authority)!,find=TestHostStateModel.findOneAndUpdate;let filter:unknown;
 const query={select(){return query},setOptions(){return query},lean:async()=>null};
 TestHostStateModel.findOneAndUpdate=mock((value:unknown)=>{filter=value;return query}) as never;
 try{
  for(const enabled of [true,false]){host.snapshot.laneControls={schemaVersion:1,receipts:[],...(enabled?{resourceControls:true as const}:{})};
   expect(await resourceReservationRepository.replace(host,[])).toBe(false);expect(filter).toMatchObject({laneControlVersion:0,resourceReservationVersion:0,sequence:1,incarnation:'mini-one'});}
  delete host.laneControlVersion;expect(await resourceReservationRepository.replace(host,[])).toBe(false);expect(filter).toMatchObject({laneControlVersion:{$exists:false}});
 }finally{TestHostStateModel.findOneAndUpdate=find}
});

test('new resource delivery CAS binds the same raw-claim version and exact authenticated observation, while ACK exchange remains recoverable',async()=>{
 const {laneControlRepository}=await import('./lane-controls.service'),host=hosts().get(authority)!,original=TestHostStateModel.findOneAndUpdate;let filter:any;
 const current:LaneControlHost={hostId:authority,laneControlVersion:0,resourceReservationVersion:0,receivedAt:host.receivedAt,observedAt:new Date(now),snapshot:host.snapshot};
 const query={select(){return query},setOptions(){return query},lean:async()=>null};TestHostStateModel.findOneAndUpdate=mock((value:unknown)=>{filter=value;return query}) as never;
 try{
  expect(await laneControlRepository.replace(authority,0,[],current)).toBe(false);
  expect(filter).toMatchObject({hostId:authority,resourceReservationVersion:0,receivedAt:host.receivedAt,observedAt:new Date(now),
    'snapshot.resourceLifecycle.schemaVersion':(host.snapshot.resourceLifecycle as {schemaVersion:number}).schemaVersion,
    'snapshot.resourceLifecycle.subjects':(host.snapshot.resourceLifecycle as {subjects:unknown[]}).subjects,'snapshot.laneControls':host.snapshot.laneControls});
  expect(await laneControlRepository.replace(authority,0,[])).toBe(false);expect(filter.resourceReservationVersion).toBeUndefined();expect(filter['snapshot.resourceLifecycle']).toBeUndefined();
 }finally{TestHostStateModel.findOneAndUpdate=original}
});

test('claim committed between canonical validation and delivery CAS prevents a new Check without hiding its original claim',async()=>{
 const h=hosts().get(authority)!;let records:ResourceControlRecord[]=[],race=true,detailReads=0,replaceCalls=0;
 const repository:LaneControlRepository={get:async()=>({hostId:authority,laneControlVersion:0,resourceReservationVersion:h.resourceReservationVersion,
   receivedAt:h.receivedAt,observedAt:new Date(now),snapshot:h.snapshot}),replace:async(_id,_version,next,expected)=>{
   replaceCalls++;expect(expected).toBeDefined();if(race){race=false;h.resourceReservationVersion=1;return false}
   if(expected!.resourceReservationVersion!==h.resourceReservationVersion)return false;records=next as ResourceControlRecord[];return true;
 }};
 const resources={detail:async()=>{detailReads++;return {generatedAt:at,subject:h.resourceReservationVersion===1?{...subject(),supportedActions:[],owner:{id:'retained',kind:'run' as const,hostId:authority,generation:null,laneId:'mac'}}:subject(),coverage:'same authoritative envelope'}}};
 const service=new LaneControlsService(repository,()=>now,resources),input={operationId:randomUUID(),hostId:authority,subject:{resourceId:id,subjectGeneration:7},expiresAt:now+120000,action:'check' as const};
 // A concurrent claim is authoritative even if local status has not advanced; retain it until a new canonical read.

 await expect(service.submit(input,'alice')).rejects.toThrow('support');expect(records).toEqual([]);expect(replaceCalls).toBe(1);expect(detailReads).toBe(2);expect(h.resourceReservationVersion).toBe(1);
});

for(const collision of ['lane','resource','operator','generation','exact'] as const)test(`return capacity matches full reservation authority rather than a colliding ${collision} ID`,async()=>{
 const core=hosts().get(authority)!;let records:any[]=[];const operator='a'.repeat(64),operationId=randomUUID(),reservation={id:'shared-id',resourceId:'original-resource',generation:8,state:'granted' as const,purpose:'Original reserve',requestedAt:at};
 const command={operationId,hostId:authority,subject:{resourceId:'original-resource',subjectGeneration:7},operatorId:operator,expiresAt:now+120000,action:'reserve' as const,purpose:reservation.purpose};
 records.push({command,receipt:{operationId,hostId:authority,subject:command.subject,inputSha256:requestInputDigest(command),completedAt:at,result:{status:'accepted',reservation}}});
 records.push({command:{operationId:randomUUID(),hostId:authority,operatorId:collision==='operator'?'b'.repeat(64):operator,expiresAt:now+120000,action:'release',
  ...(collision==='lane'?{laneId:'original-resource'}:{subject:{resourceId:collision==='resource'?'other-resource':'original-resource',subjectGeneration:8}}),reservation:{id:'shared-id',generation:collision==='generation'?9:8}}});
 records.push(...Array.from({length:97},(_,i)=>({command:{operationId:randomUUID(),hostId:authority,laneId:`lane-${i}`,operatorId:operator,expiresAt:now+120000,action:'pause'}})));
 const before=structuredClone(records);let writes=0;
 const repository:LaneControlRepository={get:async()=>({hostId:authority,receivedAt:core.receivedAt,observedAt:new Date(now),snapshot:core.snapshot,laneControlVersion:0,laneControls:structuredClone(records)}),replace:async(_id,_v,next)=>{writes++;records=structuredClone(next);return true}};
 const resources={detail:async()=>({generatedAt:at,subject:subject(),coverage:'canonical current'})},service=new LaneControlsService(repository,()=>now,resources),input={operationId:randomUUID(),hostId:authority,subject:{resourceId:id,subjectGeneration:7},expiresAt:now+120000,action:'check' as const};
 if(collision==='exact'){await service.submit(input,'alice');expect(records).toHaveLength(100);expect(writes).toBe(1)}
 else{await expect(service.submit(input,'alice')).rejects.toThrow('retain space for return');expect(writes).toBe(0);expect(records).toEqual(before)}
});

test('terminal receipt for a colliding resource reservation ID does not erase another subject owner',async()=>{
 const core=hosts().get(authority)!;const operator=createHash('sha256').update('admin-lane:alice').digest('hex'),make=(resourceId:string,state:'granted'|'released')=>{
  const command={operationId:randomUUID(),hostId:authority,subject:{resourceId,subjectGeneration:7},operatorId:operator,expiresAt:now+120000,action:'reserve' as const,purpose:'Original reserve'};
  return {command,receipt:{operationId:command.operationId,hostId:authority,subject:command.subject,inputSha256:requestInputDigest(command),completedAt:at,result:{status:'accepted' as const,reservation:{id:'same-id',resourceId,generation:8,state,purpose:command.purpose,requestedAt:at}}}};
 };
 const records=[make('first','granted'),make('second','released')];
 // Existing read-only reconciliation must preserve both distinct subject identities.
 const detail={detail:async()=>({generatedAt:at,subject:{...subject(),subject:{...subject().subject,id:'first'}},coverage:'current'})};
 const first=new LaneControlsService({get:async()=>({hostId:authority,receivedAt:core.receivedAt,observedAt:new Date(now),snapshot:core.snapshot,laneControls:records}),replace:async()=>{throw Error('No writes')}},()=>now,detail);
 const view=await first.listResource('first','alice');expect(view.controls).toHaveLength(1);
 expect(view.controls[0]!.receipt!.result).toMatchObject({reservation:{resourceId:'first',state:'granted'}});
});

for(const restored of [false,true])test(`unrelated history churn ${restored?'may trim an authoritatively restored':'retains the unresolved'} manual withdrawal`,async()=>{
 const core=hosts().get(authority)!,operationId=randomUUID(),command={operationId,hostId:authority,subject:{resourceId:id,subjectGeneration:7},operatorId:'a'.repeat(64),expiresAt:now+120000,action:'mark-out-of-service' as const,reason:'Operator withdrew'};
 let records:any[]=[{command,receipt:{operationId,hostId:authority,subject:command.subject,inputSha256:requestInputDigest(command),completedAt:at,result:{status:'accepted',resource:{resourceId:id,generation:8,status:'out-of-service'}}}},
  ...Array.from({length:99},(_,i)=>({command:{operationId:randomUUID(),hostId:authority,laneId:`lane-${i}`,operatorId:'a'.repeat(64),expiresAt:now+120000,action:'pause'}}))];
 const value=core.snapshot.resourceLifecycle!.subjects[0]!;value.generation=restored?9:8;value.status=restored?'idle':'out-of-service';value.idle.acceptedCheck!.subjectGeneration=value.generation;
 core.snapshot.lanes=Array.from({length:100},(_,i)=>({id:`lane-${i}`,platform:'ios-on-mac',state:'idle',dispatchMode:'automatic',resources:[]}));
 let writes=0;const service=new LaneControlsService({get:async()=>({hostId:authority,laneControlVersion:0,receivedAt:core.receivedAt,observedAt:new Date(now),snapshot:core.snapshot,laneControls:structuredClone(records)}),replace:async(_id,_version,next)=>{writes++;records=structuredClone(next);return true}},()=>now);
 const input={operationId:randomUUID(),hostId:authority,laneId:'lane-99',expiresAt:now+120000,action:'pause' as const};
 if(restored){await service.submit(input,'alice');expect(writes).toBe(1);expect(records).toHaveLength(100);expect(records.some(row=>row.command.operationId===operationId)).toBe(false)}
 else{await expect(service.submit(input,'alice')).rejects.toThrow('retain space');expect(writes).toBe(0);expect(records.some(row=>row.command.operationId===operationId)).toBe(true)}
});

for(const state of ['out-of-service','unknown','failed','owned','stale','unqualified'] as const)test(`a retired marker and capability loss do not bypass the existing ${state} lifecycle`,async()=>{
 const f=fixture(),core=f.rows.get(authority)!,operationId=randomUUID(),command={operationId,hostId:authority,subject:{resourceId:id,subjectGeneration:7},operatorId:'a'.repeat(64),expiresAt:now+120000,action:'mark-out-of-service' as const,reason:'Operator withdrew'};
 let records:any[]=[{command,receipt:{operationId,hostId:authority,subject:command.subject,inputSha256:requestInputDigest(command),completedAt:at,result:{status:'accepted',resource:{resourceId:id,generation:8,status:'out-of-service'}}}},
  ...Array.from({length:99},(_,i)=>({command:{operationId:randomUUID(),hostId:authority,laneId:`lane-${i}`,operatorId:'a'.repeat(64),expiresAt:now+120000,action:'pause'}}))];
 const value=core.snapshot.resourceLifecycle!.subjects[0]!;value.generation=9;value.idle.acceptedCheck!.subjectGeneration=9;
 core.snapshot.lanes=Array.from({length:100},(_,i)=>({id:`lane-${i}`,platform:'ios-on-mac',state:'idle',dispatchMode:'automatic',resources:[]}));
 const service=new LaneControlsService({get:async()=>({hostId:authority,laneControlVersion:0,receivedAt:core.receivedAt,observedAt:new Date(now),snapshot:core.snapshot,laneControls:structuredClone(records)}),replace:async(_id,_version,next)=>{records=structuredClone(next);return true}},()=>now);
 // A genuinely restored marker may leave bounded delivery history.
 await service.submit({operationId:randomUUID(),hostId:authority,laneId:'lane-99',expiresAt:now+120000,action:'pause'},'alice');
 expect(records.some(row=>row.command.operationId===operationId)).toBe(false);core.laneControls=records;
 core.snapshot.laneControls={schemaVersion:1,receipts:[]};
 if(state==='out-of-service')value.status='out-of-service';
 if(state==='unknown'){value.status='unknown';value.idle.outcome='unknown'}
 if(state==='failed'){value.status='unknown';value.idle.outcome='failed'}
 if(state==='owned'){value.status='active';value.owner={id:'original-owner',hostId:authority,kind:'run',generation:10,laneId:'mac'}}
 if(state==='stale')value.observedAt=new Date(now-120001).toISOString();
 if(state==='unqualified'){value.status='unknown';value.idle.qualifiedScope={kind:'unqualified'}}
 expect((await f.service.acquire(intent,'air')).status).toBe('waiting');expect(f.writes()).toBe(0);expect(core.resourceReservations).toEqual([]);
});

test('legacy fallback is limited to an authority with no lifecycle subject or retained controls',async()=>{
 const f=fixture(),core=f.rows.get(authority)!;core.snapshot.laneControls={schemaVersion:1,receipts:[]};core.snapshot.resourceLifecycle!.subjects=[];
 delete core.snapshot.resources![0]!.idleContract;
 expect((await f.service.acquire(intent,'air')).status).toBe('reserved');expect(f.writes()).toBe(1);
});

for(const count of [99,100])test(`${count} retained manual withdrawals preserve restoration capacity without evicting another marker`,async()=>{
 const core=hosts().get(authority)!;const operator=createHash('sha256').update('admin-lane:alice').digest('hex');
 core.snapshot.resources=Array.from({length:count},(_,i)=>({id:`manual-${i}`,kind:'fixture-data',capabilities:[capability]}));
 core.snapshot.resourceLifecycle!.subjects=Array.from({length:count},(_,i)=>({...subject(),subject:{kind:'resource' as const,id:`manual-${i}`,authorityHostId:authority},generation:8,status:'out-of-service' as const}));
 let records:any[]=Array.from({length:count},(_,i)=>{
  const command={operationId:randomUUID(),hostId:authority,subject:{resourceId:`manual-${i}`,subjectGeneration:7},operatorId:operator,expiresAt:now+120000,action:'mark-out-of-service',reason:'Operator withdrew'};
  return {command,receipt:{operationId:command.operationId,hostId:authority,subject:command.subject,inputSha256:requestInputDigest(command),completedAt:at,result:{status:'accepted',resource:{resourceId:`manual-${i}`,generation:8,status:'out-of-service'}}}};
 });
 const before=structuredClone(records);let writes=0;
 const service=new LaneControlsService({get:async()=>({hostId:authority,laneControlVersion:0,receivedAt:core.receivedAt,observedAt:new Date(now),snapshot:core.snapshot,laneControls:structuredClone(records)}),replace:async(_id,_version,next)=>{writes++;records=structuredClone(next);return true}},()=>now,
  {detail:async(resourceId:string)=>({generatedAt:at,subject:core.snapshot.resourceLifecycle!.subjects.find(value=>value.subject.id===resourceId)!,coverage:'canonical current'})});
 const input={operationId:randomUUID(),hostId:authority,subject:{resourceId:'manual-0',subjectGeneration:8},expiresAt:now+120000,action:'check' as const};
 if(count===100){await expect(service.submit(input,'alice')).rejects.toThrow('retain space');expect(writes).toBe(0);expect(records).toEqual(before);return}
 // Admission reserves the last slot instead of accepting another restriction.
 core.snapshot.resources.push({id:'manual-new',kind:'fixture-data',capabilities:[capability]});core.snapshot.resourceLifecycle!.subjects.push({...subject(),subject:{kind:'resource',id:'manual-new',authorityHostId:authority}});
 await expect(service.submit({...input,operationId:randomUUID(),subject:{resourceId:'manual-new',subjectGeneration:7},action:'mark-out-of-service',reason:'Another withdrawal'},'alice')).rejects.toThrow('retain space');
 expect(writes).toBe(0);expect(records).toEqual(before);
 await service.submit(input,'alice');expect(writes).toBe(1);expect(records).toHaveLength(100);expect(records.slice(0,99)).toEqual(before);
 const check=records.at(-1)!;
 await service.exchange(authority,{schemaVersion:1,resourceControls:true,receipts:[{operationId:input.operationId,hostId:authority,subject:input.subject,inputSha256:requestInputDigest(check.command),completedAt:at,result:{status:'accepted',check:{operationId:input.operationId,resourceId:'manual-0',generation:8,state:'settled'}}}]});
 // A passed installed baseline retires only that original marker, making the same bounded slot reusable.
 const restored=core.snapshot.resourceLifecycle!.subjects[0]!;restored.status='idle';restored.generation=9;restored.idle.acceptedCheck!.subjectGeneration=9;
 await service.submit({...input,operationId:randomUUID(),subject:{resourceId:'manual-1',subjectGeneration:8}},'alice');
 expect(records).toHaveLength(100);expect(records.some(row=>row.command.operationId===before[0]!.command.operationId)).toBe(false);
 expect(records.filter(row=>row.command.action==='mark-out-of-service')).toHaveLength(98);
});
