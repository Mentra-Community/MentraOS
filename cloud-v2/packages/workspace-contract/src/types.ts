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

// --- Deletion holds ---------------------------------------------------------

/**
 * A service's hold on a workspace. While a workspace has any hold, nobody can delete it, an
 * Organization Admin included: the delete is refused with 409 {@link WORKSPACE_HAS_HOLDS_ERROR}
 * until the service clears its hold. Each service has at most one hold per workspace, which it sets
 * with `PUT /workspaces/:workspaceId/deletion-holds/:service` (replacing its previous one) and clears
 * with `DELETE` on the same path.
 *
 * Every set and clear carries `asOf`, the instant the service computed it ({@link DeletionHoldUpdate}),
 * so a call Core applies late never overwrites a newer one.
 *
 * `service` is the service that placed it (`store`); `reason` is a lowercase code
 * ({@link DELETION_HOLD_REASON_PATTERN}, for example `owns_miniapps`); `count`, when present, is how
 * many of the things the reason names the workspace still has. `describeDeletionHold` puts a hold in
 * words.
 */
export interface WorkspaceDeletionHold {
  service: string
  reason: string
  count?: number
}

/**
 * What every set and clear of a hold carries (`PUT` and `DELETE` bodies both): `asOf`, the instant at
 * which the service computed the hold, as an ISO 8601 UTC string with at most millisecond precision
 * (`Date.prototype.toISOString`). Take it just before reading what the hold counts, so the count
 * reflects every change made before it, and make it later than every `asOf` the service sent for the
 * workspace before: an equal `asOf` with a different hold is stale too, and wall clocks repeat, step
 * back and differ between hosts.
 *
 * Core keeps, for each service, the newest `asOf` it has applied, a clear's included, and ignores a
 * set or clear that is not newer (see {@link DeletionHoldsResponse.ignored}): a call that timed out
 * and reached Core late cannot undo a newer one. The same call again, with the same `asOf`, is
 * answered as applied. An `asOf` more than {@link DELETION_HOLD_MAX_FUTURE_SKEW_MS} ahead of Core's
 * clock is 400 `invalid_request`, as is a missing or malformed one.
 */
export interface DeletionHoldUpdate {
  asOf: string
}

/** How far ahead of Core's clock a hold's `asOf` may be: five minutes. */
export const DELETION_HOLD_MAX_FUTURE_SKEW_MS = 5 * 60_000

/** Response of `PUT` and `DELETE /workspaces/:workspaceId/deletion-holds/:service`: every hold on the workspace after the call. */
export interface DeletionHoldsResponse {
  workspaceId: string
  holds: WorkspaceDeletionHold[]
  /**
   * True when Core ignored the call because it has already applied a set or clear from this service
   * with a newer `asOf`, or the same `asOf` and a different hold. Core wrote and recorded nothing, and
   * `holds` are the holds it keeps. A stale call changes nothing, so it is not a failure, but a caller
   * that needs the workspace held (before a publication takes effect) must find its own hold in
   * `holds`: an ignored set leaves whatever the newer call did, a clear included.
   */
  ignored: boolean
}

/** What a hold's `reason` must match: a lowercase code of at most 64 letters, digits and underscores, starting with a letter. */
export const DELETION_HOLD_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/** The Store's hold `reason` while a workspace still owns published miniapps; its `count` is how many. */
export const OWNS_MINIAPPS_HOLD_REASON = "owns_miniapps"

/**
 * `error` of the 409 that deleting a workspace answers while any service holds it. The body is
 * {@link WorkspaceHasHoldsErrorBody}: `error_description` says why in words and `holds` lists every hold.
 */
export const WORKSPACE_HAS_HOLDS_ERROR = "workspace_has_holds"

export interface WorkspaceHasHoldsErrorBody {
  error: typeof WORKSPACE_HAS_HOLDS_ERROR
  error_description: string
  holds: WorkspaceDeletionHold[]
}

