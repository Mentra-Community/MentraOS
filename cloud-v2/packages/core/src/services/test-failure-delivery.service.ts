import { createLogger } from "@mentra/cloud-shared";
import { testFailureCorrectionAckSchema, testFailureDeliveryAckSchema } from "../types/test-failure.types";
import { signTestFailureCorrectionDelivery, signTestFailureDelivery, testFailureEnvironment } from "./test-failure-auth";
import { TestRunService } from "./test-run.service";

const logger = createLogger("test-failure-delivery");

/** Only transports durable references into the existing dev-agent queue. */
export class TestFailureDeliveryService {
  constructor(private readonly runs = new TestRunService(), private readonly send: typeof fetch = fetch) {}

  /** One signed POST with a bounded JSON reply; null when the receiver did not accept. */
  private async post(url: URL, contentType: string, body: string, signature: (expires: number) => string, signal?: AbortSignal) {
    const expires = Math.floor(Date.now() / 1000) + 5 * 60;
    const response = await this.send(url, { method: "POST", redirect: "error", signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      headers: { "content-type": contentType,
        "x-mentra-action-expires": String(expires), "x-mentra-action-signature": signature(expires) }, body });
    if (!response.ok) { await response.body?.cancel(); return { status: response.status, value: null }; }
    // Bound the acknowledgment even if a misconfigured server streams a large body.
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, value: null };
    let bytes = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 4096) throw new Error("oversized acknowledgment");
        chunks.push(result.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return { status: response.status, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  }

  async flush(signal?: AbortSignal) {
    const environment = testFailureEnvironment();
    const secret = process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET ?? "";
    const base = process.env.CLOUD_REPORT_AGENT_URL;
    if (!environment || secret.length < 32 || !base) return { acknowledged: 0, pending: 0, configured: false };
    let url: URL, correctionUrl: URL;
    try {
      url = new URL("/internal/routine-failures", base);
      correctionUrl = new URL("/internal/routine-failure-corrections", base);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid endpoint");
    } catch { return { acknowledged: 0, pending: 0, configured: false }; }
    const pending = await this.runs.pendingFailureDeliveries(10);
    let acknowledged = 0;
    for (const occurrence of pending) {
      if (signal?.aborted) break;
      const body = JSON.stringify({ schemaVersion: 1, ...occurrence, environment });
      try {
        // Rotate failed deliveries behind untouched occurrences without deleting
        // or reassigning work. Multiple Core replicas can safely repeat intake.
        await this.runs.noteFailureDeliveryAttempt(occurrence.occurrenceId);
        const { value } = await this.post(url, "application/vnd.mentra.routine-failure+json", body,
          expires => signTestFailureDelivery(body, expires, secret), signal);
        if (value === null) continue;
        const ack = testFailureDeliveryAckSchema.parse(value);
        if (ack.occurrenceId !== occurrence.occurrenceId || ack.revision !== occurrence.revision) continue;
        await this.runs.acknowledgeFailure(occurrence.occurrenceId, ack.agentRunId);
        acknowledged++;
      } catch {
        // No remote error bodies, signing material or diagnostic payloads enter logs.
        // The persisted pending receipt is retried with the same occurrence identity.
      }
    }
    // Reviewed provenance corrections of already-acknowledged occurrences: same transport, own purpose.
    const corrections = signal?.aborted ? [] : await this.runs.pendingProvenanceCorrectionDeliveries(10);
    let corrected = 0;
    for (const correction of corrections) {
      if (signal?.aborted) break;
      const body = JSON.stringify({ schemaVersion: 1, environment, ...correction });
      try {
        await this.runs.noteProvenanceCorrectionAttempt(correction.correctionId);
        const { status, value } = await this.post(correctionUrl, "application/vnd.mentra.routine-failure-correction+json", body,
          expires => signTestFailureCorrectionDelivery(body, expires, secret), signal);
        // The controller's authenticated 409 is a durable refusal of this exact correction, never a retry signal.
        if (status === 409) { await this.runs.refuseProvenanceCorrection(correction.correctionId); continue; }
        if (value === null) continue;
        const ack = testFailureCorrectionAckSchema.parse(value);
        if (ack.occurrenceId !== correction.occurrenceId || ack.revision !== correction.revision
          || ack.correctionId !== correction.correctionId || ack.agentRunId !== correction.agentRunId) continue;
        await this.runs.acknowledgeProvenanceCorrection(correction.correctionId, ack.agentRunId);
        corrected++;
      } catch {
        // Same rule: nothing remote is logged; the pending correction keeps its identity for the next pass.
      }
    }
    return { acknowledged, pending: pending.length - acknowledged, configured: true,
      ...(corrections.length ? { corrections: { acknowledged: corrected, pending: corrections.length - corrected } } : {}) };
  }
}

/** Explicit rollout switch; no delivery is required for evidence ingestion. */
export function startTestFailureDelivery(service = new TestFailureDeliveryService()) {
  if (process.env.CLOUD_TEST_FAILURE_DELIVERY_ENABLED !== "true") return async () => {};
  const abort = new AbortController();
  let active: Promise<unknown> | undefined;
  const tick = () => {
    if (active || abort.signal.aborted) return;
    active = service.flush(abort.signal).catch(() => logger.warn("test failure delivery remains pending"))
      .finally(() => { active = undefined; });
  };
  tick();
  const timer = setInterval(tick, 30_000);
  timer.unref();
  return async () => { clearInterval(timer); abort.abort(); await active; };
}
