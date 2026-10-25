import {expect, test} from 'bun:test';
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures';
import {routineEnrollmentSchema, type RoutineEnrollment} from '../types/routine-definition.types';
import {reconcileRecorderHostReservations} from './routine-job.service';
import {RoutineDispatchService, recordedRoutineBuild} from './routine-dispatch.service';
import {TestRequestService, TestRequestConflict, requestInputDigest, isExecutableRequest, type StoredRequest, type TestRequestRepository} from './test-request.service';
import {TestRunError} from './test-result-error';
import {routineDispatchIntentSchema} from '../types/routine-dispatch.types';
import {frameworkRequestInputSchema} from '../types/framework-request.types';
import {selectedBuildInput} from '../types/test-build.types';
import {readAcceptedRoutineRequest} from './routine-request-input';
import {nightlyPreparedInput} from './nightly-routine.service';
const source = {channel: 'pr' as const, prNumber: 12, buildRunId: 55, publicationAttempt: 2};
const selected = {requestId: 'pr:12:routine', routineId: 'arbitrary.new-routine', platform: 'android' as const, source};
function fixture(frameworks?: ConstructorParameters<typeof TestRequestService>[3]) {
  let revision = 'a'.repeat(40), resolves = 0, sourceResolves = 0, enrollments = 0, available = true, automatic = true;
  let row: StoredRequest | null = null;
  const definitions = new Map<string, RoutineEnrollment>();
  const repository: TestRequestRepository = {
    async get() {return structuredClone(row);}, async insert(value) {if(row)throw Object.assign(Error('duplicate'),{code:11000});row=structuredClone(value);},
    async insertPreparation(value) {if(row)throw Object.assign(Error('duplicate'),{code:11000});row=structuredClone(value);},
    async completePreparation(id,host,digest,input,inputSha256) {if(!row||row.state!=='preparing'||row.hostId!==host||row.dispatchIntentSha256!==digest)return null;row={...row,state:'queued',input,inputSha256};return structuredClone(row);},
    async preparations(host) {return row?.state==='preparing'&&row.hostId===host?[structuredClone(row) as any]:[];},
    async queued(host) {return row&&isExecutableRequest(row)&&row.state==='queued'&&row.hostId===host?[{...structuredClone(row),createdAt:new Date('2026-10-06T12:00:00Z')}]:[];},
    async cancelPreparation(id,digest,value) {if(!row||row.state!=='preparing'||row.dispatchIntentSha256!==digest)return null;row={...row,state:'terminal',terminalStatus:'cancelled',preparationCancellation:value} as any;return structuredClone(row) as any;},
    async updatePreparation(id,host,digest,value) {if(!row||row.state!=='preparing')return null;row={...row,preparation:value} as any;return structuredClone(row) as any;},
    async rejectPreparation(id,host,digest,value) {if(!row||row.state!=='preparing')return null;row={...row,state:'terminal',terminalStatus:'not-run',preparationRejection:value} as any;return structuredClone(row) as any;},
    async accept(){return null;},async reject(){return null;},async cancel(){return null;},async acknowledgeCancellation(){return null;},async cancellations(){return []},
  };
  const requests = new TestRequestService(repository, undefined, null, frameworks ?? null);
  const definition = (commit=revision) => {const body={id:selected.routineId,minimumRoutineApiVersion:1,title:'New routine',purpose:'Check',platforms:['android'],entry:'home',account:'lane',resourceRequirements: [{kind:"phone",capabilities:[]},{kind:"app",capabilities:[]},{kind:"recorder",capabilities:[]}],requirements:[],fixtures:[],steps:[{id:'check',instruction:'Check',expected:'Checked'}],execution:{resourceKinds:['phone','app','recorder'],policy:{estimatedOutputBytes:1024**3}},source:{repository:'Mentra-Community/Mentra-Automated-Testing',revision:commit,path:`routines/${selected.routineId}/routine.ts`}};
    return routineEnrollmentSchema.parse({routineId:selected.routineId,platform:selected.platform,definitionRevision:commit,definitionSha256:requestInputDigest(body),routineSource:testRoutineSource(commit),definition:body});};
  const service = new RoutineDispatchService({async current(){return []},async getCurrent(){throw Error('no current fallback')},async getExact(id,platform,commit){return definitions.get(commit)??null},async enroll(value){const parsed=routineEnrollmentSchema.parse(value);enrollments++;definitions.set(parsed.definitionRevision,parsed);return parsed}},
    {async resolve(value,platform){resolves++;return {source:value,platform,availability:'available',title:'App',headSha:'c'.repeat(40),createdAt:'2026-10-03T11:00:00Z',buildUrl:'https://github.com/Mentra-Community/MentraOS/actions/runs/55',archive:{name:'app.apk',size:100,sha256:'d'.repeat(64),url:'https://artifactscdn.mentraglass.com/app.apk'},receipt:{size:10,sha256:'e'.repeat(64),url:'https://artifactscdn.mentraglass.com/receipt.json'}}}},
    {async get(hostId){return available?{hostId,incarnation:'one',incarnationGeneration:1,sequence:1,observedAt:new Date().toISOString(),receivedAt:new Date().toISOString(),lanes:[{id:'android-lane',platform:'android',dispatchMode:automatic?'automatic':'paused',state:'idle',resources:[{id:'phone:android',kind:'phone'},{id:'app:android',kind:'app'},{id:'recorder:android',kind:'recorder',storage:{poolId:'mini:disk:1',observedAt:new Date().toISOString(),availableBytes:64*1024**3,stagingBudgetBytes:10*1024**3,pendingEvidenceBytes:0,reservations:[]}}]}]}:null}},requests,
    {async detail(){throw new TestRunError(404,'not published')}},()=>({android:{hostId:'mini',laneId:'android-lane'}}),
    {async resolve(override){sourceResolves++;return override??revision},async inventory(commit){return {commit,files:[{path:`routines/${selected.routineId}/routine.ts`,gitBlobSha1:'f'.repeat(40),size:10}]}}}, null);
  return {service,requests,repository,definition,definitions,replaceRequest(value: StoredRequest) {row=structuredClone(value);},get resolves(){return resolves},get sourceResolves(){return sourceResolves},get enrollments(){return enrollments},set revision(value:string){revision=value},set available(value:boolean){available=value},set automatic(value:boolean){automatic=value}};
}

