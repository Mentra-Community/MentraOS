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
  workspace?: WorkspaceSummary
  membership?: MembershipSummary | null
  capabilities: WorkspaceCapability[]
}

export interface PrincipalResponse {
  principal: CorePrincipal
  workspaces: Array<WorkspaceSummary & {membership: MembershipSummary; capabilities: WorkspaceCapability[]}>
}

export interface WorkspaceChangeEvent {
  eventId: string
  organizationId: string
  workspaceId: string | null
  action: string
  occurredAt: string
  target: Record<string, unknown>
}
