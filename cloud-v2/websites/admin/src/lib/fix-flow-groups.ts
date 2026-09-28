import type { FixFlow } from "../../../../packages/core/src/types/fix-flow.types";

export const FLOW_STATUSES = [
  { id: "attention", label: "Needs attention" }, { id: "running", label: "Running" },
  { id: "waiting", label: "Waiting" }, { id: "unknown", label: "Status unavailable" }, { id: "completed", label: "Completed" },
] as const;
export const FLOW_STAGES = [
  { id: "intake", label: "Failure / intake" }, { id: "investigation", label: "Investigate" }, { id: "fix", label: "Fix" },
  { id: "review", label: "PR / review" }, { id: "verification", label: "Test / rerun" },
  { id: "merged", label: "Merged" }, { id: "closed", label: "Closed without fix" }, { id: "unknown", label: "Stage unavailable" },
] as const;
export type FlowStatus = typeof FLOW_STATUSES[number]["id"];
export type FlowStage = typeof FLOW_STAGES[number]["id"];
export type FlowFilter = { kind: "status"; value: FlowStatus } | { kind: "stage"; value: FlowStage } | null;
export interface FixFlowGroup { key: string; flow: FixFlow; occurrences: FixFlow[]; status: FlowStatus; stage: FlowStage }
const rank = Object.fromEntries(FLOW_STATUSES.map((status, index) => [status.id, index]));
// An older Core's broad `active` enum is never evidence of a running worker.
export const flowStatus = (flow: FixFlow): FlowStatus => flow.state === "active" ? "unknown" : flow.state;
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
    return { key, flow, occurrences, status: flowStatus(flow), stage: flowStage(flow) };
  }).sort((a, b) => rank[a.status]! - rank[b.status]! || b.flow.updatedAt.localeCompare(a.flow.updatedAt));
}
export function filterFixFlowGroups(groups: FixFlowGroup[], filter: FlowFilter): FixFlowGroup[] {
  return filter ? groups.filter(group => group[filter.kind === "status" ? "status" : "stage"] === filter.value) : groups;
}
