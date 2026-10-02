import type {RoutineEnrollment} from "../types/routine-definition.types";
import {expect, test} from "bun:test";
import {FrameworkResultService, type FrameworkResultRepository} from "./framework-result.service";
import type {FrameworkRun} from "../types/framework-run.types";

test("lost result acknowledgement returns same receipt and refuses rewritten terminal result", async () => {
  let stored: {payload: FrameworkRun; payloadSha256: string; uploadsComplete: boolean} | null = null;
  const repository: FrameworkResultRepository = {
    async insert(payload, payloadSha256) {
      if (stored) throw Object.assign(new Error("duplicate"), {code: 11000});
      stored = {payload, payloadSha256, uploadsComplete: true};
    },
    async getByRequest() {return stored;},
  };
  const run = {schemaVersion: 1, requestId: "r1", routineId: "notes", definitionRevision: "a".repeat(40),
    platform: "ios-on-mac", laneId: "mac", build: {}, startedAt: "2026-10-02T19:00:00Z", finishedAt: "2026-10-02T19:01:00Z",
    assets: [], result: {runId: "r1", finishedAt: "2026-10-02T19:01:00Z", setup: {status: "failed", actionId: "install"}, test: "not-run", steps: [],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [{phase: "setup", actionId: "install", message: "install failed"}], evidence: [],
      timing: {startedAt: "2026-10-02T19:00:00Z", setupMs: 100, testMs: 0, teardownMs: 100}}};
  let projectionAttempts = 0;
  const source = async () => ({definition: {steps: []}} as unknown as RoutineEnrollment);
  const service = new FrameworkResultService(repository, async () => ({hostId: "mini", input: {
    routineId: "notes", definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac", build: {}}}), async () => {projectionAttempts++;}, source);
  const first = await service.ingest(run, "mini"), duplicate = await service.ingest(run, "mini");
  expect(projectionAttempts).toBe(2);
  expect(first.created).toBe(true);
  expect(duplicate).toEqual({...first, created: false});
  expect(await service.complete("r1", "mini")).toEqual({entityId: first.entityId,
    payloadSha256: first.payloadSha256, manifestSha256: (await import("./test-request.service")).requestInputDigest([])});
  await expect(service.complete("r1", "other")).rejects.toThrow("not acknowledged");
  stored!.uploadsComplete = false;
  await expect(service.complete("r1", "mini")).rejects.toThrow("not acknowledged");
  await expect(service.ingest({...run, finishedAt: "2026-10-02T19:02:00Z", result: {...run.result, finishedAt: "2026-10-02T19:02:00Z"}}, "mini")).rejects.toThrow("different terminal result");
  await expect(service.ingest(run, "other")).rejects.toThrow("accepted request");
  await expect(service.ingest({...run, build: {different: true}}, "mini")).rejects.toThrow("accepted request");
  let attempts = 0;
  const retrying = new FrameworkResultService(repository, async () => ({hostId: "mini", input: {
    routineId: "notes", definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac", build: {}}}),
    async () => {if (++attempts === 1) throw new Error("request projection unavailable");}, source);
  await expect(retrying.ingest(run, "mini")).rejects.toThrow("projection unavailable");
  expect(await retrying.ingest(run, "mini")).toEqual({...first, created: false});
  expect(attempts).toBe(2);
  const incomplete = new FrameworkResultService(repository, async () => ({hostId: "mini", input: {
    routineId: "notes", definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac", build: {}}}),
    async () => {}, async () => ({definition: {steps: [{id: "required"}]}} as unknown as RoutineEnrollment));
  await expect(incomplete.ingest(run, "mini")).rejects.toThrow("complete ordered source definition");

});
