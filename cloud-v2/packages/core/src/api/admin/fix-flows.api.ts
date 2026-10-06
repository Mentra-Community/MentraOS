import { Hono } from "hono";
import { FixFlowService } from "../../services/fix-flow.service";
import { TestRunError } from "../../services/test-run.service";
import type { AppEnv } from "../../types/hono.types";

/** Read-only, mounted behind admin.api's `organization.testing.read` gate. */
export function createFixFlowAdminApi(service = new FixFlowService()) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });
  app.onError((error, c) => {
    if (error instanceof TestRunError) return c.json({ error: "fix_flow_error", error_description: error.message }, error.status);
    return c.json({ error: "fix_flow_unavailable", error_description: "Fix flows could not refresh. Try again." }, 503);
  });
  app.get("/", async c => c.json(await service.list()));
  app.get("/runs/:runId/steps/:stepId", async c => c.json(await service.chapter(c.req.param("runId"), c.req.param("stepId"))));
  app.get("/:occurrenceId", async c => c.json(await service.detail(c.req.param("occurrenceId"))));
  return app;
}
export default createFixFlowAdminApi();
