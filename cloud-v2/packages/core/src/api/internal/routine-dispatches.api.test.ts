import {afterEach, expect, test} from "bun:test";
import {Hono} from "hono";
import {createRoutineDispatchesApi} from "./routine-dispatches.api";
import type {RoutineDispatchService} from "../../services/routine-dispatch.service";
const previous = process.env.TEST_RUN_INGEST_TOKEN;
afterEach(() => {if (previous === undefined) delete process.env.TEST_RUN_INGEST_TOKEN; else process.env.TEST_RUN_INGEST_TOKEN = previous;});
test("internal catalog, exact-source admission and result reads require the existing capability without shadowing host routes", async () => {
  process.env.TEST_RUN_INGEST_TOKEN = "test-only-internal-token-that-exceeds-32-characters";
  const requests: unknown[] = [];
  const service = {async catalog() {return {routines: []};}, async submit(input: unknown) {requests.push(input); return {requestId: "request"};},
    async detail(requestId: string) {return {request: {requestId}, result: null};}} as unknown as RoutineDispatchService;
  const app = new Hono(); app.route("/api/internal", createRoutineDispatchesApi(service));
  app.get("/api/internal/host-route", c => c.json({host: true}));
  expect((await app.request("/api/internal/routine-catalog")).status).toBe(401);
  expect((await app.request("/api/internal/routine-dispatches/request")).status).toBe(401);
  expect((await app.request("/api/internal/routine-dispatches", {method: "POST"})).status).toBe(401);
  expect((await app.request("/api/internal/host-route")).status).toBe(200);
  const headers = {authorization: `Bearer ${process.env.TEST_RUN_INGEST_TOKEN}`, "content-type": "application/json"};
  expect(await (await app.request("/api/internal/routine-catalog", {headers})).json()).toEqual({routines: []});
  const input = {requestId: "request", routineId: "unfamiliar", platform: "android", source: {channel: "dev", buildRunId: 1, publicationAttempt: 1}};
  const response = await app.request("/api/internal/routine-dispatches", {method: "POST", headers, body: JSON.stringify(input)});
  expect(response.status).toBe(202); expect(requests).toEqual([input]);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await (await app.request("/api/internal/routine-dispatches/request", {headers})).json()).toEqual({request: {requestId: "request"}, result: null});
});
