import {describe,test,expect,spyOn} from 'bun:test';
import {validateResourceLifecycleAdvance,ResourceLifecycleService,projectResourceLifecycle} from './resource-lifecycle.service';
import {resourceLifecycleSchema,type ResourceLifecycleSubject} from '../types/resource-lifecycle.types';
const at='2026-10-16T20:00:00.000Z',now=Date.parse(at);
const subject:ResourceLifecycleSubject={subject:{kind:'resource',id:'google-account-1',authorityHostId:'host-a'},generation:2,status:'idle',observedAt:at,receivedAt:null,current:true,reason:null,owner:null,
 idle:{contractVersion:'account-v1',outcome:'passed',checkedAt:at,acceptedCheck:{operationId:'check-2',subjectGeneration:2,resultSha256:'a'.repeat(64),acceptedAt:at},qualifiedScope:{kind:'fleet'},evidenceRefs:[]},
 repair:{configured:true,state:'none'},supportedActions:['check'],resource:{kind:'account',capabilities:[],memberships:[],dependencies:[],placement:'fleet'}};
const row=(value=subject)=>({hostId:'host-a',receivedAt:new Date(at),snapshot:{hostId:'host-a',observedAt:at,resourceLifecycle:{schemaVersion:1,subjects:[value],history:[{id:'journal-2',resourceId:value.subject.id,subjectGeneration:2,at,event:'released'}]}}});

