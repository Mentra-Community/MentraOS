import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TestHostHealthError, TestHostHealthService } from "../../services/test-host-health.service";
import type { AppEnv } from "../../types/hono.types";
import { testRunIngestAuth } from "../middleware/test-run-ingest-auth.middleware";

/** Passive reporting only; no worker, cleanup, fixture or lane mutations. */
export function createTestHostObservationsApi(service = new TestHostHealthService()) {
  const app = new Hono<AppEnv>();
  app.use("*", testRunIngestAuth);
  app.onError((error, c) => {
    if (error instanceof TestHostHealthError) return c.json({ error: "host_observation_error", error_description: error.message }, error.status);
    throw error;
  });
  app.post("/", bodyLimit({ maxSize: 32 * 1024, onError: c => c.json({ error: "too_large" }, 413) }), async c => {
    c.header("Cache-Control", "no-store");
    const result = await service.ingest(await c.req.json().catch(() => null));
    return c.json(result, result.created ? 201 : 200);
  });
  return app;
}
export default createTestHostObservationsApi();
