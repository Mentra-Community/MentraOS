import { createLogger } from "@mentra/cloud-shared";
import { testFailureDeliveryAckSchema } from "../types/test-failure.types";
import { signTestFailureDelivery, testFailureEnvironment } from "./test-failure-auth";
import { TestRunService } from "./test-run.service";

const logger = createLogger("test-failure-delivery");

/** Only transports durable references into the existing dev-agent queue. */
export class TestFailureDeliveryService {
  constructor(private readonly runs = new TestRunService(), private readonly send: typeof fetch = fetch) {}

  async flush(signal?: AbortSignal) {
    const environment = testFailureEnvironment();
    const secret = process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET ?? "";
    const base = process.env.CLOUD_REPORT_AGENT_URL;
    if (!environment || secret.length < 32 || !base) return { acknowledged: 0, pending: 0, configured: false };
    let url: URL;
    try {
      url = new URL("/internal/routine-failures", base);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid endpoint");
    } catch { return { acknowledged: 0, pending: 0, configured: false }; }
    const pending = await this.runs.pendingFailureDeliveries(10);
    let acknowledged = 0;
    for (const occurrence of pending) {
      if (signal?.aborted) break;
      const body = JSON.stringify({ schemaVersion: 1, ...occurrence, environment });
      const expires = Math.floor(Date.now() / 1000) + 5 * 60;
      try {
        // Rotate failed deliveries behind untouched occurrences without deleting
        // or reassigning work. Multiple Core replicas can safely repeat intake.
        await this.runs.noteFailureDeliveryAttempt(occurrence.occurrenceId);
        const response = await this.send(url, { method: "POST", redirect: "error", signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
          headers: { "content-type": "application/vnd.mentra.routine-failure+json",
            "x-mentra-action-expires": String(expires), "x-mentra-action-signature": signTestFailureDelivery(body, expires, secret) }, body });
        if (!response.ok) { await response.body?.cancel(); continue; }
        // Bound the acknowledgment even if a misconfigured server streams a large body.
        const reader = response.body?.getReader();
        if (!reader) continue;
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
        const ack = testFailureDeliveryAckSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (ack.occurrenceId !== occurrence.occurrenceId || ack.revision !== occurrence.revision) continue;
        await this.runs.acknowledgeFailure(occurrence.occurrenceId, ack.agentRunId);
        acknowledged++;
      } catch {
        // No remote error bodies, signing material or diagnostic payloads enter logs.
        // The persisted pending receipt is retried with the same occurrence identity.
      }
    }
    return { acknowledged, pending: pending.length - acknowledged, configured: true };
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
