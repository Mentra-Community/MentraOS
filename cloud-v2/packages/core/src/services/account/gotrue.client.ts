/**
 * @fileoverview Server-side Supabase GoTrue client.
 *
 * This is the ONLY module that knows about Supabase. Everything above it speaks
 * in account-service terms and spec error codes, so a future credential-store
 * swap (issue 019 design.md, Phase 2) replaces this file and nothing else.
 *
 * Two credentials, both server-only (never shipped to the app):
 *   - SUPABASE_ANON_KEY   -> the password/pkce token grants
 *   - SUPABASE_SERVICE_ROLE_KEY -> the admin API (user mutation, delete, links)
 *
 * Each holds either the project's legacy JWT key (`anon` / `service_role`) or
 * its replacement (`sb_publishable_...` / `sb_secret_...`). New-format keys are
 * not JWTs, so they travel only in the `apikey` header; a legacy key also goes
 * in `Authorization: Bearer`, as GoTrue has always accepted it.
 */
import * as jose from "jose";
import { AccountError } from "./account-error";

export interface GotrueIdentity {
  id: string;
  email: string;
  /** `email_confirmed_at`, falling back to `confirmed_at`. */
  emailVerified: boolean;
  /**
   * `email_confirmed_at` alone. `confirmed_at` can be set by confirming something
   * other than the email (a phone number), so anything that trusts the email
   * address itself (web sign-in, Organization Admin status) uses this.
   */
  emailConfirmed: boolean;
  name?: string;
  avatarUrl?: string;
}

export type SupabaseApiKeyFormat = "legacy_jwt" | "publishable" | "secret";

export function supabaseApiKeyFormat(key: string): SupabaseApiKeyFormat {
  if (key.startsWith("sb_publishable_")) return "publishable";
  if (key.startsWith("sb_secret_")) return "secret";
  return "legacy_jwt";
}

/**
 * Refuse swapped keys at startup: a secret key in the anon slot, or a
 * publishable key in the service slot. Unset keys are allowed; the calls that
 * need them fail with "not configured".
 */
export function assertSupabaseApiKeys(env: Record<string, string | undefined> = process.env): void {
  const anon = env.SUPABASE_ANON_KEY?.trim();
  const service = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (anon && supabaseApiKeyFormat(anon) === "secret") {
    throw new Error("SUPABASE_ANON_KEY holds a secret key (sb_secret_); set it to the project's publishable key");
  }
  if (service && supabaseApiKeyFormat(service) === "publishable") {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY holds a publishable key (sb_publishable_); set it to the project's secret key");
  }
}

/**
 * Where account emails (sign-up confirmation and its resend) send the person.
 * Unset keeps GoTrue's default, the project's Site URL. Set it before the
 * Site URL changes, so these links keep landing on the same page.
 */
function accountEmailRedirect(): Record<string, string> | undefined {
  const url = process.env.CLOUD_CORE_ACCOUNT_EMAIL_REDIRECT_URL?.trim();
  return url ? { redirect_to: url } : undefined;
}

function keyHeaders(key: string): Record<string, string> {
  return supabaseApiKeyFormat(key) === "legacy_jwt" ? { apikey: key, authorization: `Bearer ${key}` } : { apikey: key };
}

function baseUrl(): string {
  const url = process.env.SUPABASE_URL?.trim();
  if (!url) throw new AccountError("server_error", "SUPABASE_URL not configured", 500);
  return url.replace(/\/+$/, "");
}

function anonKey(): string {
  const k = process.env.SUPABASE_ANON_KEY?.trim();
  if (!k) throw new AccountError("server_error", "SUPABASE_ANON_KEY not configured", 500);
  return k;
}

function serviceKey(): string {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!k) throw new AccountError("server_error", "SUPABASE_SERVICE_ROLE_KEY not configured", 500);
  return k;
}

