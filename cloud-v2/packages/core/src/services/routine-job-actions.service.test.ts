import {expect, test} from 'bun:test';
import {GithubRoutineJobActions, cancelRoutineActions, routineActionsRetry} from './routine-job-actions.service';

test('fleet transport can dispatch only the trusted Harness main workflow and cancels one member run',async()=>{
  const calls:Array<{url:string;input:RequestInit}>=[], scopes:string[]=[];
  const actions=new GithubRoutineJobActions({async token(scope){scopes.push(scope);return 'private-test-token'}},async(url,input)=>{calls.push({url,input});return new Response(null,{status:204})});
  await actions.dispatch('suite:member-one');await actions.cancel('123');
  expect(scopes).toEqual(['dispatch','dispatch']);
  expect(calls[0]!.url).toBe('https://api.github.com/repos/Mentra-Community/Mentra-Automated-Testing/actions/workflows/routine-device.yml/dispatches');
  expect(JSON.parse(String(calls[0]!.input.body))).toEqual({ref:'main',inputs:{job_id:'suite:member-one'}});
  expect(calls[0]!.input.redirect).toBe('error');expect(calls[1]!.url).toEndWith('/actions/runs/123/cancel');
  await expect(actions.dispatch('../arbitrary-workflow')).rejects.toThrow();await expect(actions.cancel('../whole-suite')).rejects.toThrow();expect(calls).toHaveLength(2);
});
test('provider failure is bounded and exposes no token or body while retaining actionable permission reason',async()=>{
  const actions=new GithubRoutineJobActions({async token(){return 'secret-token'}},async()=>Response.json({error:'secret-provider-body'},{status:403}));
  await expect(actions.dispatch('retained')).rejects.toThrow('Harness Actions write permission');
  try {await actions.dispatch('retained')} catch(error){expect(String(error)).not.toContain('secret')}
});

test('run discovery correlates only the exact logical job on the trusted main workflow before preparation',async()=>{
 const rows=[{id:10,display_title:'routine-job:suite:one',event:'workflow_dispatch',head_branch:'main',path:'.github/workflows/routine-device.yml',created_at:'2026-10-08T00:00:00Z',status:'queued',conclusion:null},
 {id:11,display_title:'routine-job:suite:two',event:'workflow_dispatch',head_branch:'main',path:'.github/workflows/routine-device.yml',created_at:'2026-10-08T00:00:00Z',status:'queued',conclusion:null},
 {id:12,display_title:'routine-job:suite:one',event:'pull_request',head_branch:'main',path:'.github/workflows/routine-device.yml',created_at:'2026-10-08T00:00:00Z',status:'queued',conclusion:null}];
 const calls:string[]=[];const actions=new GithubRoutineJobActions({async token(){return 'test-token'}},async(url)=>{calls.push(url);return Response.json({workflow_runs:rows})});
 expect(await actions.runs('suite:one','2026-10-08T00:00:00Z')).toEqual([{actionsRunId:'10',status:'queued',conclusion:null}]);
 expect(calls[0]).toContain('workflows/routine-device.yml/runs?');expect(calls[0]).toContain('event=workflow_dispatch');expect(calls[0]).toContain('branch=main');
});

test('cancellation reconciliation remains pending through queued duplicates and settles only their completed receipts',async()=>{
 let status='queued';const cancelled:string[]=[],retained:string[]=[];
 const transport={async dispatch(){},async runs(){return [{actionsRunId:'10',status,conclusion:null},{actionsRunId:'11',status,conclusion:null}]},async cancel(id:string){cancelled.push(id)}};
 const input={transport,jobId:'one',dispatch:{attempts:1,firstAttemptAt:'2026-10-08T00:00:00Z',lastAttemptAt:'2026-10-08T00:00:00Z'},known:['10'],now:Date.parse('2026-10-08T00:01:00Z'),async retain(run:any){retained.push(run.actionsRunId)}};
 expect(await cancelRoutineActions(input)).toMatchObject({settled:false});expect(cancelled).toEqual(['10','11']);expect(retained).toEqual(['10','11']);
 status='completed';expect(await cancelRoutineActions(input)).toMatchObject({settled:true});expect(cancelled).toEqual(['10','11']);
});

test('a late known workflow remains unsettled until discovery sees its completed receipt',async()=>{
 const cancelled:string[]=[];let includeLate=false;
 const transport={async dispatch(){},async runs(){return [{actionsRunId:'10',status:'completed',conclusion:'cancelled'},
  ...(includeLate?[{actionsRunId:'11',status:'completed',conclusion:'cancelled'}]:[])]},async cancel(id:string){cancelled.push(id)}};
 const input={transport,jobId:'one',known:['10','11'],now:Date.parse('2026-10-08T00:03:00Z'),async retain(){}};
 expect(await cancelRoutineActions(input)).toMatchObject({settled:false});expect(cancelled).toEqual(['11']);
 includeLate=true;expect(await cancelRoutineActions(input)).toMatchObject({settled:true});expect(cancelled).toEqual(['11']);
});

test('discovery stops streaming an oversized provider response before decoding it',async()=>{
 let cancelled=false;
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(1024*1024));controller.enqueue(new Uint8Array(1024*1024));controller.enqueue(new Uint8Array(1));},cancel(){cancelled=true}});
 const actions=new GithubRoutineJobActions({async token(){return 'test-token'}},async()=>new Response(body));
 await expect(actions.runs('one','2026-10-08T00:00:00Z')).rejects.toThrow('exceeds its bound');expect(cancelled).toBe(true);
});

