/**
 * @fileoverview Account orchestration: Mentra's first-party consumer identity
 * provider, running in-process as its own "OEM backend" (issue 019).
 *
 * Verifies credentials via GoTrue (server side, transient), then mints a
 * `mentra` subject token and feeds it through the SAME createSession path OEMs
 * use, so the device only ever receives a Cloud V2 session. No Supabase
 * material reaches the client.
 */
import type {TokenResponse} from "../../types/oauth.types"
import {createSession, mintAccountSubjectToken, revokeAllSessionsForUser} from "../session.service"
import {findOrCreateUser} from "../user.service"
import {sendEmail} from "../email/email.service"
import * as gotrue from "./gotrue.client"
import {SupportProfileModel} from "../../models/support-profile.model"
import {SupportTelemetryOutboxModel} from "../../models/support-telemetry-outbox.model"
import {UserModel} from "../../models/user.model"
import * as otc from "./one-time-code.service"
import {AccountError} from "./account-error"

const RESET_CODE_TTL_SEC = 15 * 60
const DELETE_CODE_TTL_SEC = 15 * 60
const EMAIL_CHANGE_CODE_TTL_SEC = 15 * 60

/** Turn a verified GoTrue identity into a Cloud V2 session (the shared tail of
 * login and oauth). */
async function sessionForIdentity(identity: gotrue.GotrueIdentity): Promise<TokenResponse> {
  const subjectToken = await mintAccountSubjectToken({tenantUserId: identity.id})
  return createSession({subjectToken})
}

export async function signup(email: string, password: string): Promise<void> {
  await gotrue.signUp(email, password)
  // Uniform: caller returns "verification_sent" regardless (anti-enumeration).
}

export async function resendVerification(email: string): Promise<void> {
  await gotrue.resendVerification(email)
}

export async function login(email: string, password: string): Promise<TokenResponse> {
  const identity = await gotrue.verifyPassword(email, password)
  return sessionForIdentity(identity)
}

/** Identity for GET /me. `mentraUserId` comes from the access token; email /
 * name / avatar come from GoTrue keyed on the Supabase id (our tenantUserId). */
export async function me(
  mentraUserId: string,
  tenantUserId: string,
): Promise<{mentraUserId: string; email: string | null; name?: string; avatarUrl?: string}> {
  const gt = await gotrue.getUserById(tenantUserId).catch(() => null)
  return {
    mentraUserId,
    email: gt?.email ?? null,
    name: gt?.name,
    avatarUrl: gt?.avatarUrl,
  }
}

export async function requestPasswordReset(email: string): Promise<void> {
  const user = await gotrue.findUserByEmail(email)
  if (!user) return // uniform: pretend success (anti-enumeration)
  const code = await otc.issueEmailCode({
    purpose: "password_reset",
    subject: email.toLowerCase(),
    ttlSec: RESET_CODE_TTL_SEC,
    payload: {userId: user.id},
  })
  await sendEmail({
    to: email,
    subject: "Your Mentra password reset code",
    html: `<p>Your password reset code is <b>${code}</b>. It expires in 15 minutes.</p>`,
  })
}

export async function resetPassword(email: string, code: string, newPassword: string): Promise<TokenResponse> {
  const {payload} = await otc.consumeCode({
    code,
    purpose: "password_reset",
    expectSubject: email.toLowerCase(),
  })
  const userId = (payload as {userId?: string})?.userId
  if (!userId) throw new AccountError("code_invalid", "code is invalid", 400)
  await gotrue.setPassword(userId, newPassword)
  // Reset kills ALL existing sessions, then logs the user in fresh. Revoke
  // before minting so the new session is the only survivor.
  const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: userId})
  await revokeAllSessionsForUser({mentraUserId: user.mentraUserId})
  const identity = await gotrue.verifyPassword(email, newPassword)
  return sessionForIdentity(identity)
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
  await gotrue.verifyPassword(email, currentPassword)
  await gotrue.setPassword(tenantUserId, newPassword)
  await revokeAllSessionsForUser({mentraUserId, exceptSessionId: currentSessionId})
}

/**
 * Step 1 of the email change: re-verify the password, then email a one-time
 * code to the NEW address. The change is only applied by `confirmEmailChange`,
 * so the user must prove they control the new inbox first. (The GoTrue admin
 * update applies immediately with no confirmation, so core owns this flow with
 * the same code mechanism as password reset and account deletion.)
 */
export async function requestEmailChange(
  tenantUserId: string,
  currentEmail: string,
  password: string,
  newEmail: string,
): Promise<void> {
  await gotrue.verifyPassword(currentEmail, password)
  // If the address already belongs to an account, silently no-op: the caller
  // returns the uniform "verification_sent" either way (anti-enumeration).
  const taken = await gotrue.findUserByEmail(newEmail)
  if (taken) return
  const code = await otc.issueEmailCode({
    purpose: "email_change",
    subject: tenantUserId,
    ttlSec: EMAIL_CHANGE_CODE_TTL_SEC,
    payload: {newEmail},
  })
  await sendEmail({
    to: newEmail,
    subject: "Confirm your new Mentra email address",
    html: `<p>Your email change code is <b>${code}</b>. It expires in 15 minutes. If you did not request this, ignore this email.</p>`,
  })
}

/** Step 2: consume the code (bound to this user) and apply the new address. */
export async function confirmEmailChange(tenantUserId: string, code: string): Promise<void> {
  const {payload} = await otc.consumeCode({
    code,
    purpose: "email_change",
    expectSubject: tenantUserId,
  })
  const newEmail = (payload as {newEmail?: string})?.newEmail
  if (!newEmail) throw new AccountError("code_invalid", "code is invalid", 400)
  await gotrue.setEmail(tenantUserId, newEmail)
}

export async function requestAccountDeletion(email: string, tenantUserId: string): Promise<void> {
  const code = await otc.issueEmailCode({
    purpose: "account_deletion",
    subject: tenantUserId,
    ttlSec: DELETE_CODE_TTL_SEC,
  })
  await sendEmail({
    to: email,
    subject: "Confirm your Mentra account deletion",
    html: `<p>Your account deletion code is <b>${code}</b>. It expires in 15 minutes. If you did not request this, ignore this email.</p>`,
  })
}

export async function confirmAccountDeletion(mentraUserId: string, tenantUserId: string, code: string): Promise<void> {
  await otc.consumeCode({code, purpose: "account_deletion", expectSubject: tenantUserId})
  // Order: kill V2 sessions, remove the operational support profile/outbox,
  // then delete the Supabase user. Everything human-identifying (email,
  // password, name) lives in GoTrue and dies here.
  //
  // OPEN DECISION (deferred, revisit in a future PR): the Mongo users row
  // ({mentraUserId, tenantId, tenantUserId}) is intentionally kept as a
  // tombstone for identifier stability and audit lineage. If we want
  // gone-means-gone, hard-delete it here. This flow also still needs an
  // integration test covering the cascade.
  //
  // Cloud V1 is a different system with its own database; its data lifecycle
  // is not a cloud-v2 concern and no code here talks to it.
  await revokeAllSessionsForUser({mentraUserId})
  // Set the tombstone before removing queued rows so no new telemetry can be
  // stored or delivered from here on. A capture already in flight past the
  // worker's tombstone check may still land in PostHog; delivered analytics
  // data is governed by that project's retention/deletion policy.
  await UserModel.updateOne({mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})
  await Promise.all([
    SupportProfileModel.deleteOne({mentraUserId}),
    SupportTelemetryOutboxModel.deleteMany({mentraUserId}),
  ])
  await gotrue.deleteUser(tenantUserId)
}

export {gotrue, otc}
