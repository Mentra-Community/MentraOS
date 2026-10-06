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
 *   /api/workspaces/*           — workspaces: members, invitations, credentials, audit
 *   /api/organization/*         — organization capabilities, workspace administration,
 *                                 operator keys
 *   /api/internal/workspaces/*  — signed service API for the Store and the Fleet
 *                                 integration (64 KiB body limit)
 *
 * Caller convention (auth/spec.md): /api/client/* is device-called and
 * /api/oem/* is reserved for the OEM's backend. The token exchange + refresh
 * routes are device-called, so they live under /api/client/auth, not
 * /api/oem/*.
 *
 * The global error handler translates `OauthError` subtypes to the RFC 8693
 * error body shape `{ error, error_description }`, and `WorkspaceError` to the
 * same shape with its own code and status. Anything else becomes a generic 500.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHealthApp, createLogger, type ReadinessCheck } from "@mentra/cloud-shared";
import type { AppEnv } from "../types/hono.types";
import { OauthError } from "../types/oauth.types";
import { AccountError } from "../services/account/account-error";
import { WorkspaceError } from "../services/workspaces/workspace-error";
import { requestContext } from "./middleware/context.middleware";
import adminApi from "./admin/admin.api";
import browserAuth from "./admin/browser-auth.api";
import reportAgent from "./agent/reports.api";
import testFailureAgent from "./agent/test-failures.api";
import testRunIngest from "./internal/test-runs.api";
import testRunClaims from "./internal/test-run-claims.api";
import testResourceObservations from "./internal/test-resource-observations.api";
import testHostObservations from "./internal/test-host-observations.api";
import clientAuth from "./client/auth.api";
import clientReports from "./client/reports.api";
import clientSupportProfile from "./client/support-profile.api";
import accountApi from "./account/account.api";
import accountOauth from "./account/oauth.api";
import internalIdentity from "./internal/identity.api";
import internalWorkspaces from "./internal/workspaces.api";
import portalEnterprise from "./portal/enterprise.api";
import organizationApi from "./organization/organization.api";
import workspacesApi from "./workspaces/workspaces.api";
import wellKnown from "./well-known.api";

const logger = createLogger("core").child({ service: "app" });

/** The largest request body the internal workspace service API reads. */
const INTERNAL_WORKSPACES_BODY_LIMIT_BYTES = 64 * 1024;

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

  // Legacy minimum-client-version gate for already-released mobile clients.
  // New clients use Runtime's copy. Keep this route until those releases no
  // longer need compatibility with Core.
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
  app.route("/api/agent/test-failures", testFailureAgent);
  app.route("/api/internal/test-runs", testRunIngest);
  app.route("/api/internal/test-run-claims", testRunClaims);
  app.route("/api/internal/test-resource-observations", testResourceObservations);
  app.route("/api/internal/test-host-observations", testHostObservations);
  app.route("/api/account", accountApi);
  app.route("/api/account/oauth", accountOauth);
  app.route("/api/internal/identity", internalIdentity);
  // Service calls carry small JSON bodies; the limit applies before the signature check reads one.
  app.use(
    "/api/internal/workspaces/*",
    bodyLimit({
      maxSize: INTERNAL_WORKSPACES_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );
  app.route("/api/internal/workspaces", internalWorkspaces);
  app.route("/api/portal", portalEnterprise);
  app.route("/api/workspaces", workspacesApi);
  app.route("/api/organization", organizationApi);
  app.route("/api/admin", adminApi);
  app.route("/api/console/auth", browserAuth);

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

    if (err instanceof WorkspaceError) {
      return c.json({ error: err.code, error_description: err.message }, err.status as 400);
    }

    // Unexpected. Log with the per-request logger if available so the line
    // is correlated to the originating request.
    const log = c.var.logger ?? logger;
    log.error({ err }, "unhandled error");
    return c.json({ error: "server_error", error_description: "internal server error" }, 500);
  });

  return app;
}
