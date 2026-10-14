/**
 * @fileoverview The verified account email a phone's Fleet principal carries.
 *
 * Fleet shows the email next to a phone's usage; it is a display attribute and never an identity
 * key, so the lookup is best effort. A phone reports often, and the account directory is another
 * service: one lookup per report would put every active phone on it. So an answer is remembered
 * for a few minutes, a missing email as well as a found one, and a lookup that fails or runs past
 * its deadline is `null` for a short while rather than an error or a retry on every request. The
 * email is never logged. An outage of the directory fails every lookup, so the warning for it is
 * rate limited: one a minute per process, saying how many were left out in between.
 */

import {createLogger, type Logger} from "@mentra/cloud-shared"
import {trustedAccountEmail} from "../account/trusted-email.service"

const logger = createLogger("core").child({service: "fleet-phone-email"})

/** How long an answer, a missing email included, is reused. */
const ANSWER_TTL_MS = 5 * 60_000
/** How long a failed or timed-out lookup is reused, so an outage is not asked about on every report. */
const FAILURE_TTL_MS = 30_000
/** The least time between two warnings about a lookup that failed. */
const WARN_INTERVAL_MS = 60_000
/** How long one lookup may take before the email is left out. */
const DEFAULT_LOOKUP_TIMEOUT_MS = 2_000

/** The most people remembered; past it the one asked about longest ago is forgotten first. */
export const PHONE_EMAIL_CACHE_MAX = 10_000

const cache = new Map<string, {email: string | null; expiresAt: number}>()

/** When the next warning may be logged, and how many failures were left out of the log since the last one. */
let nextWarnAt = 0
let suppressedWarnings = 0

/** Forgets every remembered answer, and the warning rate limit with them. */
export function resetPhoneEmailCache(): void {
  cache.clear()
  nextWarnAt = 0
  suppressedWarnings = 0
}

/**
 * Warns that a phone's principal went without an email, at most once a minute per process: the warning
 * carries `suppressed`, the number of failures since the previous one. `log` is the request's logger,
 * which carries its request id; the failure is `reason`, never what was said.
 */
function warnLookupFailed(log: Logger, reason: string): void {
  const now = Date.now()
  if (now < nextWarnAt) {
    suppressedWarnings++
    return
  }
  const suppressed = suppressedWarnings
  nextWarnAt = now + WARN_INTERVAL_MS
  suppressedWarnings = 0
  log.warn({reason, ...(suppressed > 0 ? {suppressed} : {})}, "Fleet phone principal sent without an email")
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
 * within `timeoutMs`. Never throws. `log` is where a failed lookup is warned about (the request's
 * logger, so the warning names the request); Core's own when there is none.
 */
export async function phoneEmail(
  mentraUserId: string,
  options: {timeoutMs?: number; log?: Logger} = {},
): Promise<string | null> {
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
    warnLookupFailed(options.log ?? logger, error instanceof Error ? error.name : "unknown")
    remember(mentraUserId, null, FAILURE_TTL_MS)
    return null
  } finally {
    clearTimeout(timer)
  }
}
