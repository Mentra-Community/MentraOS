import { describe, expect, test } from "bun:test";
import { FixFlowService, matchingFixActivity, projectFixFlow, type FixFlowRepository } from "./fix-flow.service";
import { fixActivitySchema, HttpFixActivityReader, type FixActivity, type FixActivityBinding } from "./fix-flow-activity";
import type { StoredTestRun } from "./test-run.service";
import type { TestFailureOccurrence } from "../types/test-failure.types";
import { createFixFlowAdminApi } from "../api/admin/fix-flows.api";

const occurrenceId = `tfo_${"a".repeat(64)}`, agentId = "11111111-1111-4111-8111-111111111111";
const at = "2026-09-28T18:00:00.000Z";
const occurrence: TestFailureOccurrence = { occurrenceId, revision: 1,
  failure: { phase: "test", step: { id: "NOTES-08", label: "Read expanded note" }, code: "blank-content", message: "Note content did not appear",
    assetIds: [], incidentIds: ["rep_synthetic"], redactionPolicy: "synthetic-reviewed", missingEvidence: [] },
  delivery: { state: "acknowledged", agentRunId: agentId, acknowledgedAt: at } };
const stored: StoredTestRun = { payloadSha256: "b".repeat(64), failureOccurrences: [occurrence], run: {
  runId: "notes-synthetic-run", requestId: "request-synthetic", routineId: "notes-phone", routineVersion: "synthetic", platform: "ios-mac", channel: "dev",
  release: "3.3.0-dev.synthetic", startedAt: at, finishedAt: at, outcome: "failed",
  outcomes: { test: "failed", teardown: "passed", fixture: "ready", evidence: "complete" }, provenance: { repository: "Mentra-Community/MentraOS" },
  fixture: { alias: "synthetic" }, firmwareAssertions: [], assets: [], chapters: [{ id: "NOTES-08", instruction: "Read expanded note", phase: "test", status: "failed" }],
} };
const activity: FixActivity = { runId: agentId, environment: "dev", taskKind: "routine-failure", executor: "mini-claude", status: "mini_running",
  statusLabel: "Investigating", createdAt: at, updatedAt: at,
  routineFailure: { intake: { occurrenceId, testRunId: stored.run.runId } },
  routineCase: { caseId: `mfc_${"c".repeat(64)}`, anchorRunId: agentId },
  miniExecution: { route: { repository: "Mentra-Community/MentraOS", branch: "fix/synthetic" }, checkpoints: [] } };
const repository = (rows = [stored]): FixFlowRepository => ({ recent: async () => rows,
  failure: async id => rows.find(row => row.failureOccurrences?.some(item => item.occurrenceId === id)) ?? null,
  run: async id => rows.find(row => row.run.runId === id) ?? null,
  incidents: async ids => ids.includes("rep_synthetic") ? [{ reportId: "rep_synthetic", status: "ready" }] : [] });
const reader = (runs: FixActivity[] = [activity]) => ({ list: async () => ({ runs, state: "available" as const, limited: false }),
  detail: async (id: string, binding: FixActivityBinding) => runs.find(run => (run.acknowledgedAgentRunId ?? run.runId) === id
    && run.routineFailure.intake.occurrenceId === binding.occurrenceId && run.routineFailure.intake.testRunId === binding.testRunId) ?? null });

