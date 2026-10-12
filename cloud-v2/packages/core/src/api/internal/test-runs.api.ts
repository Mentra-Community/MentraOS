import {TestSuiteService} from "../../services/test-suite.service";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TestRunError } from "../../services/test-result-error";
import { testRunIngestAuth } from "../middleware/test-run-ingest-auth.middleware";
import type { AppEnv } from "../../types/hono.types";

export function createTestRunIngestApi() {
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
  return app;
}

export default createTestRunIngestApi();
