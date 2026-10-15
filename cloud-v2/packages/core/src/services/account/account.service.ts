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
import {SigninIdentityModel} from "../../models/signin-identity.model"
import {UserModel} from "../../models/user.model"
import * as otc from "./one-time-code.service"
import {AccountError} from "./account-error"
import {forgetAccountEmail, markAccountEmailChanged} from "./account-email.service"
import {removeDeletedUserFromWorkspaces} from "../workspaces/account-deletion.service"
import {MENTRA_TENANT_ID} from "../signin/config"
import {createLogger} from "@mentra/cloud-shared"

const logger = createLogger("core").child({service: "account.service"})

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
  // Confirmed duplicates surface as email_taken; only verification flows succeed.
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

/**
 * Reset a password with an emailed code. Every session of the person ends
 * (`revokeAllSessionsForUser`). The Mentra App is then signed in fresh; the
 * sign-in page passes `signIn: false`, gets no phone session, and the person
 * signs in again through Core's sign-in server.
 */
export async function resetPassword(email: string, code: string, newPassword: string, opts: {signIn: false}): Promise<null>
export async function resetPassword(email: string, code: string, newPassword: string, opts?: {signIn?: true}): Promise<TokenResponse>
export async function resetPassword(email: string, code: string, newPassword: string, opts: {signIn?: boolean} = {}): Promise<TokenResponse | null> {
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
  if (opts.signIn === false) return null
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

/**
 * Step 2: consume the code (bound to this user) and apply the new address. Core's
 * copy of the account's email (`account-email.service.ts`) is then marked for a
 * check, so its next lookup reads the address the directory ended with and Fleet
 * shows it within minutes; should that write fail, the copy's daily check picks
 * the change up, and the change itself stands.
 */
export async function confirmEmailChange(mentraUserId: string, tenantUserId: string, code: string): Promise<void> {
  const {payload} = await otc.consumeCode({
    code,
    purpose: "email_change",
    expectSubject: tenantUserId,
  })
  const newEmail = (payload as {newEmail?: string})?.newEmail
  if (!newEmail) throw new AccountError("code_invalid", "code is invalid", 400)
  await gotrue.setEmail(tenantUserId, newEmail)
  try {
    await markAccountEmailChanged(mentraUserId)
  } catch (err) {
    logger.warn({errorName: (err as Error)?.name, mentraUserId}, "changed email not marked for a check; the daily check will pick it up")
  }
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

/**
 * Confirm the deletion of the signed-in person's account with the emailed code.
 *
 * Deletion is durable and forward-only. Confirming sets the tombstone
 * (`supportTelemetryDeletedAt`), once, and nothing ever lifts it: from then on
 * the account is deleted and no principal (`isDeletedAccount`). Sign-in, token
 * exchange and refresh, portal sessions, identity-provider tokens and the keys
 * it created are refused, and nothing can give it workspace access again. It
 * also stops new support writes before the profile is removed; a PostHog
 * capture already in flight may still deliver, and delivered analytics data is
 * governed by that project's retention/deletion policy.
 *
 * The rest (`finishAccountDeletion`) runs right away and, should any step fail
 * or the process stop, again from Core's own sweep (`startAccountDeletionCompletion`)
 * until it is recorded as complete. The person never signs in again to retry,
 * so a failure there does not fail the confirmation: the deletion is accepted.
 *
 * OPEN DECISION (deferred, revisit in a future PR): the Mongo users row
 * ({mentraUserId, tenantId, tenantUserId}) is intentionally kept as a tombstone
 * for identifier stability and audit lineage. If we want gone-means-gone,
 * hard-delete it once the deletion is complete.
 *
 * Cloud V1 is a different system with its own database; its data lifecycle is
 * not a cloud-v2 concern and no code here talks to it.
 */
export async function confirmAccountDeletion(mentraUserId: string, tenantUserId: string, code: string): Promise<void> {
  await otc.consumeCode({code, purpose: "account_deletion", expectSubject: tenantUserId})
  // Only the first confirmation sets the time.
  await UserModel.updateOne({mentraUserId, supportTelemetryDeletedAt: null}, {$set: {supportTelemetryDeletedAt: new Date()}})
  try {
    await finishAccountDeletion(mentraUserId)
  } catch (err) {
    logger.warn({err, mentraUserId}, "account deletion will be finished by the deletion sweep")
  }
}

/**
 * Run every step of a confirmed deletion and record its completion. Each step is
 * idempotent, so a repeat (a retry, a concurrent confirmation, the sweep) is
 * harmless, and completion is recorded once. Order:
 *  1. end V2 sessions, portal sessions and the identity provider's sessions;
 *  2. end workspace memberships, and revoke what the person created
 *     (`removeDeletedUserFromWorkspaces`), before the account directory is
 *     asked: a deleted account must never be left holding workspace access;
 *  3. remove the operational support profile/outbox and the person's sign-in
 *     identity, and clear Core's copy of their email (`account_emails`, whose
 *     emptied row stays as a fence against a lookup still in flight);
 *  4. on hosted Core, delete the account in the account directory (GoTrue).
 *     Everything else human-identifying (email, password, name) lives there.
 * Throws when a step fails; the deletion stays pending and the sweep retries it.
 * A users row without a tombstone is no deletion and is left alone.
 */
export async function finishAccountDeletion(mentraUserId: string): Promise<"completed" | "not_deleted"> {
  const user = await UserModel.findOne({mentraUserId}).lean()
  if (!user?.supportTelemetryDeletedAt) return "not_deleted"
  if (user.accountDeletionCompletedAt) return "completed"
  await revokeAllSessionsForUser({mentraUserId})
  await removeDeletedUserFromWorkspaces(mentraUserId)
  await SupportProfileModel.deleteOne({mentraUserId})
  // How the person last signed in to Core's sign-in server, email included.
  await SigninIdentityModel.deleteOne({mentraUserId})
  // Core's copy of the account's email: cleared, and fenced against a lookup still in flight.
  await forgetAccountEmail(mentraUserId)
  if (user.tenantId === MENTRA_TENANT_ID) await gotrue.deleteUser(user.tenantUserId)
  await UserModel.updateOne(
    {mentraUserId, accountDeletionCompletedAt: null},
    {$set: {accountDeletionCompletedAt: new Date()}},
  )
  return "completed"
}

/**
 * Finish deletions that were confirmed but not completed, oldest first, at most
 * `limit` per call. One account's failure is logged and does not stop the others.
 */
export async function finishPendingAccountDeletions(limit = 25): Promise<{completed: string[]; failed: string[]}> {
  const pending = await UserModel.find({
    supportTelemetryDeletedAt: {$gt: new Date(0)},
    accountDeletionCompletedAt: null,
  })
    .sort({supportTelemetryDeletedAt: 1})
    .limit(limit)
    .select({mentraUserId: 1})
    .lean()
  const completed: string[] = []
  const failed: string[] = []
  for (const {mentraUserId} of pending) {
    try {
      await finishAccountDeletion(mentraUserId)
      completed.push(mentraUserId)
    } catch (err) {
      failed.push(mentraUserId)
      logger.warn({err, mentraUserId}, "account deletion is not finished yet; the next sweep retries")
    }
  }
  return {completed, failed}
}

/**
 * Sweep for unfinished deletions once now and then every `intervalMs`, so a
 * deletion that a crash or an account-directory outage interrupted completes on
 * its own. Returns a stop function that waits for a sweep in progress.
 */
export function startAccountDeletionCompletion(intervalMs = 60_000): () => Promise<void> {
  let stopped = false
  let active: Promise<unknown> | undefined
  const tick = () => {
    if (stopped || active) return
    active = finishPendingAccountDeletions()
      .catch(err => logger.warn({err}, "account deletion sweep failed; it runs again shortly"))
      .finally(() => {
        active = undefined
      })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  tick()
  return async () => {
    stopped = true
    clearInterval(timer)
    await active
  }
}

export {gotrue, otc}
