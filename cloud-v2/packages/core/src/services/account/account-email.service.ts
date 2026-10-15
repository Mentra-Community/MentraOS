/**
 * @fileoverview An account's verified email, from Core's copy (`account_emails`).
 *
 * `accountEmail` answers from the copy while it is less than a day old (`ACCOUNT_EMAIL_MAX_AGE_MS`). Otherwise it
 * asks the account directory (`trustedAccountEmail`) and keeps the answer, a missing email included. So an account
 * costs the directory one lookup a day however often it is asked about, from any number of Core processes, and a
 * restart costs none. When the directory cannot answer, the copy Core already has is the answer and stays due for
 * a check; with no copy, the lookup fails.
 *
 * How a change reaches the copy:
 *  - an email changed through Core (`confirmEmailChange`) is written at once (`recordAccountEmail`);
 *  - one changed in the directory itself (its admin console) is picked up within a day.
 *
 * A lookup's answer is kept only if no newer one is: it is stamped with the time the lookup started, and replaces
 * only an older row. So a lookup that read the directory before Core changed the email cannot overwrite the change.
 */

import {AccountEmailModel} from "../../models/account-email.model"
import {trustedAccountEmail} from "./trusted-email.service"

/** How long Core's copy is used before the account directory is asked again. */
export const ACCOUNT_EMAIL_MAX_AGE_MS = 24 * 60 * 60_000

const DUPLICATE_KEY = 11000

/**
 * The account's verified email, or null when it has none (unverified, not a Mentra account, deleted). Throws only
 * when the copy is missing or a day old and the directory cannot answer. `signal` cancels the directory lookup.
 */
export async function accountEmail(mentraUserId: string, options: {signal?: AbortSignal} = {}): Promise<string | null> {
  const stored = await AccountEmailModel.findOne({mentraUserId}).lean()
  if (stored && Date.now() - stored.checkedAt.getTime() < ACCOUNT_EMAIL_MAX_AGE_MS) return stored.email ?? null

  const checkedAt = new Date()
  let email: string | null
  try {
    email = await trustedAccountEmail(mentraUserId, options)
  } catch (error) {
    // The directory is down, rate limited or slow: the address Core has is better than none.
    if (stored) return stored.email ?? null
    throw error
  }
  try {
    await AccountEmailModel.updateOne(
      {mentraUserId, checkedAt: {$lt: checkedAt}},
      {$set: {email, checkedAt}},
      {upsert: true},
    )
  } catch (error) {
    // The row is newer than this answer: the filter missed it, so the upsert tried to insert a second one.
    if ((error as {code?: unknown})?.code !== DUPLICATE_KEY) throw error
  }
  return email
}

/**
 * Keeps `email` as the account's verified email from now on, for a change Core made itself in the directory. Called
 * after the directory has the new address, so it replaces whatever a lookup kept, before or since.
 */
export async function recordAccountEmail(mentraUserId: string, email: string | null): Promise<void> {
  await AccountEmailModel.updateOne({mentraUserId}, {$set: {email, checkedAt: new Date()}}, {upsert: true})
}
