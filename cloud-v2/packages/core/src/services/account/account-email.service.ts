/**
 * @fileoverview An account's verified email, from Core's copy (`account_emails`).
 *
 * `accountEmail` answers from the copy while it is less than a day old (`ACCOUNT_EMAIL_MAX_AGE_MS`). Otherwise it
 * asks the account directory (`trustedAccountEmail`) and keeps the answer, a missing email included. So an account
 * costs the directory about one lookup a day however often it is asked about, from any number of Core processes,
 * and a restart costs none (processes that miss at the same moment each ask once). When the directory cannot
 * answer, the copy Core already has is the answer and stays due for a check; with no copy, the lookup fails.
 *
 * Only the directory's answers are kept. When Core changes an account's email (`confirmEmailChange`), it marks the
 * copy for a check (`markAccountEmailChanged`) rather than writing the address it set, so the next lookup reads
 * whatever the directory ended with, in whatever order concurrent changes reached it. One changed in the directory
 * itself (its admin console) is picked up within a day.
 *
 * Writes are ordered by `checkedAt`: a lookup is stamped with the time it started and replaces only a row stamped
 * earlier, and marking a change moves the stamp forward to the time of the change. So a lookup that read the
 * directory before a change cannot keep the address it read.
 *
 * Deleting the account (`forgetAccountEmail`) leaves the row as a fence with no email. Both writers' filters require
 * a row that is not one, so a lookup or a change still in flight when the account is deleted is refused.
 */

import {AccountEmailModel} from "../../models/account-email.model"
import {trustedAccountEmail} from "./trusted-email.service"

/** How long Core's copy is used before the account directory is asked again. */
export const ACCOUNT_EMAIL_MAX_AGE_MS = 24 * 60 * 60_000

const DUPLICATE_KEY = 11000

/**
 * The account's verified email, or null when it has none (unverified, not a Mentra account, deleted). Throws only
 * when the copy is missing, a day old or marked for a check and the directory cannot answer, and there is no copy
 * to fall back on. `signal` cancels the directory lookup.
 */
export async function accountEmail(mentraUserId: string, options: {signal?: AbortSignal} = {}): Promise<string | null> {
  const stored = await AccountEmailModel.findOne({mentraUserId}).lean()
  if (stored?.deletedAt) return null
  if (stored && !stored.recheck && Date.now() - stored.checkedAt.getTime() < ACCOUNT_EMAIL_MAX_AGE_MS) {
    return stored.email ?? null
  }

  const checkedAt = new Date()
  let email: string | null
  try {
    email = await trustedAccountEmail(mentraUserId, options)
  } catch (error) {
    // The directory is down, rate limited or slow: the address Core has is better than none.
    if (stored) return stored.email ?? null
    throw error
  }
  await writeUnlessFenced(
    {mentraUserId, deletedAt: null, checkedAt: {$lt: checkedAt}},
    {$set: {email, checkedAt, recheck: false}},
  )
  return email
}

/**
 * Marks the account's email for a check with the directory, after Core changed it there: the next `accountEmail`
 * asks the directory, and a lookup that started before now cannot keep what it read. A deleted account's row is
 * left as it is.
 */
export async function markAccountEmailChanged(mentraUserId: string): Promise<void> {
  // `$max`: concurrent changes only ever move the stamp forward, whichever finishes last.
  await writeUnlessFenced({mentraUserId, deletedAt: null}, {$set: {recheck: true}, $max: {checkedAt: new Date()}})
}

/** Clears the account's email for good, at its deletion: the row stays, with no email, as the fence. Idempotent. */
export async function forgetAccountEmail(mentraUserId: string): Promise<void> {
  const now = new Date()
  await AccountEmailModel.updateOne(
    {mentraUserId},
    {$set: {email: null, recheck: false, deletedAt: now}, $setOnInsert: {checkedAt: now}},
    {upsert: true},
  )
}

/**
 * Applies `update` to the row `filter` matches, inserting the account's row when it has none. A row the filter does
 * not match (a newer answer, or the fence) is left as it is: the upsert then tries to insert a second row for the
 * account, which the unique index refuses.
 */
async function writeUnlessFenced(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<void> {
  try {
    await AccountEmailModel.updateOne(filter, update, {upsert: true})
  } catch (error) {
    if ((error as {code?: unknown})?.code !== DUPLICATE_KEY) throw error
  }
}
