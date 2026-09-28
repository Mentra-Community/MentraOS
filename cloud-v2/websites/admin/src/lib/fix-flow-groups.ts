import type { FixFlow, FixFlowCurrentState } from "../../../../packages/core/src/types/fix-flow.types";

export const FLOW_STATUSES = [
  { id: "attention", label: "Needs attention" }, { id: "running", label: "Running" },
  { id: "waiting", label: "Waiting" }, { id: "unknown", label: "Status unavailable" }, { id: "completed", label: "Completed" },
] as const;
export const FLOW_STAGES = [
  { id: "intake", label: "Failure / intake" }, { id: "investigation", label: "Diagnosis" },
  { id: "fix", label: "Implement fix" }, { id: "review", label: "PR / review" },
  { id: "verification", label: "Test / rerun" }, { id: "merged", label: "Merged" },
  { id: "closed", label: "Closed without fix" }, { id: "unknown", label: "Unavailable" },
] as const;
export const FLOW_CURRENT_STATES = [
  { id: "queued", label: "Queued", branch: "main", description: "The failure is waiting for a worker. It starts when a worker becomes available and takes the job." },
  { id: "worker-active", label: "Worker active", branch: "main", description: "The worker is processing this failure. Its exact task is not currently reported." },
  { id: "waiting-review", label: "Waiting for review", branch: "main", description: "The agent is waiting for a review result. It continues when that result is recorded." },
  { id: "waiting-build", label: "Waiting for build", branch: "main", description: "The agent is waiting for build output. Open the linked build or PR for progress." },
  { id: "waiting-routine", label: "Waiting for rerun", branch: "main", description: "The agent is waiting for a routine rerun to verify this failure. It continues when the result is recorded." },
  { id: "merged", label: "Merged and verified", branch: "main", description: "The fix PR has merged and a rerun has verified this failure. A merged PR alone remains waiting for a rerun." },
  { id: "waiting-merge", label: "Waiting for merge decision", branch: "waiting", description: "The agent has handed the fix over for a merge decision. It continues after that decision is recorded." },
  { id: "waiting-input", label: "Waiting for input", branch: "waiting", description: "The agent needs an answer before it can continue. The question and response action should appear in the flow details." },
  { id: "stopped", label: "Stopped", branch: "stopped", description: "The agent stopped before finishing. Open the flow for the recorded reason and next action." },
  { id: "worker-repair", label: "Stopped · worker repair", branch: "stopped", description: "Work cannot continue because the worker encountered a problem. Open the flow for the error and next action." },
  { id: "closed", label: "Closed without fix", branch: "stopped", description: "The case was cancelled or closed without a fix. This does not mean the original routine passed." },
  { id: "unknown", label: "Status unavailable", branch: "stopped", description: "Current worker activity is unavailable. Refresh to check again; earlier progress does not mean work is running." },
] as const satisfies ReadonlyArray<{ id: FixFlowCurrentState; label: string; branch: string; description: string }>;
export const flowCurrentState = (flow: FixFlow): FixFlowCurrentState => {
  if (flow.currentState && FLOW_CURRENT_STATES.some(item => item.id === flow.currentState)) return flow.currentState;
  // Older Core responses can establish a broad stop or wait, never current execution or a verified fix.
  if (flow.state === "attention") return "stopped";
  if (flow.state === "waiting") return "queued";
  if (flow.state === "completed" && flow.pipelineStage === "closed") return "closed";
  return "unknown";
};
export const currentStateInfo = (flow: FixFlow) => FLOW_CURRENT_STATES.find(item => item.id === flowCurrentState(flow))!;
export type FlowStatus = typeof FLOW_STATUSES[number]["id"];
export type FlowStage = typeof FLOW_STAGES[number]["id"];
export type FlowFilter = { kind: "current"; value: FixFlowCurrentState } | { kind: "status"; value: FlowStatus } | { kind: "stage"; value: FlowStage } | null;
export interface FixFlowGroup { key: string; flow: FixFlow; occurrences: FixFlow[]; status: FlowStatus; stage: FlowStage; currentState: FixFlowCurrentState }
const rank = Object.fromEntries(FLOW_STATUSES.map((status, index) => [status.id, index]));
// An older Core's broad `active` enum is never evidence of a running worker.
export const flowStatus = (flow: FixFlow): FlowStatus => {
  const current = flowCurrentState(flow);
  return current === "worker-active" ? "running" : ["stopped", "worker-repair", "waiting-input"].includes(current) ? "attention"
    : ["merged", "closed"].includes(current) ? "completed" : current === "unknown" ? "unknown" : "waiting";
};
export const flowStage = (flow: FixFlow): FlowStage => flow.pipelineStage ?? "unknown";

export function groupFixFlows(flows: FixFlow[]): FixFlowGroup[] {
  const groups = new Map<string, FixFlow[]>();
  for (const flow of flows) {
    const owner = flow.agent?.executionOwner?.runId ?? flow.agent?.runId;
    // Own rows are acknowledged to their runId; anchorRunId is the case founder, not a replacement worker.
    const key = flow.occurrenceId && flow.agent?.caseId && owner ? `case:${flow.agent.caseId}:${owner}`
      : `occurrence:${flow.occurrenceId ?? `${flow.runId}:${flow.step?.id ?? flow.failure.code}`}`;
    groups.set(key, [...groups.get(key) ?? [], flow]);
  }
  return [...groups].map(([key, occurrences]) => {
    // Any unresolved occurrence keeps its group prominent; every individual state remains expandable.
    occurrences.sort((a, b) => rank[flowStatus(a)]! - rank[flowStatus(b)]! || b.updatedAt.localeCompare(a.updatedAt));
    const flow = occurrences[0]!;
    return { key, flow, occurrences, status: flowStatus(flow), stage: flowStage(flow), currentState: flowCurrentState(flow) };
  }).sort((a, b) => rank[a.status]! - rank[b.status]! || b.flow.updatedAt.localeCompare(a.flow.updatedAt));
}
export function filterFixFlowGroups(groups: FixFlowGroup[], filter: FlowFilter): FixFlowGroup[] {
  return filter ? groups.filter(group => group[filter.kind === "current" ? "currentState" : filter.kind === "status" ? "status" : "stage"] === filter.value) : groups;
}
