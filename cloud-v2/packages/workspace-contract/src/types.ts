/** Wire types for Core's internal workspace service API. */
import type {OrganizationCapability, WorkspaceCapability, WorkspaceRole} from "./capabilities"

export type CorePrincipal =
  | {
      kind: "user"
      mentraUserId: string
      email: string | null
      emailVerified: boolean
      /** Display name from the identity provider (first and last name, trimmed), or null when it has none. */
      name: string | null
      workosUserId: string | null
      isOrganizationAdmin: boolean
    }
  | {
      kind: "credential"
      credentialId: string
      credentialKind: "workspace" | "organization"
      workspaceId: string | null
      scopes: string[]
      /**
       * Non-empty: the key may act only on these packages. A consumer that lists or acts on packages
       * must filter by it, and must pass `packageName` to `/authorize` for anything package-specific
       * (see {@link AuthorizeRequest.packageName}).
       */
      packageNames: string[]
      label: string
    }

export interface WorkspaceSummary {
  workspaceId: string
  name: string
  status: "active" | "deleted"
  authorizationRevision: number
}

export interface MembershipSummary {
  membershipId: string
  role: WorkspaceRole
}

export type AuthorizeCredential = {type: "bearer"; token: string} | {type: "mentra_user"; mentraUserId: string}

export interface AuthorizeRequest {
  credential: AuthorizeCredential
  workspaceId?: string
  capability?: WorkspaceCapability
  /**
   * The package the request acts on. A package-scoped credential (non-empty
   * `principal.packageNames`) is refused with `package_out_of_scope` for any other package.
   *
   * Omitting it authorizes the capability workspace-wide, package-scoped keys included: Core cannot
   * apply a package restriction to a request that names no package. So every route that reads or
   * changes one package must pass it, and a route that lists packages must itself filter the result
   * by `principal.packageNames`. People and workspace-wide keys are never package-scoped.
   */
  packageName?: string
}

export type DenyReason =
  | "unauthenticated"
  | "not_a_member"
  | "capability_missing"
  | "workspace_not_found"
  | "workspace_deleted"
  | "package_out_of_scope"
  | "credential_invalid"

export interface AuthorizeResponse {
  allowed: boolean
  reason?: DenyReason
  principal: CorePrincipal | null
  workspace?: WorkspaceSummary | null
  membership?: MembershipSummary | null
  capabilities: WorkspaceCapability[]
}

export interface PrincipalResponse {
  principal: CorePrincipal
  workspaces: Array<WorkspaceSummary & {membership: MembershipSummary; capabilities: WorkspaceCapability[]}>
}

export interface MembershipCheckEntry {
  role: WorkspaceRole
  capabilities: WorkspaceCapability[]
}

/** Response of `POST /memberships/check`: one entry per requested workspace, null for a non-member. */
export interface MembershipCheckResponse {
  memberships: Record<string, MembershipCheckEntry | null>
}

/** Response of `POST /credentials`. The token is shown once. */
export interface ServiceCredentialResponse {
  credentialId: string
  token: string
}

/** Response of `POST /users/resolve-email`: the Mentra user behind a verified account email. */
export interface ResolveEmailResponse {
  mentraUserId: string
}

/**
 * One entry of Core's change feed. `eventId` identifies the event; `seq` is its position in Core's
 * audit trail, assigned in commit order, and is the only thing to page by: pass the last `seq` you
 * processed (as a decimal string) as the next request's `after`. The feed leaves out
 * organization-level events (operator keys), so consecutive feed events can skip `seq` numbers;
 * a skipped number is never a missed workspace event.
 *
 * `workspaceId` is null only for user-level tombstones ({@link USER_DELETED_ACTION}). `target`,
 * `before` and `after` are snapshots whose shape depends on `action` (see the event catalog in
 * Core's `docs/fleet-integration.md`), with every credential-looking key (`token`, `secret`,
 * `hash`, `password`) removed.
 */