async function gotrue(
  path: string,
  init: { method: string; body?: unknown; admin?: boolean; query?: Record<string, string>; signal?: AbortSignal },
): Promise<{ status: number; body: any }> {
  const key = init.admin ? serviceKey() : anonKey();
  const qs = init.query ? `?${new URLSearchParams(init.query)}` : "";
  const res = await fetch(`${baseUrl()}/auth/v1${path}${qs}`, {
    method: init.method,
    headers: {
      ...keyHeaders(key),
      "content-type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function identityFrom(user: any): GotrueIdentity {
  const meta = user?.user_metadata ?? {};
  return {
    id: user.id,
    email: user.email,
    emailVerified: Boolean(user.email_confirmed_at ?? user.confirmed_at),
    emailConfirmed: Boolean(user.email_confirmed_at),
    name: meta.full_name ?? meta.name ?? undefined,
    avatarUrl: meta.avatar_url ?? meta.picture ?? undefined,
  };
}

/**
 * Verify email + password. Returns identity on success. Never distinguishes
 * "no such user" from "wrong password" — both surface as invalid_credentials.
 * The GoTrue password grant is used TRANSIENTLY: we read identity and discard
 * the Supabase session (the device only ever gets a Cloud V2 session).
 */
export async function verifyPassword(email: string, password: string): Promise<GotrueIdentity> {
  const { status, body } = await gotrue("/token", {
    method: "POST",
    query: { grant_type: "password" },
    body: { email, password },
  });
  if (status === 200 && body?.user) {
    if (!identityFrom(body.user).emailVerified) {
      throw new AccountError("verification_required", "email not verified", 403);
    }
    return identityFrom(body.user);
  }
  // 400 invalid_grant, 400 email_not_confirmed, etc. — collapse to uniform error.
  if (body?.error_code === "email_not_confirmed") {
    throw new AccountError("verification_required", "email not verified", 403);
  }
  throw new AccountError("invalid_credentials", "invalid email or password", 401);
}

/** Create a user; GoTrue sends the verification email for an unverified account.
 * Signup intentionally discloses account existence to guide returning users to
 * sign-in, but never discloses their linked providers or account details. */
export async function signUp(email: string, password: string): Promise<void> {
  const { status, body } = await gotrue("/signup", {
    method: "POST",
    body: { email, password },
    query: accountEmailRedirect(),
  });
  if (status === 200 || status === 201) {
    // GoTrue obfuscates a confirmed duplicate as a user with no identities.
    // Invited, unconfirmed users can also have no identities; preserve their
    // verification flow. Normal new/repeated-unconfirmed signups have identities.
    if (Array.isArray(body?.identities) && body.identities.length === 0 && !body.invited_at) {
      throw new AccountError("email_taken", "This email is already registered. Please sign in.", 409);
    }
    return;
  }
  if (
    (status === 400 || status === 422) &&
    (body?.error_code === "user_already_exists" ||
      body?.error_code === "email_exists" ||
      (typeof body?.msg === "string" && /already registered/i.test(body.msg)))
  ) {
    throw new AccountError("email_taken", "This email is already registered. Please sign in.", 409);
  }
  if (status === 429) {
    throw new AccountError("rate_limited", "too many attempts, try again later", 429);
  }
  if (typeof body?.msg === "string" && /password/i.test(body.msg)) {
    throw new AccountError("weak_password", body.msg, 400);
  }
  throw new AccountError("server_error", "signup failed", 502);
}

export async function resendVerification(email: string): Promise<void> {
  await gotrue("/resend", { method: "POST", body: { type: "signup", email }, query: accountEmailRedirect() });
  // Always uniform; ignore result.
}

/**
 * Look up a user by email via the admin API (for reset/change/delete).
 *
 * GoTrue's `filter` narrows by a partial email match when honored, but it is
 * not a guaranteed exact lookup and older/self-hosted configs ignore it, so
 * `per_page: 1` could silently return the wrong (or no) user. We page through
 * results (bounded) and exact-match the email ourselves, so a missing user is
 * a real miss, not a pagination artifact.
 */
export async function findUserByEmail(email: string): Promise<GotrueIdentity | null> {
  const wanted = email.toLowerCase();
  const PER_PAGE = 200;
  const MAX_PAGES = 20; // safety cap: 4000 users scanned worst case
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { status, body } = await gotrue("/admin/users", {
      method: "GET",
      admin: true,
      query: { filter: email, page: String(page), per_page: String(PER_PAGE) },
    });
    if (status !== 200) return null;
    const users: any[] = body?.users ?? [];
    const match = users.find((u) => u.email?.toLowerCase() === wanted);
    if (match) return identityFrom(match);
    if (users.length < PER_PAGE) break; // last page reached, no match
  }
  return null;
}

/**
 * The account with exactly this email, like `findUserByEmail`, for lookups that
 * grant something (an email resolved for the Store, an owner named by email).
 * A directory that cannot answer (any status but 200, a network error or a
 * timeout) throws `AccountError` 503, so an outage is never mistaken for "no
 * such account".
 */
export async function findAccountByEmail(email: string, timeoutMs = 5_000): Promise<GotrueIdentity | null> {
  const wanted = email.toLowerCase();
  const PER_PAGE = 200;
  const MAX_PAGES = 20;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let response: { status: number; body: any };
    try {
      response = await gotrue("/admin/users", {
        method: "GET",
        admin: true,
        query: { filter: email, page: String(page), per_page: String(PER_PAGE) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof AccountError) throw err;
      throw new AccountError("server_error", "account directory unavailable", 503);
    }
    if (response.status !== 200 || !Array.isArray(response.body?.users)) {
      throw new AccountError("server_error", "account directory unavailable", 503);
    }
    const users: any[] = response.body.users;
    const match = users.find((u) => u.email?.toLowerCase() === wanted);
    if (match) return identityFrom(match);
    if (users.length < PER_PAGE) break;
  }
  return null;
}

/**
 * Whether the admin directory can be queried at all: both the project URL and
 * the service-role key are set. A deployment without GoTrue (a Private Cloud)
 * has no Mentra accounts.
 */
export function isGotrueAdminConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

/**
 * The account behind a Supabase user ID, for lookups whose answer is trusted or
 * kept (web sign-in, the account's verified email). Null when the account does
 * not exist (404). Unlike `getUserById`, a directory that cannot answer (any
 * other status, a network error, a timeout or `signal`) throws `AccountError`
 * 503, so a GoTrue outage is never mistaken for an account without a confirmed
 * email.
 */
export async function findAccountById(
  userId: string,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<GotrueIdentity | null> {
  let response: { status: number; body: any };
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    response = await gotrue(`/admin/users/${encodeURIComponent(userId)}`, {
      method: "GET",
      admin: true,
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (err) {
    if (err instanceof AccountError) throw err;
    throw new AccountError("server_error", "account directory unavailable", 503);
  }
  if (response.status === 404) return null;
  if (response.status !== 200 || typeof response.body?.id !== "string") {
    throw new AccountError("server_error", "account directory unavailable", 503);
  }
  return identityFrom(response.body);
}

export async function getUserById(userId: string, signal?: AbortSignal): Promise<GotrueIdentity | null> {
  const { status, body } = await gotrue(`/admin/users/${userId}`, { method: "GET", admin: true, signal });
  if (status !== 200 || !body?.id) return null;
  return identityFrom(body);
}

/**
 * Candidates for email/domain allowlists. GoTrue's filter is only a search
 * hint; callers must match the returned identities against their own policy.
 * Never return a partial directory as though it were complete.
 */
export async function findUsersByEmailFilters(filters: string[]): Promise<GotrueIdentity[]> {
  const identities = new Map<string, GotrueIdentity>();
  const signal = AbortSignal.timeout(10_000);
  const perPage = 200;
  for (const filter of new Set(filters)) {
    for (let page = 1; ; page++) {
      if (page > 20) throw new AccountError("server_error", "account directory search exceeded page limit", 502);
      const { status, body } = await gotrue("/admin/users", {
        method: "GET", admin: true, signal,
        query: { filter, page: String(page), per_page: String(perPage) },
      });
      if (status !== 200 || !Array.isArray(body?.users)) {
        throw new AccountError("server_error", "account directory search failed", 502);
      }
      for (const user of body.users) {
        if (typeof user.id !== "string" || typeof user.email !== "string") continue;
        identities.set(user.id, identityFrom(user));
      }
      if (body.users.length < perPage) break;
    }
  }
  return [...identities.values()];
}

export async function setPassword(userId: string, password: string): Promise<void> {
  const { status, body } = await gotrue(`/admin/users/${userId}`, {
    method: "PUT",
    admin: true,
    body: { password },
  });
  if (status === 200) return;
  if (typeof body?.msg === "string" && /password/i.test(body.msg)) {
    throw new AccountError("weak_password", body.msg, 400);
  }
  throw new AccountError("server_error", "password update failed", 502);
}

export async function setEmail(userId: string, email: string): Promise<void> {
  // Only called AFTER core's own one-time code proved the user controls the
  // new inbox (confirmEmailChange), so apply it confirmed. Leaving it
  // unconfirmed would make the next password login hit verification_required
  // (verifyPassword rejects unverified emails) and could trigger GoTrue's own
  // redundant confirmation flow.
  const { status } = await gotrue(`/admin/users/${userId}`, {
    method: "PUT",
    admin: true,
    body: { email, email_confirm: true },
  });
  if (status !== 200) throw new AccountError("server_error", "email update failed", 502);
}

export async function deleteUser(userId: string): Promise<void> {
  const { status } = await gotrue(`/admin/users/${userId}`, { method: "DELETE", admin: true });
  if (status !== 200 && status !== 204 && status !== 404) {
    throw new AccountError("server_error", "user delete failed", 502);
  }
}

/** Build the GoTrue authorize URL for an OAuth provider (browser is redirected
 * here; the callback lands back on core). `codeChallenge` is S256 of core's
 * verifier: GoTrue only issues a PKCE-exchangeable auth code when the challenge
 * rides on the authorize request, so omitting it breaks `exchangeOAuthCode`.
 * Google gets `prompt=select_account` (GoTrue passes it on), so each sign-in
 * shows its account chooser instead of reusing the account the browser last
 * signed in with, which survives signing out of Mentra. */
export function authorizeUrl(provider: string, redirectTo: string, codeChallenge: string): string {
  const q = new URLSearchParams({
    provider,
    redirect_to: redirectTo,
    code_challenge: codeChallenge,
    code_challenge_method: "s256",
  });
  if (provider === "google") q.set("prompt", "select_account");
  return `${baseUrl()}/auth/v1/authorize?${q}`;
}

/** Exchange an OAuth `code` (from the GoTrue callback) for the user identity.
 * Uses the pkce grant; the verifier for the core<->GoTrue leg is held by core. */
export async function exchangeOAuthCode(code: string, codeVerifier: string): Promise<GotrueIdentity> {
  const { status, body } = await gotrue("/token", {
    method: "POST",
    query: { grant_type: "pkce" },
    body: { auth_code: code, code_verifier: codeVerifier },
  });
  if (status === 200 && body?.user) return identityFrom(body.user);
  throw new AccountError("invalid_grant", "oauth code exchange failed", 400);
}

const GLOBAL_SIGN_OUT_TOKEN_TTL_SEC = 60;

/**
 * End every Supabase session of one person: the sign-in page's, every
 * website's and the CLI's. Refresh then fails, and the sign-in page asks for
 * credentials again.
 *
 * Supabase has no admin call that ends a person's sessions by user ID, so Core
 * signs a 60-second token for the person with the project's HS256 JWT secret
 * (`SUPABASE_JWT_SECRET`) and calls `POST /auth/v1/logout?scope=global` with
 * it and the secret key. The token carries no `session_id`, which GoTrue
 * treats as a sign-out of every session. This works only while Supabase still
 * trusts the legacy HS256 secret.
 */
export async function signOutAllSessions(supabaseUserId: string, timeoutMs = 5_000): Promise<void> {
  const secret = process.env.SUPABASE_JWT_SECRET?.trim();
  if (!secret) throw new AccountError("server_error", "SUPABASE_JWT_SECRET not configured", 500);
  const issuer = process.env.CLOUD_CORE_SUPABASE_ISSUER?.trim().replace(/\/+$/, "") || `${baseUrl()}/auth/v1`;
  const iat = Math.floor(Date.now() / 1000);
  const token = await new jose.SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(supabaseUserId)
    .setAudience("authenticated")
    .setIssuer(issuer)
    .setIssuedAt(iat)
    .setExpirationTime(iat + GLOBAL_SIGN_OUT_TOKEN_TTL_SEC)
    .sign(new TextEncoder().encode(secret));
  let status: number;
  try {
    const res = await fetch(`${baseUrl()}/auth/v1/logout?scope=global`, {
      method: "POST",
      headers: { apikey: serviceKey(), authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    await res.body?.cancel();
  } catch {
    throw new AccountError("server_error", "Supabase sign-out failed", 502);
  }
  if (status !== 204) throw new AccountError("server_error", `Supabase sign-out failed with HTTP ${status}`, 502);
}