for (const change of ['selection', 'target', 'deadline', 'expired', 'cancelled'] as const)
  test(`cached-source detail returns the same current request after a concurrent ${change} change`, async () => {
    let admissions = 0, completions = 0;
    const binding = {...testFrameworkBinding(), version: 1085};
    const f = fixture({async frameworkObservation() {const time = new Date().toISOString(); return {binding, receivedAt: time, observedAt: time}},
      async admitPreparationFramework() {admissions++; throw new Error('Changed preparation cannot acquire a framework admission');}});
    const waiting = await f.service.submit({...selected, minimumFrameworkVersion: 1085}), definition = f.definition();
    f.definitions.set(definition.definitionRevision, definition);
    const current = {...waiting, ...(change === 'selection' ? {fleetSelectionSha256: 'b'.repeat(64)} : {}),
      ...(change === 'target' ? {fleetTarget: {hostId: 'mini', laneId: 'another-lane'}} : {}),
      ...(['deadline', 'expired'].includes(change) ? {fleetDeadline: new Date(Date.now() + (change === 'expired' ? -1 : 60_000))} : {}),
      ...(change === 'cancelled' ? {state: 'terminal', terminalStatus: 'cancelled', preparationCancellation: {
        requestedAt: new Date().toISOString(), reason: 'Cancelled during reconciliation'}} : {})} as StoredRequest;
    const get = f.repository.get;
    let reads = 0;
    f.repository.get = async requestId => {
      // detail -> completePreparation -> admission: change the row before its final pre-admission read.
      if (++reads === 3) f.replaceRequest(current);
      return get(requestId);
    };
    f.repository.completePreparation = async () => {completions++; return null;};
    const detail = await f.service.detail(selected.requestId);
    expect(detail).toEqual({request: current, result: null});
    expect(detail.request.requestId).toBe(waiting.requestId); expect(detail.request.hostId).toBe('mini');
    expect(requestInputDigest(detail.request.dispatchIntent)).toBe(requestInputDigest(waiting.dispatchIntent));
    expect(detail.request.dispatchIntentSha256).toBe(waiting.dispatchIntentSha256!);
    expect(detail.request).not.toHaveProperty('input'); expect(detail.request).not.toHaveProperty('inputSha256');
    expect(admissions).toBe(0); expect(completions).toBe(0); expect(f.enrollments).toBe(0);
    expect(f.definitions.get(definition.definitionRevision)).toEqual(definition);
    expect(await f.requests.get(selected.requestId)).toEqual(current);
  });