export interface WorkspaceChangeEvent {
  eventId: string
  seq: number
  workspaceId: string | null
  action: string
  occurredAt: string
  target: Record<string, unknown>
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

/**
 * `action` of the change-feed tombstone recorded when a Mentra account is deleted: `workspaceId` is
 * null and `target` is `{mentraUserId}`. Each membership it ended was recorded before it as a
 * `membership.removed` event with `after.endedReason: "account_deleted"`.
 */
export const USER_DELETED_ACTION = "user.deleted"

// --- Membership history (Fleet) --------------------------------------------

/** Why a membership generation ended. */
export const MEMBERSHIP_ENDED_REASONS = ["removed", "left", "workspace_deleted", "account_deleted"] as const
export type MembershipEndedReason = (typeof MEMBERSHIP_ENDED_REASONS)[number]

/**
 * One role a person held within one membership generation, over the half-open interval
 * `[from, to)`. `to` is the next role's `from` or the generation's `endedAt`, and null while the
 * role is still held. `authorizationRevision` is the workspace's revision from the change that
 * started this role (the revision `/authorize` reported from then on); a role imported from the
 * Store carries the workspace's revision at import.
 */
export interface MembershipRoleInterval {
  role: WorkspaceRole
  from: string
  to: string | null
  authorizationRevision: number
}

/**
 * One membership generation: joining starts one, and leaving, removal, workspace deletion or
 * account deletion ends it. Rejoining is a new generation with a new `membershipId`. `roles` lists
 * the roles held during it, oldest first, without gaps.
 */
export interface MembershipGeneration {
  membershipId: string
  startedAt: string
  endedAt: string | null
  endedReason: MembershipEndedReason | null
  roles: MembershipRoleInterval[]
}

/**
 * `GET /workspaces/:workspaceId/memberships/history`: the generations of one person in one workspace
 * that were in effect at or after `windowStart`, oldest first. A generation or role that began
 * before `windowStart` and was still in effect at it is returned whole, with its real start;
 * anything that ended at or before `windowStart` is left out.
 */
export interface MembershipHistoryResponse {
  windowStart: string
  items: MembershipGeneration[]
}

/** The membership generation, and the role within it, in effect at one time. */
export interface MembershipAtTime {
  membershipId: string
  startedAt: string
  endedAt: string | null
  endedReason: MembershipEndedReason | null
  role: MembershipRoleInterval
}

/** One question of an as-of lookup: the membership `mentraUserId` had in `workspaceId` at `at` (default: now). */
export interface MembershipAsOfQuery {
  workspaceId: string
  mentraUserId: string
  /** An ISO 8601 time with a time zone, e.g. `2026-10-08T12:00:00.000Z`. */
  at?: string
}

/** One answer of an as-of lookup. `membership` is null when the person was not a member then. */
export interface MembershipAsOfResult {
  workspaceId: string
  mentraUserId: string
  /** The time asked about, normalized to ISO 8601 UTC. */
  at: string
  membership: MembershipAtTime | null
}

/** `GET /workspaces/:workspaceId/memberships/as-of`. */
export interface MembershipAsOfResponse extends MembershipAsOfResult {
  windowStart: string
}

/** `POST /memberships/as-of`: one result per query, in the order asked. */
export interface MembershipAsOfBatchResponse {
  windowStart: string
  items: MembershipAsOfResult[]
}

/**
 * `error` value of the 400 a history or as-of request answers when it asks about a time before the
 * lookback Core keeps for Fleet (`CLOUD_CORE_FLEET_HISTORY_MAX_DAYS`, 90 days by default).
 */
export const HISTORY_WINDOW_EXCEEDED_ERROR = "history_window_exceeded"

/** The most queries one `POST /memberships/as-of` may carry. */
export const MAX_MEMBERSHIP_AS_OF_QUERIES = 100

// --- Forwarded principals (Core -> Fleet) ----------------------------------

/**
 * The headers Core adds to a request it forwards to the Fleet integration, beyond the service
 * signature headers (`SERVICE_HEADERS`, with `x-mentra-service: core`). `principal` is the caller as
 * base64url JSON ({@link ForwardedPrincipal}); `principalSignature` is a base64url HMAC-SHA256,
 * keyed with the same secret as the service signature, over `<timestamp>\n<principal header>`.
 * Verify both with `verifyForwardedPrincipal` from `@mentra/workspace-contract/server`.
 */
export const FORWARDED_PRINCIPAL_HEADERS = {
  principal: "x-mentra-principal",
  principalSignature: "x-mentra-principal-signature",
} as const

/** The `x-mentra-service` value of every request Core forwards. */
export const FORWARDING_SERVICE = "core"

/**
 * Who a forwarded request is from. `/v1/client` only ever receives `phone` principals and
 * `/v1/admin` only `user` or `credential` principals.
 *
 * - `phone`: a signed-in phone session.
 * - `user`: a signed-in person. `isOrganizationAdmin` comes from a verified identity email;
 *   `email` may be unverified (`emailVerified`) and is never an authorization.
 * - `credential`: a Core credential. Core never forwards the bearer, so the receiver cannot ask
 *   `/authorize` about it and must apply `scopes` and a non-empty `packageNames` itself.
 */
export type ForwardedPrincipal =
  | {kind: "phone"; mentraUserId: string; tenantId: string; sessionId: string}
  | {kind: "user"; mentraUserId: string; email: string | null; emailVerified: boolean; isOrganizationAdmin: boolean}
  | {
      kind: "credential"
      credentialId: string
      credentialKind: "workspace" | "organization"
      workspaceId: string | null
      scopes: string[]
      packageNames: string[]
    }

/**
 * `error` values on 401 responses from the internal service API. The client treats only `invalid_token`
 * from `/principal` as "this bearer token is not valid"; anything else is a service-level failure.
 */
export const INVALID_TOKEN_ERROR = "invalid_token"
export const SERVICE_UNAUTHORIZED_ERROR = "service_unauthorized"

/**
 * `error` value of the 404 that `GET /workspaces/:workspaceId` answers for an unknown workspace. The
 * client reads only this 404 as "no such workspace": a 404 from anything else (a proxy, a wrong base URL,
 * a Core without this API) says nothing about the workspace and is an error.
 */
export const WORKSPACE_NOT_FOUND_ERROR = "workspace_not_found"

/**
 * `error` value of the 404 that `POST /users/resolve-email` answers when no Mentra account has that
 * email verified. As with `workspace_not_found`, the client reads only this 404 as "no such person".
 */
export const USER_NOT_FOUND_ERROR = "user_not_found"

// --- Public workspace API --------------------------------------------------
// The response bodies of Core's `/api/workspaces` and `/api/organization` routes. Every date is an ISO
// 8601 string, so the same types serve the admin dashboard, the Store's console proxy and the CLI.

/** `GET /api/workspaces/:workspaceId`: the workspace, the caller's membership in it (null for an organization admin who is not a member) and what the caller may do there. */
export interface WorkspaceDetail extends WorkspaceSummary {
  membership: MembershipSummary | null
  capabilities: WorkspaceCapability[]
}

/**
 * One row of `GET /api/workspaces/:workspaceId/members`. `pending` marks a migrated member who has not
 * signed in yet (so `mentraUserId` is still null); they hold their role from the moment they do.
 */
export interface MemberView {
  membershipId: string
  mentraUserId: string | null
  email: string | null
  name: string | null
  role: WorkspaceRole
  startedAt: string
  pending: boolean
}

/** A pending invitation as listed to administrators. It never carries the token or its hash. */
export interface InvitationView {
  invitationId: string
  email: string
  role: WorkspaceRole
  expiresAt: string
  invitedByMembershipId: string | null
}

/** A credential as shown to people (a workspace `msk_` key or an organization `mak_` operator key). It never includes the token or its hash. */
export interface CredentialView {
  credentialId: string
  prefix: "msk" | "mak"
  name: string
  /** `<prefix>_<env>_…<last4>`, e.g. `msk_prod_…abcd`. */
  display: string
  workspaceId: string | null
  scopes: string[]
  packageNames: string[]
  createdByEmail: string | null
  issuedByService: string | null
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

/** One entry of `GET /api/workspaces/:workspaceId/audit`, newest first. `target`, `before` and `after` are snapshots whose shape depends on `action`. */
export interface AuditEventView {
  eventId: string
  action: string
  actor: {
    kind: "user" | "credential" | "service" | "system"
    email: string | null
    credentialId: string | null
    service: string | null
  }
  target: Record<string, unknown> | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  occurredAt: string
}

/** `GET /api/organization`: what the caller may do to this deployment (the organization). */
export interface OrganizationView {
  capabilities: OrganizationCapability[]
}
