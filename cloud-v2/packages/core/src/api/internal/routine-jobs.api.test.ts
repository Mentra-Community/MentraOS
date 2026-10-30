import {afterEach, expect, test, spyOn} from 'bun:test';
import {Hono} from 'hono';
import {createRoutineJobBindingApi, createRoutineJobsApi} from './routine-jobs.api';
import {RoutineJobService, RoutineLaneAcceptanceConflict, RoutineBindingConflict} from '../../services/routine-job.service';
import {RoutineWorkService} from '../../services/routine-work.service';
import {TestRunError} from '../../services/test-result-error';
import {TestRequestConflict} from '../../services/test-request.service';
import {TestDispatchError} from '../../services/test-builds.service';
import type {AppEnv} from '../../types/hono.types';
import {requestContext} from '../middleware/context.middleware';
import {randomUUID} from 'node:crypto';

test('pending preparation warns before the transport deadline with the actual inbound request identity', async () => {
  process.env.TEST_RUN_INGEST_TOKEN = observerToken;
  const reqId = randomUUID(), warnings: unknown[] = [];
  let now = 0, alarm: (() => void) | undefined, cleared = false;
  let complete: (value: {jobId: string}) => void = () => {}, notifyStarted: () => void = () => {};
  const answer = new Promise<{jobId: string}>(resolve => {complete = resolve;});
  const started = new Promise<void>(resolve => {notifyStarted = resolve;});
  const jobs = {async preparation(_id: string, onPhase?: (phase: string) => void) {
    onPhase?.('job-lookup'); notifyStarted(); return answer;
  }} as unknown as RoutineJobService;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    expect(delay).toBe(10000); alarm = callback; return 1;
  }) as any);
  const cancel = spyOn(globalThis, 'clearTimeout').mockImplementation((() => {cleared = true;}) as any);
  const restores: (() => void)[] = [];
  let bindings: unknown;
  const app = new Hono<AppEnv>(); app.use('*', requestContext);
  app.use('*', async (c, next) => {
    bindings = c.var.logger.bindings();
    const info = spyOn(c.var.logger, 'info').mockImplementation((() => {}) as any);
    const warn = spyOn(c.var.logger, 'warn').mockImplementation(((fields: unknown) => {warnings.push(fields);}) as any);
    restores.push(() => {info.mockRestore(); warn.mockRestore();}); await next();
  });
  app.route('/', createRoutineJobsApi(jobs));
  const pending = app.request('/one/preparation', {headers: {authorization: `Bearer ${observerToken}`, 'x-request-id': reqId}});
  try {
    await started; expect(alarm).toBeDefined(); now = 10000; alarm!();
    expect(bindings).toMatchObject({reqId, method: 'GET', path: '/one/preparation'});
    expect(warnings).toEqual([{operation: 'lookup', phase: 'job-lookup', jobId: 'one', reqId,
      stageElapsedMs: 10000, requestElapsedMs: 10000}]);
    expect(cleared).toBe(false);
    complete({jobId: 'one'});
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe(reqId);
    expect(cleared).toBe(true);
  } finally {
    complete({jobId: 'one'}); await pending;
    restores.forEach(restore => restore()); clock.mockRestore(); timer.mockRestore(); cancel.mockRestore();
  }
});

