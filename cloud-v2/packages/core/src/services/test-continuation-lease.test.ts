import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { requireContinuationLease } from "./test-continuation-lease";
import type { ContinuationGrant } from "../types/test-continuation.types";
const old = { url: process.env.CLOUD_REPORT_AGENT_URL, secret: process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET };
afterEach(() => { if (old.url) process.env.CLOUD_REPORT_AGENT_URL = old.url; else delete process.env.CLOUD_REPORT_AGENT_URL;
  if (old.secret) process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = old.secret; else delete process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET; });
test("lease callback binds candidate, queue generation and routine without granting a broad token", async () => {
  process.env.CLOUD_REPORT_AGENT_URL = "https://agent.example.test";
  process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = "fixture-signing-key-".repeat(3);
  const grant = { agentRunId: "run-123", environment: "dev", occurrenceId: "tfo_" + "a".repeat(64),
    candidate: { repository: "Mentra-Community/MentraOS", pullRequest: 12, headSha: "b".repeat(40) },
    leaseGeneration: 3, leaseTokenSha256: "c".repeat(64) } as ContinuationGrant;
  const send = (async (url: URL, init: RequestInit) => {
    expect(url.href).toBe("https://agent.example.test/internal/routine-failure-lease"); expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers), body = String(init.body);
    expect(JSON.parse(body)).toMatchObject({ agentRunId: "run-123", leaseGeneration: 3, routineId: "no-glasses" });
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-mentra-action-signature")).toBe(createHmac("sha256", process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET!)
      .update(`mentra-mini-lease-check-v1\n${headers.get("x-mentra-action-expires")}\n${body}`).digest("hex"));
    return Response.json({ schemaVersion: 1, valid: true, agentRunId: "run-123", leaseGeneration: 3 });
  }) as unknown as typeof fetch;
  await requireContinuationLease(grant, "no-glasses", send);
  await expect(requireContinuationLease(grant, "no-glasses", (async () => new Response(null, { status: 409 })) as unknown as typeof fetch)).rejects.toThrow("lease changed");
  await expect(requireContinuationLease(grant, "no-glasses", (async () => Response.json({ schemaVersion: 1, valid: true, agentRunId: "other", leaseGeneration: 3 })) as unknown as typeof fetch)).rejects.toThrow();
});
