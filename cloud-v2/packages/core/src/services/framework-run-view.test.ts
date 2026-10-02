import {expect, spyOn, test} from "bun:test";
import {TestRunModel} from "../models/test-run.model";
import {frameworkRunSchema} from "../types/framework-run.types";
import {frameworkRunView} from "./framework-run-view";
import {MongoTestRunRepository} from "./test-run.service";

test("shared result reader presents a framework setup failure without losing its immutable identity", async () => {
  const run = frameworkRunSchema.parse({schemaVersion: 1, requestId: "local:run", routineId: "walkthrough",
    definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac", build: {channel: "dev", headSha: "b".repeat(40)},
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
    expect(stored?.run).toEqual(frameworkRunView(run));
    expect(stored?.run.outcomes.test).toBe("not-run");
    expect(stored?.run.notes).toContain("Home not reached");
    expect(stored?.run.provenance.headSha).toBe("b".repeat(40));
    expect(stored?.payloadSha256).toBe("c".repeat(64));
    expect(run.result.setup.status).toBe("failed");
  } finally {find.mockRestore();}
});