test('cached-source detail still rejects an immutable dispatch change during reconciliation', async () => {
  let admissions = 0;
  const binding = {...testFrameworkBinding(), version: 1085};
  const f = fixture({async frameworkObservation() {const time = new Date().toISOString(); return {binding, receivedAt: time, observedAt: time}},
    async admitPreparationFramework() {admissions++; throw new Error('Changed intent cannot acquire a framework admission');}});
  const waiting = await f.service.submit({...selected, minimumFrameworkVersion: 1085}), definition = f.definition();
  f.definitions.set(definition.definitionRevision, definition);
  const changedIntent = {...waiting.dispatchIntent!, minimumFrameworkVersion: 1086};
  const current = {...waiting, dispatchIntent: changedIntent, dispatchIntentSha256: requestInputDigest(changedIntent)} as StoredRequest;
  const get = f.repository.get;
  let reads = 0;
  f.repository.get = async requestId => {if (++reads === 3) f.replaceRequest(current); return get(requestId);};
  await expect(f.service.detail(selected.requestId)).rejects.toBeInstanceOf(TestRequestConflict);
  expect(admissions).toBe(0); expect(await f.requests.get(selected.requestId)).toEqual(current);
});
test('floor-bound producer completion requires its original eligible binding before enrollment and preserves frozen metadata', async () => {
  const binding = {...testFrameworkBinding(), version: 1085};
  const f = fixture({async frameworkObservation() {const time = new Date().toISOString(); return {binding, receivedAt: time, observedAt: time}},
    async admitPreparationFramework(hostId, requestId, dispatchIntentSha256, requestFenceSha256, minimum, effect) {
      const time = new Date().toISOString(); return {requestId, dispatchIntentSha256, requestFenceSha256, effect, binding,
        incarnation: 'current', incarnationGeneration: 1, sequence: 1, receivedAt: time, observedAt: time, admittedAt: time};
    }});
  const waiting = await f.service.submit({...selected, minimumFrameworkVersion: 1085}), definition = f.definition();
  const completion = {dispatchIntentSha256: waiting.dispatchIntentSha256!, routineSource: definition.routineSource,
    definitionSha256: definition.definitionSha256, definition: definition.definition};
  for (const frameworkBinding of [undefined, {...binding, version: 1083}]) {
    await expect(f.service.prepared(selected.requestId, 'mini', {...completion, ...(frameworkBinding ? {frameworkBinding} : {})})).rejects.toMatchObject({status: 409});
    expect(f.enrollments).toBe(0); expect(requestInputDigest(await f.requests.get(selected.requestId))).toBe(requestInputDigest(waiting));
  }
  const queued = await f.service.prepared(selected.requestId, 'mini', {...completion, frameworkBinding: binding});
  expect(queued.state).toBe('queued'); expect(f.enrollments).toBe(1);
  expect(f.definitions.get(definition.definitionRevision)).toEqual(definition);
  expect(requestInputDigest(queued.dispatchIntent)).toBe(requestInputDigest(waiting.dispatchIntent)); expect(queued.dispatchIntentSha256).toBe(waiting.dispatchIntentSha256);
});
for (const routineApiVersion of [42, 43]) test(`NIMO prepared dispatch preserves app identity and handles routine API ${routineApiVersion} before completion`, async () => {
  const f = fixture(), manifest = {url: 'https://artifactscdn.mentraglass.com/live/manifest.json', sha256: 'f'.repeat(64), size: 100};
  const row = f.definition(), body = {...row.definition, minimumRoutineApiVersion: routineApiVersion, glasses: {models: ['nimo']},
    resourceRequirements: [...row.definition.resourceRequirements, {kind: 'glasses' as const, capabilities: ['connection']}],
    execution: {...row.definition.execution!, resourceKinds: [...row.definition.execution!.resourceKinds, 'glasses' as const]}};
  const definition = routineEnrollmentSchema.parse({...row, definition: body, definitionSha256: requestInputDigest(body),
    routineSource: {...row.routineSource, minimumRoutineApiVersion: routineApiVersion}});
  const original = (f.service as any).builds, hosts = (f.service as any).hosts;
  (f.service as any).builds = {async resolve(...args: unknown[]) {return {...await original.resolve(...args), manifest, manifestSha256: manifest.sha256}}};
  (f.service as any).hosts = {async get(hostId: string) {const state = await hosts.get(hostId), lane = state.lanes[0];
    lane.resources.push({id: 'nimo-pair', kind: 'glasses', capabilities: ['connection']});
    lane.glasses = [{resourceId: 'nimo-pair', deviceId: 'AA:BB:CC:DD:40:27', model: 'nimo', capabilities: ['connection']}]; return state}};
  const waiting = await f.service.submit(selected), intent = routineDispatchIntentSchema.parse(waiting.dispatchIntent), frozen = intent.build;
  expect(frozen.manifest).toEqual(manifest);
  const completion = {dispatchIntentSha256: waiting.dispatchIntentSha256, routineSource: definition.routineSource,
    definitionSha256: definition.definitionSha256, definition: definition.definition};
  if (routineApiVersion < 43) {
    await expect(f.service.prepared(selected.requestId, 'mini', completion)).rejects.toMatchObject({status: 409, message: expect.stringContaining('routine API 43')});
    expect((await f.service.detail(selected.requestId)).request.state).toBe('preparing');
    expect((await f.requests.get(selected.requestId))).not.toHaveProperty('input');
    return;
  }
  const queued = await f.service.prepared(selected.requestId, 'mini', completion);
  if (!isExecutableRequest(queued)) throw new Error('Expected one NIMO executable request');
  const queuedInput = frameworkRequestInputSchema.parse(queued.input);
  const {manifest: _manifest, manifestSha256: _manifestSha256, ...expectedApp} = frozen;
  expect(queued.input).toMatchObject({glassesModel: 'nimo', build: expectedApp});
  expect(queuedInput.build.manifest).toBeUndefined();
  expect(queuedInput.build.manifestSha256).toBeUndefined();
  expect(queued.dispatchIntent).toEqual(intent);
  expect(requestInputDigest(await f.service.prepared(selected.requestId, 'mini', completion))).toBe(requestInputDigest(queued));
  expect(readAcceptedRoutineRequest(queued)).toEqual({ready: true, input: queuedInput});
  const member = {memberId: 'nimo-member', requestId: selected.requestId, routineId: intent.routineId, platform: intent.platform,
    routineRevision: intent.routineRevision, definitionRevision: intent.routineRevision, dispatchIntent: intent};
  expect(nightlyPreparedInput(member, queuedInput, queued.inputSha256)).toEqual(queuedInput);
  const forged = {...queuedInput, build: {...queuedInput.build, receipt: {...queuedInput.build.receipt as object, sha256: 'a'.repeat(64)}}};
  expect(() => readAcceptedRoutineRequest({...queued, input: forged, inputSha256: requestInputDigest(forged)})).toThrow('frozen input');
  expect(() => nightlyPreparedInput(member, forged, requestInputDigest(forged))).toThrow('frozen input');
  await expect(f.requests.completePreparation(selected.requestId, 'mini', waiting.dispatchIntentSha256!,
    {...queued.input as any, build: {...expectedApp, archive: {...expectedApp.archive as any, sha256: 'a'.repeat(64)}}})).rejects.toThrow('original dispatch intent');
});
test('new routine is retained with exact main and app references before publication; retries never substitute newer source',async()=>{
  const f=fixture();expect(await f.service.catalog()).toMatchObject({routineRevision:'a'.repeat(40),routines:[{routineId:selected.routineId}]});
  const first=await f.service.submit(selected);expect(first).toMatchObject({state:'preparing',dispatchIntent:{routineRevision:'a'.repeat(40),source,build:{headSha:'c'.repeat(40)}}});
  expect(first).not.toHaveProperty('input');expect(first).not.toHaveProperty('inputSha256');
  const page=await f.requests.queued('mini',undefined,50);expect(page.requests).toEqual([]);expect(page.preparations).toHaveLength(1);
  f.revision='b'.repeat(40);const calls=f.sourceResolves;expect(await f.service.submit(selected)).toEqual(first);expect(f.sourceResolves).toBe(calls);expect(f.resolves).toBe(1);
  for(const changed of [{...selected,source:{...source,buildRunId:56}},{...selected,routineRevision:'b'.repeat(40)},{...selected,routineId:'changed'}])await expect(f.service.submit(changed)).rejects.toThrow('changed');
});
test('host exact source completion enrolls then commits executable input once and preserves original binding',async()=>{
  const f=fixture(),waiting=await f.service.submit(selected),row=f.definition();
  const body={dispatchIntentSha256:waiting.dispatchIntentSha256,routineSource:row.routineSource,definitionSha256:row.definitionSha256,definition:row.definition};
  const queued=await f.service.prepared(selected.requestId,'mini',body);expect(queued).toMatchObject({state:'queued',input:{definitionRevision:'a'.repeat(40),laneId:'android-lane',build:{source}}});
  expect(queued.inputSha256).toBe(requestInputDigest(queued.input));expect(f.enrollments).toBe(1);f.available=false;
  expect(await f.service.prepared(selected.requestId,'mini',body)).toEqual(queued);expect(f.resolves).toBe(1);
  await expect(f.service.prepared(selected.requestId,'other',body)).rejects.toMatchObject({status:404});
  await expect(f.service.prepared(selected.requestId,'mini',{...body,routineSource:testRoutineSource('b'.repeat(40))})).rejects.toThrow();
});
for (const completion of ['producer', 'cached'] as const) test(`canonical recorded dev preparation completes through ${completion} source with its original export`, async () => {
  const f = fixture(), original = (f.service as any).builds;
  const canonicalSource = {channel: 'dev' as const, repository: 'Mentra-Community/Mentra' as const, buildRunId: 55, publicationAttempt: 2};
  const artifactSource = {repository: 'Mentra-Community/MentraOS' as const, headSha: 'b'.repeat(40)};
  (f.service as any).builds = {async resolve(...args: unknown[]) {return {...await original.resolve(...args), artifactSource};}};
  const waiting = await f.service.submit({...selected, source: canonicalSource}), definition = f.definition();
  const frozen = routineDispatchIntentSchema.parse(waiting.dispatchIntent).build;
  expect(frozen).toMatchObject({repository: canonicalSource.repository, headSha: 'c'.repeat(40), artifactSource});
  (f.service as any).builds = {async resolve() {throw Error('Completion must reuse the admitted publication');}};
  let queued: StoredRequest;
  if (completion === 'producer') queued = await f.service.prepared(selected.requestId, 'mini', {
    dispatchIntentSha256: waiting.dispatchIntentSha256, routineSource: definition.routineSource,
    definitionSha256: definition.definitionSha256, definition: definition.definition});
  else {f.definitions.set(definition.definitionRevision, definition); queued = (await f.service.detail(selected.requestId)).request;}
  expect(queued.state).toBe('queued');
  expect(queued.input).toMatchObject({build: frozen});
  expect(queued.dispatchIntent).toEqual(routineDispatchIntentSchema.parse(waiting.dispatchIntent));
  expect(queued.dispatchIntentSha256).toBe(waiting.dispatchIntentSha256);
  expect(queued.inputSha256).toBe(requestInputDigest(queued.input));
  const recorded = recordedRoutineBuild(frozen, canonicalSource, 'android');
  expect(recorded).toMatchObject({source: canonicalSource, headSha: 'c'.repeat(40), artifactSource,
    buildUrl: 'https://github.com/Mentra-Community/Mentra/actions/runs/55'});
  expect(requestInputDigest(frozen)).toBe(requestInputDigest(selectedBuildInput(recorded, 'android')));
  await expect(f.service.prepareIntent({...selected, source: canonicalSource, routineSource: definition.routineSource},
    {hostId: 'mini', laneId: 'android-lane', build: frozen})).resolves.toMatchObject({dispatchIntent: {build: frozen}});
  await expect(f.requests.completePreparation(selected.requestId, 'mini', waiting.dispatchIntentSha256!,
    {...queued.input as any, build: {...frozen, artifactSource: {...artifactSource, headSha: 'a'.repeat(40)}}})).rejects.toThrow('original dispatch intent');
  expect(f.resolves).toBe(1);
});
test('recorded app references reject foreign or missing canonical export projections without changing public originals', () => {
  const canonicalSource = {channel: 'dev' as const, repository: 'Mentra-Community/Mentra' as const, buildRunId: 55, publicationAttempt: 2};
  const artifactSource = {repository: 'Mentra-Community/MentraOS' as const, headSha: 'b'.repeat(40)};
  const build = {repository: canonicalSource.repository, headSha: 'c'.repeat(40), channel: 'dev' as const,
    source: canonicalSource, artifactSource, archive: {name: 'app.apk', size: 100, sha256: 'd'.repeat(64), url: 'https://artifactscdn.mentraglass.com/app.apk'},
    receipt: {size: 10, sha256: 'e'.repeat(64), url: 'https://artifactscdn.mentraglass.com/receipt.json'}};
  for (const changed of [{artifactSource: undefined}, {artifactSource: {...artifactSource, repository: 'foreign/repo'}},
    {artifactSource: {...artifactSource, headSha: 'not-a-commit'}}, {repository: 'Mentra-Community/MentraOS'},
    {source: {...canonicalSource, repository: 'Mentra-Community/MentraOS'}},
    {channel: 'pr', source: {...source, repository: 'Mentra-Community/Mentra'}}])
    expect(() => recordedRoutineBuild({...build, ...changed} as any, (changed.source ?? canonicalSource) as any, 'android')).toThrow('incomplete');
  const {repository: _repository, ...publicSource} = canonicalSource;
  const publicBuild = {...build, repository: 'Mentra-Community/MentraOS', source: publicSource, artifactSource: undefined};
  expect(recordedRoutineBuild(publicBuild, publicSource, 'android')).toMatchObject({headSha: build.headSha,
    buildUrl: 'https://github.com/Mentra-Community/MentraOS/actions/runs/55'});
});
test('cancellation before preparation survives restart and cannot become executable',async()=>{
  const f=fixture(),waiting=await f.service.submit(selected),row=f.definition();
  const cancelled=await f.requests.cancel(selected.requestId,'2026-10-06T12:00:00Z','User cancelled');expect(cancelled).toMatchObject({state:'terminal',terminalStatus:'cancelled',preparationCancellation:{reason:'User cancelled'}});
  expect(cancelled).not.toHaveProperty('inputSha256');
  const restarted=new TestRequestService(f.repository);expect((await restarted.queued('mini',undefined,50)).preparations).toEqual([]);
  expect(await f.service.prepared(selected.requestId,'mini',{dispatchIntentSha256:waiting.dispatchIntentSha256,routineSource:row.routineSource,definitionSha256:row.definitionSha256,definition:row.definition})).toEqual(cancelled!);
  expect(f.enrollments).toBe(0);
});
test('unsupported platform is only an input-free preparation disposition',async()=>{
  const f=fixture(),waiting=await f.service.submit(selected);
  const rejected=await f.requests.rejectPreparation(selected.requestId,'mini',{dispatchIntentSha256:waiting.dispatchIntentSha256,code:'not-applicable',reason:'Exact routine supports Mac only',rejectedAt:'2026-10-06T12:00:00Z',disposition:'not-applicable'});
  expect(rejected).toMatchObject({state:'terminal',terminalStatus:'not-run',preparationRejection:{disposition:'not-applicable'},dispatchIntent:{platform:'android',routineRevision:'a'.repeat(40)}});
  expect(rejected).not.toHaveProperty('runId');expect(rejected).not.toHaveProperty('input');
});
test('explicit source override and framework floor remain separate and immutable',async()=>{
  const f=fixture(),routineSource=testRoutineSource('d'.repeat(40));const row=await f.service.submit({...selected,routineSource,minimumFrameworkVersion:42});
  expect(row).toMatchObject({dispatchIntent:{routineRevision:routineSource.commit,routineSource,minimumFrameworkVersion:42}});
  await expect(f.service.submit({...selected,routineSource,routineRevision:'e'.repeat(40)})).rejects.toMatchObject({status:400});
  await expect(f.service.submit({...selected,routineSource,minimumFrameworkVersion:43})).rejects.toThrow('changed');
});
test('existing exact enrollment is optional warm cache and frozen historical app reuse is strict',async()=>{
  const f=fixture(),definition=f.definition();f.definitions.set(definition.definitionRevision,definition);
  const queued=await f.service.submit(selected);expect(queued.state).toBe('queued');
  if(!('input' in queued))throw Error('Fixture expected executable targeted request');
  const input=queued.input as any;expect(recordedRoutineBuild(input.build,source,'android').headSha).toBe('c'.repeat(40));
  const sourceCalls=f.sourceResolves;
  await expect(f.service.prepareIntent({...selected,routineSource:definition.routineSource},{hostId:'mini',laneId:input.laneId,build:input.build})).resolves.toMatchObject({dispatchIntent:{routineRevision:definition.definitionRevision}});expect(f.resolves).toBe(1);expect(f.sourceResolves).toBe(sourceCalls);
  expect(()=>recordedRoutineBuild({...input.build,archive:undefined},source,'android')).toThrow('incomplete');
});


