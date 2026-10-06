/** The error every `WorkspaceApi` call throws, and how the screens put one into words. */

/** A failed workspace API call. `status` is 0 when the request never reached the server. */
export class WorkspaceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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

/** Codes the server sends with no description of their own. */
const CODE_MESSAGES: Record<string, string> = {
  unauthorized: "Your session has expired. Sign in again.",
  forbidden: "You do not have permission to do that.",
  workspace_not_found: "This workspace no longer exists or you no longer have access to it.",
  identity_unavailable: "Sign-in is temporarily unavailable. Try again in a moment.",
  server_error: "The server ran into a problem. Try again.",
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A sentence for the person looking at the screen. Server explanations are kept; codes and stack noise are not. */
export function errorMessage(error: unknown): string {
  if (isWorkspaceChangedError(error)) return WORKSPACE_CHANGED_MESSAGE;
  if (error instanceof WorkspaceApiError) {
    if (error.code === "network_error") return "Could not reach the server. Check your connection and try again.";
    const known = CODE_MESSAGES[error.code];
    if (known && error.message === error.code) return known;
    return capitalize(error.message);
  }
  return "Something went wrong. Try again.";
}