test('a full suite retry history beyond five pages retains exact active-run proof', async () => {
 const rows=Array.from({length:512},(_,index)=>({id:index+1,display_title:index===511?'routine-job:suite:one':'routine-job:other',event:'workflow_dispatch',head_branch:'main',path:'.github/workflows/routine-device.yml',created_at:'2026-10-08T00:00:00Z',status:index===511?'queued':'completed',conclusion:index===511?null:'failure'}));
 const calls:string[]=[];
 const actions=new GithubRoutineJobActions({async token(){return 'test-token'}},async(url)=>{calls.push(url);const page=Number(new URL(url).searchParams.get('page'));return Response.json({workflow_runs:rows.slice((page-1)*100,page*100)})});
 const runs=await actions.runs('suite:one','2026-10-08T00:00:00Z');
 expect(runs).toEqual([{actionsRunId:'512',status:'queued',conclusion:null}]);
 expect(calls).toHaveLength(6);
 const {routineActionsRetry}=await import('./routine-job-actions.service');
 expect(routineActionsRetry({attempts:19,lastAttemptAt:'2026-10-08T00:00:00Z',acknowledgedAt:'2026-10-08T00:00:00Z'},runs,Date.parse('2026-10-08T00:10:00Z'))).toBe(false);
});

test('discovery never interprets the provider result ceiling as absence', async () => {
 const rows=Array.from({length:100},(_,index)=>({id:index+1,display_title:'routine-job:other',event:'workflow_dispatch',head_branch:'main',path:'.github/workflows/routine-device.yml',created_at:'2026-10-08T00:00:00Z',status:'completed',conclusion:'failure'}));
 let calls=0;
 const actions=new GithubRoutineJobActions({async token(){return 'test-token'}},async()=>{calls++;return Response.json({workflow_runs:rows})});
 await expect(actions.runs('suite:one','2026-10-08T00:00:00Z')).rejects.toThrow('1,000-result GitHub bound');
 expect(calls).toBe(10);
});

test('concurrent members share one bounded discovery but retain exact filtering and fresh later reads',async()=>{
 const rows=Array.from({length:512},(_,index)=>({id:index+1,display_title:`routine-job:member-${index%26}`,event:'workflow_dispatch',head_branch:'main',path:'.github/workflows/routine-device.yml',created_at:index===0?'2026-10-08T00:00:00Z':'2026-10-08T00:00:45Z',status:'queued',conclusion:null}));
 let calls=0,status='queued';
 const actions=new GithubRoutineJobActions({async token(){return 'test-token'}},async(url)=>{calls++;const page=Number(new URL(url).searchParams.get('page'));await Promise.resolve();return Response.json({workflow_runs:rows.slice((page-1)*100,page*100).map(row=>({...row,status}))})});
 const found=await Promise.all(Array.from({length:26},(_,index)=>actions.runs(`member-${index}`,new Date(Date.parse('2026-10-08T00:00:35Z')+index*1000).toISOString())));
 expect(calls).toBe(6);expect(found[0]!.some(row=>row.actionsRunId==='1')).toBe(false);
 for(let index=0;index<26;index++)expect(found[index]!.every(row=>rows[Number(row.actionsRunId)-1]!.display_title===`routine-job:member-${index}`)).toBe(true);
 status='completed';expect((await actions.runs('member-0','2026-10-08T00:00:35Z')).every(row=>row.status==='completed')).toBe(true);expect(calls).toBe(12);
});

test('shared discovery failures are discarded and cannot become cancellation absence proof',async()=>{
 let calls=0,failed=true;
 const actions=new GithubRoutineJobActions({async token(){return 'test-token'}},async()=>{calls++;return failed?new Response(null,{status:403}):Response.json({workflow_runs:[]})});
 const results=await Promise.allSettled(Array.from({length:26},(_,index)=>actions.runs(`member-${index}`,'2026-10-08T00:00:00Z')));
 expect(calls).toBe(1);expect(results.every(result=>result.status==='rejected')).toBe(true);
 failed=false;expect(await actions.runs('member-0','2026-10-08T00:00:00Z')).toEqual([]);expect(calls).toBe(2);
});


test('completed delivery history does not impose a lifetime retry limit', () => {
 const now=Date.parse('2026-10-08T00:10:00Z'), receipt={attempts:20,firstAttemptAt:'2026-10-08T00:00:00Z',lastAttemptAt:'2026-10-08T00:00:00Z',acknowledgedAt:'2026-10-08T00:00:01Z'};
 const runs=Array.from({length:20},(_,n)=>({actionsRunId:String(n+1),status:'completed',conclusion:'failure'}));
 expect(routineActionsRetry(receipt,runs,now)).toBe(true);
 for(const status of ['queued','in_progress','waiting','pending'])expect(routineActionsRetry(receipt,[...runs,{actionsRunId:'21',status,conclusion:null}],now)).toBe(false);
 expect(routineActionsRetry({...receipt,lastAttemptAt:new Date(now-29_999).toISOString()},runs,now)).toBe(false);
 expect(routineActionsRetry({...receipt,firstAttemptAt:undefined},[],now)).toBe(false);
 expect(routineActionsRetry({...receipt,acknowledgedAt:new Date(now-119_999).toISOString()},[],now)).toBe(false);
 expect(routineActionsRetry(receipt,[],now)).toBe(true);
});
