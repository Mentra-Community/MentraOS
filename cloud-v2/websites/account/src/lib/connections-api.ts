/**
 * Calls to Core's sign-in server on this origin for Connected apps: the
 * miniapp websites the person has allowed to sign them in with Mentra. The
 * sign-in site relays `/oidc/*` to Core, so these are same-origin requests
 * that carry the provider's session cookie; the page holds no token.
 */
export interface Connection {
  clientId: string;
  name: string;
  scopes: string[];
  /** When the person allowed the website (ISO 8601); null when Core does not know. */
  grantedAt: string | null;
}

export type ConnectionsResult = { kind: "ok"; connections: Connection[] } | { kind: "signed-out" } | { kind: "error" };

export type RevokeResult = { kind: "ok" } | { kind: "signed-out" } | { kind: "rate-limited" } | { kind: "error" };

export interface ConnectionsApi {
  list(): Promise<ConnectionsResult>;
  revoke(clientId: string): Promise<RevokeResult>;
}

/** Where a browser with no session at the sign-in server starts one, coming back to the page. */
export const CONNECTIONS_SIGN_IN_PATH = "/oidc/connections/sign-in";

const CONNECTIONS_PATH = "/oidc/connections";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function isConnection(value: unknown): value is Connection {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.clientId === "string" &&
    typeof entry.name === "string" &&
    Array.isArray(entry.scopes) &&
    entry.scopes.every((scope) => typeof scope === "string") &&
    (entry.grantedAt === null || typeof entry.grantedAt === "string")
  );
}

export function createConnectionsApi(fetchImpl: Fetch = (input, init) => fetch(input, init)): ConnectionsApi {
  return {
    async list() {
      let response: Response;
      try {
        response = await fetchImpl(CONNECTIONS_PATH, { credentials: "same-origin", cache: "no-store" });
      } catch {
        return { kind: "error" };
      }
      if (response.status === 401) return { kind: "signed-out" };
      if (!response.ok) return { kind: "error" };
      const body = (await response.json().catch(() => null)) as { connections?: unknown } | null;
      if (!body || !Array.isArray(body.connections)) return { kind: "error" };
      return { kind: "ok", connections: body.connections.filter(isConnection) };
    },
    async revoke(clientId) {
      let response: Response;
      try {
        response = await fetchImpl(`${CONNECTIONS_PATH}/revoke`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId }),
        });
      } catch {
        return { kind: "error" };
      }
      if (response.status === 401) return { kind: "signed-out" };
      if (response.status === 429) return { kind: "rate-limited" };
      return response.ok ? { kind: "ok" } : { kind: "error" };
    },
  };
}
