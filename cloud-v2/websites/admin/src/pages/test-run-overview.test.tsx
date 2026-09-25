import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TestRunOverview } from "../../../../packages/core/src/types/test-run-overview.types";
import { elapsed, TestRunOverviewView } from "./test-run-overview";

const stamp = "2026-09-24T20:00:00.000Z";
const data = (): TestRunOverview => ({ observedAt: stamp, warnings: [], resolvedRecoveries: [], recentMaintenance: [], jobs: [{
  id: "synthetic", title: "Routine", kind: "routine", state: "running", createdAt: stamp, startedAt: stamp,
  requests: [{ requestId: "request-1", requestRunId: 500, requestAttempt: 1, routineId: "no-glasses-android", channel: "dev",
    trigger: "successful-build", platform: "android", release: "3.3.0-dev.351" }], workerName: "Mini-1", claims: [{ requestId: "request-1", workerId: "mini", fixtureId: "samsung-phone-only", claimedAt: stamp,
    progress: { sequence: 22, mode: "running", phase: "test", step: { id: "walkthrough", label: "Walk through app" },
      completedSteps: 0, totalSteps: 1, receivedAt: stamp,
      action: { id: "open-settings", label: "Open Settings", completedActions: 7, totalActions: null } } }],
  workflow: { runId: 10, url: "https://github.com/Mentra-Community/Mentra-Automated-Testing/actions/runs/10", status: "in_progress", step: "Enter the enrolled worker once", updatedAt: stamp },
}] });
test("shows the actual reported action and distinguishes phase counts from an unknown action total", () => {
  const html = renderToStaticMarkup(<TestRunOverviewView data={data()} now={Date.parse(stamp) + 180_000} onResult={() => {}} />);
  expect(html).toContain("Open Settings"); expect(html).toContain("Testing");
  expect(html).not.toContain("Lifecycle steps");
  expect(html).toContain("7 actions completed; total unknown");
  expect(html).toContain("No recent checkpoint; activity is unconfirmed");
  expect(html).toContain("GitHub step: Enter the enrolled worker once");
  expect(html).toContain("samsung-phone-only"); expect(html).toContain("Android · Automatic build");
  expect(html).not.toContain("% complete");
});
test("fresh action progress is concise, while workflow details remain a fallback", () => {
  const value = data();
  value.jobs[0]!.claims[0]!.progress!.action!.totalActions = 38;
  let html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp) + 15_000} onResult={() => {}} />);
  expect(html).toContain("7 of 38 actions completed"); expect(html).toContain("Testing");
  expect(html).not.toContain("Lifecycle steps"); expect(html).not.toContain("GitHub step:");
  value.jobs[0]!.claims[0]!.progress!.action = null;
  html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp) + 15_000} onResult={() => {}} />);
  expect(html).toContain("Lifecycle steps 0/1 in this phase");
  value.jobs[0]!.claims[0]!.progress!.mode = "complete";
  html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp) + 15_000} onResult={() => {}} />);
  expect(html).toContain("GitHub step: Enter the enrolled worker once");
  value.jobs[0]!.claims = [];
  html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp) + 15_000} onResult={() => {}} />);
  expect(html).toContain("GitHub step: Enter the enrolled worker once");
});
test("a completed first nightly member cannot hide the next member's workflow step", () => {
  const value = data();
  const job = value.jobs[0]!;
  job.kind = "nightly";
  job.claims[0]!.progress!.mode = "complete";
  job.requests.push({...job.requests[0]!, requestId: "request-2", routineId: "mentra-call"});
  job.workflow!.step = "Run the requested Call routine";
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp) + 15_000} onResult={() => {}} />);
  expect(html).toContain("Completed checkpoint");
  expect(html).toContain("GitHub step: Run the requested Call routine");
});
test("missing progress and partial outages never render an empty-success message", () => {
  const value = data(); value.jobs[0]!.claims = [];
  let html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} />);
  expect(html).toContain("No routine checkpoint reported.");
  value.jobs = []; value.warnings = ["GitHub unavailable"];
  html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} />);
  expect(html).toContain("No activity could be confirmed"); expect(html).not.toContain("No active jobs or unresolved claims");
});
test("maintenance failures are separate from routine verdicts, with original/recovery links preserved", () => {
  const value = data(); value.jobs = [];
  value.recentMaintenance = [{ ...data().jobs[0]!, kind: "maintenance", state: "finished", workflow: { ...data().jobs[0]!.workflow!, conclusion: "failure" } }];
  value.resolvedRecoveries = [{ requestId: "request-1", fixtureId: "03BE", originalRunId: "original", recoveryRunId: "recovery-2" }];
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} />);
  expect(html).toContain("host job outcomes, not routine test verdicts"); expect(html).toContain("failure");
  expect(html).toContain("Original result"); expect(html).toContain("Recovery result");
  expect(elapsed(stamp, Date.parse(stamp) + 61_000)).toBe("1m 1s");
});
test("blocked work names a reason, responsible role and next action without pretending user input is required", () => {
  const value = data(); value.jobs[0]!.state = "blocked";
  value.jobs[0]!.attention = { reason: "Cleanup did not pass.", responsible: "Test runner / operator",
    nextAction: "Publish verified return evidence.", cancelRequestId: "request-1" };
  value.jobs[0]!.resultRunId = "original";
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} onCancel={async () => {}} />);
  expect(html).toContain("Cleanup did not pass."); expect(html).toContain("Responsible: Test runner / operator");
  expect(html).toContain("Next: Publish verified return evidence."); expect(html).toContain("Cancel further work");
  expect(html).toContain("Recorded result"); expect(html).not.toContain("Waiting for user");
});
test("cancelled work is absent from live job counts while physical readiness has a separate section", () => {
  const value = data(); value.fixtureAttention = [{ ...value.jobs[0]!, kind: "fixture", state: "blocked", attention: {
    reason: "Physical return remains unverified.", responsible: "Test runner / operator", nextAction: "Recover the fixture.", cancelledAt: stamp } }];
  value.jobs = [];
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} onCancel={async () => {}} />);
  expect(html).toContain("<strong>0</strong> blocked"); expect(html).toContain("Fixture readiness after cancelled follow-up");
  expect(html).toContain("Cancelled attempt history (1)"); expect(html).toContain("not running jobs");
  // An older Core response without summaries is shown as unverified, never as ready.
  expect(html).toContain("cannot prove the fixture&#x27;s present state"); expect(html).not.toContain("Cancel further work");
  expect(html).toContain("No active jobs. Fixture readiness below is unverified.");
  expect(html).not.toContain("No active jobs or unresolved claims");
});
test("late export and missing original recovery links describe only evidence that actually exists", () => {
  const value = data(); value.jobs = []; value.resolvedRecoveries = [
    { requestId: "request-1", originalRunId: "request-1", recoveryRunId: "request-1", fixtureId: "phone", kind: "late-result", originalAvailable: true },
    { requestId: "request-2", originalRunId: "request-2", recoveryRunId: "recovery-5", fixtureId: "03BE", kind: "recovery", originalAvailable: false },
  ];
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} />);
  expect(html).toContain("Completed result"); expect(html).toContain("Original result not published");
  expect(html).toContain("Recovery result"); expect(html).not.toContain(">Original result</button>");
});

