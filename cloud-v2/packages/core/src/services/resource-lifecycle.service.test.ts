import {describe,test,expect} from 'bun:test';
import {validateResourceLifecycleAdvance,ResourceLifecycleService,projectResourceLifecycle} from './resource-lifecycle.service';
import {resourceLifecycleSchema,type ResourceLifecycleSubject} from '../types/resource-lifecycle.types';
const at='2026-10-16T20:00:00.000Z',now=Date.parse(at);
const subject:ResourceLifecycleSubject={subject:{kind:'resource',id:'google-account-1',authorityHostId:'host-a'},generation:2,status:'idle',observedAt:at,receivedAt:null,current:true,reason:null,owner:null,
 idle:{contractVersion:'account-v1',outcome:'passed',checkedAt:at,acceptedCheck:{operationId:'check-2',subjectGeneration:2,resultSha256:'a'.repeat(64),acceptedAt:at},qualifiedScope:{kind:'fleet'},evidenceRefs:[]},
 repair:{configured:true,state:'none'},supportedActions:['check'],resource:{kind:'account',capabilities:[],memberships:[],dependencies:[],placement:'fleet'}};
const row=(value=subject)=>({hostId:'host-a',receivedAt:new Date(at),snapshot:{hostId:'host-a',resourceLifecycle:{schemaVersion:1,subjects:[value],history:[{id:'journal-2',resourceId:value.subject.id,subjectGeneration:2,at,event:'released'}]}}});
describe('resource lifecycle projection',()=>{
 test('fleet account has no invented machine placement and server receipt time',()=>{const result=projectResourceLifecycle([row()],now);expect(result.subjects[0]?.resource.memberships).toEqual([]);expect(result.subjects[0]?.receivedAt).toBe(at);expect(result.subjects[0]?.status).toBe('idle');expect(result.history).toHaveLength(1)});
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
 const service=new ResourceLifecycleService();const result=projectResourceLifecycle([row()],now);
 result.history=Array.from({length:60},(_,i)=>({...result.history[0]!,id:`event-${i}`}));
 service.list=async()=>result;
 const first=await service.history(subject.subject.id);expect(first.events).toHaveLength(50);expect(first.nextCursor).toBe('event-49');
 expect((await service.history(subject.subject.id,'event-49')).events).toHaveLength(10);
 expect(first.coverage).toContain('200 events');
 await expect(service.history(subject.subject.id,'/bad')).rejects.toThrow('cursor');
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
test('fleet claim appears once across aliases without fabricated owner generation',()=>{
 const result=projectResourceLifecycle(fleetRows(),now);expect(result.subjects).toHaveLength(1);
 const value=result.subjects[0]!;expect(value.subject.id).toBe(canonical);expect(value.status).toBe('reserved');expect(value.generation).toBe(9);expect(value.owner?.generation).toBeNull();expect(value.owner?.hostId).toBe('host-b');expect(value.resource.memberships).toEqual([]);expect(value.idle.outcome).toBe('not-checked');expect(value.supportedActions).toEqual([]);
 expect(result.history[0]?.subjectGeneration).toBeNull();
 const advanced=fleetRows();advanced[0]!.resourceReservationVersion=10;
 expect(projectResourceLifecycle(advanced,now).history).toEqual(result.history);
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

test('fleet history preserves original borrower release lineage without inventing authority acceptance',()=>{
 const rows=fleetRows(false),borrower=rows[1]!;
 const release={eventId:'release-original-1',owner:{id:'cleanup-1',kind:'boundary-cleanup',generation:5},releasedAt:at,lineage:[{id:'run-1',kind:'run',generation:4},{id:'cleanup-1',kind:'boundary-cleanup',generation:5}]};
 Object.assign(borrower.snapshot,{resourceReservations:{claims:[],returns:[{claimId:claim.id,authorityHostId:'host-a',resourceId:canonical,intentSha256:claim.intentSha256,inputSha256:claim.inputSha256,originalOwner:claim.owner,release,laneId:'android'}]}});
 const result=projectResourceLifecycle(rows,now);
 expect(result.history[0]?.event).toBe('return-reported');expect(result.history[0]?.ownerId).toBe('run-1');expect(result.history[0]?.ownerGeneration).toBe(4);expect(result.history[0]?.subjectGeneration).toBeNull();expect(result.subjects[0]?.status).toBe('unknown');
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
