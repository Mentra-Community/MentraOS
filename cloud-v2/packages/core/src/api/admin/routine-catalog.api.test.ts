import {FrameworkResultService} from "../../services/framework-result.service";
import {TestRunError} from "../../services/test-run.service";
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
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await app.request("/missing/android")).status).toBe(404);
});

test("framework result route preserves missing-result and media errors", async () => {
  class Results extends FrameworkResultService {
    override async detail(): Promise<never> {throw new TestRunError(404, "not found");}
    override async media(): Promise<never> {throw new TestRunError(416, "invalid range");}
  }
  const app = createRoutineCatalogApi(new RoutineCatalogService(), new Results());
  expect((await app.request("/results/missing")).status).toBe(404);
  expect((await app.request("/results/run/assets/video")).status).toBe(416);
});
