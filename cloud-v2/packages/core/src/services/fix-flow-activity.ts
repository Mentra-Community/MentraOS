import { z } from "zod";

const text = z.string().max(4000);
const stamp = z.string().datetime().nullable().optional();
const triage = z.object({ state: text, reason: text.optional(), nextAction: text.optional() });
const workerLease = z.object({ state: z.enum(["active", "reconciliation-required", "inactive"]), expiresAt: z.string().datetime().optional() });
const progressPhase = z.enum(["collecting_report", "inspecting_code", "implementing_fix", "running_tests", "reviewing_pr", "addressing_feedback"]);
const pr = z.object({ repository: z.string().regex(/^Mentra-Community\/[A-Za-z0-9_.-]+$/),
  pullRequestNumber: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/),
  pullRequestLifecycle: z.object({ state: z.enum(["open", "closed", "merged"]), mergedAt: stamp }).optional() });
const checkpoint = z.object({ action: text, intentId: text.optional(), repository: pr.shape.repository.optional(),
  pullRequest: pr.shape.pullRequestNumber.optional(), headSha: pr.shape.headSha.optional(),
  reviewId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(), verdict: text.optional(), summary: text.optional(), components: z.array(text).optional(),
  state: text.optional(), routineId: text.optional(), outcome: text.optional(), resultId: text.optional(),
  requestRunId: z.number().int().positive().optional(), requestAttempt: z.number().int().positive().optional(),
  occurrence: z.object({ agentRunId: z.string().uuid(), occurrenceId: z.string().regex(/^tfo_[a-f0-9]{64}$/) }).optional(),
  startedAt: stamp, recordedAt: stamp, verification: z.object({ submittedAt: stamp }).optional() });
export const fixActivitySchema = z.object({
  runId: z.string().uuid(), environment: z.enum(["dev", "staging", "prod"]), taskKind: z.literal("routine-failure"),
  executor: text, status: text, statusLabel: text.optional(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), heartbeatAt: stamp,
  acknowledgedAgentRunId: z.string().uuid().optional(),
  executionOwnerRunId: z.string().uuid().optional(), executionOwnerStatus: text.optional(), executionOwnerStatusLabel: text.optional(),
  executionOwnerUpdatedAt: z.string().datetime().optional(), executionOwnerHeartbeatAt: stamp,
  executionOwnerTriage: triage.optional(), executionOwnerWorkerLease: workerLease.optional(),
  executionOwnerProgressPhase: progressPhase.optional(), workerLease: workerLease.optional(), progressPhase: progressPhase.optional(),
  routineFailure: z.object({ intake: z.object({ occurrenceId: z.string().regex(/^tfo_[a-f0-9]{64}$/),
    testRunId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/) }) }),
  routineCase: z.object({ caseId: z.string().regex(/^mfc_[a-f0-9]{64}$/), anchorRunId: z.string().uuid() }).optional(),
  miniExecution: z.object({ stage: z.object({ stage: text, reason: text }).optional(),
    route: z.object({ repository: text, branch: text }), checkpoints: z.array(checkpoint).max(2000) }).optional(),
  miniLastTurn: z.object({ stage: text, reason: text }).optional(),
  miniTurnFailure: z.object({ kind: text, phase: text, at: z.string().datetime(),
    // Only controller-classified codes cross this boundary; newer/unknown codes do not hide the activity row.
    sourcePolicy: z.enum(["harness-source-unverified", "harness-origin-ambiguous", "harness-origin-unmerged", "harness-base-not-contained"])
      .optional().catch(undefined) }).optional(),
  miniTriage: triage.optional(),
  result: z.object({ summary: text, pullRequests: z.array(pr).max(30).optional() }).optional(),
  // The controller's routine activity view also decorates in-progress record-pr checkpoints.
  pullRequests: z.array(pr).max(30).optional(),
});
export type FixActivity = z.infer<typeof fixActivitySchema>;
export interface FixActivityBinding { occurrenceId: string; testRunId: string }
export interface FixActivityReader {
  list(): Promise<{ runs: FixActivity[]; state: "available" | "unavailable" | "not-configured"; limited: boolean }>;
  detail(id: string, binding: FixActivityBinding): Promise<FixActivity | null>;
}

export class HttpFixActivityReader implements FixActivityReader {
  constructor(private readonly env = process.env, private readonly send: typeof fetch = fetch) {}
  private async read(path: string): Promise<unknown> {
    const base = this.env.CLOUD_REPORT_AGENT_URL, token = this.env.CLOUD_REPORT_AGENT_ACTIVITY_TOKEN;
    if (!base || !token) throw new Error("not configured");
    const url = new URL(path, base);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid activity origin");
    const response = await this.send(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(12_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("activity unavailable"); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty activity");
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 8 * 1024 * 1024) throw new Error("activity too large"); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => undefined); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  async list() {
    if (!this.env.CLOUD_REPORT_AGENT_URL || !this.env.CLOUD_REPORT_AGENT_ACTIVITY_TOKEN)
      return { runs: [], state: "not-configured" as const, limited: false };
    try {
      const runs: FixActivity[] = [];
      let cursor: string | null = null, limited = false;
      for (let page = 0; page < 10; page++) {
        const value = await this.read(`/internal/activity/runs?scope=routine-fixes&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        // Older controllers return their recent array; label that limited rather than claiming complete active coverage.
        const envelope = z.object({ runs: z.array(z.unknown()).max(100), limited: z.boolean(), nextCursor: z.string().max(2048).nullable().optional() }).safeParse(value);
        const rows = envelope.success ? envelope.data.runs : z.array(z.unknown()).max(100).parse(value);
        for (const row of rows) { const parsed = fixActivitySchema.safeParse(row); if (parsed.success) runs.push(parsed.data); }
        limited = envelope.success ? envelope.data.limited : true;
        const next = envelope.success ? envelope.data.nextCursor ?? null : null;
        if (!next || next === cursor) break;
        cursor = next;
        if (page === 9) limited = true;
      }
      return { runs, state: "available" as const, limited };
    } catch { return { runs: [], state: "unavailable" as const, limited: false }; }
  }
  async detail(id: string, binding: FixActivityBinding) {
    if (!z.string().uuid().safeParse(id).success || !fixActivitySchema.shape.routineFailure.shape.intake.safeParse(binding).success) return null;
    const query = new URLSearchParams({ occurrenceId: binding.occurrenceId, testRunId: binding.testRunId });
    try { return fixActivitySchema.parse(await this.read(`/internal/activity/runs/${id}?${query}`)); } catch { return null; }
  }
}
