import {expect,test} from 'bun:test';
import {hostRequestDeliveryFilter,hostCancellationDeliveryFilter,pendingRequestFilter,requestActivity} from './test-request-activity';
import {currentRequestCustody,cancellationQueueItem,TestPendingQueueService} from './test-pending-queue.service';
import {TestRequestModel} from '../models/test-request.model';
import type {ReceivedTestHostState} from './test-host-state.service';
const now=Date.parse('2026-10-08T12:00:00Z');
const host=(owner:any,state:ReceivedTestHostState['lanes'][number]['state']='running',receivedAt=new Date(now).toISOString()):ReceivedTestHostState => ({hostId:'host',receivedAt,observedAt:new Date(now).toISOString(),incarnation:'controller',incarnationGeneration:1,sequence:1,
 lanes:[{id:'lane',state,platform:'android',dispatchMode:'automatic',resources:[],activity:{generation:3,owner}}]});

test.each(['awaiting-source','awaiting-runner','preparing','queued'])('uncancelled %s is waiting',state=>expect(requestActivity({state})).toBe('waiting'));
test.each(['accepted','running'])('uncancelled %s is active',state=>expect(requestActivity({state})).toBe('active'));
test('terminal and malformed states never imply waiting',()=>{expect(requestActivity({state:'terminal'})).toBe('terminal');expect(requestActivity({state:'broken'})).toBe('unknown');});
test('every cancellation fence wins over a delivery or execution state',()=>{
 for(const receipt of [{hostCancellation:{}},{fleetCancellation:{}},{preparationCancellation:{}}])expect(requestActivity({state:'queued',...receipt})).toBe('cancellation');
 expect(requestActivity({state:'accepted',hostCancellation:{},cancellationAcknowledged:true})).toBe('cancellation');
 expect(hostRequestDeliveryFilter('host')).toEqual({hostId:'host',state:'queued'});
 expect(hostCancellationDeliveryFilter()).toEqual({hostCancellation:{$exists:true},cancellationAcknowledged:{$ne:true}});
 expect(pendingRequestFilter).toMatchObject({hostCancellation:{$exists:false},fleetCancellation:{$exists:false},preparationCancellation:{$exists:false}});
});
test('acknowledgement with current exact run custody retains cleanup attention',()=>{
 const hosts=[host({id:'request',kind:'run',requestId:'request'})];
 const row={requestId:'request',state:'accepted',hostCancellation:{reason:'Stop'},cancellationAcknowledged:true} as any;
 expect(cancellationQueueItem(row,hosts,now)).toMatchObject({reason:'Stop',cancellation:{acknowledged:true,cleanupPending:true,custody:[{hostId:'host',laneId:'lane',ownerId:'request',ownerKind:'run'}]}});
});
test('stale or mismatched observations cannot associate cleanup custody',()=>{
 expect(currentRequestCustody('request',[host({id:'other',kind:'run',requestId:'other'})],now)).toEqual([]);
 expect(currentRequestCustody('request',[host({id:'request',kind:'run',requestId:'request'},'running',new Date(now-120_001).toISOString())],now)).toEqual([]);
 expect(currentRequestCustody('request',[host({id:'request',kind:'run',requestId:'request'},'idle')],now)).toEqual([]);
 expect(currentRequestCustody('request',[host({id:'request',kind:'run',requestId:'request'},'running','invalid')],now)).toEqual([]);
});
test('repair custody survives cancellation only through its exact current restoration reference',()=>{
 const h=host({id:'fixer:1',kind:'fixer'},'out-of-service');
 h.restoration={schemaVersion:1,truncated:false,attempts:[{current:true,laneId:'lane',executionId:'fixer:1',requestId:'request',state:'halted'} as any]};
 expect(currentRequestCustody('request',[h],now)).toHaveLength(1);
 h.restoration.attempts[0]!.executionId='different';expect(currentRequestCustody('request',[h],now)).toEqual([]);
});
test('pending page uses the same cancellation fences for rows and count, with cancellation attention separate',async()=>{
 const {spyOn}=await import('bun:test');const filters:any[]=[];
 const find=spyOn(TestRequestModel,'find').mockImplementation(((filter:any)=>{
   filters.push(filter);return{sort(){return this},limit(){return this},read(){return this},readConcern(){return this},async lean(){return[]}};
 }) as any);
 const count=spyOn(TestRequestModel,'countDocuments').mockImplementation(((filter:any)=>{expect(filter).toEqual(pendingRequestFilter);return{read(){return this},readConcern(){return this},then(resolve:any){return Promise.resolve(0).then(resolve)}};}) as any);
 try{
  const result=await new TestPendingQueueService({list:async()=>[]} as any,()=>now).list();
  expect(result).toMatchObject({total:0,items:[],cancellations:[],cancellationsTruncated:false});
  expect(filters[0]).toEqual(pendingRequestFilter);
  expect(filters[1].state).toEqual({$ne:'terminal'});
  expect(filters[1].$or).toContainEqual(hostCancellationDeliveryFilter());
  expect(filters[1].$or).toContainEqual({fleetCancellation:{$exists:true},fleetBinding:{$exists:true},dispatchCompletion:{$exists:false}});
 }finally{find.mockRestore();count.mockRestore();}
});
test('current acknowledged custody precedes old cancellations at the page bound',async()=>{
 const {spyOn}=await import('bun:test');const held={requestId:'z-held',state:'accepted',hostCancellation:{reason:'Stop'},cancellationAcknowledged:true};
 const old=Array.from({length:51},(_,i)=>({requestId:`a-${i}`,state:'accepted',hostCancellation:{reason:'Stop'}}));
 const filters:any[]=[];
 const find=spyOn(TestRequestModel,'find').mockImplementation(((filter:any)=>{
  filters.push(filter);const rows=filter.requestId?.$in?[held]:filter.requestId?.$nin?old:[];
  return{sort(){return this},limit(){return this},read(){return this},readConcern(){return this},async lean(){return rows}};
 }) as any);
 const count=spyOn(TestRequestModel,'countDocuments').mockImplementation((()=>({read(){return this},readConcern(){return this},then(resolve:any){return Promise.resolve(0).then(resolve)}})) as any);
 try{
  const result=await new TestPendingQueueService({list:async()=>[host({id:'z-held',kind:'run',requestId:'z-held'})]} as any,()=>now).list();
  expect(result.cancellations).toHaveLength(50);expect(result.cancellations[0]).toMatchObject({requestId:'z-held',cancellation:{acknowledged:true,cleanupPending:true}});
  expect(result.cancellationsTruncated).toBe(true);
  expect(filters[1]).toMatchObject({state:{$ne:'terminal'},requestId:{$in:['z-held']}});
  expect(filters[2].requestId).toEqual({$nin:['z-held']});
 }finally{find.mockRestore();count.mockRestore();}
});
