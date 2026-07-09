/**
 * @fileoverview Mentra first-party account endpoints (issue 019).
 * Mounted at /api/account. Contract: docs/issues/019-mentra-account-auth/spec.md.
 */
import { Hono } from "hono";
import type { AppContext, AppEnv } from "../../types/hono.types";
import { InvalidRequest } from "../../types/oauth.types";
import { userAuth } from "../middleware/user-auth.middleware";
import { UserModel } from "../../models/user.model";
import * as account from "../../services/account/account.service";
import { AccountError } from "../../services/account/account-error";
import { accountRateLimit } from "./rate-limit";
import {
  revokeSession,
  revokeAllSessionsForUser,
  mintAccountSubjectToken,
} from "../../services/session.service";

const app = new Hono<AppEnv>();

// === Unauthenticated ===
// Every route carries per-IP (+ per-email where a body has one) limits per
// spec.md; credential and email-sending flows get the tightest windows.

app.post(
  "/signup",
  accountRateLimit({ scope: "signup", limit: 5, windowSec: 300, perEmail: true }),
  async (c) => {
    const { email, password } = await creds(c);
    await account.signup(email, password);
    return c.json({ status: "verification_sent" }, 202);
  },
);

app.post(
  "/verify/resend",
  accountRateLimit({ scope: "resend", limit: 5, windowSec: 300, perEmail: true }),
  async (c) => {
    const { email } = await emailOnly(c);
    await account.resendVerification(email);
    return c.json({ status: "verification_sent" }, 202);
  },
);

app.post(
  "/login",
  accountRateLimit({ scope: "login", limit: 10, windowSec: 60, perEmail: true }),
  async (c) => {
    const { email, password } = await creds(c);
    return c.json(await account.login(email, password));
  },
);

app.post(
  "/password/forgot",
  accountRateLimit({ scope: "forgot", limit: 5, windowSec: 300, perEmail: true }),
  async (c) => {
    const { email } = await emailOnly(c);
    await account.requestPasswordReset(email);
    return c.json({ status: "verification_sent" }, 202);
  },
);

app.post(
  "/password/reset",
  accountRateLimit({ scope: "reset", limit: 10, windowSec: 300, perEmail: true }),
  async (c) => {
    const body = await json(c);
    const email = str(body.email);
    const code = str(body.code);
    const newPassword = str(body.newPassword);
    if (!email || !code || !newPassword) throw new InvalidRequest("email, code, newPassword required");
    return c.json(await account.resetPassword(email, code, newPassword));
  },
);

// === Authenticated ===

app.post(
  "/logout",
  accountRateLimit({ scope: "logout", limit: 30, windowSec: 60 }),
  userAuth,
  async (c) => {
    const u = c.var.user!;
    const { everywhere } = await json(c);
    if (everywhere) {
      await revokeAllSessionsForUser({ mentraUserId: u.mentraUserId });
    } else {
      await revokeSession({ sessionId: u.sessionId });
    }
    return c.body(null, 204);
  },
);

app.get("/me", userAuth, async (c) => {
  const u = c.var.user!;
  const tenantUserId = await tenantUserIdFor(u.mentraUserId);
  return c.json(await account.me(u.mentraUserId, tenantUserId));
});

// The device's cloud-client fetches a fresh short-lived subject token from here
// (authenticated by the current V2 session) and exchanges it at the public
// /api/client/auth/exchange, exactly as an external OEM's app would. This is the
// OEM-backend "mint a subject token for my app" surface.
app.post("/subject-token", userAuth, async (c) => {
  const u = c.var.user!;
  const tenantUserId = await tenantUserIdFor(u.mentraUserId);
  const token = await mintAccountSubjectToken({ tenantUserId });
  return c.json({ token, type: "oem-jwt" });
});

