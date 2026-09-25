import { Hono, type MiddlewareHandler } from "hono";
import { testFailureEnvironment, verifyTestFailureReadGrant } from "../../services/test-failure-auth";
import { TestRunError, TestRunService } from "../../services/test-run.service";
import type { AppEnv } from "../../types/hono.types";

/** A capability grants one occurrence and its assigned redacted assets, never inventory or writes. */
export function createTestFailureAgentApi(service = new TestRunService()) {
  const app = new Hono<AppEnv>();
  const authorize: MiddlewareHandler<AppEnv> = async (c, next) => {
    const authorization = c.req.header("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const occurrenceId = c.req.param("occurrenceId") ?? "";
    if (!["GET", "HEAD"].includes(c.req.method) || !verifyTestFailureReadGrant(token, occurrenceId,
      process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET ?? "", testFailureEnvironment()))
      return c.json({ error: "unauthorized", error_description: "occurrence-scoped read grant required" }, 401);
    c.header("Cache-Control", "private, no-store");
    return next();
  };
  app.onError((error, c) => {
    if (error instanceof TestRunError) return c.json({ error: "test_failure_error", error_description: error.message }, error.status);
    throw error;
  });
  app.get("/:occurrenceId", authorize, c => service.failureDetail(c.req.param("occurrenceId")).then(value => c.json(value)));
  app.on(["GET", "HEAD"], "/:occurrenceId/assets/:assetId", authorize, c =>
    service.failureMedia(c.req.param("occurrenceId"), c.req.param("assetId"), c.req.raw));
  app.all("*", c => c.json({ error: "unauthorized", error_description: "occurrence-scoped read grant required" }, 401));
  return app;
}

export default createTestFailureAgentApi();