async function readHistory(rows:Parameters<typeof projectResourceLifecycle>[0],resourceId:string,cursor?:string) {
 const {TestHostStateModel}=await import('../models/test-host-state.model');
 const read=spyOn(TestHostStateModel,'find').mockImplementation((()=>{const query={select(){return query},sort(){return query},limit(){return query},maxTimeMS(){return query},read(){return query},readConcern(){return query},lean:async()=>rows};return query}) as never);
 try {return await new ResourceLifecycleService().history(resourceId,cursor)}finally {read.mockRestore()}
}
test('fresh authority preserves an unchanged returned physical state beyond its transition age',()=>{
 const elapsed=now+180001,reportedAt=new Date(elapsed).toISOString(),value={...row(),receivedAt:new Date(elapsed),snapshot:{...row().snapshot,observedAt:reportedAt}};
 const original=structuredClone(value),current=projectResourceLifecycle([value],elapsed).subjects[0]!;
 expect(current.current).toBe(true);expect(current.status).toBe('idle');expect(current.supportedActions).toEqual(['check']);
 expect(current.observedAt).toBe(at);expect(current.idle.acceptedCheck).toEqual(subject.idle.acceptedCheck);expect(value).toEqual(original);
 for(const changed of [
  {...value,snapshot:{...value.snapshot,observedAt:at}},
  {...value,receivedAt:new Date(at)},
  {...value,snapshot:{...value.snapshot,resourceLifecycle:{...value.snapshot.resourceLifecycle,subjects:[{...subject,current:false}]}}},
  {...value,snapshot:{...value.snapshot,resourceLifecycle:{...value.snapshot.resourceLifecycle,subjects:[{...subject,observedAt:new Date(elapsed+5001).toISOString()}]}}},
 ]) {const refused=projectResourceLifecycle([changed],elapsed).subjects[0]!;expect(refused.current).toBe(false);expect(refused.status).toBe('unknown');expect(refused.supportedActions).toEqual([])}
 const owned={...value,snapshot:{...value.snapshot,resourceLifecycle:{...value.snapshot.resourceLifecycle,subjects:[{...subject,status:'checking',supportedActions:[],owner:{kind:'fixer',id:'current-repair',generation:2,hostId:'host-a'}}]}}};
 expect(projectResourceLifecycle([owned],elapsed).subjects[0]).toMatchObject({current:true,status:'checking',owner:{id:'current-repair'}});
})
test('current resource API reads fresh host timestamps and preserves stable physical facts and actual owner',async()=>{
 const {spyOn}=await import('bun:test'),{TestHostStateModel}=await import('../models/test-host-state.model');
 const elapsed=now+180001,observedAt=new Date(elapsed).toISOString(),fresh={...row(),receivedAt:new Date(elapsed),snapshot:{...row().snapshot,observedAt}};
 let rows=[fresh];const selections:Record<string,unknown>[]=[],consistency:unknown[]=[];
 const clock=spyOn(Date,'now').mockReturnValue(elapsed),read=spyOn(TestHostStateModel,'find').mockImplementation((()=>{
  const query={select(value:Record<string,unknown>){selections.push(value);return query},sort(){return query},limit(){return query},maxTimeMS(){return query},
   read(value:unknown){consistency.push(value);return query},readConcern(value:unknown){consistency.push(value);return query},lean:async()=>structuredClone(rows)};
  return query;
 }) as never);
 try {
  const service=new ResourceLifecycleService(),detail=await service.detail(subject.subject.id);
  expect(detail.subject).toMatchObject({current:true,status:'idle',observedAt:at,owner:null});expect(detail.subject.idle).toEqual(subject.idle);
  expect(selections[0]['snapshot.observedAt']).toBe(1);expect(consistency).toEqual(['primary','majority']);
  for(const changed of [{...fresh,receivedAt:new Date(at)},
    {...fresh,snapshot:{...fresh.snapshot,observedAt:at}},
    {...fresh,snapshot:{...fresh.snapshot,observedAt:new Date(elapsed+5001).toISOString()}}]) {
   rows=[changed];expect((await service.detail(subject.subject.id)).subject).toMatchObject({current:false,status:'unknown',supportedActions:[]});
  }
  rows=[{...fresh,snapshot:{...fresh.snapshot,resourceLifecycle:{...fresh.snapshot.resourceLifecycle,subjects:[{...subject,status:'checking',supportedActions:[],owner:{kind:'fixer',id:'current-repair',generation:2,hostId:'host-a'}}]}}} as typeof fresh];
  expect((await service.detail(subject.subject.id)).subject).toMatchObject({current:true,status:'checking',owner:{id:'current-repair'}});
  expect(fresh.snapshot.resourceLifecycle.subjects[0]).toEqual(subject);
 } finally {clock.mockRestore();read.mockRestore()}
})
describe('resource lifecycle projection',()=>{
 test('fleet account has no invented machine placement and server receipt time',()=>{const result=projectResourceLifecycle([row()],now);expect(result.subjects[0]?.resource.memberships).toEqual([]);expect(result.subjects[0]?.receivedAt).toBe(at);expect(result.subjects[0]?.status).toBe('idle');expect(result).not.toHaveProperty('history')});
 test('stale authority makes idle unknown while preserving custody and check context',()=>{const result=projectResourceLifecycle([row()],now+180001);expect(result.subjects[0]?.status).toBe('unknown');expect(result.subjects[0]?.idle.outcome).toBe('passed');expect(result.subjects[0]?.supportedActions).toEqual([])});
 test('legacy snapshot remains valid without fabricated resource idle',()=>expect(projectResourceLifecycle([{hostId:'host-a',receivedAt:new Date(at),snapshot:{hostId:'host-a'}}],now).subjects).toEqual([]));
 test('duplicate canonical resource or wrong authority fails closed',()=>{expect(()=>projectResourceLifecycle([row(),row()],now)).toThrow();const bad=row();bad.hostId='host-b';expect(()=>projectResourceLifecycle([bad],now)).toThrow()});
 test('idle rejects missing or stale generation qualification and ownership',()=>{for(const value of [{...subject,owner:{id:'run-1',kind:'run',generation:1,hostId:'host-a',laneId:'lane-a'}},{...subject,generation:3},{...subject,idle:{...subject.idle,qualifiedScope:{kind:'unqualified'}}}])expect(resourceLifecycleSchema.safeParse({schemaVersion:1,subjects:[value],history:[]}).success).toBe(false)});
});

