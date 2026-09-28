import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FixFlow } from "../../../../packages/core/src/types/fix-flow.types";
import { failedStepFlow, fixFlowHref, readFixFlowLink } from "../lib/fix-flow-links";
import { filterFixFlowGroups, groupFixFlows, flowCurrentState, FLOW_CURRENT_STATES } from "../lib/fix-flow-groups";
import { FixFlowDetail, FixFlowsPage, FixFlowOverview } from "./fix-flows";
import type { TestRunDetail } from "./test-runs-data";
import { projectFixFlow } from "../../../../packages/core/src/services/fix-flow.service";
import type { StoredTestRun } from "../../../../packages/core/src/services/test-run.service";
import type { TestFailureOccurrence } from "../../../../packages/core/src/types/test-failure.types";

const id = `tfo_${"a".repeat(64)}`;
const flow: FixFlow = {
  occurrenceId: id, runId: "synthetic-notes", routineId: "notes-phone", channel: "dev", build: "dev.synthetic",
  step: { id: "NOTES-08", label: "Expand the note" }, failure: { code: "blank", message: "The note content is blank <script>bad()</script>" },
  startedAt: "2026-09-28T18:00:00Z", updatedAt: "2026-09-28T18:05:00Z", state: "attention", pipelineStage: "review", stage: "Review requested changes",
  nextAction: "Address the review and request another review", activity: "available", agent: { runId: "synthetic-agent", executor: "mini-claude",
    status: "mini_waiting", caseId: `mfc_${"b".repeat(64)}`, anchorRunId: "synthetic-agent", repository: "Mentra-Community/MentraOS", branch: "fix/synthetic", heartbeatAt: null, executionOwner: null },
  incidents: [{ reportId: "rep_synthetic", status: "ready" }], pullRequests: [], timeline: [
    { id: "failure", stage: "test", title: "Routine failed", detail: "Blank note", at: "2026-09-28T18:00:00Z", url: "/?testRun=synthetic-notes&step=NOTES-08" },
    { id: "review", stage: "record-review", title: "Review requested changes", detail: "a".repeat(40), at: null, url: "https://github.com/Mentra-Community/MentraOS/pull/42#pullrequestreview-13" },
  ],
};

