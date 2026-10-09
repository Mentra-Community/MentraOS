/**
 * @fileoverview Hono app environment types for cloud-core.
 *
 * `AppVariables` is the per-request context bag set by middleware and read by
 * handlers. Optional fields are populated by audience-specific auth middleware
 * (e.g. the mobile client token middleware sets `user`; `principalAuth` sets
 * `principal`). A handler should only depend on the fields its audience's
 * middleware guarantees.
 */

import type {Context} from "hono"
import type {FederatedIdentity, Logger} from "@mentra/cloud-shared"
import type {AuthorizeResponse, CorePrincipal} from "@mentra/workspace-contract"

export interface AppVariables {
  /** Request ID for log correlation. Set by request-id middleware on every request. */
  reqId: string

  /** Per-request child logger pre-bound with reqId, route, and audience. */
  logger: Logger

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
   * Who is calling, resolved once per request by `principalAuth` (or the first
   * `requireOrganizationCapability` / `requireWorkspaceCapability` that needs
   * it): a signed-in person (WorkOS bearer or session) or an `msk_` / `mak_`
   * credential.
   */
  principal?: CorePrincipal

  /** The workspace decision `requireWorkspaceCapability` made for this request; set only when it allowed it. */
  workspaceAuthorization?: AuthorizeResponse

  /**
   * The trusted service behind an internal service API call, set by `serviceAuth` once the request's
   * signature verified: the Store (`store`) or the Fleet integration (`fleet`).
   */
  service?: "store" | "fleet"

  /** The raw request body `serviceAuth` read to verify the signature, which it covers. Parse this, not the stream. */
  serviceBody?: string
}

export interface AppEnv {
  Variables: AppVariables
}

export type AppContext = Context<AppEnv>
