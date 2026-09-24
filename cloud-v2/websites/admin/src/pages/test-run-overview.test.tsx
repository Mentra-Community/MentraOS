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
  value.jobs[0]!.claims = [];
  html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp) + 15_000} onResult={() => {}} />);
  expect(html).toContain("GitHub step: Enter the enrolled worker once");
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
