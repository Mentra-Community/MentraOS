/**
 * @fileoverview Root Hono app for cloud-core.
 *
 * Layout:
 *   /healthz, /ready            — health, no middleware (kept lightweight)
 *   /.well-known/jwks.json      — public signing keys (JWKS), unauthenticated
 *   /api/* + request-context    — per-request reqId + logger
 *   /api/client/auth/*          — device-called auth: exchange, refresh,
 *                                 miniapp-token
 *   /api/client/reports/*       — device-filed reports
 *   /api/agent/reports/*        — read-only private dev-agent access
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
import { AccountError } from "../services/account/account-error";
import { requestContext } from "./middleware/context.middleware";
import adminPreinstalled from "./admin/preinstalled.api";
import reportAgent from "./agent/reports.api";
import clientAuth from "./client/auth.api";
import clientReports from "./client/reports.api";
import clientSupportProfile from "./client/support-profile.api";
import clientMiniapps from "./client/miniapps.api";
import accountApi from "./account/account.api";
import accountOauth from "./account/oauth.api";
import consoleAuth from "./console/cli-auth.api";
import portalEnterprise from "./portal/enterprise.api";
import storeCatalog from "./store/catalog.api";
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

  // Minimum-client-version gate. Device-called, unauthenticated: the mobile
  // app hits this on boot (RestComms.getMinimumClientVersion) before login and
  // refuses to proceed if it can't reach it. Versions are config-driven and
  // default to "0.0.0" so any build passes unless an operator pins a floor.
  app.get("/api/client/min-version", (c) =>
    c.json({
      success: true,
      data: {
        required: process.env.CLOUD_CLIENT_MIN_VERSION ?? "0.0.0",
        recommended: process.env.CLOUD_CLIENT_RECOMMENDED_VERSION ?? "0.0.0",
      },
    }),
  );

  // Audience mounts. Device-called auth lives under /api/client/*.
  app.route("/api/client/auth", clientAuth);
  app.route("/api/client/reports", clientReports);
  app.route("/api/client/support-profile", clientSupportProfile);
  app.route("/api/agent/reports", reportAgent);
  app.route("/api/client/miniapps", clientMiniapps);
  app.route("/api/account", accountApi);
  app.route("/api/account/oauth", accountOauth);
  app.route("/api/console", consoleAuth);
  app.route("/api/portal", portalEnterprise);
  app.route("/api/store", storeCatalog);
  app.route("/api/admin", adminPreinstalled);

  // Global error translator.
  app.onError((err, c) => {
    if (err instanceof OauthError || err instanceof AccountError) {
      return c.json(
        { error: err.code, error_description: err.description },
        // Hono's typing wants a literal status code; cast keeps it loose so
        // future error subclasses (4xx/5xx) compile without a switch.
        err.httpStatus as 400,
      );
    }

    // Unexpected. Log with the per-request logger if available so the line
    // is correlated to the originating request.
    const log = c.var.logger ?? logger;
    log.error({ err }, "unhandled error");
    return c.json({ error: "server_error", error_description: "internal server error" }, 500);
  });

  return app;
}