test('exact preparation completes on its frozen explicitly assigned paused lane without asserting a start',async()=>{
  const f=fixture();f.automatic=false;const waiting=await f.service.submit(selected),definition=f.definition();
  const prepared=await f.service.prepared(selected.requestId,'mini',{dispatchIntentSha256:waiting.dispatchIntentSha256,routineSource:definition.routineSource,definitionSha256:definition.definitionSha256,definition:definition.definition});
  expect(prepared.state).toBe('queued');expect(prepared).not.toHaveProperty('hostReceipt');expect(prepared).not.toHaveProperty('runId');expect((prepared.input as any).laneId).toBe('android-lane');
});


test('known candidate-only source is a precise validation refusal without ordinary promotion',async()=>{
  const f=fixture(),definition=f.definition();let enrolls=0;
  (f.service as any).definitions={async getExact(_id:string,_platform:string,_revision:string,ordinary:boolean){return ordinary?null:definition},async enroll(){enrolls++}};
  await expect(f.service.submit({...selected,routineRevision:definition.definitionRevision})).rejects.toMatchObject({status:422,message:expect.stringContaining('accepted authoring job')});
  expect(enrolls).toBe(0);expect(await f.requests.get(selected.requestId)).toBeNull();
});

test('selected catalog uses exact ordinary definitions while unpublished main remains requestable', async () => {
  const f = fixture(), revision = 'b'.repeat(40), ids = ['android-only', 'mac-only', 'both', 'unpublished'];
  let resolutions = 0;
  (f.service as any).sources = {async resolve(value?: string) {resolutions++; return value ?? revision;},
    async inventory(commit: string) {return {commit, files: ids.map(id => ({path: `routines/${id}/routine.ts`}))};}};
  const calls: unknown[] = [];
  (f.service as any).definitions = {async getExact(id: string, platform: string, commit: string, ordinary: boolean) {
    calls.push({id, platform, commit, ordinary});
    const platforms = id === 'android-only' ? ['android'] : id === 'mac-only' ? ['ios-on-mac'] : id === 'both' ? ['android', 'ios-on-mac'] : [];
    if (!platforms.includes(platform)) return null;
    const definition = {...f.definition(commit).definition, id, platforms,
      source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: commit, path: `routines/${id}/routine.ts`}};
    return routineEnrollmentSchema.parse({routineId: id, platform, definitionRevision: commit, definitionSha256: requestInputDigest(definition),
      routineSource: testRoutineSource(commit), definition});
  }};
  expect(await f.service.catalog(undefined, ids)).toEqual({routineRevision: revision, routines: [
    {routineId: 'android-only', platforms: ['android']}, {routineId: 'mac-only', platforms: ['ios-on-mac']},
    {routineId: 'both', platforms: ['android', 'ios-on-mac']}, {routineId: 'unpublished'},
  ]});
  expect(resolutions).toBe(1);
  expect(calls).toHaveLength(8);
  expect(calls.every((call: any) => call.commit === revision && call.ordinary)).toBe(true);
  await expect(f.service.catalog(revision, ['missing'])).rejects.toMatchObject({status: 422});
  await expect(f.service.catalog(revision, ['android-only', 'android-only'])).rejects.toMatchObject({status: 422});
  (f.service as any).definitions = {async getExact() {const row = f.definition(revision); return {...row, definitionSha256: 'f'.repeat(64)};}};
  await expect(f.service.catalog(revision, ['android-only'])).rejects.toMatchObject({status: 503});
});


