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
import type {AuthorizeResponse} from "@mentra/workspace-contract"
import type {CorePrincipal} from "../services/signin/principal.service"

export interface AppVariables {
  /** Request ID for log correlation. Set by request-id middleware on every request. */
  reqId: string

  /** Per-request child logger pre-bound with reqId, route, and audience. */
  logger: Logger

  /** OEM identity from a verified machine-to-machine OEM token. */
  oem?: {
    tenantId: string
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

  /**
   * The caller of a portal or workspace API (`/api/admin`, `/api/portal`,
   * `/api/workspaces`, `/api/organization`): a person (a portal session or an
   * identity-provider access token) or a Core credential. Set by `principalAuth`
   * and the gates built on it.
   */
  principal?: CorePrincipal

  /** The decision `requireWorkspaceCapability` allowed the request on. */
  workspaceAuthorization?: AuthorizeResponse

  /** The service that signed an internal service API request (`serviceAuth`). */
  service?: "store"

  /** The raw body the service signature covered, read once by `serviceAuth`. */
  serviceBody?: string

  /** The admin portal's caller, as its label for audit fields. */
  developer?: {
    developerId: string
    email: string
  }
}

export interface AppEnv {
  Variables: AppVariables
}

export type AppContext = Context<AppEnv>
