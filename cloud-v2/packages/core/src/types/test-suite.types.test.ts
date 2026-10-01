import {describe, expect, test} from "bun:test";
import {summarizeSuite, testSuiteSchema, type SuiteRun} from "./test-suite.types";
const plan = testSuiteSchema.parse({suiteId: "nightly-123", channel: "dev", trigger: "nightly",
  startedAt: "2026-10-01T11:00:00Z", build: {headSha: "a".repeat(40)},
  members: [{memberId: "mac-captions", requestId: "req-1", routineId: "captions-phone", platform: "ios-mac"},
    {memberId: "android-ota", requestId: "req-2", routineId: "ota", platform: "android"}]});
const run = (index: number, outcome = "passed"): SuiteRun => ({...plan.members[index]!, runId: `run-${index}`, outcome,
  channel: "dev", provenance: {headSha: plan.build.headSha}, startedAt: plan.startedAt, finishedAt: "2026-10-01T11:02:00Z"});
describe("suite verdict", () => {
  test("waits for completion and all expected members before all green", () => {
    expect(summarizeSuite(plan, [run(0), run(1)]).outcome).toBe("running");
    expect(summarizeSuite(plan, [run(0), run(1)], "2026-10-01T11:03:00Z").outcome).toBe("passed");
  });
  test("missing and blocked members are visible failures at completion", () => {
    const result = summarizeSuite(plan, [run(0)], "2026-10-01T11:03:00Z");
    expect(result.outcome).toBe("failed");
    expect(result.members[1]!.status).toBe("not-run");
    expect(result.failedRoutines).toEqual(["ota"]);
    expect(summarizeSuite(plan, [run(0), run(1, "blocked")], "2026-10-01T11:03:00Z").outcome).toBe("failed");
  });
  test("wrong build or lane and ambiguous retries cannot satisfy member", () => {
    for (const wrong of [{...run(1), provenance: {headSha: "b".repeat(40)}}, {...run(1), platform: "ios-mac"}])
      expect(summarizeSuite(plan, [run(0), wrong], "2026-10-01T11:03:00Z").passed).toBe(1);
    expect(summarizeSuite(plan, [run(0), run(1), {...run(1), runId: "another"}], "2026-10-01T11:03:00Z").passed).toBe(1);
  });
  test("pre-send missing bindings stay visible and per-member build pins work", () => {
    const pending = {...plan, members: plan.members.map(({requestId, ...member}) => member)};
    expect(summarizeSuite(pending, [run(0), run(1)], "2026-10-01T11:03:00Z").passed).toBe(0);
    const differentBuild = {...plan, members: [plan.members[0]!, {...plan.members[1]!, headSha: "b".repeat(40)}]};
    expect(summarizeSuite(differentBuild, [run(0), {...run(1), provenance: {headSha: "b".repeat(40)}}], "2026-10-01T11:03:00Z").outcome).toBe("passed");
  });
  test("rejects empty and duplicated member plans", () => {
    expect(testSuiteSchema.safeParse({...plan, members: []}).success).toBe(false);
    expect(testSuiteSchema.safeParse({...plan, members: [plan.members[0], plan.members[0]]}).success).toBe(false);
  });
});
