import {FrameworkResultService} from "../../services/framework-result.service";
import {TestRunError} from "../../services/test-result-error";
import {expect, test} from "bun:test";
import {createRoutineCatalogApi} from "./routine-catalog.api";
import {RoutineCatalogError, RoutineCatalogService} from "../../services/routine-catalog.service";

test("catalog detail routes routine identity and scoped pagination without run-route collisions", async () => {
  const calls: unknown[] = [];
  class Service extends RoutineCatalogService {
    override async list() {return [];}
    override async detail(id: string, platform: string, cursor?: string, limit = 25): Promise<any> {
      calls.push({id, platform, cursor, limit});
      if (id === "missing") throw new RoutineCatalogError(404, "not enrolled");
      return {routineId: id, platform, example: null, history: [], nextCursor: null};
    }
  }
  const app = createRoutineCatalogApi(new Service());
  expect(await (await app.request("/")).json()).toEqual({routines: []});
  const response = await app.request("/notes/ios-on-mac?limit=2&cursor=next");
  expect(response.status).toBe(200);
  expect(calls).toEqual([{id: "notes", platform: "ios-on-mac", cursor: "next", limit: 2}]);
  expect((await app.request("/results/android")).status).toBe(200);
  expect(calls.at(-1)).toEqual({id: "results", platform: "android", cursor: undefined, limit: 25});
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await app.request("/missing/android")).status).toBe(404);
});

test("framework result route preserves missing-result and media errors", async () => {
  class Results extends FrameworkResultService {
    override async detailByRun(): Promise<never> {throw new TestRunError(404, "not found");}
    override async mediaByRun(): Promise<never> {throw new TestRunError(416, "invalid range");}
  }
  const app = createRoutineCatalogApi(new RoutineCatalogService(), new Results());
  expect((await app.request("/results/by-run/missing")).status).toBe(404);
  expect((await app.request("/results/by-run/run/assets/video")).status).toBe(416);
});


test("run and request result routes stay explicit and media responses keep their range headers", async () => {
  const calls: unknown[] = [];
  class Results extends FrameworkResultService {
    override async detailByRun(id: string): Promise<any> {calls.push({runId: id}); return {run: {result: {runId: id}}, outcome: "pass"};}
    override async detail(id: string): Promise<any> {calls.push({requestId: id}); return {run: {requestId: id}, outcome: "pass"};}
    override async mediaByRun(id: string, asset: string, request: Request): Promise<Response> {
      calls.push({runId: id, asset, method: request.method, range: request.headers.get("range")});
      return new Response("xy", {status: 206, headers: {"content-range": "bytes 0-1/20"}});
    }
  }
  const app = createRoutineCatalogApi(new RoutineCatalogService(), new Results());
  expect((await (await app.request("/results/by-run/run-1")).json() as {run: {result: {runId: string}}}).run.result.runId).toBe("run-1");
  expect((await (await app.request("/results/by-request/request-1")).json() as {run: {requestId: string}}).run.requestId).toBe("request-1");
  const media = await app.request("/results/by-run/run-1/assets/video", {headers: {range: "bytes=0-1"}});
  expect(media.status).toBe(206);
  expect(media.headers.get("content-range")).toBe("bytes 0-1/20");
  expect(await media.text()).toBe("xy");
  expect(calls).toEqual([{runId: "run-1"}, {requestId: "request-1"}, {runId: "run-1", asset: "video", method: "GET", range: "bytes=0-1"}]);
});
