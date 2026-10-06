import {expect, spyOn, test} from "bun:test";
import {Hono} from "hono";
import {createTestRunAdminApi} from "./test-runs.api";
import {TestHistoryService} from "../../services/test-history.service";
import {LaneRestorationService} from "../../services/lane-restoration.service";
import {TestHostHealthService} from "../../services/test-host-health.service";
import {FrameworkResultService, type StoredFrameworkRun} from "../../services/framework-result.service";
import {TestRunError} from "../../services/test-result-error";
import {requestInputDigest, TestRequestService, type StoredTestRequest, type TestRequestRepository} from "../../services/test-request.service";
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
  const input = {routineId: "new-product", definitionRevision: "a".repeat(40), platform: "android", laneId: "phone",
    resources: [], build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}};
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
});

test("a cancelled request read reconciles late host custody and then its real recorded result through the same route", async () => {
  const requestId = "cancelled-request";
  const input = {routineId: "new-product", definitionRevision: "a".repeat(40), platform: "android", laneId: "phone",
    resources: [], build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}};
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
  const definition = routineEnrollmentSchema.parse({routineId: input.routineId, platform: input.platform, definitionRevision: input.definitionRevision, definitionSha256: "d".repeat(64),
    definition: {id: input.routineId, title: "New product", purpose: "Check", platforms: ["android"], entry: "home", account: "lane", requires: [], requirements: [], fixtures: [],
      steps: [{id: "check", instruction: "Check", expected: "Checked"}], source: {repository: "Mentra-Community/Mentra-Automated-Testing", revision: input.definitionRevision, path: "routines/new-product/routine.ts"}}});
  const results = new FrameworkResultService({
    async insert(payload, payloadSha256) {storedRun = {payload, payloadSha256, uploadsComplete: true};},
    async getByRequest() {return structuredClone(storedRun);}, async getByRun() {return structuredClone(storedRun);}, async getAsset() {return null;},
  }, async () => row?.hostReceipt ? {hostId: row.hostId, input} : null, async run => {
    row = {...row!, state: "terminal", terminalStatus: "cancelled", runId: run.result.runId};
  }, async () => definition);
  const app = createTestRunAdminApi(undefined, undefined, results, requests);
  const queued = await requests.submit(requestId, "mini", input);
  await requests.cancel(requestId, "2026-10-03T11:01:00Z", "Nightly occurrence reached its completion boundary.");
  const cancelled: any = await (await app.request(`/${requestId}`)).json();
  expect(cancelled).toMatchObject({kind: "request", request: {state: "terminal", terminalStatus: "cancelled", cancellationRequested: true,
    cancellationAcknowledged: false, reason: "Nightly occurrence reached its completion boundary."}});
  expect(cancelled.request.acceptedAt).toBeUndefined(); expect(cancelled.run).toBeUndefined();
  await requests.accept({requestId, hostId: "mini", inputSha256: queued.inputSha256, acceptedAt: "2026-10-03T11:00:30Z"}, "mini");
  const accepted: any = await (await app.request(`/${requestId}`)).json();
  expect(accepted).toMatchObject({kind: "request", request: {state: "terminal", terminalStatus: "cancelled", acceptedAt: "2026-10-03T11:00:30Z"}});
  expect(accepted.run).toBeUndefined(); expect(accepted.request.steps).toBeUndefined();
  const run = frameworkRunSchema.parse({schemaVersion: 1, requestId, hostId: "mini", routineId: input.routineId,
    definitionRevision: input.definitionRevision, platform: input.platform, laneId: input.laneId, build: input.build,
    startedAt: "2026-10-03T11:00:30Z", finishedAt: "2026-10-03T11:01:30Z", assets: [],
    result: {runId: requestId, finishedAt: "2026-10-03T11:01:30Z", setup: {status: "cancelled"}, test: "cancelled",
      steps: [{id: "check", status: "not-run", durationMs: 0}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [], evidence: [], timing: {startedAt: "2026-10-03T11:00:30Z", setupMs: 30000, testMs: 0, teardownMs: 30000}}});
  await results.ingest(run, "mini");
  const published: any = await (await app.request(`/${requestId}`)).json();
  expect(published).toMatchObject({kind: "run", outcome: "cancelled", uploadsComplete: true, run});
  expect(published.request).toBeUndefined();
});


test("restoration list has a bounded uncached route outside generic run identities", async () => {
  class Restoration extends LaneRestorationService {
    override async list() {return {generatedAt: "2026-10-05T01:00:00Z", freshForMs: 120_000, hosts: [], truncated: false};}
  }
  const response = await createTestRunAdminApi(undefined, undefined, undefined, undefined, new Restoration()).request("/restoration/list");
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({hosts: [], truncated: false});
});