test('completed matching logs its computed wait and target without exposing the preparation body', async () => {
  process.env.TEST_RUN_INGEST_TOKEN = observerToken;
  for (const waiting of [true, false]) {
    const result = {jobId: 'one', state: 'awaiting-runner', waitingReason: waiting ? 'Recorder space is unavailable' : undefined,
      resourceTarget: waiting ? undefined : {hostId: 'mini', laneId: 'android'},
      routingLabels: waiting ? [] : ['mentra-platform-android'], selection: {privateSource: 'private prepared source body'}};
    const records: {fields: Record<string, unknown>; message: string}[] = [];
    const jobs = {async preparation() {return result;}} as unknown as RoutineJobService;
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('reqId', 'matching-request');
      c.set('logger', {info: (fields: Record<string, unknown>, message: string) => records.push({fields, message})} as any);
      await next();
    });
    app.route('/', createRoutineJobsApi(jobs));
    const response = await app.request('/one/preparation', {headers: {authorization: `Bearer ${observerToken}`}});
    expect(response.status).toBe(200);
    const completed = records.filter(record => record.message === 'routine job preparation matching completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.fields).toMatchObject({operation: 'lookup', jobId: 'one', reqId: 'matching-request', state: 'awaiting-runner',
      waitingReason: waiting ? 'Recorder space is unavailable' : null,
      resourceTarget: waiting ? null : {hostId: 'mini', laneId: 'android'}, routingLabelCount: waiting ? 0 : 1});
    expect(JSON.stringify(records)).not.toContain(result.selection.privateSource);
  }
});

test('normal observations stay quiet and a slow original request retains its phase and existing request context',async()=>{
  process.env.TEST_RUN_INGEST_TOKEN=observerToken;
  for(const slow of [false,true]) {
    let now=0,alarm:(()=>void)|undefined,cleared=false;const warnings:unknown[]=[];
    const clock=spyOn(Date,'now').mockImplementation(()=>now);
    const timer=spyOn(globalThis,'setTimeout').mockImplementation(((callback:()=>void,delay:number)=>{expect(delay).toBe(10000);alarm=callback;return 1;})as any);
    const cancel=spyOn(globalThis,'clearTimeout').mockImplementation((()=>{cleared=true;})as any);
    const jobs={async observation(_id:string,phase:(value:string)=>void){phase('result');if(slow){now=10000;alarm!();now=12000;}return{jobId:'one',terminal:false};}}as unknown as RoutineJobService;
    const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{c.set('logger',{warn:(fields:unknown,message:string)=>warnings.push({fields,message,reqId:'original-request'})}as any);await next();});
    app.route('/',createRoutineJobsApi(jobs));
    try{
      const response=await app.request('/one/observation',{headers:{authorization:`Bearer ${observerToken}`}});
      expect(response.status).toBe(200);expect(await response.json()).toEqual({jobId:'one',terminal:false});expect(cleared).toBe(true);
      expect(warnings).toEqual(slow?[{fields:{phase:'result',elapsedMs:10000},message:'routine job observation is slow',reqId:'original-request'},
        {fields:{phase:'result',elapsedMs:12000,status:200},message:'slow routine job observation completed',reqId:'original-request'}]:[]);
    }finally{clock.mockRestore();timer.mockRestore();cancel.mockRestore();}
  }
});

test('slow fallback failure settles its diagnostic timer without changing the original API error',async()=>{
  process.env.TEST_RUN_INGEST_TOKEN=observerToken;let now=0,cleared=false;const warnings:any[]=[];
  const clock=spyOn(Date,'now').mockImplementation(()=>now);
  const timer=spyOn(globalThis,'setTimeout').mockImplementation((()=>1)as any),cancel=spyOn(globalThis,'clearTimeout').mockImplementation((()=>{cleared=true;})as any);
  const jobs={async observation(){throw new TestRunError(404,'Missing run');}}as unknown as RoutineJobService;
  const authors={async observation(){now=11000;throw new TestRunError(409,'Original author conflict');}}as unknown as RoutineWorkService;
  const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{c.set('logger',{warn:(fields:unknown,message:string)=>warnings.push({fields,message})}as any);await next();});app.route('/',createRoutineJobsApi(jobs,authors));
  try{
    const response=await app.request('/author/observation',{headers:{authorization:`Bearer ${observerToken}`}});
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({message:'Original author conflict'});
    expect(cleared).toBe(true);expect(warnings).toEqual([{fields:{phase:'author',elapsedMs:11000,status:409,errorKind:'routine_job_error',errorName:'Error'},message:'slow routine job observation failed'}]);
  }finally{clock.mockRestore();timer.mockRestore();cancel.mockRestore();}
});

