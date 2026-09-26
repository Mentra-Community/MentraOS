import { Hono } from "hono";
import { TestRunError, TestRunService } from "../../services/test-run.service";
import { TestRunOverviewService } from "../../services/test-run-overview.service";
import { TestRunFollowUpError, TestRunFollowUpService } from "../../services/test-run-follow-up.service";
import { testRunQuerySchema } from "../../types/test-run.types";
import type { AppEnv } from "../../types/hono.types";

/** Mounted only behind preinstalled.api's existing adminAuth gate. */
export function createTestRunAdminApi(service = new TestRunService(), overview = new TestRunOverviewService(), followUp = new TestRunFollowUpService()) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof TestRunError) return c.json({ error: "test_run_error", error_description: error.message }, error.status);
    if (error instanceof TestRunFollowUpError) return c.json({ error: "test_run_follow_up_error", error_description: error.message }, error.status);
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
  app.post("/claims/:requestId/cancel-follow-up", async c => {
    const admin = c.get("developer");
    if (!c.get("isAdmin") || !admin) throw new TestRunFollowUpError(403, "admin access required");
    if (c.req.header("content-type") !== "application/json") throw new TestRunFollowUpError(400, "JSON confirmation required");
    const input = await c.req.json().catch(() => null);
    if (!input || input.confirmation !== "cancel-follow-up" || Object.keys(input).length !== 1)
      throw new TestRunFollowUpError(400, "explicit follow-up cancellation confirmation required");
    return c.json(await followUp.cancel(c.req.param("requestId"), admin.developerId));
  });
  app.get("/:runId", async c => c.json(await service.detail(c.req.param("runId"))));
  app.on(["GET", "HEAD"], "/:runId/assets/:assetId", c => service.media(c.req.param("runId"), c.req.param("assetId"), c.req.raw));
  return app;
}

export default createTestRunAdminApi();
