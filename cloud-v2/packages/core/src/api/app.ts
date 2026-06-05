/**
 * @fileoverview Root Hono app for cloud-core.
 *
 * Layout:
 *   /healthz, /ready            — health, no middleware (kept lightweight)
 *   /.well-known/jwks.json      — public signing keys (JWKS), unauthenticated
 *   /api/* + request-context    — per-request reqId + logger
 *   /api/client/auth/*          — device-called auth: exchange, refresh,
 *                                 miniapp-token
 *
 * Caller convention (auth/spec.md): /api/client/* is device-called and
 * /api/oem/* is reserved for the OEM's backend. The token exchange + refresh
 * routes are device-called, so they live under /api/client/auth, not
 * /api/oem/*.
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
import clientAuth from "./client/auth.api";
import wellKnown from "./well-known.api";

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

  // Public key discovery. Mounted at the root (not under /api/*) so it lives
  // at the standard /.well-known/jwks.json. Unauthenticated by design: it only
  // exposes public keys.
  app.route("/", wellKnown);

  // Per-request context (reqId, logger) for everything under /api/*.
  app.use("/api/*", requestContext);

  // Audience mounts. Device-called auth lives under /api/client/*.
  app.route("/api/client/auth", clientAuth);

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
