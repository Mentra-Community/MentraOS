import { createHmac } from "node:crypto";
import { z } from "zod";
import { testRepairOperationSchema, type TestRepairOperation, type TestRepairReceipt } from "../types/test-repair.types";
import type { TestRepairExecutor } from "./test-repair.service";

/**
 * Signed HTTP client for the internal-tools repair bridge (bridge-wire-handoff §2–§3). It reuses the
 * existing Core → internal-tools relationship (CLOUD_REPORT_AGENT_URL / CLOUD_REPORT_AGENT_SIGNING_SECRET,
 * as for the lease check) with its own HMAC domains and content types. Core never runs a repair.
 */
export const REPAIR_SUBMIT = { path: "/internal/routine-failure-repair", domain: "mentra-mini-repair-submit-v1",
  contentType: "application/vnd.mentra.mini-repair+json" } as const;
export const REPAIR_STATUS = { path: "/internal/routine-failure-repair-status", domain: "mentra-mini-repair-status-v1",
  contentType: "application/vnd.mentra.mini-repair-status+json" } as const;
/** Operations with an actual enrolled host adapter. An allowlist naming anything else is refused. */
export const ENROLLABLE_REPAIR_OPERATIONS: readonly TestRepairOperation[] = ["android.sign-in-recovery"];
const MAX_BODY = 4096, MAX_REPLY = 64 * 1024, EXPIRES_SECONDS = 30, TIMEOUT_MS = 15_000;

export interface HttpRepairExecutorOptions {
  url: string;
  secret: string;
  operations: readonly TestRepairOperation[];
  fetch?: typeof fetch;
  now?: () => number;
}

class RepairTransportError extends Error {}
/** Stands in for an unparseable status body; it can never satisfy Core's status schema. */
const MALFORMED = Object.freeze({ malformed: true });
const acceptedReply = z.object({ schemaVersion: z.literal(1), repairId: z.string().uuid(), operation: testRepairOperationSchema,
  state: z.enum(["accepted", "running", "unknown", "completed", "failed", "rejected"]) }).strict();
// Fixed reasons only: the executor's reply text is never copied into a receipt.
const refusals: Record<number, string> = {
  400: "The executor rejected a malformed repair request; nothing was admitted",
  409: "The lease, occurrence, candidate, intent or budget is not current; nothing was admitted",
  501: "No enrolled host capability for this operation; nothing was admitted",
};

/** Exact bytes, signed once; the receiver parses these bytes without re-serialisation. */
function signedRequest(options: HttpRepairExecutorOptions, route: typeof REPAIR_SUBMIT | typeof REPAIR_STATUS, value: unknown): [URL, RequestInit] {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_BODY) throw new RepairTransportError("Repair request exceeds its bound");
  const expires = Math.floor((options.now ?? Date.now)() / 1000) + EXPIRES_SECONDS;
  const signature = createHmac("sha256", options.secret).update(`${route.domain}\n${expires}\n${body}`).digest("hex");
  return [new URL(route.path, options.url), { method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), body,
    headers: { "content-type": route.contentType, "x-mentra-action-expires": String(expires), "x-mentra-action-signature": signature } }];
}
async function bounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_REPLY) throw new RepairTransportError("Repair reply exceeds its bound");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
/** The binding both routes share: anchor, occurrence, candidate, routine and the registered operation. */
function binding(receipt: TestRepairReceipt) {
  return { occurrenceId: receipt.binding.occurrenceId, agentRunId: receipt.binding.agentRunId };
}

export class HttpTestRepairExecutor implements TestRepairExecutor {
  constructor(private readonly options: HttpRepairExecutorOptions) {}
  supports(operation: TestRepairOperation) { return this.options.operations.includes(operation); }

