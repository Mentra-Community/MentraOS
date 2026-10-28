import {expect, spyOn, test} from 'bun:test';
import {createTestRunAdminApi} from '../api/admin/test-runs.api';
import {TestHostStateModel} from '../models/test-host-state.model';
import {ResourceLifecycleService} from './resource-lifecycle.service';
import type {ResourceLifecycleSubject} from '../types/resource-lifecycle.types';

const at='2026-10-28T01:00:00.000Z',now=Date.parse(at);
function fleet() {
 return Array.from({length:5},(_,hostIndex)=>{
  const hostId=`host-${hostIndex}`;
  const subjects:ResourceLifecycleSubject[]=Array.from({length:hostIndex===0?11:10},(_,index)=>{
   const id=`${hostId}-resource-${index}`;
   return {subject:{kind:'resource',id,authorityHostId:hostId},generation:2,status:'idle',observedAt:at,receivedAt:null,current:true,reason:null,owner:null,
    idle:{contractVersion:'idle-v1',outcome:'passed',checkedAt:at,acceptedCheck:{operationId:`check-${id}`,subjectGeneration:2,resultSha256:'a'.repeat(64),acceptedAt:at},qualifiedScope:{kind:'fleet'},evidenceRefs:[]},
    repair:{configured:true,state:'none'},supportedActions:['check'],resource:{kind:'fixture',capabilities:[],memberships:[],dependencies:[],placement:'fleet'}};
  });
  const history=Array.from({length:200},(_,index)=>({id:`${hostId}-event-${String(index).padStart(3,'0')}`,resourceId:subjects[0]!.subject.id,subjectGeneration:2,at,event:'released'}));
  return {hostId,receivedAt:new Date(at),snapshot:{hostId,observedAt:at,lanes:[],resourceLifecycle:{schemaVersion:1,subjects,history}},resourceLifecycleCursor:{schemaVersion:1,subjects,history}};
 });
}
// Mongo inclusion projections retain only the requested dotted fields, including inside arrays.
function project(input:unknown,selection:Record<string,unknown>) {
 type Tree={whole?:boolean;fields?:Record<string,Tree>};const tree:Tree={};
 for(const [path,included] of Object.entries(selection)) if(included) {
  let node=tree;for(const part of path.split('.')) {node.fields??={};node=node.fields[part]??={}}node.whole=true;
 }
 function pick(value:unknown,node:Tree):unknown {
  if(node.whole)return structuredClone(value);
  if(Array.isArray(value))return value.map(item=>pick(item,node));
  if(value===null||typeof value!=='object')return undefined;
  return Object.fromEntries(Object.entries(node.fields??{}).filter(([key])=>key in value).map(([key,child])=>[key,pick((value as Record<string,unknown>)[key],child)]));
 }
 return pick(input,tree);
}
async function withStore(run:(rows:ReturnType<typeof fleet>,selections:Record<string,unknown>[])=>Promise<void>) {
 const rows=fleet(),selections:Record<string,unknown>[]=[],clock=spyOn(Date,'now').mockReturnValue(now);
 const find=spyOn(TestHostStateModel,'find').mockImplementation((()=>{
  let selection:Record<string,unknown>={};
  const query={select(value:Record<string,unknown>){selection=value;selections.push(value);return query},sort(){return query},limit(){return query},maxTimeMS(){return query},read(){return query},readConcern(){return query},lean:async()=>rows.map(row=>project(row,selection))};
  return query;
 }) as never);
 try {await run(rows,selections)}finally {find.mockRestore();clock.mockRestore()}
}

