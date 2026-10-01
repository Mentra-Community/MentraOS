import {TestSuiteService} from "../../services/test-suite.service";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TestRunError, TestRunService } from "../../services/test-run.service";
import { testRunIngestAuth } from "../middleware/test-run-ingest-auth.middleware";
import { WorkerDiagnosticsService } from "../../services/worker-diagnostics.service";
import { WORKER_DIAGNOSTICS_MAX_BYTES } from "../../types/worker-diagnostics.types";
import type { AppEnv } from "../../types/hono.types";

export function createTestRunIngestApi(service = new TestRunService(),
  diagnostics: Pick<WorkerDiagnosticsService, "forRun"> = new WorkerDiagnosticsService()) {
  const app = new Hono<AppEnv>();
  app.use("*", testRunIngestAuth);
  app.onError((error, c) => {
    if (error instanceof TestRunError) return c.json({ error: "test_run_error", error_description: error.message }, error.status);
    throw error;
  });
  const suites = new TestSuiteService();
  const suiteLimit = bodyLimit({maxSize: 64 * 1024, onError: c => c.json({error: "too_large"}, 413)});
  app.post("/suites", suiteLimit, async c => c.json(await suites.create(await c.req.json().catch(() => null)), 200));
  app.get("/suites/:suiteId", async c => c.json(await suites.detail(c.req.param("suiteId"))));
  app.post("/suites/:suiteId/members/:memberId", suiteLimit, async c => c.json(await suites.bind(c.req.param("suiteId"), c.req.param("memberId"), await c.req.json().catch(() => null))));
  app.post("/suites/:suiteId/complete", suiteLimit, async c => c.json(await suites.complete(c.req.param("suiteId"), await c.req.json().catch(() => null))));
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
  app.post("/:runId/diagnostics", bodyLimit({ maxSize: WORKER_DIAGNOSTICS_MAX_BYTES,
    onError: c => c.json({ error: "too_large" }, 413) }), async c => {
    let input: unknown;
    try { input = await c.req.json(); } catch { throw new TestRunError(400, "invalid JSON"); }
    c.header("Cache-Control", "private, no-store");
    return c.json(await diagnostics.forRun(c.req.param("runId"), input));
  });
  return app;
}

export default createTestRunIngestApi();
