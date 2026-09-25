import { Hono, type MiddlewareHandler } from "hono";
import { testFailureEnvironment, verifyTestFailureReadGrant, verifyTestContinuationGrant } from "../../services/test-failure-auth";
import { TestRunError, TestRunService } from "../../services/test-run.service";
import { TestContinuationService } from "../../services/test-continuation.service";
import { TestDispatchError } from "../../services/test-builds.service";
import { ZodError } from "zod";
import type { ContinuationGrant } from "../../types/test-continuation.types";
import type { AppEnv } from "../../types/hono.types";

/** A capability grants one occurrence and its assigned redacted assets, never inventory or writes. */
export function createTestFailureAgentApi(service = new TestRunService(), continuation = new TestContinuationService()) {
  type Env = AppEnv & { Variables: AppEnv["Variables"] & { continuationGrant: ContinuationGrant } };
  const app = new Hono<Env>();
  const capability = (action: "request-routine" | "read-results"): MiddlewareHandler<Env> => async (c, next) => {
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
    const grant = verifyTestContinuationGrant(token, c.req.param("occurrenceId") ?? "",
      process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET ?? "", testFailureEnvironment());
    if (!grant || !grant.actions.includes(action)) return c.json({ error: "unauthorized", error_description: "case continuation grant required" }, 401);
    c.set("continuationGrant", grant); c.header("Cache-Control", "private, no-store");
    return next();
  };
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
    if (error instanceof ZodError) return c.json({ error: "invalid_request", error_description: "Invalid continuation request" }, 400);
    if (error instanceof TestDispatchError) return c.json({ error: "test_continuation_error", error_description: error.message }, error.status);
    if (error instanceof TestRunError) return c.json({ error: "test_failure_error", error_description: error.message }, error.status);
    throw error;
  });
  app.get("/:occurrenceId/builds", capability("read-results"), c =>
    continuation.inventory(c.get("continuationGrant"), c.req.query("routineId")).then(value => c.json(value)));
  app.get("/:occurrenceId/reruns", capability("read-results"), c => continuation.list(c.get("continuationGrant")).then(value => c.json(value)));
  app.post("/:occurrenceId/reruns", capability("request-routine"), async c => {
    const text = await c.req.text();
    if (text.length > 8192) return c.json({ error: "invalid_request" }, 400);
    let input; try { input = JSON.parse(text); } catch { return c.json({ error: "invalid_request" }, 400); }
    return c.json(await continuation.request(c.get("continuationGrant"), input), 202);
  });
  app.get("/:occurrenceId/reruns/:operationId", capability("read-results"), c =>
    continuation.detail(c.get("continuationGrant"), c.req.param("operationId")).then(value => c.json(value)));
  app.get("/:occurrenceId/reruns/:operationId/failures/:failureId", capability("read-results"), c =>
    continuation.failure(c.get("continuationGrant"), c.req.param("operationId"), c.req.param("failureId")).then(value => c.json(value)));
  app.on(["GET", "HEAD"], "/:occurrenceId/reruns/:operationId/failures/:failureId/assets/:assetId", capability("read-results"), c =>
    continuation.media(c.get("continuationGrant"), c.req.param("operationId"), c.req.param("failureId"), c.req.param("assetId"), c.req.raw));
  app.get("/:occurrenceId", authorize, c => service.failureDetail(c.req.param("occurrenceId")).then(value => c.json(value)));
  app.on(["GET", "HEAD"], "/:occurrenceId/assets/:assetId", authorize, c =>
    service.failureMedia(c.req.param("occurrenceId"), c.req.param("assetId"), c.req.raw));
  app.all("*", c => c.json({ error: "unauthorized", error_description: "occurrence-scoped read grant required" }, 401));
  return app;
}

export default createTestFailureAgentApi();