describe("exact failure-to-fixer projection", () => {
  test("requires the acknowledgement, occurrence, run and environment together", () => {
    expect(matchingFixActivity(stored, occurrence, activity, "dev")).toEqual(activity);
    for (const candidate of [{ ...activity, environment: "staging" as const }, { ...activity, runId: "22222222-2222-4222-8222-222222222222" },
      { ...activity, routineFailure: { intake: { ...activity.routineFailure.intake, testRunId: "another-run" } } },
      { ...activity, routineFailure: { intake: { ...activity.routineFailure.intake, occurrenceId: `tfo_${"d".repeat(64)}` } } }])
      expect(matchingFixActivity(stored, occurrence, candidate, "dev")).toBeNull();
    expect(matchingFixActivity(stored, { ...occurrence, delivery: { state: "pending" } }, activity, "dev")).toBeNull();
  });
  test("pending delivery never claims an agent is running", () => {
    const result = projectFixFlow(stored, { ...occurrence, delivery: { state: "pending" } }, null, "pending", []);
    expect(result.stage).toBe("Awaiting fixer intake"); expect(result.agent).toBeNull(); expect(result.state).toBe("active");
  });
  test("two runs linked to one case retain distinct occurrence identities and shared owner progress", async () => {
    const linkedId = "22222222-2222-4222-8222-222222222222", linkedOccurrenceId = `tfo_${"e".repeat(64)}`;
    const linkedOccurrence = { ...occurrence, occurrenceId: linkedOccurrenceId };
    const linkedStored = { ...stored, run: { ...stored.run, runId: "second-notes-run" }, failureOccurrences: [linkedOccurrence] };
    const linkedActivity: FixActivity = { ...activity, runId: linkedId, status: "mini_linked", acknowledgedAgentRunId: agentId,
      executionOwnerRunId: agentId, executionOwnerStatus: "mini_waiting", executionOwnerStatusLabel: "Waiting for review",
      executionOwnerUpdatedAt: "2026-09-28T19:00:00.000Z",
      routineFailure: { intake: { occurrenceId: linkedOccurrenceId, testRunId: linkedStored.run.runId } },
      miniExecution: { ...activity.miniExecution!, stage: { stage: "waiting-for-review", reason: "review-pending" }, checkpoints: [
        { action: "record-pr", repository: "Mentra-Community/MentraOS", pullRequest: 42, headSha: "a".repeat(40) },
        { action: "reserve-dispatch", intentId: "anchor-rerun", occurrence: { agentRunId: agentId, occurrenceId } },
        { action: "consume-result", intentId: "anchor-rerun", resultId: "anchor-only", outcome: "passed" },
        { action: "reserve-dispatch", intentId: "own-rerun", occurrence: { agentRunId: linkedId, occurrenceId: linkedOccurrenceId } },
        { action: "consume-result", intentId: "own-rerun", resultId: "linked-result", outcome: "failed" },
      ] } };
    const service = new FixFlowService(repository([stored, linkedStored]), reader([activity, linkedActivity]), "dev");
    const flows = (await service.list()).flows;
    expect(flows).toHaveLength(2);
    const linked = flows.find(flow => flow.occurrenceId === linkedOccurrenceId)!;
    expect(linked.stage).toBe("Linked case · Waiting for review");
    expect(linked.agent).toMatchObject({ runId: linkedId, status: "mini_linked", executionOwner: { runId: agentId, status: "mini_waiting" } });
    expect(linked.updatedAt).toBe(linkedActivity.executionOwnerUpdatedAt!);
    expect(linked.pullRequests[0].number).toBe(42);
    expect(linked.timeline.filter(event => event.stage === "consume-result").map(event => event.detail)).toEqual(["linked-result"]);
    expect(await service.detail(linkedOccurrenceId)).toEqual(linked);
    expect(matchingFixActivity(linkedStored, linkedOccurrence, activity, "dev")).toBeNull();
    for (const bad of [{ ...linkedActivity, acknowledgedAgentRunId: linkedId }, { ...linkedActivity, executionOwnerRunId: linkedId },
      { ...linkedActivity, executionOwnerStatus: undefined }, { ...linkedActivity, routineCase: undefined },
      { ...linkedActivity, routineFailure: activity.routineFailure }])
      expect(matchingFixActivity(linkedStored, linkedOccurrence, bad, "dev")).toBeNull();
  });
  test("controller outage keeps exact failure and incident available", async () => {
    const service = new FixFlowService(repository(), { list: async () => ({ runs: [], state: "unavailable", limited: false }), detail: async () => null }, "dev");
    const result = await service.list();
    expect(result.activity).toBe("unavailable"); expect(result.flows[0].state).toBe("unknown");
    expect(result.flows[0].incidents).toEqual([{ reportId: "rep_synthetic", status: "ready" }]);
  });
  test("in-progress older occurrences are fetched outside recent history", async () => {
    const service = new FixFlowService({ ...repository(), recent: async () => [] }, reader(), "dev");
    expect((await service.list()).flows[0].agent?.runId).toBe(agentId);
  });
  test("shows requested changes and later approval as separate recorded reviews", () => {
    const result = projectFixFlow(stored, occurrence, { ...activity, miniExecution: { ...activity.miniExecution!, checkpoints: [
      { action: "record-pr", repository: "Mentra-Community/MentraOS", pullRequest: 42, headSha: "a".repeat(40) },
      { action: "record-review", repository: "Mentra-Community/MentraOS", pullRequest: 42, headSha: "a".repeat(40), reviewId: "12", verdict: "changes-requested" },
      { action: "record-pr", repository: "Mentra-Community/MentraOS", pullRequest: 42, headSha: "b".repeat(40) },
      { action: "record-review", repository: "Mentra-Community/MentraOS", pullRequest: 42, headSha: "b".repeat(40), reviewId: "13", verdict: "approved" },
    ] } }, "available", []);
    expect(result.timeline.filter(item => item.stage === "record-review").map(item => item.title)).toEqual(["Review requested changes", "Review approved"]);
    expect(result.pullRequests[0].state).toBe("unknown");
    expect(result.pullRequests[0].headSha).toBe("b".repeat(40));
    expect(result.timeline.some(item => item.url?.endsWith("#pullrequestreview-12"))).toBe(true);
  });
  test("a stale result cannot decorate a newer checkpoint head as merged", () => {
    const result = projectFixFlow(stored, occurrence, { ...activity,
      result: { summary: "old", pullRequests: [{ repository: "Mentra-Community/MentraOS", pullRequestNumber: 42, headSha: "a".repeat(40), pullRequestLifecycle: { state: "merged", mergedAt: at } }] },
      miniExecution: { ...activity.miniExecution!, checkpoints: [{ action: "record-pr", repository: "Mentra-Community/MentraOS", pullRequest: 42, headSha: "b".repeat(40) }] } }, "available", []);
    expect(result.pullRequests[0].state).toBe("unknown"); expect(result.stage).not.toBe("Fix merged");
  });
  test("a merged PR does not complete a still-running verification", () => {
    const result = projectFixFlow(stored, occurrence, { ...activity, pullRequests: [{ repository: "Mentra-Community/MentraOS", pullRequestNumber: 42,
      headSha: "a".repeat(40), pullRequestLifecycle: { state: "merged", mergedAt: at } }] }, "available", []);
    expect(result.stage).toBe("Fix merged"); expect(result.state).toBe("active"); expect(result.nextAction).toContain("pending");
  });
  test("a historical stop does not override a currently running agent", () => {
    const result = projectFixFlow(stored, occurrence, { ...activity, miniTurnFailure: { kind: "process-exit", phase: "model", at } }, "available", []);
    expect(result.state).toBe("active"); expect(result.stage).toBe("Investigating");
    expect(result.timeline.some(item => item.stage === "agent-stop")).toBe(true);
  });
  test("an actual blocked controller remains visible even after its PR merged", () => {
    const result = projectFixFlow(stored, occurrence, { ...activity, status: "mini_needs_input", miniLastTurn: { stage: "needs-input", reason: "budget-exhausted" },
      pullRequests: [{ repository: "Mentra-Community/MentraOS", pullRequestNumber: 42, headSha: "a".repeat(40), pullRequestLifecycle: { state: "merged", mergedAt: at } }] }, "available", []);
    expect(result.state).toBe("attention"); expect(result.nextAction).toContain("execution budget is exhausted");
  });
  test("admitted triage cannot mask the current review wait or access blocker", () => {
    for (const reason of ["review-pending", "access-required"]) {
      const result = projectFixFlow(stored, occurrence, { ...activity, status: "mini_waiting",
        miniTriage: { state: "admitted", nextAction: "Old admission text" },
        miniExecution: { ...activity.miniExecution!, stage: { stage: reason === "review-pending" ? "waiting-for-review" : "needs-input", reason } },
      }, "available", []);
      expect(result.nextAction).not.toContain("Old admission");
      expect(result.nextAction).toContain(reason === "review-pending" ? "reviewer" : "Required access");
    }
  });
  test("another occurrence's rerun cannot appear as this flow's verification", () => {
    const checkpoints = [{ action: "reserve-dispatch", intentId: "dispatch", occurrence: { agentRunId: agentId, occurrenceId: `tfo_${"d".repeat(64)}` } },
      { action: "consume-result", intentId: "dispatch", resultId: "another-result", outcome: "passed" }];
    const result = projectFixFlow(stored, occurrence, { ...activity, miniExecution: { ...activity.miniExecution!, checkpoints } }, "available", []);
    expect(result.timeline.some(item => item.stage === "consume-result")).toBe(false);
  });
  test("missing structured failure yields a truthful step-specific pending page", async () => {
    const service = new FixFlowService(repository([{ ...stored, failureOccurrences: [] }]), reader(), "dev");
    expect(await service.chapter(stored.run.runId, "NOTES-08")).toMatchObject({ pending: true, runId: stored.run.runId, chapterId: "NOTES-08" });
    await expect(service.chapter(stored.run.runId, "unrelated-step")).rejects.toThrow("not found");
  });
  test("multiple phase failures offer exact occurrences instead of choosing the first", async () => {
    const service = new FixFlowService(repository([{ ...stored, failureOccurrences: [occurrence, { ...occurrence, occurrenceId: `tfo_${"e".repeat(64)}`,
      failure: { ...occurrence.failure, phase: "teardown" } }] }]), reader(), "dev");
    const result = await service.chapter(stored.run.runId, "NOTES-08");
    expect(result).toMatchObject({ choices: [{ occurrenceId }, { occurrenceId: `tfo_${"e".repeat(64)}` }] });
  });
  test("read-only route rejects malformed IDs and never offers mutations", async () => {
    const app = createFixFlowAdminApi(new FixFlowService(repository(), reader(), "dev"));
    expect((await app.request("/not-an-occurrence")).status).toBe(400);
    expect((await app.request(`/${occurrenceId}`, { method: "POST" })).status).toBe(404);
    const response = await app.request(`/${occurrenceId}`);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ occurrenceId, agent: { runId: agentId } });
  });
});