test('slow failure diagnostics distinguish existing API statuses without logging error messages',async()=>{
  process.env.TEST_RUN_INGEST_TOKEN=observerToken;
  for(const [error,status,errorKind] of [
    [new TestRunError(403,'private request payload'),403,'routine_job_error'],
    [new TestDispatchError(404,'private artifact URL'),404,'routine_job_error'],
    [new TestRequestConflict('private conflicting request'),409,'routine_job_conflict'],
    [new Error('private database details'),503,'routine_job_unavailable'],
  ]as const) {
    let now=0,cleared=false;const warnings:any[]=[];
    const clock=spyOn(Date,'now').mockImplementation(()=>now);
    const timer=spyOn(globalThis,'setTimeout').mockImplementation((()=>1)as any),cancel=spyOn(globalThis,'clearTimeout').mockImplementation((()=>{cleared=true;})as any);
    const jobs={async observation(){now=11000;throw error;}}as unknown as RoutineJobService;
    const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{c.set('logger',{warn:(fields:unknown,message:string)=>warnings.push({fields,message}),error:()=>{}}as any);await next();});app.route('/',createRoutineJobsApi(jobs));
    try {
      const response=await app.request('/one/observation',{headers:{authorization:`Bearer ${observerToken}`}});
      expect(response.status).toBe(status);expect(cleared).toBe(true);
      expect(warnings).toEqual([{fields:{phase:'request',elapsedMs:11000,status,errorKind,errorName:'Error'},message:'slow routine job observation failed'}]);
      expect(JSON.stringify(warnings)).not.toContain(error.message);
    }finally{clock.mockRestore();timer.mockRestore();cancel.mockRestore();}
  }
});
const previous = process.env.TEST_RUN_INGEST_TOKEN;
afterEach(() => {if (previous === undefined) delete process.env.TEST_RUN_INGEST_TOKEN; else process.env.TEST_RUN_INGEST_TOKEN=previous});
const observerToken='observer-token-at-least-thirty-two-characters';
const hostToken='host-token-at-least-thirty-two-characters';
test('bind acceptance checklist retains the installed conflict envelope and actual request correlation', async () => {
  const reqId = randomUUID(), records: unknown[] = [], restores: (() => void)[] = [];
  const diagnostic = {stage: 'after-reservation' as const, hostId: 'mini', laneId: 'android', conditions: [
    {id: 'enrolled-host', status: 'passed' as const, expected: 'Authenticated host', observed: 'mini'},
    {id: 'lane-automatic', status: 'failed' as const, expected: 'automatic', observed: 'manual'},
    {id: 'resource-state', status: 'not-evaluated' as const, expected: 'Original resource authority'},
  ]};
  const jobs = {async bind() {throw new RoutineLaneAcceptanceConflict(diagnostic);}} as unknown as RoutineJobService;
  const app = new Hono<AppEnv>(); app.use('*', requestContext);
  app.use('*', async (c, next) => {
    const warn = spyOn(c.var.logger, 'warn').mockImplementation(((fields: unknown, message: string) => records.push({fields, message})) as any);
    restores.push(() => warn.mockRestore()); await next();
  });
  app.route('/test-requests', createRoutineJobBindingApi(jobs, () => JSON.stringify({mini: hostToken})));
  try {
    const response = await app.request('/test-requests/original/bind', {method: 'POST', headers: {
      authorization: `Bearer ${hostToken}`, 'content-type': 'application/json', 'x-request-id': reqId},
      body: JSON.stringify({privateSource: 'private-body-sentinel'})});
    const body = await response.json() as {error: string; message: string};
    expect(response.status).toBe(409); expect(Object.keys(body).sort()).toEqual(['error', 'message']);
    expect(body.error).toBe('routine_job_conflict'); expect(body.message).toContain('after-reservation: lane-automatic');
    expect(body.message).toContain('resource-state=not-evaluated'); expect(body.message.length).toBeLessThanOrEqual(2000);
    expect(response.headers.get('x-request-id')).toBe(reqId);
    expect(records).toEqual([{fields: {jobId: 'original', reqId, ...diagnostic}, message: 'routine job lane acceptance refused'}]);
    expect(JSON.stringify({body, records})).not.toContain(hostToken);
    expect(JSON.stringify({body, records})).not.toContain('private-body-sentinel');
  } finally {restores.forEach(restore => restore());}
});
test('generic binding conflicts keep their prior response and do not invent a checklist', async () => {
  const jobs = {async bind() {throw new TestRequestConflict('Original immutable input changed');}} as unknown as RoutineJobService;
  const app = createRoutineJobBindingApi(jobs, () => JSON.stringify({mini: hostToken}));
  const response = await app.request('/original/bind', {method: 'POST', headers: {authorization: `Bearer ${hostToken}`,
    'content-type': 'application/json'}, body: '{}'});
  expect(response.status).toBe(409); expect(await response.json()).toEqual({error: 'routine_job_conflict', message: 'Original immutable input changed'});
});
test('trusted observer cannot impersonate host; host identity comes only from enrolled token',async()=>{
  process.env.TEST_RUN_INGEST_TOKEN=observerToken;const bindings:unknown[]=[];
  const jobs={async preparation(){return {jobId:'one',state:'awaiting-runner',routingLabels:['mentra-platform-android']}},async observation(){return {jobId:'one',terminal:false}},
    async bind(jobId:string,hostId:string,input:unknown){bindings.push({jobId,hostId,input});return {binding:{jobId,hostId},execute:true}}} as unknown as RoutineJobService;
  const app=new Hono();app.route('/api/internal/routine-jobs',createRoutineJobsApi(jobs));app.route('/api/internal/test-requests',createRoutineJobBindingApi(jobs,()=>JSON.stringify({mini:hostToken})));
  expect((await app.request('/api/internal/routine-jobs/one/observation')).status).toBe(401);
  expect((await app.request('/api/internal/routine-jobs/one/observation',{headers:{authorization:`Bearer ${hostToken}`}})).status).toBe(401);
  expect((await app.request('/api/internal/routine-jobs/one/observation',{headers:{authorization:`Bearer ${observerToken}`}})).status).toBe(200);
  const body={inputSha256:'a'.repeat(64),laneId:'android',descriptorRevision:'b'.repeat(64),actionsRunId:'10',actionsJobId:'20'};
  expect((await app.request('/api/internal/test-requests/one/bind',{method:'POST',headers:{authorization:`Bearer ${observerToken}`,'content-type':'application/json'},body:JSON.stringify(body)})).status).toBe(401);
  const response=await app.request('/api/internal/test-requests/one/bind',{method:'POST',headers:{authorization:`Bearer ${hostToken}`,'content-type':'application/json'},body:JSON.stringify(body)});
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(bindings).toEqual([{jobId:'one',hostId:'mini',input:body}]);
});
test('author fallback is limited to missing run jobs; conflict cannot route into another job kind',async()=>{
  process.env.TEST_RUN_INGEST_TOKEN=observerToken;let calls=0;
  const jobs={async preparation(id:string){throw new TestRunError(id==='missing'?404:409,'unavailable')}} as unknown as RoutineJobService;
  const authors={async preparation(id:string){calls++;return {jobId:id,kind:'author'}}} as unknown as RoutineWorkService;
  const app=createRoutineJobsApi(jobs,authors),headers={authorization:`Bearer ${observerToken}`};
  expect(await (await app.request('/missing/preparation',{headers})).json()).toEqual({jobId:'missing',kind:'author'});
  expect((await app.request('/conflict/preparation',{headers})).status).toBe(409);expect(calls).toBe(1);
});

