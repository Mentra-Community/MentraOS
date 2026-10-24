/**
 * @fileoverview Root Hono app for cloud-core.
 *
 * Layout:
 *   /healthz, /ready            — health, no middleware (kept lightweight)
 *   /.well-known/jwks.json      — public signing keys (JWKS), unauthenticated
 *   /.well-known/openid-configuration, /oidc/*, /interaction/*
 *                               — Core's sign-in server (OpenID Connect provider),
 *                                 on the issuer CLOUD_CORE_OIDC_ISSUER
 *   /api/* + request-context    — per-request reqId + logger
 *   /api/client/auth/*          — device-called auth: exchange, refresh,
 *                                 miniapp-token
 *   /api/client/reports/*       — device-filed reports
 *   /api/client/bluetooth-sdk/* — Bluetooth SDK startup update check,
 *                                 unauthenticated (called from customer apps)
 *   /api/client/workspaces/*    — the Mentra App's workspace: mine, invitations (accept,
 *                                 decline), leave
 *   /api/client/fleet/*         — a phone's Fleet reports, forwarded to the optional Fleet
 *                                 service (404 fleet_not_installed without one)
 *   /api/client/registry/*      — the Mentra App's registry calls: register a miniapp URL at
 *                                 install (Core verifies it), and the updater's status batch
 *   /api/client/miniapps/*      — LEGACY: the frozen preinstalled catalog that
 *                                 released Mentra App versions still install from
 *   /api/agent/reports/*        — read-only private dev-agent access
 *   /api/cli/config             — the issuer and client ID the `mentra` CLI signs
 *                                 in with, unauthenticated
 *   /api/admin/auth/*, /api/portal/auth/*
 *                               — portal sign-in (the deployment's identity provider)
 *   /api/admin/*                — the admin portal's API (capability-gated), incl.
 *                                 /api/admin/workspaces and /api/admin/organization, and
 *                                 /api/admin/fleet/*, forwarded to the optional Fleet
 *                                 service for an Organization Admin
 *   /api/portal/*               — the workspace portal's API, incl. /api/portal/workspaces
 *   /api/workspaces/*, /api/organization/*
 *                               — the same workspace and organization handlers, for
 *                                 bearers (identity-provider access tokens, Core keys)
 *   /api/internal/workspaces/*  — the signed service API the Store calls (64 KiB body limit)
 *   /api/internal/licenses/*    — the signed license API the Store's billing module calls
 *                                 (64 KiB body limit)
 *   /api/internal/fleet/*       — the signed API Fleet calls: each workspace's assigned
 *                                 miniapps (64 KiB body limit)
 *   everything else (GET)       — the admin portal's files, when
 *                                 CLOUD_CORE_ADMIN_STATIC_DIR is set (Private Cloud)
 *
 * Caller convention (auth/spec.md): /api/client/* is device-called and
 * /api/oem/* is reserved for the OEM's backend. The token exchange + refresh
 * routes are device-called, so they live under /api/client/auth, not
 * /api/oem/*.
 *
 * The global error handler translates `OauthError` subtypes to the RFC 8693
 * error body shape `{ error, error_description }`, and expected workspace
 * failures (`WorkspaceError`) to the same shape with their status (plus any
 * fields the error carries in `details`). Anything
 * else becomes a generic 500.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHealthApp, createLogger, type ReadinessCheck } from "@mentra/cloud-shared";
import type { AppEnv } from "../types/hono.types";
import { OauthError } from "../types/oauth.types";
import { AccountError } from "../services/account/account-error";
import { requestContext } from "./middleware/context.middleware";
import adminApi from "./admin/admin.api";
import reportAgent from "./agent/reports.api";
import {createInternalRoutineCaseApi} from './internal/routine-cases.api';
import {createTestRequestsApi} from "./internal/test-requests.api";
import {createPrRoutineCheckApi} from './internal/pr-routine-check.api';
import {createFrameworkResultsApi} from "./internal/framework-results.api";
import {createTestHostStateApi} from "./internal/test-host-state.api";
import {createRoutineDefinitionsApi} from "./internal/routine-definitions.api";
import {createNightlyRoutinesApi} from "./internal/nightly-routines.api";
import {createStateRepairDiagnosticsApi} from "./internal/state-repair-diagnostics.api";
import {createTestRerunsApi} from "./internal/test-reruns.api";
import {createRoutineJobsApi, createRoutineJobBindingApi} from './internal/routine-jobs.api';
import {createTestingDispatchApi} from './internal/testing-dispatch.api';
import {createRoutineDispatchesApi} from "./internal/routine-dispatches.api";
import {createRoutineWorkIntakeApi, createRoutineWorkDeliveriesApi} from "./internal/routine-work.api";
import testRunIngest from "./internal/test-runs.api";
import testHostObservations from "./internal/test-host-observations.api";
import clientAuth from "./client/auth.api";
import clientReports from "./client/reports.api";
import clientSupportProfile from "./client/support-profile.api";
import clientWorkspaces from "./client/workspaces.api";
import clientMiniapps from "./client/miniapps.api";
import clientRegistry from "./client/registry.api";
import clientBluetoothSdk from "./client/bluetooth-sdk.api";
import { clientFleetApi } from "./fleet/fleet-forwarding";
import accountApi from "./account/account.api";
import accountOauth from "./account/oauth.api";
import cliApi from "./cli/cli.api";
import portalEnterprise from "./portal/enterprise.api";
import internalFleet from "./internal/fleet.api";
import internalLicenses from "./internal/licenses.api";
import internalWorkspaces from "./internal/workspaces.api";
import { createOrganizationApi } from "./organization/organization.api";
import { createWorkspacesApi } from "./workspaces/workspaces.api";
import { WorkspaceError } from "../services/workspaces/workspace-error";
import wellKnown from "./well-known.api";
import { createAdminStaticApp } from "./admin-static";
import { createOidcApi } from "./oidc/oidc.api";

const logger = createLogger("core").child({ service: "app" });

/** The largest body the signed workspace, license and Fleet service APIs read. */
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

  // Core's sign-in server (OpenID Connect provider): discovery, /oidc/* and
  // /interaction/*. Answers 404 unless CLOUD_CORE_OIDC_ISSUER is set.
  app.route("/", createOidcApi());

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
  app.route("/api/client/workspaces", clientWorkspaces);
  app.route("/api/client/bluetooth-sdk", clientBluetoothSdk);
  app.route("/api/client/registry", clientRegistry);
  // Fleet is optional and lives in its own service; Core authenticates the phone (its own gate) and forwards.
  app.route("/api/client/fleet", clientFleetApi);
  app.route("/api/agent/reports", reportAgent);
  app.route("/api/cli", cliApi);
  // Service calls carry small JSON bodies; the limit applies before the signature check reads one.
  app.use(
    "/api/internal/workspaces/*",
    bodyLimit({
      maxSize: INTERNAL_WORKSPACES_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );
  app.route("/api/internal/workspaces", internalWorkspaces);
  app.use(
    "/api/internal/licenses/*",
    bodyLimit({
      maxSize: INTERNAL_WORKSPACES_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );
  app.route("/api/internal/licenses", internalLicenses);
  app.use(
    "/api/internal/fleet/*",
    bodyLimit({
      maxSize: INTERNAL_WORKSPACES_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );
  app.route("/api/internal/fleet", internalFleet);
  app.route("/api/internal/test-requests", createRoutineJobBindingApi());
  app.route("/api/internal/test-requests", createTestRequestsApi());
  app.route("/api/internal/routine-cases", createInternalRoutineCaseApi());
  app.route("/api/internal/routine-jobs", createRoutineJobsApi());
  app.route('/api/internal/pr-routine-checks', createPrRoutineCheckApi());
  app.route("/api/internal/testing/dispatch", createTestingDispatchApi());
  app.route("/api/internal/framework-results", createFrameworkResultsApi());
  app.route("/api/internal/test-host-state", createTestHostStateApi());
  app.route("/api/internal/routine-definitions", createRoutineDefinitionsApi());
  app.route("/api/internal/nightly-routines", createNightlyRoutinesApi());
  app.route("/api/internal/test-repairs", createStateRepairDiagnosticsApi());
  app.route("/api/internal", createRoutineDispatchesApi());
  app.route("/api/internal/test-reruns", createTestRerunsApi());
  app.route("/api/internal/routine-work", createRoutineWorkIntakeApi());
  app.route("/api/internal/routine-work-deliveries", createRoutineWorkDeliveriesApi());
  app.route("/api/internal/test-runs", testRunIngest);
  app.route("/api/internal/test-host-observations", testHostObservations);
  // LEGACY: released Mentra App versions install their preinstalled miniapps
  // from here until supported versions install only from the Store's backend.
  app.route("/api/client/miniapps", clientMiniapps);
  app.route("/api/account", accountApi);
  app.route("/api/account/oauth", accountOauth);
  app.route("/api/portal", portalEnterprise);
  app.route("/api/admin", adminApi);
  app.route("/api/workspaces", createWorkspacesApi());
  app.route("/api/organization", createOrganizationApi());

  // A Private Cloud serves the admin portal from Core itself, on Core's host.
  // Mounted last: it answers only GET/HEAD outside /api and /.well-known.
  const adminStaticDir = process.env.CLOUD_CORE_ADMIN_STATIC_DIR?.trim();
  if (adminStaticDir) app.route("/", createAdminStaticApp(adminStaticDir));

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
      // `details` add fields (a 409 workspace_has_holds lists the holds); they never replace these two.
      return c.json({ ...err.details, error: err.code, error_description: err.message }, err.status as 400);
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
