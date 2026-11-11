import { CONNECTIONS_SIGN_IN_PATH, type Connection, type ConnectionsApi } from "./connections-api";

/**
 * The Connected apps route (`/connections`). The page knows the person only
 * by the sign-in server's session cookie. Without a session it sends the
 * browser through sign-in once, as the sign-in site's own client, and comes
 * back here; the code that return carries is dropped unread (`main.tsx`),
 * since the session is all the page needs.
 */
export type ConnectionsState =
  | { kind: "loading" }
  | { kind: "redirecting" }
  | { kind: "list"; connections: Connection[]; notice: "none" | "revoke-failed" | "rate-limited" }
  /** Back from sign-in and still not signed in: say so instead of going round again. */
  | { kind: "sign-in-failed" }
  | { kind: "error" };

export interface ConnectionsDeps {
  api: ConnectionsApi;
  /** Navigates the page away. Only ever called with the sign-in start on this origin. */
  navigate: (url: string) => void;
}

/**
 * Whether this page load is the return from sign-in: the sign-in server sends
 * the browser back with `code` (or `error`) in the query.
 */
export function isSignInReturn(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("code") || params.has("error");
}

export async function loadConnections(deps: ConnectionsDeps, returnedFromSignIn: boolean): Promise<ConnectionsState> {
  const result = await deps.api.list();
  if (result.kind === "ok") return { kind: "list", connections: result.connections, notice: "none" };
  if (result.kind === "error") return { kind: "error" };
  if (returnedFromSignIn) return { kind: "sign-in-failed" };
  deps.navigate(CONNECTIONS_SIGN_IN_PATH);
  return { kind: "redirecting" };
}

/** Revoke one website and answer the list as it now stands. */
export async function revokeConnection(
  deps: ConnectionsDeps,
  connections: Connection[],
  clientId: string,
): Promise<ConnectionsState> {
  const result = await deps.api.revoke(clientId);
  if (result.kind === "ok") {
    return { kind: "list", connections: connections.filter((entry) => entry.clientId !== clientId), notice: "none" };
  }
  if (result.kind === "signed-out") {
    deps.navigate(CONNECTIONS_SIGN_IN_PATH);
    return { kind: "redirecting" };
  }
  return { kind: "list", connections, notice: result.kind === "rate-limited" ? "rate-limited" : "revoke-failed" };
}
