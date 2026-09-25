import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TestRunOverview } from "../../../../packages/core/src/types/test-run-overview.types";
import { elapsed, TestRunOverviewView } from "./test-run-overview";

const stamp = "2026-09-24T20:00:00.000Z";
const data = (): TestRunOverview => ({ observedAt: stamp, warnings: [], resolvedRecoveries: [], recentMaintenance: [], fixtureSummary: [], jobs: [{
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
  expect(html).toContain("<strong>0</strong> blocked"); expect(html).toContain("Fixture readiness after resolved follow-up");
  expect(html).toContain("Resolved follow-up history (1)"); expect(html).toContain("keep their original results");
  // Without a Core summary, nothing is presented as ready.
  expect(html).toContain("Fixture readiness was not reported by Core. Treat these fixtures as unverified.");
  expect(html).not.toContain("Cancel further work"); expect(html).not.toContain(">returned<");
  expect(html).toContain("No active jobs. Some fixture readiness below is not verified.");
  expect(html).not.toContain("No active jobs or unresolved claims");
});
test("a closed claim is history with its failed result and uncommissioned fixture, not a live block or pass", () => {
  const value = data(); value.fixtureAttention = [{ ...value.jobs[0]!, kind: "fixture", state: "finished", title: "Closed without a test",
    resultRunId: "request-1", attention: { reason: "Android refused the selected app update.", responsible: "Test runner / operator",
      nextAction: "Commission this fixture before another request.", closedAt: stamp } }];
  value.fixtureSummary = [{ workerId: "mini-1", fixtureId: "phone", cancelledRequestIds: ["request-1"], latestCancelledClaimAt: stamp, status: "unverified" }];
  value.jobs = [];
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} onCancel={async () => {}} />);
  expect(html).toContain("<strong>0</strong> blocked"); expect(html).toContain("Closed by its original worker 0s ago; no test ran and the fixture was left uncommissioned");
  expect(html).toContain("Recorded result"); expect(html).toContain(">unverified<"); expect(html).not.toContain(">returned<");
  expect(html).not.toContain("Cancel further work"); expect(html).toContain("No active jobs. Some fixture readiness below is not verified.");
});
test("shared history names cancelled and owner-closed requests neutrally while each entry keeps its own resolution", () => {
  const value = data(); const base = value.jobs[0]!;
  const entry = (id: string, attention: NonNullable<typeof base.attention>) => ({ ...base, id: "claim-" + id, kind: "fixture" as const,
    state: "finished" as const, workflow: undefined, resultRunId: "original-" + id,
    requests: [{ ...base.requests[0]!, requestId: id, routineId: "no-glasses-" + id }],
    claims: [{ requestId: id, workerId: "mini-1", fixtureId: "phone", claimedAt: stamp }], attention });
  value.fixtureAttention = [
    entry("cancelled", { reason: "Physical return remains unverified.", responsible: "Test runner / operator", nextAction: "Recover the fixture.", cancelledAt: stamp }),
    entry("closed", { reason: "Android refused the selected app update.", responsible: "Test runner / operator",
      nextAction: "Commission this fixture before another request.", closedAt: stamp }),
  ];
  value.fixtureSummary = [{ workerId: "mini-1", fixtureId: "phone", cancelledRequestIds: ["closed", "cancelled"], latestCancelledClaimAt: stamp, status: "unverified" }];
  value.jobs = [];
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} />);
  expect(html).not.toMatch(/cancelled attempt/i);
  expect(html).toContain("Fixture readiness after resolved follow-up"); expect(html).toContain("Cancelled and closed requests keep their original results.");
  expect(html).toContain("2 resolved requests before it"); expect(html).toContain("No newer claim on this worker and fixture since the newest resolved request.");
  expect(html).toContain("No active jobs. Some fixture readiness below is not verified.");
  const history = html.slice(html.indexOf("Resolved follow-up history (2)"));
  const [cancelled, closed] = history.split("no-glasses-closed");
  expect(cancelled).toContain("no-glasses-cancelled"); expect(cancelled).toContain("Follow-up cancelled 0s ago"); expect(cancelled).not.toContain("Closed by its original worker");
  expect(closed).toContain("Closed by its original worker 0s ago; no test ran and the fixture was left uncommissioned"); expect(closed).not.toContain("Follow-up cancelled");
  expect(history.match(/Recorded result/g)).toHaveLength(2);
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

