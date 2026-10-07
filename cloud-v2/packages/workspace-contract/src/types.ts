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

/**
 * One entry of Core's change feed. `eventId` identifies the event; `seq` is its position in the
 * feed, assigned in commit order with no gaps, and is the only thing to page by: pass the
 * last `seq` you processed (as a decimal string) as the next request's `after`.
 */
export interface WorkspaceChangeEvent {
  eventId: string
  seq: number
  workspaceId: string | null
  action: string
  occurredAt: string
  target: Record<string, unknown>
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
