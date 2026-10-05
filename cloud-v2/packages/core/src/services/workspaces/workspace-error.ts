/**
 * @fileoverview The error every workspace service operation raises for an expected failure.
 *
 * It lives in its own module so the audit service can raise it without importing
 * the workspace service that imports the audit service. `workspace.service`
 * re-exports it, which is where callers import it from.
 */

export type WorkspaceErrorCode =
  | "not_found"
  | "forbidden"
  | "last_owner"
  | "membership_changed"
  | "invalid_role"
  | "invalid_request"
  | "workspace_deleted"
  | "already_member"
  | "email_mismatch"
  | "invitation_expired"
  | "invitation_not_found"
  | "workspace_has_packages"
  | "store_unavailable"

const STATUS_BY_CODE: Record<WorkspaceErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  last_owner: 409,
  membership_changed: 409,
  invalid_role: 400,
  invalid_request: 400,
  workspace_deleted: 410,
  already_member: 409,
  email_mismatch: 403,
  invitation_expired: 410,
  invitation_not_found: 404,
  workspace_has_packages: 409,
  store_unavailable: 503,
}

export class WorkspaceError extends Error {
  constructor(
    public code: WorkspaceErrorCode,
    public status: number,
    message?: string,
  ) {
    super(message ?? code)
    this.name = "WorkspaceError"
  }
}

export function fail(code: WorkspaceErrorCode, message?: string): never {
  throw new WorkspaceError(code, STATUS_BY_CODE[code], message)
}