describe("bounded authenticated activity reader", () => {
  const env = { CLOUD_REPORT_AGENT_URL: "https://agent.example.test", CLOUD_REPORT_AGENT_ACTIVITY_TOKEN: "synthetic-read-token" };
  test("passes only the read token upstream and strips fields outside the projection", async () => {
    const send = async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-read-token");
      expect(init?.redirect).toBe("error");
      return Response.json({ runs: [{ ...activity, pendingPrompt: "private", miniLease: { token: "private" } }], limited: false });
    };
    const result = await new HttpFixActivityReader(env, send as unknown as typeof fetch).list();
    expect(result.runs).toEqual([fixActivitySchema.parse(activity)]); expect(JSON.stringify(result)).not.toContain("private");
  });
  test("follows a bounded cursor and labels legacy lists limited", async () => {
    let calls = 0;
    const send = async (url: unknown) => { calls++; expect(String(url)).toContain(calls === 1 ? "limit=100" : "cursor=next");
      return Response.json({ runs: calls === 1 ? [activity] : [], limited: calls === 1, nextCursor: calls === 1 ? "next" : null }); };
    const result = await new HttpFixActivityReader(env, send as unknown as typeof fetch).list();
    expect(calls).toBe(2); expect(result.limited).toBe(false);
    expect((await new HttpFixActivityReader(env, (async () => Response.json([activity])) as unknown as typeof fetch).list()).limited).toBe(true);
  });
  test("detail supplies both exact occurrence identifiers to the acknowledged owner lookup", async () => {
    let calls = 0;
    const send = async (input: unknown) => {
      calls++;
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/internal/activity/runs/${agentId}`);
      expect(url.searchParams.get("occurrenceId")).toBe(occurrenceId);
      expect(url.searchParams.get("testRunId")).toBe(stored.run.runId);
      return Response.json(activity);
    };
    const client = new HttpFixActivityReader(env, send as unknown as typeof fetch);
    expect(await client.detail(agentId, { occurrenceId, testRunId: stored.run.runId })).toEqual(fixActivitySchema.parse(activity));
    expect(await client.detail(agentId, { occurrenceId: "not-an-occurrence", testRunId: stored.run.runId })).toBeNull();
    expect(calls).toBe(1);
  });
  test("does not call an invalid origin and does not echo remote error text", async () => {
    let calls = 0; const send = async () => { calls++; return new Response("private diagnostic", { status: 503 }); };
    const invalid = await new HttpFixActivityReader({ ...env, CLOUD_REPORT_AGENT_URL: "http://agent.example.test" }, send as unknown as typeof fetch).list();
    expect(calls).toBe(0); expect(invalid.state).toBe("unavailable");
    expect(JSON.stringify(await new HttpFixActivityReader(env, send as unknown as typeof fetch).list())).not.toContain("diagnostic");
  });
});
