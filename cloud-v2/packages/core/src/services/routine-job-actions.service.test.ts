import {expect, test} from 'bun:test';
import {GithubRoutineJobActions, cancelRoutineActions} from './routine-job-actions.service';

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