test("repeated cancelled attempts collapse into one row per worker/fixture while every attempt stays in history", () => {
  const value = data(); const live = value.jobs[0]!;
  live.state = "blocked"; live.claims[0] = { ...live.claims[0]!, requestId: "current", workerId: "mini-1", fixtureId: "mini-ui-unpaired" };
  const attempt = (id: string, workerId: string, fixtureId: string) => ({ ...data().jobs[0]!, id: "claim-" + id, kind: "fixture" as const,
    state: "blocked" as const, resultRunId: "original-" + id, workflow: undefined,
    requests: [{ ...data().jobs[0]!.requests[0]!, requestId: id, routineId: "day1-ota-" + id }],
    claims: [{ requestId: id, workerId, fixtureId, claimedAt: stamp }],
    attention: { reason: "Cleanup did not pass; physical return is unverified.", responsible: "Test runner / operator" as const,
      nextAction: "Complete recovery for this request and publish its verified return evidence.", cancelledAt: stamp } });
  value.fixtureAttention = [attempt("a1", "mini-1", "glasses-03be"), attempt("a2", "mini-1", "glasses-03be"),
    attempt("a3", "mini-1", "glasses-03be"), attempt("a4", "mini-1", "glasses-03be"),
    attempt("u1", "mini-1", "mini-ui-unpaired"), attempt("u2", "mini-1", "mini-ui-unpaired"), attempt("o1", "mini-2", "glasses-03be")];
  value.fixtureSummary = [
    { workerId: "mini-1", fixtureId: "mini-ui-unpaired", status: "current-work", cancelledRequestIds: ["u2", "u1"], latestCancelledClaimAt: stamp, currentRequestIds: ["current"] },
    { workerId: "mini-2", fixtureId: "glasses-03be", status: "unverified", cancelledRequestIds: ["o1"], latestCancelledClaimAt: stamp },
    { workerId: "mini-1", fixtureId: "glasses-03be", status: "later-return-verified", cancelledRequestIds: ["a4", "a3", "a2", "a1"], latestCancelledClaimAt: stamp,
      laterReturn: { requestId: "verified", claimedAt: stamp, recoveryRunId: "recovery-53ef-3" } },
  ];
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} />);
  const section = html.slice(html.indexOf("Fixture readiness after cancelled follow-up"));
  const [summary, history] = section.split("Cancelled attempt history");
  // One compact row per worker/fixture; no per-attempt blocked wall or per-request recovery instruction.
  expect(summary!.match(/<tr class="border-t/g)).toHaveLength(3);
  expect(summary).not.toContain(">blocked<"); expect(section).not.toContain("Complete recovery for this request");
  expect(summary).toContain("<strong>1</strong> current work"); expect(summary).toContain("<strong>1</strong> unverified");
  expect(summary).toContain("<strong>1</strong> returned later");
  expect(summary).toContain("4 cancelled attempts without their own verified return");
  expect(summary).toContain("Newer work on this fixture is in Live activity: current.");
  expect(summary).toContain("verified, published verified return evidence"); expect(summary).toContain("Return result");
  expect(summary).toContain("No recovery is needed for these cancelled attempts. Activity after that return is not checked here.");
  expect(summary).toContain("cannot prove the fixture&#x27;s present state");
  // The live blocker remains in the main table, and all original attempts and result links are retained.
  expect(html).toContain("<strong>1</strong> blocked");
  expect(history).toContain("(7)");
  for (const id of ["a1", "a2", "a3", "a4", "u1", "u2", "o1"]) expect(history).toContain("day1-ota-" + id);
  expect(history!.match(/Recorded result/g)).toHaveLength(7);
  expect(history).toContain("Cleanup did not pass; physical return is unverified.");
});
