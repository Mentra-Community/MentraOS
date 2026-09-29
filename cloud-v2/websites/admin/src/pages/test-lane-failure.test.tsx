import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FixFlow, FixFlowList } from "../../../../packages/core/src/types/fix-flow.types";
import { noOwnerObservation, retainedObservation } from "../../../../packages/core/src/types/test-resource-observation.examples";
import type { TestRunOverview } from "../../../../packages/core/src/types/test-run-overview.types";
import { laneCard } from "./test-lanes";
import { laneFailureFlows, laneFailureRun } from "./test-lane-failure";
import { TestRunOverviewView } from "./test-run-overview";

const at = "2026-09-29T19:00:00.000Z", now = Date.parse(at), runId = "routine-123-1-dev-no-glasses";
const occurrenceId = `tfo_${"a".repeat(64)}`;
beforeEach(() => setSystemTime(now));
afterEach(() => setSystemTime());
const flow: FixFlow = { occurrenceId, runId, routineId: "no-glasses", channel: "dev", build: "3.3.0-dev.468",
  step: { id: "unpaired-source", label: "Check source" },
  failure: { code: "phase-failed", message: "The lifecycle phase failed before it could complete.", detailUnpublished: true },
  startedAt: at, updatedAt: at, state: "waiting", currentState: "queued", stage: "Awaiting next agent turn", activity: "available",
  nextAction: "The controller has scheduled another agent turn. The earlier stop remains in the recorded history.",
  agent: { runId: "synthetic-agent", executor: "mini-claude", status: "mini_waiting", caseId: "synthetic-case", anchorRunId: "synthetic-agent",
    repository: "Mentra-Community/Mentra-Automated-Testing", branch: "fix/synthetic", heartbeatAt: null, executionOwner: null },
  incidents: [], pullRequests: [], timeline: [{ id: "old-stop", stage: "agent-stop", title: "Earlier access-required stop", detail: null, at, url: null }] };
const feed = (flows = [flow]): FixFlowList => ({ flows, refreshedAt: at, activity: "available", limited: false });
const data = (): TestRunOverview => {
  const observation = noOwnerObservation(runId);
  return { observedAt: at, warnings: [], jobs: [], recentMaintenance: [], resolvedRecoveries: [], fixtureSummary: [],
    resourceObservations: { available: true, truncated: false, items: [{ hostId: "test-mini", resourceKey: "shared", revision: 1,
      receivedAt: at, publishedRunIds: [runId], observation: { ...observation, state: "idle-prerequisite-blocked", reason: "recorded-fixture-recovery-required",
        fixture: { checked: true, record: "valid", fixtureID: "mini-ui", status: "recovery-required", lastRunID: runId } } }] } };
};
const card = (value = data()) => laneCard(value, value.resourceObservations!.items[0]!, now);
const html = (value = data(), flows = feed()) => renderToStaticMarkup(<TestRunOverviewView data={value} fixFlows={flows} now={now} onResult={() => {}} />);

test("an idle recovery lane links the exact reported failure and queued fixer without demanding operator recovery", () => {
  const rendered = html();
  expect(rendered).toContain("Recovery needed"); expect(rendered).toContain("Check source (unpaired-source)");
  expect(rendered).toContain("Detailed cause is not included in this failure summary.");
  expect(rendered).toContain(`href="/?fixFlow=${occurrenceId}"`); expect(rendered).toContain(">Queued</a>");
  expect(rendered).toContain("Automated fixer"); expect(rendered).toContain("The controller has scheduled another agent turn.");
  expect(rendered).toContain("No input request reported."); expect(rendered).not.toContain("Earlier access-required stop");
  const visibleLane = rendered.slice(rendered.indexOf('aria-label="Execution lane'), rendered.indexOf('aria-label="Recently finished runs'));
  expect(visibleLane).not.toContain("Test runner / operator"); expect(visibleLane).not.toContain("Recover the fixture");
  expect(visibleLane).toContain("Fixture recovery remains unverified"); expect(visibleLane).not.toContain("found 0");
});

test("reported concrete errors are shown verbatim without being inferred from fixture state", () => {
  const rendered = html(data(), feed([{ ...flow, failure: { code: "app-not-running", message: "Expected one running com.mentra.mentra process, found 0" } }]));
  expect(rendered).toContain("Expected one running com.mentra.mentra process, found 0");
  expect(rendered).not.toContain("Detailed cause is not included");
});

test("current investigation, fix, test and review phases retain their verified actor and next action", () => {
  for (const currentState of ["investigating", "fixing", "testing", "reviewing"] as const) {
    const rendered = html(data(), feed([{ ...flow, state: "running", currentState, nextAction: `Current ${currentState} action` }]));
    expect(rendered).toContain("Responsible:</strong> Automated fixer");
    expect(rendered).toContain(`Current ${currentState} action`);
    expect(rendered).toContain("No input request reported.");
    expect(rendered).not.toContain("Status unavailable");
  }
});

test("a published run without a matching occurrence keeps the recorded fixture recovery guidance", () => {
  for (const response of [undefined, feed([]), { ...feed([]), activity: "unavailable" as const },
    { ...feed([]), limited: true }, feed([{ ...flow, runId: "other-run" }])]) {
    const rendered = renderToStaticMarkup(<TestRunOverviewView data={data()} fixFlows={response} now={now} onResult={() => {}} />);
    expect(rendered).toContain("Test runner / operator");
    expect(rendered).toContain("Recover the fixture and publish verified return evidence before routines use it.");
    expect(rendered).toContain("Responsible party and input needs are unconfirmed.");
    expect(rendered).not.toContain("No input request reported.");
  }
});

