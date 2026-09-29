import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TestFailureCorrectionService } from "../../services/test-failure-correction.service";
import { TestRunError, TestRunService } from "../../services/test-run.service";
import { TestRunOverviewService } from "../../services/test-run-overview.service";
import { TestRunFollowUpError, TestRunFollowUpService } from "../../services/test-run-follow-up.service";
import { testRunQuerySchema } from "../../types/test-run.types";
import type { AppEnv } from "../../types/hono.types";
import { TestHostHealthError, TestHostHealthService } from "../../services/test-host-health.service";
import { TestFailureEvidenceService } from "../../services/test-failure-evidence.service";

/** Mounted only behind preinstalled.api's existing adminAuth gate. */
export function createTestRunAdminApi(service = new TestRunService(), overview = new TestRunOverviewService(), followUp = new TestRunFollowUpService(),
  corrections = new TestFailureCorrectionService(), health = new TestHostHealthService(), evidence = new TestFailureEvidenceService()) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof TestRunError) return c.json({ error: "test_run_error", error_description: error.message }, error.status);
    if (error instanceof TestRunFollowUpError) return c.json({ error: "test_run_follow_up_error", error_description: error.message }, error.status);
    if (error instanceof TestHostHealthError) return c.json({ error: "host_health_error", error_description: error.message }, error.status);
    throw error;
  });
  app.get("/", async c => {
    const parsed = testRunQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new TestRunError(400, "invalid test run list query");
    return c.json(await service.list(parsed.data));
  });
  app.get("/overview", async c => {
    c.header("Cache-Control", "no-store");
    return c.json(await overview.overview());
  });
  app.get("/recent", async c => {
    c.header("Cache-Control", "no-store");
    return c.json(await service.recent());
  });
  app.get("/health", async c => {
    c.header("Cache-Control", "no-store");
    return c.json(await health.list());
  });
  app.get("/health/:hostId", async c => {
    c.header("Cache-Control", "no-store");
    return c.json(await health.history(c.req.param("hostId"), c.req.query("days")));
  });
  app.post("/claims/:requestId/cancel-follow-up", async c => {
    const admin = c.get("developer");
    if (!c.get("isAdmin") || !admin) throw new TestRunFollowUpError(403, "admin access required");
    if (c.req.header("content-type") !== "application/json") throw new TestRunFollowUpError(400, "JSON confirmation required");
    const input = await c.req.json().catch(() => null);
    if (!input || input.confirmation !== "cancel-follow-up" || Object.keys(input).length !== 1)
      throw new TestRunFollowUpError(400, "explicit follow-up cancellation confirmation required");
    return c.json(await followUp.cancel(c.req.param("requestId"), admin.developerId));
  });
  // Explicit reviewed provenance correction of one acknowledged occurrence. The admin session identifies the reviewer;
  // the service still corroborates every binding against the immutable result. No other caller can write it.
  const correctionPath = "/:runId/failures/:occurrenceId/provenance-correction";
  app.get(correctionPath, async c => {
    c.header("Cache-Control", "no-store");
    return c.json(await corrections.read(c.req.param("runId"), c.req.param("occurrenceId")));
  });
  app.post(correctionPath, bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: "too_large" }, 413) }), async c => {
    c.header("Cache-Control", "no-store");
    const admin = c.get("developer");
    if (!c.get("isAdmin") || !admin) throw new TestRunFollowUpError(403, "admin access required");
    if (c.req.header("content-type") !== "application/json") throw new TestRunError(400, "JSON correction required");
    const input = await c.req.json().catch(() => null);
    const result = await corrections.submit(c.req.param("runId"), c.req.param("occurrenceId"), input, admin.developerId);
    return c.json(result.correction, result.created ? 201 : 200);
  });
  app.get("/:runId", async c => c.json(await service.detail(c.req.param("runId"))));
  const evidencePath = "/:runId/failures/:occurrenceId/evidence-supplements";
  app.get(evidencePath, async c => {
    c.header("Cache-Control", "no-store");
    return c.json(await evidence.list(c.req.param("runId"), c.req.param("occurrenceId")));
  });
  app.post(evidencePath, bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: "too_large" }, 413) }), async c => {
    c.header("Cache-Control", "no-store");
    const admin = c.get("developer");
    if (!c.get("isAdmin") || !admin) throw new TestRunFollowUpError(403, "admin access required");
    if (c.req.header("content-type") !== "application/json") throw new TestRunError(400, "JSON evidence supplement required");
    const result = await evidence.submit(c.req.param("runId"), c.req.param("occurrenceId"), await c.req.json().catch(() => null), admin.developerId);
    return c.json(result.supplement, result.created ? 201 : 200);
  });
  app.on(["GET", "HEAD"], "/:runId/assets/:assetId", c => service.media(c.req.param("runId"), c.req.param("assetId"), c.req.raw));
  return app;
}

export default createTestRunAdminApi();
