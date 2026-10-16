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
