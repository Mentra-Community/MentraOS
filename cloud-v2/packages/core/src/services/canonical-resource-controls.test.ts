import {expect,test,mock} from 'bun:test'
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
 [authority,{hostId:authority,incarnation:'mini-one',incarnationGeneration:1,sequence:1,receivedAt:new Date(now),resourceReservationVersion:0,laneControlVersion:0,laneControls:[],resourceReservations:[],snapshot:hostStateSchema.parse({hostId:authority,incarnation:'mini-one',incarnationGeneration:1,sequence:1,observedAt:at,resources:[{id,kind:'fixture-data',capabilities:[capability]}],lanes:[],laneControls:{schemaVersion:1,receipts:[],resourceControls:true},resourceLifecycle:{schemaVersion:1,subjects:[subject()],history:[]}})}],
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
    'snapshot.resourceLifecycle':host.snapshot.resourceLifecycle,'snapshot.laneControls':host.snapshot.laneControls});
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
