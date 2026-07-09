/**
 * @fileoverview Account orchestration: Mentra's first-party consumer identity
 * provider, running in-process as its own "OEM backend" (issue 019).
 *
 * Verifies credentials via GoTrue (server side, transient), then mints a
 * `mentra` subject token and feeds it through the SAME createSession path OEMs
 * use, so the device only ever receives a Cloud V2 session. No Supabase
 * material reaches the client.
 */
import type { TokenResponse } from "../../types/oauth.types";
import { createSession, mintAccountSubjectToken, revokeAllSessionsForUser } from "../session.service";
import { findOrCreateUser } from "../user.service";
import { sendEmail } from "../email/email.service";
import * as gotrue from "./gotrue.client";
import * as otc from "./one-time-code.service";
import { AccountError } from "./account-error";

const RESET_CODE_TTL_SEC = 15 * 60;
const DELETE_CODE_TTL_SEC = 15 * 60;

/** Turn a verified GoTrue identity into a Cloud V2 session (the shared tail of
 * login and oauth). */
async function sessionForIdentity(identity: gotrue.GotrueIdentity): Promise<TokenResponse> {
  const subjectToken = await mintAccountSubjectToken({ tenantUserId: identity.id });
  return createSession({ subjectToken });
}

export async function signup(email: string, password: string): Promise<void> {
  await gotrue.signUp(email, password);
  // Uniform: caller returns "verification_sent" regardless (anti-enumeration).
}

export async function resendVerification(email: string): Promise<void> {
  await gotrue.resendVerification(email);
}

export async function login(email: string, password: string): Promise<TokenResponse> {
  const identity = await gotrue.verifyPassword(email, password);
  return sessionForIdentity(identity);
}

/** Identity for GET /me. `mentraUserId` comes from the access token; email /
 * name / avatar come from GoTrue keyed on the Supabase id (our tenantUserId). */
export async function me(
  mentraUserId: string,
  tenantUserId: string,
): Promise<{ mentraUserId: string; email: string | null; name?: string; avatarUrl?: string }> {
  const gt = await gotrue.getUserById(tenantUserId).catch(() => null);
  return {
    mentraUserId,
    email: gt?.email ?? null,
    name: gt?.name,
    avatarUrl: gt?.avatarUrl,
  };
}

export async function requestPasswordReset(email: string): Promise<void> {
  const user = await gotrue.findUserByEmail(email);
  if (!user) return; // uniform: pretend success (anti-enumeration)
  const code = await otc.issueEmailCode({
    purpose: "password_reset",
    subject: email.toLowerCase(),
    ttlSec: RESET_CODE_TTL_SEC,
    payload: { userId: user.id },
  });
  await sendEmail({
    to: email,
    subject: "Your Mentra password reset code",
    html: `<p>Your password reset code is <b>${code}</b>. It expires in 15 minutes.</p>`,
  });
}

export async function resetPassword(
  email: string,
  code: string,
  newPassword: string,
): Promise<TokenResponse> {
  const { payload } = await otc.consumeCode({
    code,
    purpose: "password_reset",
    expectSubject: email.toLowerCase(),
  });
  const userId = (payload as { userId?: string })?.userId;
  if (!userId) throw new AccountError("code_invalid", "code is invalid", 400);
  await gotrue.setPassword(userId, newPassword);
  // Reset kills ALL existing sessions, then logs the user in fresh. Revoke
  // before minting so the new session is the only survivor.
  const user = await findOrCreateUser({ tenantId: "mentra", tenantUserId: userId });
  await revokeAllSessionsForUser({ mentraUserId: user.mentraUserId });
  const identity = await gotrue.verifyPassword(email, newPassword);
  return sessionForIdentity(identity);
}

export async function changePassword(
  mentraUserId: string,
  tenantUserId: string,
  currentPassword: string,
  newPassword: string,
  email: string,
  currentSessionId?: string,
): Promise<void> {
  // Re-verify the current password before allowing a change.
  await gotrue.verifyPassword(email, currentPassword);
  await gotrue.setPassword(tenantUserId, newPassword);
  await revokeAllSessionsForUser({ mentraUserId, exceptSessionId: currentSessionId });
}

export async function changeEmail(
  _mentraUserId: string,
  tenantUserId: string,
  currentEmail: string,
  password: string,
  newEmail: string,
): Promise<void> {
  // Re-verify the password, then hand the address change to GoTrue, which
  // emails the new address a confirmation link and only applies it on click.
  await gotrue.verifyPassword(currentEmail, password);
  await gotrue.setEmail(tenantUserId, newEmail);
}

export async function requestAccountDeletion(email: string, tenantUserId: string): Promise<void> {
  const code = await otc.issueEmailCode({
    purpose: "account_deletion",
    subject: tenantUserId,
    ttlSec: DELETE_CODE_TTL_SEC,
  });
  await sendEmail({
    to: email,
    subject: "Confirm your Mentra account deletion",
    html: `<p>Your account deletion code is <b>${code}</b>. It expires in 15 minutes. If you did not request this, ignore this email.</p>`,
  });
}

export async function confirmAccountDeletion(
  mentraUserId: string,
  tenantUserId: string,
  code: string,
): Promise<void> {
  await otc.consumeCode({ code, purpose: "account_deletion", expectSubject: tenantUserId });
  // Order: kill V2 sessions, delete the Supabase user, fan out to V1 (best
  // effort; a reconciliation job retries). The V2 user row is left tombstoned
  // by session removal; a follow-up may hard-delete it.
  await revokeAllSessionsForUser({ mentraUserId });
  await gotrue.deleteUser(tenantUserId);
  await deleteFromLegacy(tenantUserId).catch(() => {
    // Non-fatal: the user's V2 identity is already gone. Log-and-reconcile.
  });
}

async function deleteFromLegacy(tenantUserId: string): Promise<void> {
  const url = process.env.LEGACY_CORE_URL?.trim();
  const secret = process.env.LEGACY_DELETE_SECRET?.trim();
  if (!url || !secret) return; // V1 removal in progress; nothing to fan out to.
  await fetch(`${url.replace(/\/+$/, "")}/api/internal/account/delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ userId: tenantUserId }),
  });
}

export { gotrue, otc };