test('author Actions registration and host completion retain their authentication and route only a missing run job',async()=>{
  process.env.TEST_RUN_INGEST_TOKEN=observerToken; const calls:unknown[]=[];
  const missing=(id:string)=>{throw new TestRunError(id==='author'?404:409,'unavailable')};
  const jobs={async actions(id:string){return missing(id)},async complete(id:string){return missing(id)}} as unknown as RoutineJobService;
  const authors={async actions(jobId:string,input:unknown){calls.push({kind:'actions',jobId,input});return {jobId,kind:'author',terminal:false}},
    async complete(jobId:string,hostId:string,input:unknown){calls.push({kind:'complete',jobId,hostId,input});return input}} as unknown as RoutineWorkService;
  const app=new Hono();app.route('/routine-jobs',createRoutineJobsApi(jobs,authors));app.route('/test-requests',createRoutineJobBindingApi(jobs,()=>JSON.stringify({mini:hostToken}),authors));
  const request=(path:string,token:string,body:unknown)=>app.request(path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const action={inputSha256:'a'.repeat(64),actionsRunId:'10'},completion={inputSha256:'b'.repeat(64),disposition:'clean',completedAt:'2026-10-08T01:00:00Z'};
  expect((await request('/routine-jobs/author/actions',hostToken,action)).status).toBe(401);
  expect((await request('/routine-jobs/conflict/actions',observerToken,action)).status).toBe(409);
  expect(await (await request('/routine-jobs/author/actions',observerToken,action)).json()).toEqual({jobId:'author',kind:'author',terminal:false});
  expect((await request('/test-requests/author/dispatch-completion',observerToken,completion)).status).toBe(401);
  expect((await request('/test-requests/conflict/dispatch-completion',hostToken,completion)).status).toBe(409);
  const response=await request('/test-requests/author/dispatch-completion',hostToken,completion);
  expect(response.status).toBe(200);expect(await response.json()).toEqual({completion});expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(calls).toEqual([{kind:'actions',jobId:'author',input:action},{kind:'complete',jobId:'author',hostId:'mini',input:completion}]);
});

test('author fleet intake dispatches, binds exact local work and finishes observation when custody returns during review',async()=>{
  process.env.TEST_RUN_INGEST_TOKEN=observerToken;
  const {requestInputDigest}=await import('../../services/test-request.service');
  const {routineLaneDescriptorRevision,routineRequirementLabels}=await import('../../services/routine-job.service');
  const {createRoutineWorkIntakeApi,createRoutineWorkDeliveriesApi}=await import('./routine-work.api');
  type Delivery=import('../../services/routine-work.service').RoutineWorkDelivery;
  type Repository=import('../../services/routine-work.service').RoutineWorkRepository;
  let row:Delivery|null=null;const dispatched:string[]=[],time=Date.parse('2026-10-08T00:00:00Z');
  const copy=<T>(value:T):T=>structuredClone(value);
  const repository:Repository={
    async get(id){return row?.workId===id?copy(row):null},async insert(value){row=copy(value)},async queued(){return []},
    async accept(receipt){if(!row||row.acceptance)return null;row={...row,acceptance:copy(receipt)};return copy(row)},
    async updateStatus(event){if(!row)return null;row={...row,status:copy(event),statusReceipts:[{eventId:event.eventId,sequence:event.sequence,sha256:requestInputDigest(event)}]};return copy(row)},
    async dispatch(_id,previous,value){if(!row||requestInputDigest(row.fleetDispatch??null)!==requestInputDigest(previous??null))return null;row={...row,fleetDispatch:copy(value)};return copy(row)},
    async actions(_id,digest,value){if(!row||row.fleetInputSha256!==digest)return null;row={...row,fleetActions:[...row.fleetActions??[],copy(value)]};return copy(row)},
    async bind(_id,digest,binding,work){if(!row||row.fleetBinding||row.fleetInputSha256!==digest)return null;row={...row,hostId:binding.hostId,fleetBinding:copy(binding),work:copy(work),inputSha256:requestInputDigest(work)};return copy(row)},
    async complete(_id,hostId,digest,receipt){if(!row||row.hostId!==hostId||row.inputSha256!==digest||row.dispatchCompletion)return null;row={...row,dispatchCompletion:copy(receipt)};return copy(row)},
    async cancel(){throw new Error('Unexpected cancellation')},
  };
  const lane={id:'android',platform:'android' as const,state:'idle' as const,dispatchMode:'automatic' as const,
    resources:[{id:'app',kind:'app' as const},{id:'phone',kind:'phone' as const},{id:'recorder',kind:'recorder' as const},{id:'glasses',kind:'glasses' as const}],
    glasses:[{resourceId:'glasses',deviceId:'physical-live',model:'mentra-live',capabilities:['camera']}]};
  const observed={hostId:'mini',incarnation:'one',incarnationGeneration:1,sequence:1,observedAt:new Date(time).toISOString(),receivedAt:new Date(time).toISOString(),lanes:[{...lane,descriptorRevision:routineLaneDescriptorRevision(lane)}]};
  const authors=new RoutineWorkService(repository,{async resolve(source,platform){return {source,platform,availability:'available',headSha:'b'.repeat(40),title:'Candidate',buildUrl:'https://github.com/run/55',createdAt:new Date(time).toISOString(),
    archive:{name:'candidate.apk',url:'https://artifactscdn.mentraglass.com/candidate.apk',size:100,sha256:'c'.repeat(64)},receipt:{url:'https://artifactscdn.mentraglass.com/receipt',size:20,sha256:'d'.repeat(64)}}}},
    {async get(){return observed},async list(){return [observed]}},{async publish(){}},{async resolve(){return 'a'.repeat(40)}},()=>time,
    {async dispatch(id){dispatched.push(id)},async cancel(){}});
  const absent=async()=>{throw new TestRunError(404,'missing run')};
  const jobs={preparation:absent,actions:absent,bind:absent,complete:absent,observation:absent} as unknown as RoutineJobService;
  const app=new Hono();app.route('/routine-work',createRoutineWorkIntakeApi(authors));app.route('/routine-jobs',createRoutineJobsApi(jobs,authors));
  app.route('/test-requests',createRoutineJobBindingApi(jobs,()=>JSON.stringify({mini:hostToken}),authors));
  app.route('/routine-work-deliveries',createRoutineWorkDeliveriesApi(authors,()=>JSON.stringify({mini:hostToken})));
  const headers={authorization:`Bearer ${observerToken}`,'content-type':'application/json'};
  const input={schemaVersion:1,workId:'author-fleet',kind:'edit',routineId:'camera-check',brief:{goal:'Verify camera independently',stepsOrChanges:['Observe image'],expected:['Image visible']},source:{repository:'Mentra-Community/Mentra-Automated-Testing'},
    requirements:{platform:'android',glasses:['mentra-live'],environment:[],resources:[{kind:'app',capabilities:[]},{kind:'phone',capabilities:[]},{kind:'recorder',capabilities:[]},{kind:'glasses',capabilities:[]}]},
    origin:{repository:'Mentra-Community/MentraOS',prNumber:12,headSha:'b'.repeat(40)},buildSource:{channel:'pr',prNumber:12,buildRunId:55,publicationAttempt:2}};
  expect((await app.request('/routine-work',{method:'POST',headers,body:JSON.stringify(input)})).status).toBe(202);expect(dispatched).toEqual(['author-fleet']);
  const prepared=await (await app.request('/routine-jobs/author-fleet/preparation',{headers})).json() as any;
  expect(prepared.kind).toBe('author');expect(prepared.chosenModel).toBe('mentra-live');
  expect(prepared.routingLabels).toEqual(routineRequirementLabels(prepared.prepared.requirements,'mentra-live'));
  const action={inputSha256:prepared.inputSha256,actionsRunId:'10'};
  expect((await app.request('/routine-jobs/author-fleet/actions',{method:'POST',headers,body:JSON.stringify(action)})).status).toBe(200);
  const bind={...action,laneId:'android',descriptorRevision:observed.lanes[0]!.descriptorRevision,actionsJobId:'20'};
  const hostHeaders={authorization:`Bearer ${hostToken}`,'content-type':'application/json'};
  const boundResponse=await app.request('/test-requests/author-fleet/bind',{method:'POST',headers:hostHeaders,body:JSON.stringify(bind)});
  expect(boundResponse.status).toBe(200);expect(await boundResponse.json()).toMatchObject({execute:true});
  const retained=await authors.inspect('author-fleet');expect(retained.inputSha256).not.toBe(prepared.inputSha256);
  const acceptance={workId:retained.workId,hostId:'mini',inputSha256:retained.inputSha256,acceptedAt:'2026-10-08T00:00:30Z'};
  expect((await app.request('/routine-work-deliveries/author-fleet/accept',{method:'POST',headers:hostHeaders,body:JSON.stringify(acceptance)})).status).toBe(200);
  const status={...acceptance,eventId:'awaiting-review',sequence:1,state:'awaiting-review',details:{...acceptance,state:'awaiting-review',sequence:1,work:retained.work,details:{summary:'Review is pending'},events:[]}};
  const {acceptedAt:_,...statusEvent}=status;
  expect((await app.request('/routine-work-deliveries/author-fleet/status',{method:'POST',headers:hostHeaders,body:JSON.stringify(statusEvent)})).status).toBe(200);
  expect(await (await app.request('/routine-jobs/author-fleet/observation',{headers})).json()).toMatchObject({terminal:false,state:'awaiting-review'});
  const completion={inputSha256:retained.inputSha256,disposition:'clean',completedAt:'2026-10-08T00:01:00Z'};
  expect((await app.request('/test-requests/author-fleet/dispatch-completion',{method:'POST',headers:hostHeaders,body:JSON.stringify({...completion,inputSha256:prepared.inputSha256})})).status).toBe(409);
  expect((await app.request('/test-requests/author-fleet/dispatch-completion',{method:'POST',headers:hostHeaders,body:JSON.stringify(completion)})).status).toBe(200);
  expect(await (await app.request('/routine-jobs/author-fleet/observation',{headers})).json()).toMatchObject({terminal:true,state:'awaiting-review',inputSha256:prepared.inputSha256,cleanupDisposition:'clean'});
});


test('binding commit refusal keeps the HTTP409 envelope and logs its exact stage under the authenticated request', async () => {
  const reqId = randomUUID(), records: unknown[] = [], restores: (() => void)[] = [];
  const diagnostics = {stage: 'host-cas' as const, predicate: 'unchanged-host-selector', hostId: 'mini', laneId: 'android',
    expected: {sequence: 10, laneControlVersion: null, laneControlVersionAbsent: true}};
  const jobs = {async bind() {throw new RoutineBindingConflict('Routine resource admission did not commit worker binding', diagnostics);}} as unknown as RoutineJobService;
  const app = new Hono<AppEnv>(); app.use('*', requestContext);
  app.use('*', async (c, next) => {
    const warn = spyOn(c.var.logger, 'warn').mockImplementation(((fields: unknown, message: string) => records.push({fields, message})) as any);
    restores.push(() => warn.mockRestore()); await next();
  });
  app.route('/test-requests', createRoutineJobBindingApi(jobs, () => JSON.stringify({mini: hostToken})));
  try {
    const response = await app.request('/test-requests/original/bind', {method: 'POST', headers: {
      authorization: `Bearer ${hostToken}`, 'content-type': 'application/json', 'x-request-id': reqId}, body: JSON.stringify({secret: 'private-body-sentinel'})});
    const body = await response.json() as {error: string; message: string};
    expect(response.status).toBe(409); expect(Object.keys(body).sort()).toEqual(['error', 'message']);
    expect(body.error).toBe('routine_job_conflict'); expect(body.message).toContain('host-cas: unchanged-host-selector');
    expect(body.message).toContain('expected {\"sequence\":10,\"laneControlVersion\":null,\"laneControlVersionAbsent\":true}');
    expect(body.message.length).toBeLessThan(2000); expect(response.headers.get('x-request-id')).toBe(reqId);
    expect(records).toEqual([{fields: {jobId: 'original', reqId, ...diagnostics}, message: 'routine job binding commit refused'}]);
    expect(JSON.stringify({body, records})).not.toContain(hostToken);
    expect(JSON.stringify({body, records})).not.toContain('private-body-sentinel');
  } finally {restores.forEach(restore => restore());}
});
