/** Wire types for Core's workspace APIs: the signed service API and the public workspace and organization routes. */
import type {OrganizationCapability, WorkspaceCapability, WorkspaceRole} from "./capabilities"

/**
 * Who is calling Core. A person is a Core user (`mentraUserId`): the same user on the phone and in the
 * browser. A credential is a Core key: a workspace key (`msk_`) or an organization operator key (`mak_`,
 * or an `msk_` admin key made before operator keys).
 */
export type CorePrincipal =
  | {
      kind: "user"
      mentraUserId: string
      email: string | null
      /** Whether the identity provider verified `email`. An unverified email is never an authorization. */
      emailVerified: boolean
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
// The response bodies of Core's workspace and organization routes. Every date is an ISO 8601 string,
// so the same types serve the workspace portal, the admin portal and the Store's Developer Console.

/** A workspace, the caller's membership in it (null for an Organization Admin who is not a member) and what the caller may do there. */
export interface WorkspaceDetail extends WorkspaceSummary {
  /** The caller's own membership, null when they have none. Their role is this, whatever `capabilities` say. */
  membership: MembershipSummary | null
  capabilities: WorkspaceCapability[]
  /**
   * Whether the caller is an Organization Admin, who acts as an Owner in every workspace: when their
   * membership's role grants less (or they have none), that is where `capabilities` come from.
   * Optional for servers that predate it.
   */
  organizationAdmin?: boolean
}

/** One row of a workspace's member list. `email` is display-only and never an authorization. */
export interface MemberView {
  membershipId: string
  mentraUserId: string
  email: string | null
  role: WorkspaceRole
  startedAt: string
}

/** A pending invitation as listed to administrators. It never carries the token or its hash. */
export interface InvitationView {
  invitationId: string
  email: string
  role: WorkspaceRole
  expiresAt: string
  invitedByMembershipId: string | null
}

/**
 * An invitation as the invitee sees it before accepting: what an invitation link is for
 * (`POST /invitations/peek`), and each of the invitations addressed to the signed-in person
 * (`GET /invitations/mine`). It never carries the token or its hash.
 */
export interface InvitationPreview {
  invitationId: string
  workspaceId: string
  workspaceName: string
  /** The invited address. */
  email: string
  role: WorkspaceRole
  /** Who sent it, by email address; null when the system did, or the address is no longer known. */
  invitedByEmail: string | null
  expiresAt: string
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

/** One entry of a workspace's audit log, newest first. `target`, `before` and `after` are snapshots whose shape depends on `action`. */
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

/**
 * What the caller may do to this deployment (the organization). `workspaceCreation` says whether this
 * caller may create a workspace: on hosted Core anyone with a verified email may; a Private Cloud may
 * limit creation to Organization Admins (`CLOUD_CORE_WORKSPACE_CREATION`).
 */
export interface OrganizationView {
  capabilities: OrganizationCapability[]
  workspaceCreation: {allowed: boolean; reason: "email_unverified" | "organization_admins_only" | "not_a_person" | null}
}
