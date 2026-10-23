/**
 * Password reset through Core's account API, on this origin (the sign-in site
 * relays `/api/account/password/*` to Core). A reset there ends every session
 * of the person, as any password reset does; the page asks for no phone
 * session (`signIn: false`).
 */
export type ResetResult = { kind: "ok" } | { kind: "invalid-code" } | { kind: "weak-password" } | { kind: "rate-limited" } | { kind: "error" };

export interface AccountApi {
  requestReset(email: string): Promise<ResetResult>;
  resetPassword(input: { email: string; code: string; newPassword: string }): Promise<ResetResult>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function createAccountApi(fetchImpl: Fetch = (input, init) => fetch(input, init)): AccountApi {
  async function post(path: string, body: unknown): Promise<ResetResult> {
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return { kind: "error" };
    }
    if (response.ok) return { kind: "ok" };
    if (response.status === 429) return { kind: "rate-limited" };
    const error = ((await response.json().catch(() => null)) as { error?: unknown } | null)?.error;
    if (error === "code_invalid") return { kind: "invalid-code" };
    if (error === "weak_password") return { kind: "weak-password" };
    return { kind: "error" };
  }

  return {
    requestReset: (email) => post("/api/account/password/forgot", { email }),
    resetPassword: ({ email, code, newPassword }) =>
      post("/api/account/password/reset", { email, code, newPassword, signIn: false }),
  };
}
