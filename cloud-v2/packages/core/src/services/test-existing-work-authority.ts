import { createHmac } from "node:crypto";
import { z } from "zod";
import type { ExistingWorkGrant } from "../types/test-existing-work.types";
import type { TestBuildSource } from "../types/test-dispatch.types";
import { TestDispatchError, readTestMetadata } from "./test-builds.service";

/** The exact operation Core is about to write; the controller must have reserved it on the same row. */
export interface ExistingWorkOperation {
  operationId: string;
  source: TestBuildSource;
  archiveSha256: string;
  expectedHeadSha: string;
  routineId: string;
  verificationAttempt: 1;
}
export type ExistingWorkAuthority = (grant: ExistingWorkGrant, operation: ExistingWorkOperation, send?: typeof fetch) => Promise<void>;

/**
 * Before any durable send receipt, the controller confirms that this exact operation is reserved
 * on the same existing-work row at the signed binding revision. It is a separate purpose from the
 * continuation lease check and carries no lease. Absent configuration or controller support,
 * an unknown response, a stale revision or any differing echo sends nothing.
 */
export async function requireExistingWorkOperation(grant: ExistingWorkGrant, operation: ExistingWorkOperation,
  send: typeof fetch = fetch): Promise<void> {
  const secret = process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET ?? "";
  const base = process.env.CLOUD_REPORT_AGENT_URL;
  if (!base || secret.length < 32) throw new TestDispatchError(501, "Existing-work operation authority is not configured; nothing was sent");
  const url = new URL("/internal/routine-existing-work-operation", base);
  if (url.protocol !== "https:" || url.username || url.password) throw new TestDispatchError(503, "Invalid existing-work authority origin");
  const body = JSON.stringify({ schemaVersion: 1, environment: grant.environment, occurrenceId: grant.occurrenceId,
    agentRunId: grant.agentRunId, binding: { sha256: grant.binding.sha256, revision: grant.binding.revision },
    operation: { operationId: operation.operationId, source: operation.source, archiveSha256: operation.archiveSha256,
      expectedHeadSha: operation.expectedHeadSha, routineId: operation.routineId, verificationAttempt: operation.verificationAttempt } });
  const expires = Math.floor(Date.now() / 1000) + 30;
  const signature = createHmac("sha256", secret).update(`mentra-existing-work-operation-check-v1\n${expires}\n${body}`).digest("hex");
  let response: Response;
  try {
    response = await send(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/vnd.mentra.existing-work-operation+json", "x-mentra-action-expires": String(expires),
        "x-mentra-action-signature": signature }, body });
  } catch { throw new TestDispatchError(503, "Existing-work operation authority is unreachable; nothing was sent"); }
  if (response.status === 409) { await response.body?.cancel(); throw new TestDispatchError(409,
    "The existing-work binding changed or this operation is not reserved at the signed revision; nothing was sent"); }
  if ([404, 405, 501].includes(response.status)) { await response.body?.cancel(); throw new TestDispatchError(501,
    "The controller does not support existing-work operation checks yet; nothing was sent"); }
  // Every echoed identity must equal what Core signed; `valid: true` alone is not authority.
  const accepted = z.object({ schemaVersion: z.literal(1), valid: z.literal(true), agentRunId: z.literal(grant.agentRunId),
    bindingSha256: z.literal(grant.binding.sha256), bindingRevision: z.literal(grant.binding.revision),
    operationId: z.literal(operation.operationId) }).strict();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readTestMetadata(response, 4096))); }
  catch { throw new TestDispatchError(503, "Existing-work operation authority returned an unknown response; nothing was sent"); }
  if (!accepted.safeParse(value).success)
    throw new TestDispatchError(409, "Existing-work operation authority did not confirm this exact binding and operation; nothing was sent");
}
