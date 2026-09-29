import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { aliveObservation, noOwnerObservation, resourceProgress, retainedObservation } from "../../../../packages/core/src/types/test-resource-observation.examples";
import type { OverviewJob, OverviewResourceObservation, TestRunOverview } from "../../../../packages/core/src/types/test-run-overview.types";
import { TestRunFlow, testFlowItems } from "./test-run-flow";
import type { TestRunSummary } from "./test-runs-data";

const now = Date.parse("2026-09-28T23:00:00.000Z");
const time = (ago = 0) => new Date(now - ago).toISOString();
const data = (items: OverviewResourceObservation[] = [], jobs: OverviewJob[] = []): TestRunOverview => ({
  observedAt: time(), jobs, warnings: [], recentMaintenance: [], resolvedRecoveries: [], fixtureSummary: [],
  resourceObservations: { available: true, truncated: false, items },
});
const resource = (resourceKey: string, runId?: string): OverviewResourceObservation => ({
  hostId: "test-mini", resourceKey, revision: 1, receivedAt: time(), publishedRunIds: [],
  observation: runId ? aliveObservation(runId, 5000, "none") : noOwnerObservation("prior-run"),
  ...(runId ? { progress: { ...resourceProgress(runId, 1), receivedAt: time() } } : {}),
});
const job = (id: string, state: OverviewJob["state"] = "queued", ago = 0): OverviewJob => ({
  id, kind: "routine", state, title: id, createdAt: time(ago), claims: [],
  requests: [{ requestId: id, requestRunId: 42, requestAttempt: 1, routineId: "no-glasses", trigger: "admin", channel: "dev", release: "3.3.0-dev.1", platform: "ios-on-mac" }],
});
const run: TestRunSummary = { runId: "recorded-failure", requestId: "request", routineId: "captions-phone", routineVersion: "1",
  channel: "dev", platform: "ios-mac", release: "3.3.0-dev.1", startedAt: time(180_000), finishedAt: time(60_000), outcome: "failed",
  outcomes: { test: "failed", teardown: "passed", fixture: "ready", evidence: "incomplete" }, provenance: { repository: "Mentra-Community/MentraOS" }, fixture: { alias: "mac-phone-mode" } };

describe("routine execution flow", () => {
  test("waiting jobs stay oldest first without being assigned to a free lane or duplicating maintenance", () => {
    const maintenance = { ...job("maintenance", "waiting", 100_000), kind: "maintenance" as const };
    const result = testFlowItems(data([resource("shared")], [job("newer", "queued", 10), job("older", "waiting", 50), maintenance]), now);
    expect(result.waiting.map(row => row.id)).toEqual(["older", "newer"]);
    expect(result.lanes[0]?.runId).toBeUndefined();
    expect(result.lanes[0]?.state).toBe("available");
  });
  test("counts execution lanes separately from glasses resources; a local run remains visible", () => {
    const result = testFlowItems(data([resource("shared", "local-session"), resource("android-aabbccddeeff"), resource("glasses-aabbccddeeff", "local-session")]), now);
    expect(result.lanes).toHaveLength(2); expect(result.resources).toHaveLength(1);
    expect(result.lanes[0]?.runId).toBe("local-session");
    const html = renderToStaticMarkup(<TestRunFlow data={data([resource("shared", "local-session")])} now={now} onResult={() => {}} />);
    expect(html).toContain("Local / unreported routine"); expect(html).toContain("Build not reported by this session");
    expect(html).not.toContain("PR #undefined");
  });
  test("a fresh step cannot make a stale host report running", () => {
    const item = resource("shared", "local-session"); item.receivedAt = time(120_001);
    const input = data([item]);
    expect(testFlowItems(input, now).lanes[0]?.state).toBe("unknown");
    const html = renderToStaticMarkup(<TestRunFlow data={input} now={now} onResult={() => {}} />);
    expect(html).toContain("Status unknown"); expect(html).toContain("Last reported lane progress");
    expect(html).not.toContain('aria-label="Current lane progress"');
  });
  test("retained recovery is still held beside a published completed result", () => {
    const item = resource("shared", run.runId); item.observation = retainedObservation(run.runId, 5000, "none");
    item.receivedAt = time(86_400_000); item.publishedRunIds = [run.runId];
    const input = data([item]);
    expect(testFlowItems(input, now).lanes[0]?.state).toBe("recovery");
    const html = renderToStaticMarkup(<TestRunFlow data={input} recentRuns={[run]} recentState="ready" now={now} onResult={() => {}} />);
    expect(html).toContain("Recovery needed"); expect(html).toContain("Open run");
    expect(html).toContain("Finished 1m 0s ago · 2m 0s"); expect(html).toContain("Evidence: incomplete");
  });
  test("a multi-request CI job stays visible when only one request has a lane report", () => {
    const current = job("known", "running"); current.requests.push({ ...current.requests[0]!, requestId: "not-observed" });
    const input = data([resource("shared", "known")], [current]);
    expect(testFlowItems(input, now).other.map(row => row.id)).toEqual(["known"]);
    current.requests.pop(); expect(testFlowItems(input, now).other).toEqual([]);
  });
  test("unavailable feeds never turn cached resources into available lanes", () => {
    const input = data([resource("shared")]); input.resourceObservations!.available = false;
    expect(testFlowItems(input, now).lanes).toEqual([]);
    const html = renderToStaticMarkup(<TestRunFlow data={input} now={now} onResult={() => {}} />);
    expect(html).toContain("Current ownership is unknown"); expect(html).not.toContain(">Available<");
  });
  test("failed recent refresh keeps prior evidence visible and marks it out of date", () => {
    const html = renderToStaticMarkup(<TestRunFlow data={data()} now={now} recentRuns={[run]} recentState="error" onResult={() => {}} />);
    expect(html).toContain("Recent results could not refresh"); expect(html).toContain("captions-phone");
    expect(html).toContain(">failed<"); expect(html).toContain("Fixture: ready"); expect(html).toContain("View result &amp; recording");
  });
});