test("one readiness row per worker/fixture shows its newest claim; every cancelled attempt stays in history", () => {
  const value = data(); const live = value.jobs[0]!;
  live.state = "blocked"; live.claims[0] = { ...live.claims[0]!, requestId: "phone-active", workerId: "mini-1", fixtureId: "android-phone" };
  const attempt = (id: string, workerId: string, fixtureId: string) => ({ ...data().jobs[0]!, id: "claim-" + id, kind: "fixture" as const,
    state: "blocked" as const, resultRunId: "original-" + id, workflow: undefined,
    requests: [{ ...data().jobs[0]!.requests[0]!, requestId: id, routineId: "no-glasses-" + id }],
    claims: [{ requestId: id, workerId, fixtureId, claimedAt: stamp }],
    attention: { reason: "Cleanup did not pass; physical return is unverified.", responsible: "Test runner / operator" as const,
      nextAction: "Complete recovery for this request and publish its verified return evidence.", cancelledAt: stamp } });
  value.fixtureAttention = [attempt("u1", "mini-1", "mini-ui-unpaired"), attempt("u2", "mini-1", "mini-ui-unpaired"),
    attempt("u3", "mini-1", "mini-ui-unpaired"), attempt("g1", "mini-1", "glasses-03be"), attempt("o1", "mini-2", "mini-ui-unpaired"),
    attempt("p1", "mini-1", "android-phone"), attempt("t1", "mini-1", "tablet")];
  const later = new Date(Date.parse(stamp) + 3_600_000).toISOString();
  value.fixtureSummary = [
    { workerId: "mini-1", fixtureId: "android-phone", status: "current-work", cancelledRequestIds: ["p1"], latestCancelledClaimAt: stamp,
      latest: { requestId: "phone-active", claimedAt: later, reason: "This newer claim still owns the fixture; follow it in Live activity." } },
    { workerId: "mini-1", fixtureId: "tablet", status: "not-checked", cancelledRequestIds: ["t1"], latestCancelledClaimAt: stamp },
    { workerId: "mini-1", fixtureId: "glasses-03be", status: "unverified", cancelledRequestIds: ["g1"], latestCancelledClaimAt: stamp,
      latest: { requestId: "glasses-failure", claimedAt: later, reason: "The recorded run left the fixture unavailable.", resultRunId: "glasses-failure" } },
    { workerId: "mini-2", fixtureId: "mini-ui-unpaired", status: "unverified", cancelledRequestIds: ["o1"], latestCancelledClaimAt: stamp },
    { workerId: "mini-1", fixtureId: "mini-ui-unpaired", status: "latest-return-verified", cancelledRequestIds: ["u3", "u2", "u1"], latestCancelledClaimAt: stamp,
      latest: { requestId: "routine-36080522386-1-dev-no-glasses", claimedAt: later, reason: "Verified return evidence is published.",
        resultRunId: "routine-36080522386-1-dev-no-glasses" } },
  ];
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(later) + 60_000} onResult={() => {}} />);
  const section = html.slice(html.indexOf("Fixture readiness after resolved follow-up"));
  const [summary, history] = section.split("Resolved follow-up history");
  // One compact row per worker/fixture; no per-attempt blocked wall or per-request recovery instruction.
  expect(summary!.match(/<tr class="border-t/g)).toHaveLength(5);
  expect(summary).not.toContain(">blocked<"); expect(section).not.toContain("Complete recovery for this request");
  for (const [count, badge] of [[1, "in use"], [1, "not checked"], [2, "unverified"], [1, "returned"]] as const)
    expect(summary).toContain("<strong>" + count + "</strong> " + badge + "</span>");
  expect(summary).toContain("Latest claim routine-36080522386-1-dev-no-glasses, 1m 0s ago: cleanup and return were verified.");
  expect(summary).toContain("3 resolved requests before it");
  expect(summary).toContain("No recovery is needed for the resolved requests. Use outside routine claims is not observed.");
  expect(summary).toContain("Latest claim glasses-failure, 1m 0s ago: The recorded run left the fixture unavailable.");
  expect(summary).toContain("Latest claim phone-active, 1m 0s ago: This newer claim still owns the fixture");
  expect(summary).toContain("Newer claims on this worker and fixture could not be checked.");
  expect(summary).toContain("No newer claim on this worker and fixture since the newest resolved request.");
  expect(summary!.match(/>Result<\/button>/g)).toHaveLength(2);
  // The live blocker remains in the main table, and all original attempts and result links are retained.
  expect(html).toContain("<strong>1</strong> blocked");
  expect(history).toContain("(7)");
  for (const id of ["u1", "u2", "u3", "g1", "o1", "p1", "t1"]) expect(history).toContain("no-glasses-" + id);
  expect(history!.match(/Recorded result/g)).toHaveLength(7);
  expect(history).toContain("Cleanup did not pass; physical return is unverified.");
});
