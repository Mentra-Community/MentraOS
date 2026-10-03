import type {RoutineEnrollment} from "../types/routine-definition.types";
import {expect, test, spyOn} from "bun:test";
import {FrameworkResultService, type FrameworkResultRepository} from "./framework-result.service";
import {TestRunModel} from "../models/test-run.model";
import type {FrameworkRun} from "../types/framework-run.types";

test("lost result acknowledgement returns same receipt and refuses rewritten terminal result", async () => {
  let stored: {payload: FrameworkRun; payloadSha256: string; uploadsComplete: boolean} | null = null;
  const repository: FrameworkResultRepository = {
    async insert(payload, payloadSha256) {
      if (stored) throw Object.assign(new Error("duplicate"), {code: 11000});
      stored = {payload, payloadSha256, uploadsComplete: true};
    },
    async getByRequest() {return stored;},
    async getByRun() {return stored;},
  };
  const run = {schemaVersion: 1, requestId: "r1", routineId: "notes", definitionRevision: "a".repeat(40),
    platform: "ios-on-mac", laneId: "mac", build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}, startedAt: "2026-10-02T19:00:00Z", finishedAt: "2026-10-02T19:01:00Z",
    assets: [], result: {runId: "r1", finishedAt: "2026-10-02T19:01:00Z", setup: {status: "failed", actionId: "install"}, test: "not-run", steps: [{id: "required", status: "not-run", durationMs: 0, causedBy: "install"}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [{phase: "setup", actionId: "install", message: "install failed"}], evidence: [],
      timing: {startedAt: "2026-10-02T19:00:00Z", setupMs: 100, testMs: 0, teardownMs: 100}}};
  let projectionAttempts = 0;
  const source = async () => ({definition: {steps: [{id: "required"}]}} as unknown as RoutineEnrollment);
  const service = new FrameworkResultService(repository, async () => ({hostId: "mini", input: {
    routineId: "notes", definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac", build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}}}), async () => {projectionAttempts++;}, source);
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
  await expect(service.ingest({...run, build: {...run.build, different: true}}, "mini")).rejects.toThrow("accepted request");
  let attempts = 0;
  const retrying = new FrameworkResultService(repository, async () => ({hostId: "mini", input: {
    routineId: "notes", definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac", build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}}}),
    async () => {if (++attempts === 1) throw new Error("request projection unavailable");}, source);
  await expect(retrying.ingest(run, "mini")).rejects.toThrow("projection unavailable");
  expect(await retrying.ingest(run, "mini")).toEqual({...first, created: false});
  expect(attempts).toBe(2);
  const incomplete = new FrameworkResultService(repository, async () => ({hostId: "mini", input: {
    routineId: "notes", definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac", build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}}}),
    async () => {}, async () => ({definition: {steps: [{id: "required"}]}} as unknown as RoutineEnrollment));
  expect((await incomplete.ingest(run, "mini")).created).toBe(false);
  await expect(incomplete.ingest({...run, result: {...run.result, steps: []}}, "mini"))
    .rejects.toThrow("complete ordered source step list");
  stored!.uploadsComplete = true;
  stored!.payload.result.failures.push({phase: "evidence", actionId: "capture", message: "Recording failed"});
  // Cloud custody of the declared diagnostics still permits disposal after capture failed.
  expect((await service.complete("r1", "mini")).entityId).toBe(first.entityId);
  expect((await service.detail("r1")).evidenceStatus).toBe("failed");

});


test("a completed test can publish a teardown failure without becoming a catalog pass", async () => {
  const {frameworkRunSchema, frameworkRunOutcome} = await import("../types/framework-run.types");
  let stored: FrameworkRun | undefined;
  const failure = {phase: "teardown" as const, actionId: "uninstall", message: "App removal failed"};
  const run = frameworkRunSchema.parse({schemaVersion: 1, requestId: "local:teardown", routineId: "notes",
    definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac",
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
    startedAt: "2026-10-02T19:00:00Z", finishedAt: "2026-10-02T19:01:00Z", assets: [],
    result: {runId: "local:teardown", finishedAt: "2026-10-02T19:01:00Z", setup: {status: "passed"}, test: "passed",
      steps: [{id: "required", status: "passed", durationMs: 10}],
      teardown: {ready: false, outcomes: [{state: "failed", resourceId: "app", failure}], errors: [failure], unavailableResources: []},
      failures: [failure], evidence: [], timing: {startedAt: "2026-10-02T19:00:00Z", setupMs: 10, testMs: 10, teardownMs: 10}}});
  const service = new FrameworkResultService({async insert(payload) {stored = payload;}, async getByRequest() {return null;}, async getByRun() {return null;}},
    async () => ({hostId: "mini", input: {routineId: run.routineId, definitionRevision: run.definitionRevision,
      platform: run.platform, laneId: run.laneId, build: run.build}}), async () => {},
    async () => ({definition: {steps: [{id: "required"}]}} as unknown as RoutineEnrollment));
  expect((await service.ingest(run, "mini")).created).toBe(true);
  expect(stored?.result.failures).toEqual([failure]);
  expect(frameworkRunOutcome(stored!)).toBe("teardown-failed");
  await expect(service.ingest({...run, result: {...run.result, steps: []}}, "mini")).rejects.toThrow("Invalid frozen");
  await expect(service.ingest({...run, result: {...run.result, failures: [{...failure, phase: "test"}]}}, "mini")).rejects.toThrow("Invalid frozen");
});


test("native result list scopes the archive digest and excludes retained old payloads", async () => {
  let filter: Record<string, unknown> | null = null;
  const find = spyOn(TestRunModel, "find").mockImplementation(((query: Record<string, unknown>) => {
    filter = query;
    const chain = {sort() {return chain;}, limit() {return chain;}, read() {return chain;}, readConcern() {return chain;}, async lean() {return [];}};
    return chain;
  }) as any);
  try {
    const service = new FrameworkResultService();
    expect(await service.list({routineId: "walkthrough", platform: "ios-on-mac", archiveSha256: "a".repeat(64), prNumber: "12", channel: "pr"})).toEqual({runs: []});
    expect(filter as Record<string, unknown> | null).toEqual({"payload.schemaVersion": 1, routineId: "walkthrough", platform: "ios-on-mac", "payload.build.archive.sha256": "a".repeat(64), "payload.build.prNumber": 12, "payload.build.channel": "pr"});
  } finally {find.mockRestore();}
});