test("responses arriving between page timer ticks remain current at render time", () => {
  for (const tick of [0, 1000, 15_000]) {
    const response = { ...feed(), refreshedAt: new Date(now + tick + 500).toISOString() };
    setSystemTime(now + tick + 750);
    // The parent retains its previous timer sample while the query response triggers a render.
    const rendered = renderToStaticMarkup(<TestRunOverviewView data={data()} fixFlows={response}
      now={now + tick} onResult={() => {}} />);
    expect(rendered).toContain(">Queued</a>");
    expect(rendered).toContain("No input request reported.");
    expect(rendered).not.toContain(">Status unavailable</a>");
  }
  setSystemTime(now + 120_501);
  const old = { ...feed(), refreshedAt: new Date(now + 500).toISOString() };
  expect(html(data(), old)).toContain(">Status unavailable</a>");
  setSystemTime(now + 750);
  expect(html(data(), { ...old, activity: "unavailable" })).toContain(">Status unavailable</a>");
});

test("only the exact published last-run or retained owner joins; fixture aliases and older runs never do", () => {
  expect(laneFailureFlows(card(), feed([{ ...flow, runId: "another-run" }]), now)).toEqual([]);
  expect(laneFailureFlows(card(), feed([{ ...flow, occurrenceId: null }]), now)).toEqual([]);
  const unpublished = data(); unpublished.resourceObservations!.items[0]!.publishedRunIds = [];
  expect(laneFailureRun(card(unpublished))).toBeUndefined();
  const held = data(); held.resourceObservations!.items[0]!.observation = retainedObservation("other-owner", 100, "none");
  expect(laneFailureRun(card(held))).toBeUndefined();
  held.resourceObservations!.items[0]!.publishedRunIds.push("other-owner");
  expect(laneFailureRun(card(held))).toBe("other-owner");
  expect(laneFailureFlows(card(held), feed(), now)).toEqual([]);
  const invalid = data(); invalid.resourceObservations!.items[0]!.observation.owner = { valid: false };
  expect(laneFailureRun(card(invalid))).toBeUndefined();
});

test("stale host reports and available lanes never borrow a historical failure as their current blocker", () => {
  const stale = data(); stale.resourceObservations!.items[0]!.receivedAt = "2026-09-29T18:00:00.000Z";
  expect(laneFailureRun(card(stale))).toBeUndefined();
  const ready = data(); ready.resourceObservations!.items[0]!.observation = noOwnerObservation(runId);
  expect(laneFailureRun(card(ready))).toBeUndefined();
});

test("a stale, failed or unmatched fixer read keeps historical evidence but cannot claim an actor or input status", () => {
  for (const unavailable of [{ ...feed(), refreshedAt: "2026-09-29T18:00:00.000Z" }, { ...feed(), activity: "unavailable" as const },
    feed([{ ...flow, activity: "unmatched" }])]) {
    expect(laneFailureFlows(card(), unavailable, now)[0]!.currentState).toBe("unknown");
    const rendered = html(data(), unavailable);
    expect(rendered).toContain("Check source (unpaired-source)"); expect(rendered).toContain(">Status unavailable</a>");
    expect(rendered).toContain("Unconfirmed"); expect(rendered).not.toContain("No input request reported.");
    expect(rendered).not.toContain("The controller has scheduled another agent turn.");
  }
  expect(html(data(), { ...feed([]), limited: true })).toContain("No fix flow for this exact run was found in the current view.");
});

test("stopped is not waiting for user input; only the typed waiting-input state reports a request", () => {
  const stopped = html(data(), feed([{ ...flow, currentState: "stopped", nextAction: "Inspect the checkpoint validation error." }]));
  expect(stopped).toContain("Inspect the checkpoint validation error."); expect(stopped).toContain("Your input:</strong> Unconfirmed");
  expect(stopped).not.toContain("Requested respondent");
  const input = html(data(), feed([{ ...flow, currentState: "waiting-input", nextAction: "Answer the recorded question." }]));
  expect(input).toContain("Requested respondent"); expect(input).toContain("Requested — open the fix flow for the question.");
  const merge = html(data(), feed([{ ...flow, currentState: "waiting-merge" }]));
  expect(merge).toContain("A merge decision is needed"); expect(merge).not.toContain("No input request reported.");
});

test("a merged fix never turns a recovery-required lane into available or removes the return requirement", () => {
  const rendered = html(data(), feed([{ ...flow, currentState: "merged", nextAction: "The fix was verified." }]));
  expect(rendered).toContain("Recovery needed"); expect(rendered).toContain("Fixture recovery remains unverified");
  expect(rendered).not.toContain(">Available</span>");
});

test("multiple exact occurrences retain separate links and actions rather than picking a convenient cause", () => {
  const second = { ...flow, occurrenceId: `tfo_${"b".repeat(64)}`, step: { id: "return-home", label: "Return Home" }, currentState: "stopped" as const,
    nextAction: "Inspect this return failure." };
  const rendered = html(data(), feed([flow, second]));
  expect(rendered).toContain(`/?fixFlow=${second.occurrenceId}`); expect(rendered).toContain(`/?fixFlow=${occurrenceId}`);
  expect(rendered).toContain("Inspect this return failure."); expect(rendered).toContain("No input request reported.");
});
