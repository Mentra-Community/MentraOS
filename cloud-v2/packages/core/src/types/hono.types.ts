/**
 * @fileoverview Hono app environment types for cloud-core.
 *
 * `AppVariables` is the per-request context bag set by middleware and read by
 * handlers. Optional fields are populated by audience-specific auth middleware
 * (e.g. the OEM token middleware sets `oem`; the developer console session
 * middleware sets `developer`). A handler should only depend on the fields its
 * audience's middleware guarantees.
 */

import type {Context} from "hono"
import type {FederatedIdentity, Logger} from "@mentra/cloud-shared"
import type {AuthorizeResponse, CorePrincipal} from "@mentra/workspace-contract"

export interface AppVariables {
  /** Request ID for log correlation. Set by request-id middleware on every request. */
  reqId: string

  /** Per-request child logger pre-bound with reqId, route, and audience. */
  logger: Logger

  /** OEM identity from a verified machine-to-machine OEM token. */
  oem?: {
    tenantId: string
  }

  /** OEM portal user (browser session, WorkOS-issued). */
  oemAdmin?: {
    workosUserId: string
    tenantId: string
    role: "owner" | "admin" | "viewer"
  }

  /** End user (mobile client), identified via Mentra-issued access token. */
  user?: {
    mentraUserId: string
    tenantId: string
    sessionId: string
    accessTokenJti: string
    accessTokenExpiresAt: number
    federatedIdentity?: FederatedIdentity
  }

  /** Developer console session. */
  developer?: {
    developerId: string
    email: string
  }

  /** Admin scope flag, set when the caller's credential carries admin perms. */
  isAdmin?: boolean

  /**
   * Who is calling, resolved once per request by `principalAuth` (or the first
   * `requireOrganizationCapability` / `requireWorkspaceCapability` that needs
   * it): a signed-in person (WorkOS bearer or session) or an `msk_` / `mak_`
   * credential.
   */
  principal?: CorePrincipal

  /** The workspace decision `requireWorkspaceCapability` made for this request; set only when it allowed it. */
  workspaceAuthorization?: AuthorizeResponse

  /** The trusted service (for example the Store) behind an internal service API call. */
  service?: string
}

export interface AppEnv {
  Variables: AppVariables
}

export type AppContext = Context<AppEnv>