test('accepted subject generation cannot regress and original journal IDs cannot change',()=>{
 const before=row().snapshot.resourceLifecycle;
 const next=structuredClone(before);next.subjects[0]!.generation=1;next.subjects[0]!.idle.acceptedCheck!.subjectGeneration=1;next.history[0]!.subjectGeneration=1;
 expect(()=>validateResourceLifecycleAdvance(before,next)).toThrow('generation regressed');
 const changed=structuredClone(before);changed.history[0]!.event='active';
 expect(()=>validateResourceLifecycleAdvance(before,changed)).toThrow('immutable');
 expect(()=>validateResourceLifecycleAdvance(before,structuredClone(before))).not.toThrow();
});
test('retained history pages are bounded with explicit coverage and strict cursors',async()=>{
 const value=row();value.snapshot.resourceLifecycle.history=Array.from({length:60},(_,i)=>({...value.snapshot.resourceLifecycle.history[0]!,id:`event-${String(i).padStart(2,'0')}`}));
 const first=await readHistory([value],subject.subject.id);expect(first.events).toHaveLength(50);expect(first.nextCursor).toBe('event-49');
 expect((await readHistory([value],subject.subject.id,'event-49')).events).toHaveLength(10);
 expect(first.coverage).toContain('200 events');
 await expect(readHistory([value],subject.subject.id,'/bad')).rejects.toThrow('cursor');
});

test('history cannot attribute another canonical resource or future subject generation',()=>{
 const value=row().snapshot.resourceLifecycle;
 expect(resourceLifecycleSchema.safeParse({...value,history:[{...value.history[0]!,resourceId:'other-resource'}]}).success).toBe(false);
 expect(resourceLifecycleSchema.safeParse({...value,history:[{...value.history[0]!,subjectGeneration:3}]}).success).toBe(false);
});

test('resource-only passive custody can omit an execution lane',()=>{
 const value={...subject,status:'checking',owner:{id:'resource-check-1',kind:'boundary-cleanup',generation:3,hostId:'host-a'}};
 expect(resourceLifecycleSchema.safeParse({schemaVersion:1,subjects:[value],history:[]}).success).toBe(true);
});

