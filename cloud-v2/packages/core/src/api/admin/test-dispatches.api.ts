import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { GithubTestBuildGateway, TestDispatchError, type TestBuildGateway } from "../../services/test-builds.service";
import { TestDispatchService } from "../../services/test-dispatch.service";
import { TEST_ROUTINES, testBuildQuerySchema } from "../../types/test-dispatch.types";
import type { AppEnv } from "../../types/hono.types";

/** Mounted behind the existing admin session gate; worker capability tokens do not grant access. */
export function createTestDispatchAdminApi(service = new TestDispatchService(), builds: TestBuildGateway = new GithubTestBuildGateway()) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof TestDispatchError) return c.json({ error: "test_dispatch_error", error_description: error.message }, error.status);
    return c.json({ error: "test_dispatch_unavailable", error_description: "Routine request service is unavailable; retain the submission ID and check its status before retrying." }, 503);
  });
  app.get("/test-routines", c => c.json({ routines: TEST_ROUTINES }));
  app.get("/test-builds", async c => {
    const parsed = testBuildQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new TestDispatchError(400, "Choose PR, dev or staging; PR requires a positive PR number");
    return c.json({ builds: await builds.inventory(parsed.data) });
  });
  app.get("/test-dispatches", async c => c.json(await service.list()));
  app.get("/test-dispatches/:dispatchId", async c => c.json(await service.detail(c.req.param("dispatchId"))));
  app.post("/test-dispatches", bodyLimit({ maxSize: 4096, onError: c => c.json({ error: "too_large" }, 413) }), async c => {
    // JSON prevents a cross-origin form from submitting with the admin's cookies.
    if (c.req.header("content-type")?.split(";")[0] !== "application/json")
      throw new TestDispatchError(400, "application/json is required");
    let input: unknown;
    try { input = await c.req.json(); } catch { throw new TestDispatchError(400, "Invalid JSON"); }
    return c.json(await service.create(input, c.var.developer?.email ?? ""), 202);
  });
  return app;
}
export default createTestDispatchAdminApi();
