import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TestRunError, TestRunService } from "../../services/test-run.service";
import { testRunIngestAuth } from "../middleware/test-run-ingest-auth.middleware";
import type { AppEnv } from "../../types/hono.types";

export function createTestRunIngestApi(service = new TestRunService()) {
  const app = new Hono<AppEnv>();
  app.use("*", testRunIngestAuth);
  app.onError((error, c) => {
    if (error instanceof TestRunError) return c.json({ error: "test_run_error", error_description: error.message }, error.status);
    throw error;
  });
  app.post("/", bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: "too_large" }, 413) }), async c => {
    let input: unknown;
    try { input = await c.req.json(); } catch { throw new TestRunError(400, "invalid JSON"); }
    const result = await service.ingest(input);
    return c.json(result, result.created ? 201 : 200);
  });
  app.put("/:runId/assets/:assetId", async c => {
    const result = await service.upload(c.req.param("runId"), c.req.param("assetId"), c.req.raw.body, c.req.raw.headers);
    return c.json(result, result.created ? 201 : 200);
  });
  return app;
}

export default createTestRunIngestApi();
