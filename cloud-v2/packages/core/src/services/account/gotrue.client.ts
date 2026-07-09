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
 */
import { AccountError } from "./account-error";

export interface GotrueIdentity {
  id: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  avatarUrl?: string;
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
  init: { method: string; body?: unknown; admin?: boolean; query?: Record<string, string> },
): Promise<{ status: number; body: any }> {
  const key = init.admin ? serviceKey() : anonKey();
  const qs = init.query ? `?${new URLSearchParams(init.query)}` : "";
  const res = await fetch(`${baseUrl()}/auth/v1${path}${qs}`, {
    method: init.method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
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

/** Create a user; GoTrue sends the verification email. Idempotent-ish: an
 * existing address returns a user object without a session (obfuscated by the
 * caller into the uniform "verification_sent"). */
export async function signUp(email: string, password: string): Promise<void> {
  const { status, body } = await gotrue("/signup", {
    method: "POST",
    body: { email, password },
  });
  if (status === 200 || status === 201) return;
  if (typeof body?.msg === "string" && /password/i.test(body.msg)) {
    throw new AccountError("weak_password", body.msg, 400);
  }
  if (status === 422 || status === 429) {
    // 422 often = already registered; keep uniform to avoid enumeration.
    return;
  }
  throw new AccountError("server_error", "signup failed", 502);
}

export async function resendVerification(email: string): Promise<void> {
  await gotrue("/resend", { method: "POST", body: { type: "signup", email } });
  // Always uniform; ignore result.
}

/** Look up a user id by email via the admin API (for reset/change/delete). */
export async function findUserByEmail(email: string): Promise<GotrueIdentity | null> {
  const { status, body } = await gotrue("/admin/users", {
    method: "GET",
    admin: true,
    query: { filter: email, per_page: "1" },
  });
  if (status !== 200) return null;
  const user = (body?.users ?? []).find((u: any) => u.email?.toLowerCase() === email.toLowerCase());
  return user ? identityFrom(user) : null;
}

export async function getUserById(userId: string): Promise<GotrueIdentity | null> {
  const { status, body } = await gotrue(`/admin/users/${userId}`, { method: "GET", admin: true });
  if (status !== 200 || !body?.id) return null;
  return identityFrom(body);
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
  const { status } = await gotrue(`/admin/users/${userId}`, {
    method: "PUT",
    admin: true,
    body: { email, email_confirm: false },
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
 * here; the callback lands back on core). */
export function authorizeUrl(provider: string, redirectTo: string): string {
  const q = new URLSearchParams({ provider, redirect_to: redirectTo });
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
