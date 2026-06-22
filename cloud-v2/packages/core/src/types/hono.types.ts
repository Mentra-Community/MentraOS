/**
 * @fileoverview Hono app environment types for cloud-core.
 *
 * `AppVariables` is the per-request context bag set by middleware and read by
 * handlers. Optional fields are populated by audience-specific auth middleware
 * (e.g. the OEM token middleware sets `oem`; the developer console session
 * middleware sets `developer`). A handler should only depend on the fields its
 * audience's middleware guarantees.
 */

import type { Context } from "hono";
import type { Logger } from "@mentra/cloud-shared";

export interface AppVariables {
  /** Request ID for log correlation. Set by request-id middleware on every request. */
  reqId: string;

  /** Per-request child logger pre-bound with reqId, route, and audience. */
  logger: Logger;

  /** OEM identity from a verified machine-to-machine OEM token. */
  oem?: {
    tenantId: string;
  };

  /** OEM portal user (browser session, WorkOS-issued). */
  oemAdmin?: {
    workosUserId: string;
    tenantId: string;
    role: "owner" | "admin" | "viewer";
  };

  /** End user (mobile client), identified via Mentra-issued access token. */
  user?: {
    mentraUserId: string;
    tenantId: string;
    sessionId: string;
  };

  /** Developer console session. */
  developer?: {
    developerId: string;
    email: string;
  };

  /** Admin scope flag, set when the caller's credential carries admin perms. */
  isAdmin?: boolean;
}

export interface AppEnv {
  Variables: AppVariables;
}

export type AppContext = Context<AppEnv>;