const canonical='google-account-opaque-1';
const claim={kind:'exclusive' as const,id:'d7811de8-f7e7-4808-aef6-a2d97ecbc853',resourceId:canonical,authorityHostId:'host-a',borrowerHostId:'host-b',laneId:'android',operationId:'run:run-1',intentSha256:'a'.repeat(64),inputSha256:'b'.repeat(64),owner:{id:'run-1',kind:'run' as const},controllerIncarnation:'process-1',controllerGeneration:7,borrowerSequence:12,reservedAt:at};
function fleetRows(held=true) {return [{hostId:'host-a',receivedAt:new Date('2020-01-01'),resourceReservationVersion:9,resourceReservations:held?[claim]:[],snapshot:{hostId:'host-a',lanes:[{id:'android',resources:[{exclusiveDependencies:[{resourceId:canonical,authorityHostId:'host-a',capability:'google-login'}]}]}]}},{hostId:'host-b',receivedAt:new Date(at),snapshot:{hostId:'host-b',lanes:[{id:'android',resources:[{exclusiveDependencies:[{resourceId:canonical,authorityHostId:'host-a',capability:'google-login'}]}]}]}}]}
test('ordinary fleet claim preserves the accepted historical checklist without promoting readiness or changing custody',()=>{
 const checked:ResourceLifecycleSubject={...subject,subject:{...subject.subject,id:canonical},idle:{...subject.idle,report:{resourceId:canonical,
  authorityHostId:'host-a',contractVersion:'account-v1',operationId:'check-2',checkedAt:at,resultSha256:'a'.repeat(64),outcome:'passed',evidenceRefs:[],
  conditions:[{id:'session-closed',label:'Session closed',status:'passed',reportedStatus:'passed',observed:null,expected:null,explanation:null,repairAction:null,evidenceRefs:[],source:null}]}}};
 const original=structuredClone(checked),authority={...row(checked),resourceReservationVersion:9,resourceReservations:[claim]};
 for(const time of [now,now+3600000]) {
  const value=projectResourceLifecycle([authority],time).subjects[0]!;
  expect(value.idle.report).toEqual(checked.idle.report);
  expect(value).toMatchObject({status:'reserved',generation:9,owner:{id:'run-1',generation:null,hostId:'host-b'},supportedActions:[]});
  expect(value.idle.outcome).toBe('not-checked');expect(value.idle.acceptedCheck).toBeNull();
 }
 expect(checked).toEqual(original);
});
test('fleet claim appears once across aliases without fabricated owner generation',()=>{
 const result=projectResourceLifecycle(fleetRows(),now);expect(result.subjects).toHaveLength(1);
 const value=result.subjects[0]!;expect(value.subject.id).toBe(canonical);expect(value.status).toBe('reserved');expect(value.generation).toBe(9);expect(value.owner?.generation).toBeNull();expect(value.owner?.hostId).toBe('host-b');expect(value.resource.memberships).toEqual([]);expect(value.idle.outcome).toBe('not-checked');expect(value.supportedActions).toEqual([]);
 expect(result).not.toHaveProperty('history');
 const advanced=fleetRows();advanced[0]!.resourceReservationVersion=10;
 expect(projectResourceLifecycle(advanced,now)).not.toHaveProperty('history');
 expect(value.observedAt).toBe(claim.reservedAt);expect(value.receivedAt).toBe('2020-01-01T00:00:00.000Z');
 const later=projectResourceLifecycle(fleetRows(),now+3600000).subjects[0]!;
 expect(later.observedAt).toBe(value.observedAt);expect(later.receivedAt).toBe(value.receivedAt);expect(later.status).toBe('reserved');expect(later.supportedActions).toEqual([]);
});
test('unclaimed fleet dependency remains unknown until commissioned',()=>{const value=projectResourceLifecycle(fleetRows(false),now).subjects[0]!;expect(value.status).toBe('unknown');expect(value.owner).toBeNull();expect(value.resource.placement).toBe('fleet');expect(value.idle.acceptedCheck).toBeNull()});
test('retained claim survives removed enrollment and stale borrower',()=>{const rows=fleetRows();rows[0]!.snapshot.lanes=[];rows[1]!.snapshot.lanes=[];const value=projectResourceLifecycle(rows,now).subjects[0]!;expect(value.status).toBe('reserved');expect(value.owner?.id).toBe('run-1')});
test('fleet alias cannot map canonical identity to another authority',()=>{const rows=fleetRows();rows[1]!.snapshot.lanes[0]!.resources[0]!.exclusiveDependencies[0]!.authorityHostId='host-b';expect(()=>projectResourceLifecycle(rows,now)).toThrow('Conflicting canonical resource authority')});
test('host offers accept only bounded complete idle contracts',async()=>{
 const {hostStateSchema}=await import('./test-host-state.service');
 const contract={version:'contract-v1',maximumAgeMs:1000,qualifiedScope:{kind:'fleet'},conditions:['session-closed'],repairConfigured:true,dependencies:['browser-resource']};
 const host={hostId:'host-a',incarnation:'process-1',incarnationGeneration:1,sequence:1,observedAt:at,lanes:[{id:'lane-a',platform:'android',dispatchMode:'automatic',state:'idle',resources:[{id:'app-a',kind:'app',idleContract:contract}]}]};
 expect(hostStateSchema.safeParse(host).success).toBe(true);
 for(const idleContract of [{...contract,maximumAgeMs:86400001},{...contract,conditions:['session-closed','session-closed']},{...contract,dependencies:Array(9).fill('browser-resource')},{...contract,secret:'forbidden'}])
  expect(hostStateSchema.safeParse({...host,lanes:[{...host.lanes[0],resources:[{id:'app-a',kind:'app',idleContract}]}]}).success).toBe(false);
});

test('unknown retained owner generation cannot authorize mutations',()=>{
 const value={...subject,status:'reserved',owner:{id:'run-1',kind:'run',generation:null,hostId:'host-b'}};
 expect(resourceLifecycleSchema.safeParse({schemaVersion:1,subjects:[value],history:[]}).success).toBe(false);
 expect(resourceLifecycleSchema.safeParse({schemaVersion:1,subjects:[{...value,supportedActions:[]}],history:[]}).success).toBe(true);
});