  /** One send. 200 for this exact operation is accepted; 400/409/501 are definite refusals; anything else
   * (401, 5xx, timeout, malformed or mismatched reply) throws, leaving the send unknown: never resent. */
  async submit(receipt: TestRepairReceipt): Promise<{ state: "accepted" } | { state: "rejected"; reason: string }> {
    const lease = receipt.lease;
    if (!lease || lease.executionAttempt !== 1) throw new RepairTransportError("Repair receipt has no execution-attempt-1 lease");
    const [url, init] = signedRequest(this.options, REPAIR_SUBMIT, { schemaVersion: 1, environment: lease.environment, ...binding(receipt),
      executionAttempt: 1, leaseGeneration: lease.leaseGeneration, leaseTokenSha256: lease.leaseTokenSha256,
      candidate: receipt.binding.candidate, routineId: receipt.request.routineId,
      repair: { operation: receipt.request.operation, operationId: receipt.repairId }, reason: receipt.request.reason });
    const response = await (this.options.fetch ?? fetch)(url, init);
    if (refusals[response.status]) { await response.body?.cancel(); return { state: "rejected", reason: refusals[response.status]! }; }
    if (response.status !== 200) { await response.body?.cancel(); throw new RepairTransportError(`Repair submit outcome unknown (HTTP ${response.status})`); }
    const reply = acceptedReply.safeParse(JSON.parse(await bounded(response)));
    if (!reply.success || reply.data.repairId !== receipt.repairId || reply.data.operation !== receipt.request.operation)
      throw new RepairTransportError("Repair submit reply does not name this operation");
    return { state: "accepted" };
  }

  /** Read-only. 200 relays the body to Core's strict status check; anything else is unavailable. */
  async status(receipt: TestRepairReceipt): Promise<unknown> {
    const environment = receipt.lease?.environment;
    if (!environment) throw new RepairTransportError("Repair receipt has no lease environment");
    const [url, init] = signedRequest(this.options, REPAIR_STATUS, { schemaVersion: 1, environment, ...binding(receipt),
      candidate: receipt.binding.candidate, routineId: receipt.request.routineId,
      repair: { operation: receipt.request.operation, operationId: receipt.repairId } });
    const response = await (this.options.fetch ?? fetch)(url, init);
    if (response.status !== 200) { await response.body?.cancel(); throw new RepairTransportError(`Repair status unavailable (HTTP ${response.status})`); }
    // An oversized, non-UTF-8 or non-JSON 200 is a malformed answer, not an outage: Core's strict check
    // then refuses it (502). Only transport failures count as unavailable.
    let text: string;
    try { text = await bounded(response); }
    catch (error) {
      if (error instanceof RepairTransportError || (error instanceof TypeError && /encoded data|decode/i.test(error.message))) return MALFORMED;
      throw error;
    }
    try { return JSON.parse(text); } catch { return MALFORMED; }
  }
}

/**
 * The HTTP executor only when the existing internal-tools origin and signing secret are configured and
 * CLOUD_TEST_REPAIR_OPERATIONS explicitly lists enrolled operations. Otherwise null (absent, 501). An
 * invalid or speculative allowlist is refused as a whole rather than partially enabled.
 */
export function configuredTestRepairExecutor(env: NodeJS.ProcessEnv = process.env, fetcher?: typeof fetch): HttpTestRepairExecutor | null {
  const url = env.CLOUD_REPORT_AGENT_URL, secret = env.CLOUD_REPORT_AGENT_SIGNING_SECRET ?? "";
  const names = (env.CLOUD_TEST_REPAIR_OPERATIONS ?? "").split(",").map(name => name.trim()).filter(Boolean);
  if (!url || secret.length < 32 || names.length === 0) return null;
  let origin: URL;
  try { origin = new URL(url); } catch { return null; }
  if (origin.protocol !== "https:" || origin.username || origin.password) return null;
  if (new Set(names).size !== names.length || names.some(name => !(ENROLLABLE_REPAIR_OPERATIONS as readonly string[]).includes(name))) return null;
  return new HttpTestRepairExecutor({ url: origin.origin, secret, operations: names as TestRepairOperation[], ...(fetcher ? { fetch: fetcher } : {}) });
}
