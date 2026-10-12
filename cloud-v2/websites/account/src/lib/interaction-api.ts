import { isProviderContinuation } from "./links";

/**
 * Calls to Core's sign-in server on this origin: the interaction's details,
 * the Supabase hand-off and the consent decision. The sign-in site relays
 * these paths to Core, so they are same-origin requests carrying the
 * provider's interaction cookie.
 */
export type DetailsResult =
  | { kind: "ok"; prompt: string; clientName: string; scopes: string[] }
  | { kind: "expired" }
  | { kind: "error" };

export type ContinueResult =
  | { kind: "continue"; url: string }
  | { kind: "refused" }
  | { kind: "expired" }
  | { kind: "rate-limited" }
  | { kind: "error" };

export interface InteractionApi {
  details(interactionId: string): Promise<DetailsResult>;
  /** Hand the person's Supabase access token to the provider's sign-in step. */
  handOff(interactionId: string, accessToken: string): Promise<ContinueResult>;
  decide(interactionId: string, decision: "allow" | "deny"): Promise<ContinueResult>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function createInteractionApi(origin: string, fetchImpl: Fetch = (input, init) => fetch(input, init)): InteractionApi {
  const path = (interactionId: string, suffix: string) => `/interaction/${encodeURIComponent(interactionId)}/${suffix}`;

  async function post(url: string, body: unknown): Promise<ContinueResult> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return { kind: "error" };
    }
    if (response.status === 401) return { kind: "refused" };
    if (response.status === 400) return { kind: "expired" };
    if (response.status === 429) return { kind: "rate-limited" };
    if (!response.ok) return { kind: "error" };
    const payload = (await response.json().catch(() => null)) as { redirectTo?: unknown } | null;
    // Follow only the provider's own continuation on this origin.
    return isProviderContinuation(origin, payload?.redirectTo)
      ? { kind: "continue", url: new URL(payload!.redirectTo as string, origin).href }
      : { kind: "error" };
  }

  return {
    async details(interactionId) {
      let response: Response;
      try {
        response = await fetchImpl(path(interactionId, "details"), { credentials: "same-origin", cache: "no-store" });
      } catch {
        return { kind: "error" };
      }
      if (response.status === 400) return { kind: "expired" };
      if (!response.ok) return { kind: "error" };
      const body = (await response.json().catch(() => null)) as {
        prompt?: unknown;
        client?: { name?: unknown };
        scopes?: unknown;
      } | null;
      if (!body || typeof body.prompt !== "string") return { kind: "error" };
      return {
        kind: "ok",
        prompt: body.prompt,
        clientName: typeof body.client?.name === "string" ? body.client.name : "",
        scopes: Array.isArray(body.scopes) ? body.scopes.filter((scope): scope is string => typeof scope === "string") : [],
      };
    },
    handOff(interactionId, accessToken) {
      return post(path(interactionId, "supabase"), { access_token: accessToken });
    },
    decide(interactionId, decision) {
      return post(path(interactionId, "consent"), { decision });
    },
  };
}