test('fleet history preserves original borrower release lineage without inventing authority acceptance',async()=>{
 const rows=fleetRows(false),borrower=rows[1]!;
 const release={eventId:'release-original-1',owner:{id:'cleanup-1',kind:'boundary-cleanup',generation:5},releasedAt:at,lineage:[{id:'run-1',kind:'run',generation:4},{id:'cleanup-1',kind:'boundary-cleanup',generation:5}]};
 Object.assign(borrower.snapshot,{resourceReservations:{claims:[],returns:[{claimId:claim.id,authorityHostId:'host-a',resourceId:canonical,intentSha256:claim.intentSha256,inputSha256:claim.inputSha256,originalOwner:claim.owner,release,laneId:'android'}]}});
 const result=projectResourceLifecycle(rows,now);
 const history=await readHistory(rows,canonical);expect(history.events[0]?.event).toBe('return-reported');expect(history.events[0]?.ownerId).toBe('run-1');expect(history.events[0]?.ownerGeneration).toBe(4);expect(history.events[0]?.subjectGeneration).toBeNull();expect(result.subjects[0]?.status).toBe('unknown');expect(result).not.toHaveProperty('history');
});

test('comparison cursor keeps subject high-water marks within a fixed bound and bounds retained history', async()=>{
 const {advanceResourceLifecycleCursor}=await import('./resource-lifecycle.service');
 const first=row().snapshot.resourceLifecycle;
 const cursor=advanceResourceLifecycleCursor(first,{schemaVersion:1,subjects:[],history:[]})!;
 expect(cursor.subjects[0]?.generation).toBe(2);
 const full={schemaVersion:1,subjects:Array.from({length:200},(_,i)=>({...subject,subject:{...subject.subject,id:`resource-${i}`}})),history:[]};
 expect(()=>advanceResourceLifecycleCursor(full,first)).toThrow('explicit retirement');
 const events=Array.from({length:200},(_,i)=>({...first.history[0]!,id:`old-${i}`}));
 expect(advanceResourceLifecycleCursor({...first,history:events},first)!.history).toHaveLength(200);
});
test('idle contract rejects duplicate dependencies like the harness contract',async()=>{
 const {resourceIdleContractSchema}=await import('../types/resource-lifecycle.types');
 expect(resourceIdleContractSchema.safeParse({version:'v1',maximumAgeMs:1000,qualifiedScope:{kind:'fleet'},conditions:['closed'],repairConfigured:true,dependencies:['browser','browser']}).success).toBe(false);
});

test('offset timestamps sort and retain by instant rather than lexical spelling', async()=>{
 const {advanceResourceLifecycleCursor}=await import('./resource-lifecycle.service');
 const value=row();
 value.snapshot.resourceLifecycle.history=[
  {...value.snapshot.resourceLifecycle.history[0]!,id:'earlier-offset',at:'2026-01-01T01:00:00+02:00'},
  {...value.snapshot.resourceLifecycle.history[0]!,id:'later-utc',at:'2026-01-01T00:30:00Z'},
 ];
 expect((await readHistory([value],subject.subject.id)).events.map(event=>event.id)).toEqual(['later-utc','earlier-offset']);
 const history=Array.from({length:199},(_,i)=>({...value.snapshot.resourceLifecycle.history[0]!,id:`old-${i}`,at:'2025-01-01T00:00:00Z'}));
 const cursor=advanceResourceLifecycleCursor({...value.snapshot.resourceLifecycle,history},{...value.snapshot.resourceLifecycle})!;
 expect(cursor.history).toHaveLength(200);expect(cursor.history[0]?.id).toBe('later-utc');expect(cursor.history[1]?.id).toBe('earlier-offset');
});