// Authenticated, but still limited: these re-verify a password or consume a
// short numeric code, so a stolen session must not get unlimited guesses.
app.post(
  "/password/change",
  accountRateLimit({ scope: "pwchange", limit: 10, windowSec: 300 }),
  userAuth,
  async (c) => {
    const u = c.var.user!;
    const body = await json(c);
    const currentPassword = str(body.currentPassword);
    const newPassword = str(body.newPassword);
    if (!currentPassword || !newPassword) throw new InvalidRequest("currentPassword, newPassword required");
    const { tenantUserId, email } = await authedIdentity(u.mentraUserId);
    await account.changePassword(u.mentraUserId, tenantUserId, currentPassword, newPassword, email, u.sessionId);
    return c.body(null, 204);
  },
);

app.post(
  "/email/change",
  accountRateLimit({ scope: "emchange", limit: 5, windowSec: 300, perEmail: true }),
  userAuth,
  async (c) => {
    const u = c.var.user!;
    const body = await json(c);
    const newEmail = str(body.newEmail);
    const password = str(body.password);
    if (!newEmail || !password) throw new InvalidRequest("newEmail, password required");
    const { tenantUserId, email } = await authedIdentity(u.mentraUserId);
    await account.requestEmailChange(tenantUserId, email, password, newEmail);
    return c.json({ status: "verification_sent" }, 202);
  },
);

app.post(
  "/email/change/confirm",
  accountRateLimit({ scope: "emconfirm", limit: 10, windowSec: 300 }),
  userAuth,
  async (c) => {
    const u = c.var.user!;
    const body = await json(c);
    const code = str(body.code);
    if (!code) throw new InvalidRequest("code required");
    const tenantUserId = await tenantUserIdFor(u.mentraUserId);
    await account.confirmEmailChange(tenantUserId, code);
    return c.body(null, 204);
  },
);

app.post(
  "/delete/request",
  accountRateLimit({ scope: "delrequest", limit: 5, windowSec: 300 }),
  userAuth,
  async (c) => {
    const u = c.var.user!;
    const { tenantUserId, email } = await authedIdentity(u.mentraUserId);
    await account.requestAccountDeletion(email, tenantUserId);
    return c.json({ status: "verification_sent" }, 202);
  },
);

app.post(
  "/delete/confirm",
  accountRateLimit({ scope: "delconfirm", limit: 10, windowSec: 300 }),
  userAuth,
  async (c) => {
    const u = c.var.user!;
    const body = await json(c);
    const code = str(body.code);
    if (!code) throw new InvalidRequest("code required");
    const tenantUserId = await tenantUserIdFor(u.mentraUserId);
    await account.confirmAccountDeletion(u.mentraUserId, tenantUserId, code);
    return c.body(null, 204);
  },
);

// === helpers ===

async function json(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    if (b && typeof b === "object") return b as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new InvalidRequest("request body must be a JSON object");
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

async function creds(c: AppContext): Promise<{ email: string; password: string }> {
  const b = await json(c);
  const email = str(b.email);
  const password = typeof b.password === "string" ? b.password : "";
  if (!email || !password) throw new InvalidRequest("email and password required");
  return { email, password };
}

async function emailOnly(c: AppContext): Promise<{ email: string }> {
  const b = await json(c);
  const email = str(b.email);
  if (!email) throw new InvalidRequest("email required");
  return { email };
}

async function tenantUserIdFor(mentraUserId: string): Promise<string> {
  const user = await UserModel.findOne({ mentraUserId }).lean();
  if (!user) throw new InvalidRequest("user not found");
  // Every authenticated account route resolves identity through here, so this
  // is the single gate keeping external-OEM sessions out of the first-party
  // account surface. Without it, an OEM-authenticated user could hit
  // /subject-token and mint themselves a `mentra` session.
  if (user.tenantId !== "mentra") {
    throw new AccountError(
      "unauthorized_client",
      "account endpoints require a Mentra first-party session",
      403,
    );
  }
  return user.tenantUserId;
}

async function authedIdentity(mentraUserId: string): Promise<{ tenantUserId: string; email: string }> {
  const tenantUserId = await tenantUserIdFor(mentraUserId);
  const identity = await account.me(mentraUserId, tenantUserId);
  if (!identity.email) throw new InvalidRequest("account email unavailable");
  return { tenantUserId, email: identity.email };
}

export default app;
