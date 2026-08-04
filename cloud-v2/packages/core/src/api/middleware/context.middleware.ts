/**
 * @fileoverview Per-request context middleware.
 *
 * Runs first on every request inside `/api/*`. Two responsibilities:
 *
 *   1. Assign a request ID. Use the inbound `X-Request-Id` header if the
 *      caller (frontend, proxy, another service) already chose one so traces
 *      chain across hops; otherwise mint a fresh ULID. Echoed back in the
 *      response header so the client can correlate too.
 *
 *   2. Attach a per-request child logger pre-bound with `reqId`, method, and
 *      path. Handlers should log via `c.var.logger` rather than the root
 *      logger so every log line in a request is automatically correlated.
 */

import { createMiddleware } from "hono/factory";
import { ulid } from "ulid";
import { createLogger } from "@mentra/cloud-shared";
import type { AppEnv } from "../../types/hono.types";

const rootLogger = createLogger("core");

export const requestContext = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const reqId = incoming && incoming.length <= 64 ? incoming : ulid();

  c.set("reqId", reqId);
  c.set(
    "logger",
    rootLogger.child({
      reqId,
      method: c.req.method,
      path: c.req.path,
    }),
  );

  c.header("x-request-id", reqId);

  await next();
});
