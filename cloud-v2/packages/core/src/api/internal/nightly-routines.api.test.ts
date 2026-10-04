import {afterEach, expect, test} from "bun:test";
import {createNightlyRoutinesApi} from "./nightly-routines.api";
import type {NightlyRoutineService} from "../../services/nightly-routine.service";

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
