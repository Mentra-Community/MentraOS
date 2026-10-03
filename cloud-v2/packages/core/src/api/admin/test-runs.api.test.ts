import {expect, spyOn, test} from "bun:test";
import {createTestRunAdminApi} from "./test-runs.api";
import {TestHistoryService} from "../../services/test-history.service";
import {TestHostHealthService} from "../../services/test-host-health.service";
import {FrameworkResultService} from "../../services/framework-result.service";
import {TestRunError} from "../../services/test-result-error";
import {requestInputDigest, TestRequestService} from "../../services/test-request.service";

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
