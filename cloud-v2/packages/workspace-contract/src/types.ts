/** Wire types for Core's internal workspace service API. */
import type {WorkspaceCapability, WorkspaceRole} from "./capabilities"

export type CorePrincipal =
  | {
      kind: "user"
      organizationId: string
      mentraUserId: string
      email: string | null
      emailVerified: boolean
      workosUserId: string | null
      isOrganizationAdmin: boolean
    }
  | {
      kind: "credential"
      organizationId: string
      credentialId: string
      credentialKind: "workspace" | "organization"
      workspaceId: string | null
      scopes: string[]
      packageNames: string[]
      label: string
    }

export interface WorkspaceSummary {
  organizationId: string
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
  organizationId: string
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
  organizationId: string
  memberships: Record<string, MembershipCheckEntry | null>
}

/** Response of `POST /credentials`. The token is shown once. */
export interface ServiceCredentialResponse {
  organizationId: string
  credentialId: string
  token: string
}

export interface WorkspaceChangeEvent {
  eventId: string
  organizationId: string
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