describe("Fix flows navigation and recorded states", () => {
  test("exact occurrence links survive authentication return URL encoding", () => {
    const target = fixFlowHref({ occurrenceId: id });
    const auth = new URL(`https://auth.example.test/?return_to=${encodeURIComponent(`https://admin.dev.example.test${target}`)}`);
    expect(readFixFlowLink(new URL(auth.searchParams.get("return_to")!).search)).toEqual({ occurrenceId: id });
    expect(readFixFlowLink(`?fixFlow=${id}&fixFlow=${id}`)).toBeNull();
    expect(readFixFlowLink(`?fixFlow=${id}&fixFlowRun=another&fixStep=step`)).toBeNull();
  });
  test("a step without an occurrence goes to its own pending lookup, never another failure", () => {
    const run = { runId: "synthetic-run", failureOccurrences: [{ occurrenceId: id, failure: { step: { id: "other" } } }] } as TestRunDetail;
    expect(failedStepFlow(run, "NOTES-08")).toEqual({ runId: "synthetic-run", stepId: "NOTES-08" });
    expect(readFixFlowLink(fixFlowHref(failedStepFlow(run, "NOTES-08")).slice(1))).toEqual({ runId: "synthetic-run", stepId: "NOTES-08" });
  });
  test("detail preserves actual review history, incident link and separate recording link", () => {
    const html = renderToStaticMarkup(<FixFlowDetail flow={flow} />);
    expect(html).toContain("Review requested changes"); expect(html).toContain("#pullrequestreview-13");
    expect(html).toContain("/?report=rep_synthetic"); expect(html).toContain("Failed step and recording");
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>bad()");
    expect(html).not.toContain("PR #42 merged");
  });
  test("list puts attention first while completed work stays below it", () => {
    const qc = new QueryClient();
    qc.setQueryData(["admin-fix-flows"], { flows: [flow, { ...flow, occurrenceId: `tfo_${"c".repeat(64)}`, routineId: "finished-routine", state: "completed" }],
      activity: "available", refreshedAt: flow.updatedAt, limited: false });
    const html = renderToStaticMarkup(<QueryClientProvider client={qc}><FixFlowsPage selection={null} onSelect={() => {}} /></QueryClientProvider>);
    expect(html).toContain("notes-phone"); expect(html).toContain("Stopped"); expect(html).toContain("Status unavailable");
    expect(html.indexOf("notes-phone")).toBeLessThan(html.indexOf("finished-routine")); expect(html).toContain("Address the review");
  });
  test("same case and owner groups related failures without losing their exact links", () => {
    const second = { ...flow, occurrenceId: `tfo_${"d".repeat(64)}`, runId: "second-run", agent: { ...flow.agent!,
      runId: "linked-observer", executionOwner: { runId: "synthetic-agent", status: "mini_waiting" } } };
    const replacedOwner = { ...flow, occurrenceId: `tfo_${"e".repeat(64)}`, agent: { ...flow.agent!, runId: "replacement-owner" } };
    const linkedReplacement = { ...flow, occurrenceId: `tfo_${"9".repeat(64)}`, agent: { ...flow.agent!, runId: "replacement-observer",
      executionOwner: { runId: "replacement-owner", status: "mini_waiting" } } };
    const unassigned = { ...flow, occurrenceId: `tfo_${"f".repeat(64)}`, agent: null };
    const data = { flows: [flow, second, replacedOwner, linkedReplacement, unassigned], activity: "available" as const, refreshedAt: flow.updatedAt, limited: false };
    const groups = groupFixFlows(data.flows);
    expect(groups).toHaveLength(3); expect(groups.find(group => group.occurrences.length === 2)?.occurrences).toHaveLength(2);
    expect(groups.find(group => group.occurrences.includes(flow))?.occurrences).toEqual([flow, second]);
    expect(groups.find(group => group.occurrences.includes(replacedOwner))?.occurrences).toEqual([replacedOwner, linkedReplacement]);
    const html = renderToStaticMarkup(<FixFlowOverview data={data} filter={null} onFilter={() => {}} onSelect={() => {}} />);
    expect(html).toContain("3 flows"); expect(html).toContain("5 failures"); expect(html).toContain("2 related failure occurrences");
    for (const item of data.flows) expect(html).toContain(`?fixFlow=${item.occurrenceId}`);
  });
  test("current-state filters count every grouped flow once, including zero nodes and All reset", () => {
    const waiting: FixFlow = { ...flow, occurrenceId: `tfo_${"1".repeat(64)}`, state: "waiting", currentState: "waiting-review", agent: null };
    const data = { flows: [flow, waiting], activity: "available" as const, refreshedAt: flow.updatedAt, limited: false };
    const groups = groupFixFlows(data.flows);
    expect(FLOW_CURRENT_STATES.reduce((total, item) => total + filterFixFlowGroups(groups, { kind: "current", value: item.id }).length, 0)).toBe(groups.length);
    expect(filterFixFlowGroups(groups, { kind: "current", value: "worker-active" })).toEqual([]);
    expect(filterFixFlowGroups(groups, null)).toHaveLength(2);
    const html = renderToStaticMarkup(<FixFlowOverview data={data} filter={{ kind: "current", value: "waiting-review" }} onFilter={() => {}} onSelect={() => {}} />);
    expect(html).toContain('aria-label="Waiting for review: 1 flow groups" aria-pressed="true"');
    expect(html).toContain('aria-label="Merged and verified: 0 flow groups"'); expect(html).toContain("All flows");
    expect(html).not.toContain(`?fixFlow=${flow.occurrenceId}`); expect(html).toContain(`?fixFlow=${waiting.occurrenceId}`);
  });
  test("a completed occurrence cannot hide pending verification or attention in its case group", () => {
    const completed: FixFlow = { ...flow, state: "completed", currentState: "merged", pipelineStage: "merged", updatedAt: "2026-09-28T19:00:00Z" };
    const pending: FixFlow = { ...flow, occurrenceId: `tfo_${"2".repeat(64)}`, state: "waiting", pipelineStage: "verification" };
    const attention: FixFlow = { ...flow, occurrenceId: `tfo_${"3".repeat(64)}`, pipelineStage: "review" };
    const waitingGroups = groupFixFlows([completed, pending]);
    expect(waitingGroups).toHaveLength(1);
    expect(waitingGroups[0]?.status).toBe("waiting"); expect(waitingGroups[0]?.stage).toBe("verification");
    expect(filterFixFlowGroups(waitingGroups, { kind: "stage", value: "merged" })).toHaveLength(0);
    const attentionGroups = groupFixFlows([completed, pending, attention]);
    expect(attentionGroups[0]?.status).toBe("attention"); expect(attentionGroups[0]?.stage).toBe("review");
    const html = renderToStaticMarkup(<FixFlowOverview data={{ flows: [completed, pending, attention], activity: "available", refreshedAt: completed.updatedAt, limited: false }} filter={null} onFilter={() => {}} onSelect={() => {}} />);
    expect(html).toContain("1 flows"); expect(html).toContain("3 failures");
    for (const occurrence of [completed, pending, attention]) expect(html).toContain(`?fixFlow=${occurrence.occurrenceId}`);
    expect(completed.state).toBe("completed"); expect(pending.state).toBe("waiting");
  });
  test("current-state nodes never mix a stopped diagnosis with active work or count duplicates", () => {
    const currentStates = ["worker-active", "stopped", "worker-repair", "waiting-review", "unknown"] as const;
    const rows = currentStates.map((currentState, i): FixFlow => ({ ...flow, currentState, pipelineStage: "investigation",
      occurrenceId: `tfo_${String(i + 1).repeat(64)}`, agent: { ...flow.agent!, runId: `owner-${i}` } }));
    const repeated = { ...rows[0]!, occurrenceId: `tfo_${"6".repeat(64)}` };
    const data = { flows: [...rows, repeated], activity: "available" as const, refreshedAt: flow.updatedAt, limited: false };
    const groups = groupFixFlows(data.flows);
    expect(groups).toHaveLength(5);
    for (const currentState of currentStates) expect(filterFixFlowGroups(groups, { kind: "current", value: currentState })).toHaveLength(1);
    const html = renderToStaticMarkup(<FixFlowOverview data={data} filter={null} onFilter={() => {}} onSelect={() => {}} />);
    for (const label of ["Worker active", "Stopped", "Stopped · worker repair", "Waiting for review", "Status unavailable"])
      expect(html).toContain(`aria-label="${label}: 1 flow groups"`);
    expect(html).toContain("Last recorded progress: Diagnosis");
    expect(html).not.toContain('aria-label="Diagnosis:');
    expect(html).toContain("Stopped or unresolved"); expect(html).toContain("Waiting for a decision or input");
  });
  test("every selected current state explains its meaning above the list even when empty", () => {
    const data = { flows: [flow], activity: "available" as const, refreshedAt: flow.updatedAt, limited: false };
    for (const state of FLOW_CURRENT_STATES) {
      const html = renderToStaticMarkup(<FixFlowOverview data={data} filter={{ kind: "current", value: state.id }} onFilter={() => {}} onSelect={() => {}} />);
      expect(html).toContain(`aria-label="${state.label} meaning"`);
      expect(html).toContain(state.description);
      expect(html.indexOf(state.description)).toBeLessThan(html.indexOf(state.id === "stopped" ? "<article" : "No flow groups match"));
    }
  });
  test("overview, repeated occurrences and detail share the server current-state label", () => {
    for (const state of FLOW_CURRENT_STATES) {
      const row: FixFlow = { ...flow, currentState: state.id, stage: "Investigating", pipelineStage: "investigation" };
      const html = renderToStaticMarkup(<FixFlowDetail flow={row} />);
      expect(html).toContain(state.label); expect(html).toContain(state.description);
      expect(html).not.toContain(">Investigating<");
      expect(flowCurrentState(row)).toBe(state.id);
    }
    for (const state of ["active", "running"] as const) expect(flowCurrentState({ ...flow, state })).toBe("unknown");
  });
  test("legacy broad active responses are unverified, never Running", () => {
    const result = groupFixFlows([{ ...flow, state: "active", pipelineStage: undefined }]);
    expect(result[0]?.status).toBe("unknown"); expect(result[0]?.stage).toBe("unknown");
  });
  test("blocked original and linked triage reach the attention filter with exact grouped counts", () => {
    const stored = { run: { runId: "triage-run", routineId: "notes-phone", channel: "dev", finishedAt: flow.startedAt, release: "dev.synthetic" } } as StoredTestRun;
    const blocked = ["rejected", "linked-owner"].flatMap((state, index) => [false, true].map((linked, member) => {
      const occurrenceId = `tfo_${String(index * 2 + member + 4).repeat(64)}`;
      const owner = `owner-${index}`;
      const occurrence: TestFailureOccurrence = { occurrenceId, revision: 1,
        failure: { phase: "test", step: null, code: state, message: "Synthetic triage outcome", incidentIds: [], assetIds: [], missingEvidence: [], redactionPolicy: "synthetic-reviewed" },
        delivery: { state: "acknowledged", agentRunId: owner, acknowledgedAt: flow.startedAt } };
      const triage = { state, nextAction: "Reconcile the recorded owner." };
      return projectFixFlow(stored, occurrence, { runId: linked ? `observer-${index}` : owner, executor: "mini-claude", environment: "dev", taskKind: "routine-failure",
        status: linked ? "mini_linked" : "awaiting_executor", createdAt: flow.startedAt, updatedAt: flow.updatedAt,
        routineFailure: { intake: { occurrenceId, testRunId: stored.run.runId } }, routineCase: { caseId: `mfc_${String(index).repeat(64)}`, anchorRunId: owner },
        ...(linked ? { executionOwnerRunId: owner, executionOwnerStatus: "awaiting_executor", executionOwnerTriage: triage } : { miniTriage: triage }) }, "available", []);
    }));
    const groups = groupFixFlows(blocked);
    expect(groups).toHaveLength(2); expect(groups.map(group => group.occurrences.length)).toEqual([2, 2]);
    expect(filterFixFlowGroups(groups, { kind: "status", value: "attention" })).toHaveLength(2);
    expect(filterFixFlowGroups(groups, { kind: "status", value: "waiting" })).toHaveLength(0);
    const html = renderToStaticMarkup(<FixFlowOverview data={{ flows: blocked, activity: "available", refreshedAt: flow.updatedAt, limited: false }} filter={{ kind: "status", value: "attention" }} onFilter={() => {}} onSelect={() => {}} />);
    expect(html).toContain("Stopped: 2 flow groups"); expect(html).toContain("4 failures");
    for (const occurrence of blocked) expect(html).toContain(`?fixFlow=${occurrence.occurrenceId}`);
  });
  test("linked occurrence labels its execution owner separately", () => {
    const html = renderToStaticMarkup(<FixFlowDetail flow={{ ...flow, agent: { ...flow.agent!, status: "mini_linked",
      executionOwner: { runId: "case-owner", status: "mini_waiting" } } }} />);
    expect(html).toContain("mini-claude · mini_linked");
    expect(html).toContain("Linked case owner: mini_waiting");
  });
  test("unpublished step gets an explanation and a return link", () => {
    const selection = { runId: "synthetic-notes", stepId: "NOTES-08" };
    const qc = new QueryClient();
    qc.setQueryData(["admin-fix-flow", selection], { pending: true, runId: selection.runId, chapterId: selection.stepId, message: "No structured occurrence yet" });
    const html = renderToStaticMarkup(<QueryClientProvider client={qc}><FixFlowsPage selection={selection} onSelect={() => {}} /></QueryClientProvider>);
    expect(html).toContain("Failure recorded, fix flow pending"); expect(html).toContain("Return to this failed step and recording");
  });
});
