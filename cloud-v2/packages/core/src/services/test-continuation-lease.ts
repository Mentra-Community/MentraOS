import { createHmac } from "node:crypto";
import { z } from "zod";
import type { ContinuationGrant } from "../types/test-continuation.types";
import type { TestRoutineId } from "../types/test-dispatch.types";
import { TestDispatchError, readTestMetadata } from "./test-builds.service";

/** Core checks the authoritative existing queue immediately before its send
 * fence. A valid signature alone cannot keep a reclaimed lease writable. */
export async function requireContinuationLease(grant: ContinuationGrant, routineId: TestRoutineId,
  send: typeof fetch = fetch): Promise<void> {
  const secret = process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET ?? "";
  const base = process.env.CLOUD_REPORT_AGENT_URL;
  if (!base || secret.length < 32) throw new TestDispatchError(503, "Continuation lease validation is not configured");
  const url = new URL("/internal/routine-failure-lease", base);
  if (url.protocol !== "https:" || url.username || url.password) throw new TestDispatchError(503, "Invalid lease validator origin");
  const body = JSON.stringify({ schemaVersion: 1, environment: grant.environment, occurrenceId: grant.occurrenceId,
    agentRunId: grant.agentRunId, candidate: grant.candidate, ...(grant.caseBinding ? { caseBinding: grant.caseBinding } : {}),
    executionAttempt: grant.executionAttempt, leaseGeneration: grant.leaseGeneration,
    leaseTokenSha256: grant.leaseTokenSha256, routineId });
  const expires = Math.floor(Date.now() / 1000) + 30;
  const signature = createHmac("sha256", secret).update(`mentra-mini-lease-check-v1\n${expires}\n${body}`).digest("hex");
  const response = await send(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/vnd.mentra.mini-lease+json", "x-mentra-action-expires": String(expires),
      "x-mentra-action-signature": signature }, body });
  if (response.status === 409) { await response.body?.cancel(); throw new TestDispatchError(409, "Mini lease changed or its candidate was not reserved"); }
  const value = z.object({ schemaVersion: z.literal(1), valid: z.literal(true), agentRunId: z.literal(grant.agentRunId),
    leaseGeneration: z.literal(grant.leaseGeneration) }).strict().parse(JSON.parse(new TextDecoder().decode(await readTestMetadata(response, 4096))));
  if (!value.valid) throw new TestDispatchError(409, "Mini lease is no longer current");
}
