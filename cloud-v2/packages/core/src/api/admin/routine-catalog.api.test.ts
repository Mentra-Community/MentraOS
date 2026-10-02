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
