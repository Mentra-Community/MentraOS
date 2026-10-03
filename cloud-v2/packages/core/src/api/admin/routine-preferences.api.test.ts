import {expect, test} from "bun:test";
import {Hono} from "hono";
import {createRoutinePreferencesApi} from "./routine-preferences.api";
import type {RoutineCatalogService} from "../../services/routine-catalog.service";

test("protected preference route accepts only a boolean and keeps routine/platform identity", async () => {
  const writes: unknown[] = [];
  const service = {async setPreference(routineId: string, platform: string, nightlyEnabled: boolean) {
    const row = {routineId, platform, nightlyEnabled}; writes.push(row); return row;
  }} as RoutineCatalogService;
  const app = new Hono();
  app.use("*", async (c, next) => c.req.header("authorization") === "admin" ? next() : c.json({error: "unauthorized"}, 401));
  app.route("/api/admin/routines", createRoutinePreferencesApi(service));
  const path = "/api/admin/routines/another.new-routine/platforms/android/preferences";
  expect((await app.request(path, {method: "PATCH"})).status).toBe(401);
  for (const body of [{nightlyEnabled: "false"}, {nightlyEnabled: false, revision: "old"}, {}])
    expect((await app.request(path, {method: "PATCH", headers: {authorization: "admin", "content-type": "application/json"}, body: JSON.stringify(body)})).status).toBe(400);
  const result = await app.request(path, {method: "PATCH", headers: {authorization: "admin", "content-type": "application/json"}, body: JSON.stringify({nightlyEnabled: false})});
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual({routineId: "another.new-routine", platform: "android", nightlyEnabled: false});
  expect(writes).toHaveLength(1);
});
