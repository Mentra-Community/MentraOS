import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TestRunClaimError, TestRunClaimService } from "../../services/test-run-claim.service";
import type { AppEnv } from "../../types/hono.types";
import { testRunClaimAuth } from "../middleware/test-run-claim-auth.middleware";

export function createTestRunClaimApi(service = new TestRunClaimService()) {
  const app = new Hono<AppEnv>();
  app.use("*", testRunClaimAuth);
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, c) => {
    if (error instanceof TestRunClaimError) {
      return c.json({ error: "test_run_claim_error", error_description: error.message, executionGranted: false }, error.status);
    }
    c.var.logger?.error({ errorName: error.name }, "test run claim outcome unknown");
    return c.json({ error: "claim_outcome_unknown", executionGranted: false,
      error_description: "No execution granted by this response; reconcile the existing request before any device work" }, 503);
  });
  const limit = bodyLimit({ maxSize: 4096, onError: c => c.json({ error: "too_large", executionGranted: false }, 413) });
  const parse = async (req: { json(): Promise<unknown> }) => {
    try { return await req.json(); } catch { throw new TestRunClaimError(400, "invalid JSON"); }
  };
  app.post("/", limit, async c => {
    const result = await service.claim(await parse(c.req));
    return c.json(result, result.executionGranted ? 201 : 200);
  });
  app.get("/:requestId", async c => c.json(await service.get(c.req.param("requestId"))));
  app.put("/:requestId/state", limit, async c => c.json(await service.settle(c.req.param("requestId"), await parse(c.req))));
  app.put("/:requestId/progress", limit, async c => c.json(await service.progress(c.req.param("requestId"), await parse(c.req))));
  return app;
}

export default createTestRunClaimApi();
