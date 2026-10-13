/**
 * @fileoverview The verified account email a phone's Fleet principal carries.
 *
 * Fleet shows the email next to a phone's usage; it is a display attribute and never an identity
 * key, so the lookup is best effort. A phone reports often, and the account directory is another
 * service: one lookup per report would put every active phone on it. So an answer is remembered
 * for a few minutes, a missing email as well as a found one, and a lookup that fails or runs past
 * its deadline is `null` for a short while rather than an error or a retry on every request. The
 * email is never logged.
 */

import {createLogger} from "@mentra/cloud-shared"
import {trustedAccountEmail} from "../account/trusted-email.service"

const logger = createLogger("core").child({service: "fleet-phone-email"})

/** How long an answer, a missing email included, is reused. */
const ANSWER_TTL_MS = 5 * 60_000
/** How long a failed or timed-out lookup is reused, so an outage is not asked about on every report. */
const FAILURE_TTL_MS = 30_000
/** How long one lookup may take before the email is left out. */
const DEFAULT_LOOKUP_TIMEOUT_MS = 2_000

/** The most people remembered; past it the one asked about longest ago is forgotten first. */
export const PHONE_EMAIL_CACHE_MAX = 10_000

const cache = new Map<string, {email: string | null; expiresAt: number}>()

/** Forgets every remembered answer. */
export function resetPhoneEmailCache(): void {
  cache.clear()
}

function remember(mentraUserId: string, email: string | null, ttlMs: number): void {
  cache.delete(mentraUserId)
  if (cache.size >= PHONE_EMAIL_CACHE_MAX) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(mentraUserId, {email, expiresAt: Date.now() + ttlMs})
}

/**
 * The account's verified email, or null when it has none, is unverified, or could not be looked up
 * within `timeoutMs`. Never throws.
 */
export async function phoneEmail(mentraUserId: string, options: {timeoutMs?: number} = {}): Promise<string | null> {
  const remembered = cache.get(mentraUserId)
  if (remembered && Date.now() < remembered.expiresAt) {
    // Asking again keeps a person the Core still hears from out of the next eviction.
    cache.delete(mentraUserId)
    cache.set(mentraUserId, remembered)
    return remembered.email
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`the account email lookup took longer than ${timeoutMs} ms`))
    }, timeoutMs)
  })
  try {
    const email = await Promise.race([trustedAccountEmail(mentraUserId, {signal: controller.signal}), deadline])
    remember(mentraUserId, email, ANSWER_TTL_MS)
    return email
  } catch (error) {
    logger.warn({reason: error instanceof Error ? error.name : "unknown"}, "Fleet phone principal sent without an email")
    remember(mentraUserId, null, FAILURE_TTL_MS)
    return null
  } finally {
    clearTimeout(timer)
  }
}
