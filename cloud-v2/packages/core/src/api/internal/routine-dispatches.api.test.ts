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

test('selected applicability query is bounded and keeps exact revision under the existing trusted capability', async () => {
  process.env.TEST_RUN_INGEST_TOKEN = 'test-only-internal-token-that-exceeds-32-characters';
  const calls: unknown[] = [], service = {async catalog(revision: string, ids: string[]) {
    calls.push({revision, ids}); return {routineRevision: revision, routines: ids.map(routineId => ({routineId, platforms: ['android']}))};
  }} as unknown as RoutineDispatchService;
  const app = new Hono(); app.route('/api/internal', createRoutineDispatchesApi(service));
  const headers = {authorization: `Bearer ${process.env.TEST_RUN_INGEST_TOKEN}`}, revision = 'a'.repeat(40);
  const response = await app.request(`/api/internal/routine-catalog?revision=${revision}&routines=first,second`, {headers});
  expect(response.status).toBe(200); expect(calls).toEqual([{revision, ids: ['first', 'second']}]);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await app.request('/api/internal/routine-catalog?routines=', {headers})).status).toBe(400);
  expect((await app.request(`/api/internal/routine-catalog?routines=${Array.from({length: 31}, (_, i) => `id${i}`).join(',')}`, {headers})).status).toBe(400);
  expect(calls).toHaveLength(1);
});
