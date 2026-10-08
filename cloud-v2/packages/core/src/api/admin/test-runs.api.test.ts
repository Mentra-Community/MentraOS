import {testRoutineSource, testFrameworkBinding} from "../../testing/framework-fixtures"
import {expect, spyOn, test} from "bun:test";
import {Hono} from "hono";
import {createTestRunAdminApi} from "./test-runs.api";
import {TestSuiteService} from "../../services/test-suite.service";
import {TestHistoryService} from "../../services/test-history.service";
import {LaneRestorationService} from "../../services/lane-restoration.service";
import {TestHostHealthService} from "../../services/test-host-health.service";
import {FrameworkResultService, type StoredFrameworkRun} from "../../services/framework-result.service";
import {TestRunError} from "../../services/test-result-error";
import {requestInputDigest, TestRequestService, type StoredTestRequest, type StoredPreparingRequest, type TestRequestRepository} from "../../services/test-request.service";
import {routineEnrollmentSchema} from "../../types/routine-definition.types";
import {frameworkRunSchema} from "../../types/framework-run.types";

test("mounted lane run history forwards host, lane and pagination at the collection URL", async () => {
  const calls: Record<string, string>[] = [];
  class Results extends FrameworkResultService {
    override async list(query: Record<string, string> = {}) {
      calls.push(query); return {runs: [], nextCursor: null};
    }
  }
  const app = new Hono();
  app.route("/api/admin/test-runs", createTestRunAdminApi(undefined, undefined, new Results()));
  for (const suffix of ["", "&cursor=cursor%3Anext"]) {
    const response = await app.request(`/api/admin/test-runs?hostId=host%3Aone&laneId=lane%3Atwo${suffix}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({runs: [], nextCursor: null});
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect(calls).toEqual([{hostId: "host:one", laneId: "lane:two"},
    {hostId: "host:one", laneId: "lane:two", cursor: "cursor:next"}]);
});

test("combined history route forwards pagination outside the generic run ID path", async () => {
  const calls: Record<string, string>[] = [];
  class History extends TestHistoryService {
    override async list(query: Record<string, string> = {}) {
      calls.push(query); return {entries: [], nextCursor: null};
    }
  }
  const response = await createTestRunAdminApi(new TestHostHealthService(), new History()).request("/history/list?limit=3&cursor=next");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({entries: [], nextCursor: null});
  expect(calls).toEqual([{limit: "3", cursor: "next"}]);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("history query timeout returns a controlled retryable response", async () => {
  class History extends TestHistoryService {
    override async list(): Promise<never> {throw new TestRunError(503, "Test history query timed out. Try again.");}
  }
  const response = await createTestRunAdminApi(undefined, new History()).request("/history/list?limit=25");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({error: "test_run_error", message: "Test history query timed out. Try again."});
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("the valid run ID history still opens its individual result", async () => {
  const detail = spyOn(FrameworkResultService.prototype, "detailByRun").mockResolvedValue({runId: "history"} as never);
  try {
    const response = await createTestRunAdminApi().request("/history");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({kind: "run", runId: "history"});
    expect(detail).toHaveBeenCalledWith("history");
  } finally {detail.mockRestore();}
});

test("the existing result route prefers actual runs and otherwise shows exact rejected request identity", async () => {
  const calls: string[] = [];
  const input = {
    routineSource: testRoutineSource(),
    routineId: "new-product",
    definitionRevision: "a".repeat(40),
    platform: "android",
    laneId: "phone",
    resources: [],
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40), kind: 'android-apk',
      source: {channel: 'dev', buildRunId: 1, publicationAttempt: 1},
      archive: {name: 'app.apk', url: 'https://artifactscdn.mentraglass.com/app.apk', size: 100, sha256: 'c'.repeat(64)},
      receipt: {url: 'https://artifactscdn.mentraglass.com/receipt', size: 10, sha256: 'd'.repeat(64)}},
  }
  const inputSha256 = requestInputDigest(input);
  class Results extends FrameworkResultService {
    override async detailByRun(id: string): Promise<any> {
      calls.push("run:" + id);
      if (id === "actual") return {run: {result: {runId: id}}, outcome: "pass"};
      throw new TestRunError(id === "outage" ? 503 : 404, "unavailable");
    }
    override async detail(id: string): Promise<any> {
      calls.push("result-request:" + id);
      if (id === "published-request") return {run: {requestId: id, result: {runId: "actual"}}, outcome: "pass"};
      throw new TestRunError(404, "missing result");
    }
  }
  class Requests extends TestRequestService {
    override async get(id: string) {
      calls.push("request:" + id);
      if (id === "missing") return null;
      return {requestId: id, hostId: "mini", input, inputSha256, state: "terminal" as const, terminalStatus: "not-run",
        hostRejection: {requestId: id, hostId: "mini", inputSha256, rejectedAt: "2026-10-03T11:00:00Z",
          code: "missing-definition", reason: "The exact source revision is not installed."}};
    }
  }
  const app = createTestRunAdminApi(undefined, undefined, new Results(), new Requests());
  expect(await (await app.request("/actual")).json()).toMatchObject({kind: "run", outcome: "pass"});
  expect(calls).toEqual(["run:actual"]);
  expect(await (await app.request("/published-request")).json()).toMatchObject({kind: "run", run: {requestId: "published-request"}});
  const response = await app.request("/rejected-request");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body: any = await response.json();
  expect(body).toMatchObject({kind: "request", request: {requestId: "rejected-request", hostId: "mini", routineId: input.routineId,
    platform: input.platform, laneId: input.laneId, definitionRevision: input.definitionRevision, build: input.build,
    state: "terminal", terminalStatus: "not-run", reason: "missing-definition: The exact source revision is not installed."}});
  expect(body.run).toBeUndefined();
  expect(body.request.steps).toBeUndefined();
  expect((await app.request("/missing")).status).toBe(404);
  calls.length = 0;
  expect((await app.request("/outage")).status).toBe(503);
  expect(calls).toEqual(["run:outage"]);
})

test("a cancelled request read reconciles late host custody and then its real recorded result through the same route", async () => {
  const requestId = "cancelled-request";
  const input = {
    routineSource: testRoutineSource(),
    routineId: "new-product",
    definitionRevision: "a".repeat(40),
    platform: "android",
    laneId: "phone",
    resources: [],
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40), kind: 'android-apk',
      source: {channel: 'dev', buildRunId: 1, publicationAttempt: 1},
      archive: {name: 'app.apk', url: 'https://artifactscdn.mentraglass.com/app.apk', size: 100, sha256: 'c'.repeat(64)},
      receipt: {url: 'https://artifactscdn.mentraglass.com/receipt', size: 10, sha256: 'd'.repeat(64)}},
  }
  let row: StoredTestRequest | null = null, storedRun: StoredFrameworkRun | null = null;
  const repository = {
    async insert(value: StoredTestRequest) {row = structuredClone(value);},
    async get() {return structuredClone(row);},
    async cancel(receipt) {
      if (!row || row.state !== "queued") return null;
      row = {...row, state: "terminal", terminalStatus: "cancelled", hostCancellation: receipt}; return structuredClone(row);
    },
    async accept(receipt) {
      if (!row || row.state !== "terminal" || !row.hostCancellation) return null;
      row.hostReceipt = structuredClone(receipt); return structuredClone(row);
    },
    async reject() {throw new Error("unused rejection");}, async acknowledgeCancellation() {throw new Error("unused cancellation acknowledgement");},
    async queued() {throw new Error("unused queue read");}, async cancellations() {throw new Error("unused cancellation read");},
  } satisfies TestRequestRepository;
  const requests = new TestRequestService(repository);
  const definition = routineEnrollmentSchema.parse({
    routineId: input.routineId,
    platform: input.platform,
    definitionRevision: input.definitionRevision,
    definitionSha256: "d".repeat(64),
    routineSource: testRoutineSource(),
    definition: {
      minimumRoutineApiVersion: 1,
      id: input.routineId,
      title: "New product",
      purpose: "Check",
      platforms: ["android"],
      entry: "home",
      account: "lane",
      resourceRequirements: [],
      requirements: [],
      fixtures: [],
      steps: [{id: "check", instruction: "Check", expected: "Checked"}],
      source: {repository: "Mentra-Community/Mentra-Automated-Testing", revision: input.definitionRevision, path: "routines/new-product/routine.ts"},
    },
  })
  const results = new FrameworkResultService(
    {
    async insert(payload, payloadSha256) {storedRun = {payload, payloadSha256, uploadsComplete: true};},
    async getByRequest() {return structuredClone(storedRun);}, async getByRun() {return structuredClone(storedRun);}, async getAsset() {return null;},
  },
    async () => (row?.hostReceipt ? {hostId: row.hostId, input} : null),
    async run => {
    row = {...row!, state: "terminal", terminalStatus: "cancelled", runId: run.result.runId};
  },
    async () => definition,
  )
  const app = createTestRunAdminApi(undefined, undefined, results, requests);
  const queued = await requests.submit(requestId, "mini", input);
  await requests.cancel(requestId, "2026-10-03T11:01:00Z", "Nightly occurrence reached its completion boundary.");
  const cancelled: any = await (await app.request(`/${requestId}`)).json();
  expect(cancelled).toMatchObject({kind: "request", request: {state: "terminal", terminalStatus: "cancelled", cancellationRequested: true,
    cancellationAcknowledged: false, reason: "Nightly occurrence reached its completion boundary."}});
  expect(cancelled.request.acceptedAt).toBeUndefined();
  expect(cancelled.run).toBeUndefined();
  await requests.accept({requestId, hostId: "mini", inputSha256: queued.inputSha256, acceptedAt: "2026-10-03T11:00:30Z"}, "mini");
  const accepted: any = await (await app.request(`/${requestId}`)).json();
  expect(accepted).toMatchObject({kind: "request", request: {state: "terminal", terminalStatus: "cancelled", acceptedAt: "2026-10-03T11:00:30Z"}});
  expect(accepted.run).toBeUndefined();
  expect(accepted.request.steps).toBeUndefined();
  const run = frameworkRunSchema.parse({
    schemaVersion: 1,
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    requestId,
    hostId: "mini",
    routineId: input.routineId,
    definitionRevision: input.definitionRevision,
    platform: input.platform,
    laneId: input.laneId,
    build: input.build,
    startedAt: "2026-10-03T11:00:30Z",
    finishedAt: "2026-10-03T11:01:30Z",
    assets: [],
    result: {runId: requestId, finishedAt: "2026-10-03T11:01:30Z", setup: {status: "cancelled"}, test: "cancelled",
      steps: [{id: "check", status: "not-run", durationMs: 0}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [], evidence: [], timing: {startedAt: "2026-10-03T11:00:30Z", setupMs: 30000, testMs: 0, teardownMs: 30000}},
  })
  await results.ingest(run, "mini");
  const published: any = await (await app.request(`/${requestId}`)).json();
  expect(published).toMatchObject({kind: "run", outcome: "cancelled", uploadsComplete: true, run});
  expect(published.request).toBeUndefined();
})

test("restoration list has a bounded uncached route outside generic run identities", async () => {
  class Restoration extends LaneRestorationService {
    override async list() {return {generatedAt: "2026-10-05T01:00:00Z", freshForMs: 120_000, hosts: [], truncated: false};}
  }
  const response = await createTestRunAdminApi(undefined, undefined, undefined, undefined, new Restoration()).request("/restoration/list");
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({hosts: [], truncated: false});
});

test('current lane and host-filtered history routes remain distinct uncached reads', async () => {
  class Restoration extends LaneRestorationService {
    override async overview() {return {generatedAt: '2026-10-05T01:00:00Z', freshForMs: 120_000, hosts: [], truncated: false}}
    override async list(hostId?: string) {expect(hostId).toBe('selected-host'); return this.overview() as any}
  }
  const app = createTestRunAdminApi(undefined, undefined, undefined, undefined, new Restoration());
  for (const path of ['/lanes/overview', '/restoration/list?hostId=selected-host']) {
    const response = await app.request(path);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
});

test('historical request detail preserves an absent routine source and original digest without enabling new admission', async () => {
  const input = {routineId: 'old-product', definitionRevision: 'a'.repeat(40), platform: 'android', laneId: 'phone', resources: [],
    build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)}};
  const inputSha256 = requestInputDigest(input), before = JSON.stringify(input);
  const row: StoredTestRequest = {requestId: 'old-request', hostId: 'mini', input, inputSha256, state: 'terminal', terminalStatus: 'not-run',
    hostRejection: {requestId: 'old-request', hostId: 'mini', inputSha256, rejectedAt: '2026-10-03T11:00:00Z', code: 'missing-definition', reason: 'Original source was unavailable.'}};
  class Results extends FrameworkResultService {
    override async detailByRun(): Promise<never> {throw new TestRunError(404, 'missing result');}
    override async detail(): Promise<never> {throw new TestRunError(404, 'missing result');}
  }
  class Requests extends TestRequestService {override async get() {return row;}}
  const response = await createTestRunAdminApi(undefined, undefined, new Results(), new Requests()).request('/old-request');
  expect(response.status).toBe(200);
  const body = await response.json() as {request: unknown};
  expect(body).toMatchObject({kind: 'request', request: {requestId: row.requestId, inputSha256, definitionRevision: input.definitionRevision}});
  expect(body.request).not.toHaveProperty('routineSource');
  expect(JSON.stringify(input)).toBe(before);
  expect(requestInputDigest(input)).toBe(inputSha256);
  await expect(new Requests().submit('new-request', 'mini', input)).rejects.toMatchObject({status: 400});
});


test('activity and detail show input-free exact source preparation with its observed wait reason', async () => {
  const {TestRequestModel} = await import('../../models/test-request.model');
  const source = {channel: 'dev' as const, buildRunId: 1, publicationAttempt: 1};
  const intent = {requestId: 'waiting-main', routineId: 'new-main-routine', platform: 'android' as const, routineRevision: 'a'.repeat(40), laneId: 'phone', source,
    build: {repository: 'Mentra-Community/MentraOS' as const, channel: 'dev' as const, kind: 'android-apk' as const, headSha: 'b'.repeat(40), source,
      archive: {name: 'app.apk', url: 'https://artifactscdn.mentraglass.com/app.apk', size: 100, sha256: 'c'.repeat(64)}, receipt: {url: 'https://artifactscdn.mentraglass.com/receipt', size: 10, sha256: 'd'.repeat(64)}}};
  const row: StoredPreparingRequest = {requestId: intent.requestId, hostId: 'mini', state: 'preparing', dispatchIntent: intent, dispatchIntentSha256: requestInputDigest(intent),
    preparation: {code: 'minimum-routine-api', reason: 'Waiting for the required routine API installation.', observedAt: '2026-10-06T12:00:00Z'}};
  let selected: unknown;
  const find = spyOn(TestRequestModel, 'find').mockReturnValue({sort(){return this},limit(){return this},select(value: unknown){selected=value;return this},read(){return this},readConcern(){return this},lean:async()=>[row]} as any);
  class Results extends FrameworkResultService {override async detailByRun(): Promise<never> {throw new TestRunError(404,'missing')};override async detail(): Promise<never> {throw new TestRunError(404,'missing')}}
  class Requests extends TestRequestService {override async get() {return row}}
  try {
    const api = createTestRunAdminApi(undefined,undefined,new Results(),new Requests());
    const activity = await (await api.request('/activity')).json() as {requests: unknown[]};
    const detail = await (await api.request('/waiting-main')).json() as {request: unknown};
    expect(activity.requests).toEqual([detail.request]);
    expect(detail.request).toMatchObject({routineId:'new-main-routine',platform:'android',laneId:'phone',state:'preparing',definitionRevision:intent.routineRevision,reason:row.preparation!.reason});
    expect(detail.request).not.toHaveProperty('input');expect(detail.request).not.toHaveProperty('inputSha256');
    expect(selected).toMatchObject({dispatchIntent:1,dispatchIntentSha256:1,preparation:1});
  } finally {find.mockRestore()}
});

test('unbound fleet request keeps a stable exact-input URL and shows awaiting runner before assignment', async () => {
  const {portableRoutineSelectionSchema}=await import('../../types/routine-job.types')
  const selected=portableRoutineSelectionSchema.parse({requestId:'fleet-pending',routineId:'new-routine',platform:'android',routineRevision:'a'.repeat(40),
    source:{channel:'pr',prNumber:12,buildRunId:55,publicationAttempt:2},build:{repository:'Mentra-Community/MentraOS',headSha:'b'.repeat(40),channel:'pr',prNumber:12,
      kind:'android-apk',source:{channel:'pr',prNumber:12,buildRunId:55,publicationAttempt:2},
      archive:{name:'app.apk',url:'https://artifactscdn.mentraglass.com/app.apk',size:100,sha256:'c'.repeat(64)},
      receipt:{url:'https://artifactscdn.mentraglass.com/receipt.json',size:10,sha256:'d'.repeat(64)}}})
  const rows={async get(){return {requestId:selected.requestId,state:'awaiting-runner',fleetSelection:selected,fleetSelectionSha256:requestInputDigest(selected),
    fleetDeadline:new Date('2026-10-08T03:00:00Z')}}} as unknown as TestRequestService
  const results={async detailByRun(){throw new TestRunError(404,'missing')},async detail(){throw new TestRunError(404,'missing')}} as unknown as FrameworkResultService
  const app=createTestRunAdminApi(undefined,undefined,results,rows)
  const response=await app.request('/fleet-pending')
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({kind:'request',request:{requestId:'fleet-pending',state:'awaiting-runner',
    routineId:'new-routine',reason:'Awaiting a compatible testing runner.',build:{headSha:'b'.repeat(40)}}})
})


test("suite summary exposes bounded presentation without reading complete inputs", async () => {
  const reads = spyOn(TestSuiteService.prototype, "summaries").mockResolvedValue(new Map([["nightly-summary", {suiteId: "nightly-summary", members: []} as never]]));
  const full = spyOn(TestSuiteService.prototype, "detail").mockRejectedValue(new Error("Full inputs must not load"));
  try {
    const response = await createTestRunAdminApi().request("/suites/nightly-summary/summary");
    expect(response.status).toBe(200); expect(await response.json()).toEqual({suiteId: "nightly-summary", members: []});
    expect(reads).toHaveBeenCalledTimes(1); expect(reads.mock.calls[0]![0]).toEqual(["nightly-summary"]);
    expect(reads.mock.calls[0]![1]).toBeGreaterThan(Date.now()); expect(full).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  } finally {reads.mockRestore();full.mockRestore();}
});

test("suite summary preserves missing and invalid-receipt errors", async () => {
  const reads=spyOn(TestSuiteService.prototype,"summaries");
  try {
    reads.mockResolvedValue(new Map());
    expect((await createTestRunAdminApi().request("/suites/missing/summary")).status).toBe(404);
    reads.mockResolvedValue(new Map([["invalid",new TestRunError(503,"Receipt differs")]]));
    const response=await createTestRunAdminApi().request("/suites/invalid/summary");
    expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"test_run_error",message:"Receipt differs"});
  } finally {reads.mockRestore();}
});
