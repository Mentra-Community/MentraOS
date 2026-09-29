import { z } from "zod";
import { testResourceHostIdSchema } from "./test-resource-observation.types";

export const HOST_FRESH_MS = 180_000;
export const DISK_GAP_MS = 90_000; // A missed 60-second tick is a gap; permit ordinary scheduling jitter.
export const DISK_FLOOR_BYTES = 5 * 1024 ** 3; // Recorder minimum; cleanup uses separate trigger/target settings.
export const HOST_HISTORY_DAYS = 7;
export const HOST_SAMPLE_LIMIT = 10_081; // One real sample/minute over seven days, plus a boundary sample.
export const HOST_COMPONENTS = ["general-worker", "triage-worker", "disk-cleanup"] as const;
const timestamp = z.string().datetime({ offset: true });
const bytes = z.number().int().nonnegative().safe().nullable();
export const hostReasonSchema = z.enum(["none", "operator-drained", "disabled", "not-configured", "not-installed", "process-missing",
  "permission-denied", "budget-limited", "held-custody", "unsettled", "startup-failed", "inspection-unavailable", "unknown"]);
export type HostReason = z.infer<typeof hostReasonSchema>;
const component = z.object({
  component: z.enum(HOST_COMPONENTS), enabled: z.boolean().nullable(),
  state: z.enum(["running", "scheduled", "stopped", "blocked", "unknown"]), reason: hostReasonSchema,
}).strict().superRefine((value, ctx) => {
  const valid = value.state === "running" ? value.reason === "none"
    : value.state === "scheduled" ? value.component === "disk-cleanup" && value.enabled === true && value.reason === "none"
    : value.state === "stopped" ? ["operator-drained", "disabled"].includes(value.reason)
    : value.state === "blocked" ? ["process-missing", "permission-denied", "budget-limited", "held-custody", "unsettled", "startup-failed"].includes(value.reason)
    : ["not-configured", "not-installed", "inspection-unavailable", "unknown"].includes(value.reason);
  if (!valid || (["running", "scheduled"].includes(value.state) && value.enabled === false)
    || value.reason === "process-missing" && value.enabled !== true || value.reason === "disabled" && value.enabled !== false)
    ctx.addIssue({ code: "custom", message: "component state and reason disagree" });
});

/** Safe receipt summary only. No paths, commands, raw errors, configs, process arguments or ownership tokens. */
export const cleanupEventSchema = z.object({
  receiptId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  origin: z.enum(["scheduled", "manual", "pre-job", "unknown"]),
  startedAt: timestamp, finishedAt: timestamp.nullable(),
  status: z.enum(["above-trigger", "target-reached", "dry-run-complete", "already-running", "retained-or-budget-limited", "refused", "error", "unknown"]),
  reason: hostReasonSchema, removedCount: z.number().int().nonnegative().max(100_000),
  freeBefore: bytes, freeAfter: bytes, freeAfterSampledAt: timestamp.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.finishedAt && Date.parse(value.finishedAt) < Date.parse(value.startedAt)
    || value.freeAfterSampledAt && (value.freeAfter === null || Date.parse(value.freeAfterSampledAt) < Date.parse(value.startedAt)
      || value.finishedAt !== null && Date.parse(value.freeAfterSampledAt) > Date.parse(value.finishedAt)))
    ctx.addIssue({ code: "custom", message: "invalid cleanup measurement times" });
  if (value.status === "already-running" && (value.reason !== "none" || value.removedCount !== 0
    || value.finishedAt === null || value.origin === "unknown"))
    ctx.addIssue({ code: "custom", message: "overlapping cleanup must be a completed, identified skip with no removals" });
});
export type CleanupHealthEvent = z.infer<typeof cleanupEventSchema>;

/** Passive monitor snapshot, independent of fixer/triage/cleanup process lifetime. Exact retries keep identity/time. */
export const testHostSampleSchema = z.object({
  schemaVersion: z.literal(1), hostId: testResourceHostIdSchema, sampleId: z.string().uuid(), sampledAt: timestamp,
  freeBytes: bytes,
  components: z.array(component).max(3),
  cleanupEvents: z.array(cleanupEventSchema).max(32),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.components.map(item => item.component)).size !== value.components.length)
    ctx.addIssue({ code: "custom", message: "duplicate component" });
  for (const event of value.cleanupEvents) {
    if ([event.startedAt, event.finishedAt, event.freeAfterSampledAt].some(time => time && Date.parse(time) > Date.parse(value.sampledAt)))
      ctx.addIssue({ code: "custom", message: "cleanup event is newer than observation" });
  }
});
export type TestHostSample = z.infer<typeof testHostSampleSchema>;
export type HostComponent = TestHostSample["components"][number];
export interface TestHostLatest extends TestHostSample { receivedAt: string }
export interface TestHostList { generatedAt: string; hosts: TestHostLatest[]; truncated: boolean; freshForMs: number }
export interface HostDiskPoint { sampleId: string; sampledAt: string; freeBytes: number | null }
export interface TestHostHistory {
  hostId: string; generatedAt: string; from: string; to: string; points: HostDiskPoint[];
  cleanupEvents: CleanupHealthEvent[]; truncated: boolean; thresholdBytes: number; gapAfterMs: number;
}

export function hostIsFresh(host: Pick<TestHostLatest, "sampledAt" | "receivedAt">, now: number) {
  const sampled = Date.parse(host.sampledAt), received = Date.parse(host.receivedAt);
  return Number.isFinite(sampled) && Number.isFinite(received) && sampled <= now + 5_000 && received <= now + 5_000
    && now - sampled <= HOST_FRESH_MS && now - received <= HOST_FRESH_MS;
}
