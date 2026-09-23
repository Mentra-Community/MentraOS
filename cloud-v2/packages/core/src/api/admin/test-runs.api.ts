import { Hono } from "hono";
import { TestRunError, TestRunService } from "../../services/test-run.service";
import { testRunQuerySchema } from "../../types/test-run.types";
import type { AppEnv } from "../../types/hono.types";

/** Mounted only behind Core admin.api's existing adminAuth gate. */
export function createTestRunAdminApi(service = new TestRunService()) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof TestRunError) return c.json({ error: "test_run_error", error_description: error.message }, error.status);
    throw error;
  });
  app.get("/", async c => {
    const parsed = testRunQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new TestRunError(400, "invalid test run list query");
    return c.json(await service.list(parsed.data));
  });
  app.get("/:runId", async c => c.json(await service.detail(c.req.param("runId"))));
  app.on(["GET", "HEAD"], "/:runId/assets/:assetId", c => service.media(c.req.param("runId"), c.req.param("assetId"), c.req.raw));
  return app;
}

export default createTestRunAdminApi();
