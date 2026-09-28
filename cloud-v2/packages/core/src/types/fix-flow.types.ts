/** Read-only Admin projection. No lease tokens, prompts, local paths or raw agent output. */
export interface FixFlow {
  occurrenceId: string | null;
  runId: string;
  routineId: string;
  channel: string;
  build: string;
  step: { id: string; label: string } | null;
  failure: { code: string; message: string; expected?: string };
  startedAt: string;
  updatedAt: string;
  state: "active" | "attention" | "completed" | "unknown";
  stage: string;
  nextAction: string;
  agent: { runId: string; executor: string; status: string; caseId: string | null; anchorRunId: string | null;
    repository: string | null; branch: string | null; heartbeatAt: string | null;
    executionOwner: { runId: string; status: string } | null } | null;
  incidents: Array<{ reportId: string; status: string }>;
  pullRequests: Array<{ repository: string; number: number; headSha: string; state: "open" | "closed" | "merged" | "unknown";
    url: string; mergedAt: string | null }>;
  timeline: Array<{ id: string; stage: string; title: string; detail: string | null; at: string | null; url: string | null }>;
  activity: "available" | "pending" | "unavailable" | "not-configured" | "unmatched";
}

export interface FixFlowList {
  flows: FixFlow[];
  refreshedAt: string;
  activity: "available" | "unavailable" | "not-configured";
  limited: boolean;
}
