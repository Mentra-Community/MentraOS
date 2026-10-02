import {expect, spyOn, test} from "bun:test";
import {TestRunModel} from "../models/test-run.model";
import {frameworkRunSchema} from "../types/framework-run.types";
import {frameworkRunView} from "./framework-run-view";
import {MongoTestRunRepository} from "./test-run.service";

test("shared result reader presents a framework setup failure without losing its immutable identity", async () => {
  const run = frameworkRunSchema.parse({schemaVersion: 1, requestId: "local:run", routineId: "walkthrough",
    definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac", build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
    startedAt: "2026-10-02T19:00:00Z", finishedAt: "2026-10-02T19:01:00Z", assets: [],
    result: {runId: "local:run", finishedAt: "2026-10-02T19:01:00Z", setup: {status: "failed", actionId: "entry"},
      test: "not-run", steps: [{id: "home", status: "not-run", durationMs: 0, causedBy: "entry"}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [{phase: "setup", actionId: "entry", message: "Home not reached"}], evidence: [],
      timing: {startedAt: "2026-10-02T19:00:00Z", setupMs: 10, testMs: 0, teardownMs: 10}}});
  const find = spyOn(TestRunModel, "findOne").mockReturnValue({read: () => ({readConcern: () => ({lean: async () =>
    ({payload: run, payloadSha256: "c".repeat(64)})})})} as unknown as ReturnType<typeof TestRunModel.findOne>);
  try {
    const stored = await new MongoTestRunRepository().get(run.result.runId);
    expect(stored?.frameworkResult).toBe(true);
    expect(stored?.run).toEqual(frameworkRunView(run));
    expect(stored?.run.outcomes.test).toBe("not-run");
    expect(stored?.run.notes).toContain("Home not reached");
    expect(stored?.run.provenance.headSha).toBe("b".repeat(40));
    expect(stored?.payloadSha256).toBe("c".repeat(64));
    expect(run.result.setup.status).toBe("failed");
  } finally {find.mockRestore();}
});

test("shared history filters both payload formats and accepts framework pagination identities", async () => {
  const queries: Record<string, unknown>[] = [];
  const find = spyOn(TestRunModel, "find").mockImplementation(((filter: unknown) => {
    queries.push(filter as Record<string, unknown>);
    return {sort: () => ({limit: () => ({lean: async () => []})})} as unknown as ReturnType<typeof TestRunModel.find>;
  }) as typeof TestRunModel.find);
  try {
    const cursor = Buffer.from(JSON.stringify({startedAt: "2026-10-02T19:00:00Z", runId: "local:run"})).toString("base64url");
    await new MongoTestRunRepository().list({limit: 25, platform: "ios-mac", channel: "dev", outcome: "failed", cursor});
    expect(queries[0]?.$and).toEqual([
      {$or: [{"payload.channel": "dev"}, {definitionRevision: {$exists: true}, "payload.build.channel": "dev"}]},
      {$or: [{"payload.platform": "ios-mac"}, {definitionRevision: {$exists: true}, "payload.platform": "ios-on-mac"}]},
    ]);
    expect(queries[0]?.outcome).toBe("failed");
    expect(queries[0]?.$or).toEqual([{startedAt: {$lt: new Date("2026-10-02T19:00:00Z")}},
      {startedAt: new Date("2026-10-02T19:00:00Z"), runId: {$lt: "local:run"}}]);
    for (const outcome of ["passed", "blocked"] as const) {
      await new MongoTestRunRepository().list({limit: 25, outcome});
      expect(queries.at(-1)?.outcome).toBe(outcome);
    }
    const invalid = Buffer.from(JSON.stringify({startedAt: "2026-10-02T19:00:00Z", runId: "../run"})).toString("base64url");
    await expect(new MongoTestRunRepository().list({limit: 25, cursor: invalid})).rejects.toThrow("invalid cursor");
  } finally {find.mockRestore();}
});

test("framework pass remains passed in shared presentation despite pending or failed evidence", async () => {
 const {TestRunService} = await import("./test-run.service");
 for (const evidence of ["complete", "incomplete"] as const) {
  const run = {runId: "local:pass", outcome: "passed", outcomes: {evidence}, assets: [{assetId: "recording"}],
    provenance: {}, chapters: [], notes: ""};
  const repository = {assets: async () => []};
  const service = new TestRunService(repository as any);
  const stored = {frameworkResult: true, run, payloadSha256: "a".repeat(64)};
  const result = await (service as any).present(stored);
  expect(result.outcome).toBe("passed");
  expect(result.outcomes.evidence).toBe("incomplete");
 }
});