test('ordinary overview and detail read 51 current subjects without selecting or returning 1000 debug events',async()=>withStore(async(rows,selections)=>{
 const original=structuredClone(rows),app=createTestRunAdminApi();
 const response=await app.request('/resources/overview');expect(response.status).toBe(200);
 const overview=await response.json() as {subjects:ResourceLifecycleSubject[]};
 expect(overview.subjects).toHaveLength(51);expect(overview.subjects.every(subject=>subject.current&&subject.status==='idle')).toBe(true);
 expect(overview).not.toHaveProperty('history');expect(JSON.stringify(overview)).not.toContain('host-0-event-');
 const detail=await app.request('/resources/host-0-resource-0/detail');expect(detail.status).toBe(200);
 expect((await detail.json() as {subject:ResourceLifecycleSubject}).subject.owner).toBeNull();
 for(const selection of selections) {
  for(const path of ['snapshot.resourceLifecycle','resourceLifecycleCursor','snapshot.lanes','snapshot.resourceLifecycle.history','resourceLifecycleCursor.history'])expect(selection[path]).toBeUndefined();
  expect(selection['snapshot.resourceLifecycle.subjects']).toBe(1);expect(selection['resourceLifecycleCursor.subjects']).toBe(1);
 }
 expect(rows).toEqual(original);
}));

test('corrupt debug arrays do not invalidate current state but current authority and custody still refuse',async()=>withStore(async(rows)=>{
 const service=new ResourceLifecycleService();
 rows[0]!.snapshot.resourceLifecycle.history[0]!.event='not-an-event';
 rows[0]!.resourceLifecycleCursor.history[0]!.subjectGeneration=999;
 expect((await service.list()).subjects).toHaveLength(51);
 const subject=rows[0]!.snapshot.resourceLifecycle.subjects[0]!;
 subject.subject.authorityHostId='foreign-host';await expect(service.list()).rejects.toThrow('Invalid resource lifecycle observation');
 subject.subject.authorityHostId='host-0';subject.owner={kind:'run',id:'active-original',generation:2,hostId:'host-0'};
 await expect(service.list()).rejects.toThrow();
 subject.owner=null;subject.generation=3;await expect(service.list()).rejects.toThrow();
}));

test('current cursor high-water rejects a regressed snapshot without relying on debug events',async()=>withStore(async(rows)=>{
 const old=rows[0]!.snapshot.resourceLifecycle.subjects[0]!;
 rows[0]!.resourceLifecycleCursor={schemaVersion:1,subjects:[{...structuredClone(old),generation:3,idle:{...old.idle,acceptedCheck:{...old.idle.acceptedCheck!,subjectGeneration:3}}}],history:[]};
 await expect(new ResourceLifecycleService().list()).rejects.toThrow('generation regressed');
}));

test('debug history is a separate requested read with bounded pages and errors independent of overview',async()=>withStore(async(rows,selections)=>{
 const app=createTestRunAdminApi(),resourceId='host-0-resource-0';
 const response=await app.request(`/resources/${resourceId}/history`);expect(response.status).toBe(200);
 const page=await response.json() as {events:{id:string;resourceId:string}[];nextCursor:string;coverage:string};
 expect(page.events).toHaveLength(50);expect(page.events.every(event=>event.resourceId===resourceId)).toBe(true);
 expect(page.nextCursor).toBe('host-0-event-049');expect(page.coverage).toContain('200 events');
 expect(selections[0]!['snapshot.resourceLifecycle.history']).toBe(1);expect(selections[0]!['resourceLifecycleCursor.history']).toBe(1);
 const next=await app.request(`/resources/${resourceId}/history?cursor=${page.nextCursor}`);expect(next.status).toBe(200);
 expect((await next.json() as {events:{id:string}[]}).events[0]!.id).toBe('host-0-event-050');
 rows[0]!.snapshot.resourceLifecycle.history[0]!.subjectGeneration=999;
 expect((await app.request('/resources/overview')).status).toBe(200);
 expect((await app.request(`/resources/${resourceId}/history`)).status).toBe(400);
 expect((await app.request('/resources/overview')).status).toBe(200);
}));

test('explicit history keeps the existing 200-event cursor window instead of merging obsolete snapshot events',async()=>withStore(async(rows)=>{
 rows[0]!.snapshot.resourceLifecycle.history=rows[0]!.snapshot.resourceLifecycle.history.map(event=>({...event,id:`obsolete-${event.id}`}));
 const page=await new ResourceLifecycleService().history('host-0-resource-0','host-0-event-149');
 expect(page.events).toHaveLength(50);expect(page.events[0]!.id).toBe('host-0-event-150');expect(page.nextCursor).toBeNull();
}));