// --- Change feed ------------------------------------------------------------

/**
 * One entry of Core's change feed (`GET /changes`). `eventId` identifies the event; `seq` is its
 * position in the feed, assigned in commit order, and is the only thing to page by: pass the last
 * `seq` you processed, as a decimal string, as the next request's `after`. The feed leaves out
 * organization-level events (operator keys), so consecutive events can skip `seq` numbers. A
 * skipped number is never a missed event.
 *
 * `workspaceId` is null only for user-level tombstones ({@link USER_DELETED_ACTION}). `action`
 * names the change (`"user.deleted"`, `"workspace.created"`, ...); a receiver treats an action it
 * does not know as a no-op. `target`, `before` and `after` are snapshots whose shape depends on
 * `action` (see the event catalog in Core's `docs/fleet-integration.md`), null when the event has
 * none, with every credential-looking key (`token`, `secret`, `hash`, `password`) removed at any
 * depth.
 */
export interface WorkspaceChangeEvent {
  eventId: string
  seq: number
  workspaceId: string | null
  action: string
  occurredAt: string
  target: Record<string, unknown> | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

/**
 * Response of `GET /changes`: events in `seq` order. `next` is the cursor for the following page
 * (the last event's `seq`), or null when the page was not full and there is nothing more yet.
 */
export interface WorkspaceChangesResponse {
  events: WorkspaceChangeEvent[]
  next: string | null
}

/**
 * `action` of the tombstone recorded when a Mentra account is deleted: `workspaceId` is null and
 * `target` is `{mentraUserId}`. A service that keeps data keyed by that user deletes it. Each
 * membership the deletion ended was recorded before it, as a `membership.removed` event.
 */
export const USER_DELETED_ACTION = "user.deleted"

// --- Forwarded principals (Core -> Fleet) ----------------------------------

/**
 * The headers Core adds to a request it forwards to the Fleet integration or to a portal module, beyond the service
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
 * What a signed-in person's forwarded request covers, decided by Core: the whole organization, one
 * workspace (a team), or the person's own account.
 */
export type ForwardedScope =
  | {kind: "organization"}
  | {kind: "workspace"; workspaceId: string}
  | {kind: "person"}

/** The scope under its first name, when Fleet was the only service Core forwarded to. */
export type FleetScope = ForwardedScope

/**
 * Who a forwarded request is from. Only people reach a service Core forwards to: Fleet's `/v1/client` only
 * ever receives `phone` principals, and Fleet's `/v1/admin` and a portal module's `/v1/portal` only `user`
 * principals.
 *
 * - `phone`: a signed-in phone session. `email` is the account's verified email, or null; it is a
 *   display attribute and never an identity key.
 * - `user`: a signed-in person. `isOrganizationAdmin` comes from a verified identity email; `email`
 *   may be unverified (`emailVerified`) and is never an authorization. `organizationCapabilities` is
 *   what Core decided the person may do to the organization, and `scope` is what this request covers.
 */
export type ForwardedPrincipal =
  | {kind: "phone"; mentraUserId: string; tenantId: string; sessionId: string; email: string | null}
  | {
      kind: "user"
      mentraUserId: string
      email: string | null
      emailVerified: boolean
      isOrganizationAdmin: boolean
      organizationCapabilities: OrganizationCapability[]
      scope: ForwardedScope
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
  /**
   * What holds the workspace from deletion: deleting it is refused while this is not empty. Optional for
   * servers that predate holds.
   */
  deletionHolds?: WorkspaceDeletionHold[]
}

/**
 * One row of a workspace's member list. `email` is display-only and never an authorization. `pending`
 * marks a membership imported from the Store whose person has not signed in yet: it has no
 * `mentraUserId` until they do, and holds its role meanwhile.
 */
export interface MemberView {
  membershipId: string
  mentraUserId: string | null
  email: string | null
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
