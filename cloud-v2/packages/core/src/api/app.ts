/**
 * @fileoverview Root Hono app for cloud-core.
 *
 * Layout:
 *   /healthz, /ready          — health, no middleware (kept lightweight)
 *   /api/* + request-context  — per-request reqId + logger
 *   /api/oem/oauth/*          — OEM token exchange + refresh
 *
 * The global error handler translates `OauthError` subtypes to the RFC 8693
 * error body shape `{ error, error_description }`. Anything else becomes a
 * generic 500.
 */

import { Hono } from "hono";
import { createHealthApp, createLogger, type ReadinessCheck } from "@mentra/cloud-shared";
import type { AppEnv } from "../types/hono.types";
import { OauthError } from "../types/oauth.types";
import { requestContext } from "./middleware/context.middleware";
import oemTokens from "./oem/tokens.api";

const logger = createLogger("core").child({ service: "app" });

export interface CreateAppOptions {
  readinessChecks: ReadinessCheck[];
}

export function createApp(opts: CreateAppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Health endpoints mount first, before any /api/* middleware. /healthz
  // stays the cheapest possible response; /ready runs the readiness checks.
  app.route(
    "/",
    createHealthApp({
      packageName: "core",
      readinessChecks: opts.readinessChecks,
    }),
  );

  // Per-request context (reqId, logger) for everything under /api/*.
  app.use("/api/*", requestContext);

  // Audience mounts.
  app.route("/api/oem/oauth", oemTokens);

  // Global error translator.
  app.onError((err, c) => {
    if (err instanceof OauthError) {
      return c.json(
        { error: err.code, error_description: err.description },
        // Hono's typing wants a literal status code; cast keeps it loose so
        // future OauthError subclasses (4xx/5xx) compile without a switch.
        err.httpStatus as 400,
      );
    }

    // Unexpected. Log with the per-request logger if available so the line
    // is correlated to the originating request.
    const log = c.var.logger ?? logger;
    log.error({ err }, "unhandled error");
    return c.json(
      { error: "server_error", error_description: "internal server error" },
      500,
    );
  });

  return app;
}
