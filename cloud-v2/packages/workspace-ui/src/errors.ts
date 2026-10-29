/** The error every `WorkspaceApi` call throws, and how the screens put one into words. */

import {
  describeDeletionHolds,
  WORKSPACE_HAS_HOLDS_ERROR,
  type WorkspaceDeletionHold,
} from "@mentra/workspace-contract";

/**
 * A failed workspace API call. `status` is 0 when the request never reached the server. `holds` are what
 * a 409 `workspace_has_holds` said holds the workspace from deletion; empty for every other failure.
 */
export class WorkspaceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly holds: WorkspaceDeletionHold[] = [],
  ) {
    super(message);
    this.name = "WorkspaceApiError";
  }
}

/** Shown when another change got in first (HTTP 409 `membership_changed`): the screen has already refetched. */
export const WORKSPACE_CHANGED_MESSAGE = "This workspace changed. Review and try again.";

/** Whether `error` is the 409 `membership_changed` that means the caller acted on a stale view. */
export function isWorkspaceChangedError(error: unknown): error is WorkspaceApiError {
  return error instanceof WorkspaceApiError && error.status === 409 && error.code === "membership_changed";
}

/** Whether `error` is the 409 `workspace_has_holds`: a service still needs the workspace, so it cannot be deleted. */
export function isWorkspaceHeldError(error: unknown): error is WorkspaceApiError {
  return error instanceof WorkspaceApiError && error.status === 409 && error.code === WORKSPACE_HAS_HOLDS_ERROR;
}

/**
 * Whether `error` says a license changed under the caller: every seat was taken before theirs (409
 * `no_seats_available`), or the license is gone (404 `license_not_found`). The view they acted on is stale.
 */
export function isLicenseChangedError(error: unknown): error is WorkspaceApiError {
  return (
    error instanceof WorkspaceApiError &&
    ((error.status === 409 && error.code === "no_seats_available") ||
      (error.status === 404 && error.code === "license_not_found"))
  );
}

/** Codes the server sends with no description of their own. */
const CODE_MESSAGES: Record<string, string> = {
  unauthorized: "Your session has expired. Sign in again.",
  forbidden: "You do not have permission to do that.",
  workspace_not_found: "This workspace no longer exists or you no longer have access to it.",
  temporarily_unavailable: "Sign-in is temporarily unavailable. Try again in a moment.",
  server_error: "The server ran into a problem. Try again.",
  workspace_has_miniapps: "Delete this workspace's miniapps before deleting the workspace.",
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A sentence for the person looking at the screen. Server explanations are kept; codes and stack noise are not. */
export function errorMessage(error: unknown): string {
  if (isWorkspaceChangedError(error)) return WORKSPACE_CHANGED_MESSAGE;
  // Holds are put in words here, the same words the settings screen shows before anyone tries.
  if (isWorkspaceHeldError(error) && error.holds.length > 0) return describeDeletionHolds(error.holds);
  if (error instanceof WorkspaceApiError) {
    if (error.code === "network_error") return "Could not reach the server. Check your connection and try again.";
    const known = CODE_MESSAGES[error.code];
    if (known && error.message === error.code) return known;
    return capitalize(error.message);
  }
  return "Something went wrong. Try again.";
}

/**
 * Whether `error` says an invitation can never be accepted: unknown, used, revoked, replaced, expired, or
 * from an inviter who can no longer send it (404 `invitation_not_found`, 410 `invitation_expired`).
 * Other failures (a dropped connection, a signed-out session) say nothing about the invitation.
 */
export function isInvitationGone(error: unknown): boolean {
  return (
    error instanceof WorkspaceApiError &&
    ((error.status === 404 && error.code === "invitation_not_found") ||
      (error.status === 410 && error.code === "invitation_expired"))
  );
}