test('fresh omissions retain their reason while stale authority remains stale',()=>{
 const value={...row(),resourceLifecycleCursor:row().snapshot.resourceLifecycle,snapshot:{hostId:'host-a',observedAt:at}};
 expect(projectResourceLifecycle([value],now).subjects[0]?.reason?.code).toBe('observation-omitted');
 expect(projectResourceLifecycle([value],now+180001).subjects[0]?.reason?.code).toBe('stale-observation');
 expect(projectResourceLifecycle([{...value,snapshot:{hostId:'host-a'}}],now).subjects[0]?.reason?.code).toBe('stale-observation');
});

test('resource history queries its own bounded host scope instead of the global overview window',async()=>{
 const {spyOn}=await import('bun:test');const {TestHostStateModel}=await import('../models/test-host-state.model');
 const target=row();target.snapshot.resourceLifecycle.history=Array.from({length:60},(_,i)=>({...target.snapshot.resourceLifecycle.history[0]!,id:`target-${String(i).padStart(3,'0')}`,at:'2025-01-01T00:00:00Z'}));
 const rows=[target,...Array.from({length:12},(_,i)=>{const host=`other-${i}`,resourceId=`resource-${i}`;
  return {hostId:host,receivedAt:new Date(at),snapshot:{hostId:host,resourceLifecycle:{schemaVersion:1,subjects:[{...subject,subject:{...subject.subject,id:resourceId,authorityHostId:host}}],history:Array.from({length:200},(_,j)=>({id:`${host}-${j}`,resourceId,subjectGeneration:2,at,event:'checking'}))}}};
 })];
 expect(projectResourceLifecycle(rows,now)).not.toHaveProperty('history');
 const queries:unknown[]=[];let limit=0;
 const mock=spyOn(TestHostStateModel,'find').mockImplementation(((filter:unknown)=>{queries.push(filter);const query={select(){return query},sort(){return query},limit(value:number){limit=value;return query},maxTimeMS(){return query},read(){return query},readConcern(){return query},lean:async()=>rows};return query}) as never);
 try {
  const service=new ResourceLifecycleService();const first=await service.history(subject.subject.id);
  expect(first.events).toHaveLength(50);expect(first.events[0]?.id).toBe('target-000');
  const second=await service.history(subject.subject.id,first.nextCursor!);expect(second.events).toHaveLength(10);expect(second.events[0]?.id).toBe('target-050');
  expect(queries[0]).toMatchObject({$or:[{'snapshot.resourceLifecycle.subjects.subject.id':subject.subject.id},{'snapshot.resources.id':subject.subject.id},{'resourceLifecycleCursor.subjects.subject.id':subject.subject.id},{'resourceReservations.resourceId':subject.subject.id},{'snapshot.lanes.resources.exclusiveDependencies.resourceId':subject.subject.id},{'snapshot.resourceReservations.returns.resourceId':subject.subject.id}]});
  expect(limit).toBe(101);
  rows.push(...Array.from({length:88},()=>target));
  await expect(service.history(subject.subject.id)).rejects.toThrow('bounded 100-host');
 } finally {mock.mockRestore()}
});

test('resource-scoped reads fetch the existing fleet authority anchor after its claim returned',async()=>{
 const {spyOn}=await import('bun:test');const {TestHostStateModel}=await import('../models/test-host-state.model');
 const rows=fleetRows(false);rows[0]!.resourceReservationVersion=17;rows[0]!.snapshot.lanes=[];
 const expected=projectResourceLifecycle(rows,now).subjects[0]!;
 const queries:unknown[]=[];
 const mock=spyOn(TestHostStateModel,'find').mockImplementation(((filter:unknown)=>{queries.push(filter);const query={select(){return query},sort(){return query},limit(){return query},maxTimeMS(){return query},read(){return query},readConcern(){return query},lean:async()=>queries.length===1?[rows[1]!]:[rows[0]!]};return query}) as never);
 try {
  const result=await new ResourceLifecycleService().detail(canonical);
  expect(result.subject.generation).toBe(17);expect(result.subject.generation).toBe(expected.generation);
  expect(result.subject.subject.authorityHostId).toBe('host-a');expect(result.subject.owner).toBeNull();
  expect(queries).toHaveLength(2);expect(queries[1]).toEqual({hostId:{$in:['host-a']}});
 } finally {mock.mockRestore()}
});
