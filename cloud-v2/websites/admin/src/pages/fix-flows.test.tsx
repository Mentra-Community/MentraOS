import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FixFlow } from "../../../../packages/core/src/types/fix-flow.types";
import { failedStepFlow, fixFlowHref, readFixFlowLink } from "../lib/fix-flow-links";
import { filterFixFlowGroups, groupFixFlows, FLOW_STAGES, FLOW_STATUSES } from "../lib/fix-flow-groups";
import { FixFlowDetail, FixFlowsPage, FixFlowOverview } from "./fix-flows";
import type { TestRunDetail } from "./test-runs-data";

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
    expect(html).toContain("notes-phone"); expect(html).toContain("Needs attention"); expect(html).toContain("Completed");
    expect(html.indexOf("notes-phone")).toBeLessThan(html.indexOf("finished-routine")); expect(html).toContain("Address the review");
  });
  test("same case and owner groups related failures without losing their exact links", () => {
    const second = { ...flow, occurrenceId: `tfo_${"d".repeat(64)}`, runId: "second-run", agent: { ...flow.agent!,
      runId: "linked-observer", executionOwner: { runId: "synthetic-agent", status: "mini_waiting" } } };
    const replacedOwner = { ...flow, occurrenceId: `tfo_${"e".repeat(64)}`, agent: { ...flow.agent!, anchorRunId: "replacement-owner" } };
    const unassigned = { ...flow, occurrenceId: `tfo_${"f".repeat(64)}`, agent: null };
    const data = { flows: [flow, second, replacedOwner, unassigned], activity: "available" as const, refreshedAt: flow.updatedAt, limited: false };
    const groups = groupFixFlows(data.flows);
    expect(groups).toHaveLength(3); expect(groups.find(group => group.occurrences.length === 2)?.occurrences).toHaveLength(2);
    const html = renderToStaticMarkup(<FixFlowOverview data={data} filter={null} onFilter={() => {}} onSelect={() => {}} />);
    expect(html).toContain("3 flows"); expect(html).toContain("4 failures"); expect(html).toContain("2 related failure occurrences");
    for (const item of data.flows) expect(html).toContain(`?fixFlow=${item.occurrenceId}`);
  });
  test("pipeline and status filters have exact grouped counts, including zero and All reset", () => {
    const waiting = { ...flow, occurrenceId: `tfo_${"1".repeat(64)}`, state: "waiting" as const, pipelineStage: "intake" as const, agent: null };
    const data = { flows: [flow, waiting], activity: "available" as const, refreshedAt: flow.updatedAt, limited: false };
    const groups = groupFixFlows(data.flows);
    expect(FLOW_STAGES.reduce((total, item) => total + filterFixFlowGroups(groups, { kind: "stage", value: item.id }).length, 0)).toBe(groups.length);
    expect(FLOW_STATUSES.reduce((total, item) => total + filterFixFlowGroups(groups, { kind: "status", value: item.id }).length, 0)).toBe(groups.length);
    expect(filterFixFlowGroups(groups, { kind: "status", value: "running" })).toEqual([]);
    expect(filterFixFlowGroups(groups, null)).toHaveLength(2);
    const html = renderToStaticMarkup(<FixFlowOverview data={data} filter={{ kind: "stage", value: "review" }} onFilter={() => {}} onSelect={() => {}} />);
    expect(html).toContain('aria-label="PR / review: 1 flow groups" aria-pressed="true"');
    expect(html).toContain('aria-label="Merged: 0 flow groups"'); expect(html).toContain("All flows");
    expect(html).toContain(`?fixFlow=${flow.occurrenceId}`); expect(html).not.toContain(`?fixFlow=${waiting.occurrenceId}`);
  });
  test("a completed occurrence cannot hide pending verification or attention in its case group", () => {
    const completed: FixFlow = { ...flow, state: "completed", pipelineStage: "merged", updatedAt: "2026-09-28T19:00:00Z" };
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
  test("legacy broad active responses are unverified, never Running", () => {
    const result = groupFixFlows([{ ...flow, state: "active", pipelineStage: undefined }]);
    expect(result[0]?.status).toBe("unknown"); expect(result[0]?.stage).toBe("unknown");
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
