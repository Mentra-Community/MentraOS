import {afterEach, expect, test} from "bun:test";
import {createNightlyRoutinesApi} from "./nightly-routines.api";
import type {NightlyRoutineService} from "../../services/nightly-routine.service";
import {TestRunError} from "../../services/test-result-error";

const original = process.env.TEST_RUN_INGEST_TOKEN;
afterEach(() => {if (original === undefined) delete process.env.TEST_RUN_INGEST_TOKEN; else process.env.TEST_RUN_INGEST_TOKEN = original;});
test("nightly selection uses the existing internal capability and keeps occurrence retries explicit", async () => {
  process.env.TEST_RUN_INGEST_TOKEN = "test-only-nightly-token-that-is-at-least-32-characters";
  const calls: unknown[] = [];
  const service = {async start(input: unknown) {calls.push(input); return {plan: input, admissions: []};},
    async detail(id: string) {calls.push(id); return {occurrenceId: id, status: "running"};},
    async complete(id: string) {calls.push(id); return {occurrenceId: id, status: "incomplete"};}} as unknown as NightlyRoutineService;
  const app = createNightlyRoutinesApi(service);
  const input = {occurrenceId: "schedule:2026-10-03", startedAt: "2026-10-03T11:00:00Z", trigger: "nightly"};
  expect((await app.request("/", {method: "POST", body: JSON.stringify(input)})).status).toBe(401);
  expect(calls).toHaveLength(0);
  const headers = {authorization: `Bearer ${process.env.TEST_RUN_INGEST_TOKEN}`, "content-type": "application/json"};
  const admitted = await app.request("/", {method: "POST", headers, body: JSON.stringify(input)});
  expect(admitted.status).toBe(202);
  expect(admitted.headers.get("cache-control")).toBe("no-store");
  expect(calls[0]).toEqual(input);
  expect((await app.request("/schedule%3A2026-10-03", {headers})).status).toBe(200);
  expect(await (await app.request("/schedule%3A2026-10-03/complete", {method: "POST", headers})).json()).toEqual({occurrenceId: input.occurrenceId, status: "incomplete"});
});

test("nightly cancellation authenticates, bounds its reason and returns custody without claiming executor settlement", async () => {
  process.env.TEST_RUN_INGEST_TOKEN = "test-only-nightly-token-that-is-at-least-32-characters";
  const calls: unknown[] = [], receipt = {occurrenceId: "manual-dev-123", suiteId: "nightly-suite",
    cancellation: {requestedAt: "2026-10-03T11:01:00Z", reason: "Superseded by latest passing build"}, requestsCancellationRecorded: true};
  const app = createNightlyRoutinesApi({async cancel(id: string, input: unknown) {
    calls.push({id, input}); if (!input || typeof (input as any).reason !== "string" || !(input as any).reason.length)
      throw new TestRunError(400, "Invalid nightly cancellation");
    return receipt;
  }} as unknown as NightlyRoutineService);
  const body = JSON.stringify({reason: receipt.cancellation.reason});
  expect((await app.request("/manual-dev-123/cancel", {method: "POST", body})).status).toBe(401);
  expect(calls).toEqual([]);
  const headers = {authorization: `Bearer ${process.env.TEST_RUN_INGEST_TOKEN}`, "content-type": "application/json"};
  const response = await app.request("/manual-dev-123/cancel", {method: "POST", headers, body});
  expect(response.status).toBe(202);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(receipt);
  expect(calls).toEqual([{id: "manual-dev-123", input: {reason: receipt.cancellation.reason}}]);
  expect((await app.request("/manual-dev-123/cancel", {method: "POST", headers, body: "{}"})).status).toBe(400);
  expect((await app.request("/manual-dev-123/cancel", {method: "POST", headers, body: JSON.stringify({reason: "x".repeat(5000)})})).status).toBe(413);
});
