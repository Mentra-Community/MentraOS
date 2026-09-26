import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TestResourceObservationError, TestResourceObservationService } from "../../services/test-resource-observation.service";
import type { AppEnv } from "../../types/hono.types";
import { testRunIngestAuth } from "../middleware/test-run-ingest-auth.middleware";

/**
 * Report-only latest observation of one host resource guard, under the existing
 * result-ingestion capability. It grants no execution, claim, lock or recovery.
 */
export function createTestResourceObservationApi(service = new TestResourceObservationService()) {
  const app = new Hono<AppEnv>();
  app.use("*", testRunIngestAuth);
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, c) => {
    if (error instanceof TestResourceObservationError)
      return c.json({ error: "test_resource_observation_error", error_description: error.message }, error.status);
    throw error;
  });
  const limit = bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: "too_large" }, 413) });
  app.get("/:hostId/:resourceKey", async c => c.json(await service.get(c.req.param("hostId"), c.req.param("resourceKey"))));
  app.put("/:hostId/:resourceKey", limit, async c => {
    let input: unknown;
    try { input = await c.req.json(); } catch { throw new TestResourceObservationError(400, "invalid JSON"); }
    return c.json(await service.put(c.req.param("hostId"), c.req.param("resourceKey"), input));
  });
  return app;
}

export default createTestResourceObservationApi();