test('bound host preparation rejection has an exact terminal fence without creating an executable digest',async()=>{
 const f=fixture(),waiting=await f.service.submit(selected),at=new Date().toISOString();
 const rejection={dispatchIntentSha256:waiting.dispatchIntentSha256!,code:'not-applicable',reason:'Exact source does not support platform',rejectedAt:at,disposition:'not-applicable'};
 const stopped=await f.requests.rejectPreparation(selected.requestId,'mini',rejection);
 expect(stopped).toMatchObject({state:'terminal',preparationRejection:rejection});expect(stopped).not.toHaveProperty('inputSha256');
 const claim={id:'591e0c34-ee97-41df-a0ec-5e2d0c7503ee',requestId:selected.requestId,fleetInputSha256:'a'.repeat(64),hostId:'mini',laneId:'android-lane',poolId:'mini:disk:1',minimumAvailableBytes:3*1024**3,reservedAt:at};
 const row={...stopped,fleetInputSha256:claim.fleetInputSha256,fleetBinding:{hostId:'mini',laneId:'android-lane'}} as any;
 const measured={poolId:claim.poolId,observedAt:at,availableBytes:64*1024**3,stagingBudgetBytes:10*1024**3,pendingEvidenceBytes:0,reservations:[]};
 expect(reconcileRecorderHostReservations([claim],[row],measured)).toEqual([]);
 expect(reconcileRecorderHostReservations([claim],[row],{...measured,reservations:[{requestId:selected.requestId,inputSha256:'b'.repeat(64),remainingOutputBytes:0}]})).toEqual([claim]);
})
