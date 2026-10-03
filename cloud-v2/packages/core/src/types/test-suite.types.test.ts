import {describe, expect, test} from "bun:test";
import {summarizeSuite, testSuiteSchema, type SuiteRun} from "./test-suite.types";
const plan = testSuiteSchema.parse({suiteId: "nightly-123", channel: "dev", trigger: "nightly",
  startedAt: "2026-10-01T11:00:00Z", build: {headSha: "a".repeat(40)},
  members: [{memberId: "mac-captions", requestId: "req-1", routineId: "captions-phone", platform: "ios-on-mac"},
    {memberId: "android-ota", requestId: "req-2", routineId: "ota", platform: "android"}]});
const run = (index: number, outcome = "pass"): SuiteRun => ({...plan.members[index]!, requestId: plan.members[index]!.requestId!, runId: `run-${index}`, outcome, publicationComplete: true,
  channel: "dev", provenance: {headSha: plan.build.headSha}, startedAt: plan.startedAt, finishedAt: "2026-10-01T11:02:00Z"});
describe("suite verdict", () => {
  test("waits for completion and all expected members before all green", () => {
    expect(summarizeSuite(plan, [run(0), run(1)]).outcome).toBe("running");
    expect(summarizeSuite(plan, [run(0)]).members[1]!.status).toBe("waiting");
    expect(summarizeSuite(plan, [run(0), run(1)], "2026-10-01T11:03:00Z").outcome).toBe("passed");
  });
  test("missing and blocked members are visible failures at completion", () => {
    const result = summarizeSuite(plan, [run(0)], "2026-10-01T11:03:00Z");
    expect(result.outcome).toBe("failed");
    expect(result.members[1]!.status).toBe("not-run");
    expect(result.failedRoutines).toEqual(["ota"]);
    expect(summarizeSuite(plan, [run(0), run(1, "blocked")], "2026-10-01T11:03:00Z").outcome).toBe("failed");
  });
  test("wrong request, routine, platform, channel or build and ambiguous retries cannot satisfy member", () => {
    for (const wrong of [{...run(1), requestId: "another-request"}, {...run(1), routineId: "another-routine"},
      {...run(1), platform: "ios-on-mac"}, {...run(1), channel: "staging"}, {...run(1), provenance: {headSha: "b".repeat(40)}}])
      expect(summarizeSuite(plan, [run(0), wrong], "2026-10-01T11:03:00Z").passed).toBe(1);
    expect(summarizeSuite(plan, [run(0), run(1), {...run(1), runId: "another"}], "2026-10-01T11:03:00Z").passed).toBe(1);
  });
  test("pre-send missing bindings stay visible and per-member build pins work", () => {
    const pending = {...plan, members: plan.members.map(({requestId, ...member}) => member)};
    expect(summarizeSuite(pending, [run(0), run(1)], "2026-10-01T11:03:00Z").members.every(member => member.status === "not-run")).toBe(true);
    const differentBuild = {...plan, members: [plan.members[0]!, {...plan.members[1]!, headSha: "b".repeat(40)}]};
    expect(summarizeSuite(differentBuild, [run(0), {...run(1), provenance: {headSha: "b".repeat(40)}}], "2026-10-01T11:03:00Z").outcome).toBe("passed");
  });
  test("rejects empty, single and duplicated member plans but accepts two unbound members", () => {
    expect(testSuiteSchema.safeParse({...plan, members: []}).success).toBe(false);
    expect(testSuiteSchema.safeParse({...plan, members: [plan.members[0]]}).success).toBe(false);
    expect(testSuiteSchema.safeParse({...plan, members: [plan.members[0], plan.members[0]]}).success).toBe(false);
    expect(testSuiteSchema.safeParse({...plan, members: plan.members.map(({requestId, ...member}) => member)}).success).toBe(true);
  });
});

test("suite membership and history filters share enrolled routine identity", async () => {
  const {routineIdentitySchema} = await import("./routine-definition.types");
  const routineId = "notes.search_v2";
  expect(routineIdentitySchema.safeParse(routineId).success).toBe(true);
  expect(testSuiteSchema.safeParse({...plan, members: [{...plan.members[0], routineId}, plan.members[1]]}).success).toBe(true);
});

test("missing publication fails suite completeness without rewriting a member pass", () => {
 const result = summarizeSuite(plan, [{...run(0), publicationComplete: false}, run(1)], "2026-10-01T11:03:00Z");
 expect(result.members[0]!.status).toBe("pass");
 expect(result.outcome).toBe("failed");
 expect(result.failedRoutines).toEqual(["captions-phone"]);
});
