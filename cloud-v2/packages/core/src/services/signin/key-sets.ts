/**
 * @fileoverview Remote JSON Web Key Sets for identity-provider tokens.
 *
 * One cached key set per configured URL. Keys come only from that URL, never
 * from URLs in a token's header (`jku`, `x5u`): jose's remote key set selects a
 * key by `kid` among the published keys and nothing else.
 *
 * An unknown `kid` refreshes the set once (a key rotation), at most once per
 * `FORCED_RELOAD_INTERVAL_MS` per set, so a flood of made-up key IDs cannot
 * turn into a flood of fetches. A fetch failure is an outage
 * (`KeySetUnavailableError`), which callers answer with 503, never as a
 * successful or an invalid sign-in.
 */

import * as jose from "jose"

const FORCED_RELOAD_INTERVAL_MS = 5_000

interface CachedKeySet {
  keySet: ReturnType<typeof jose.createRemoteJWKSet>
  lastForcedReload: number
}

const keySets = new Map<string, CachedKeySet>()

export class KeySetUnavailableError extends Error {
  override name = "KeySetUnavailableError"
}

function cached(url: string): CachedKeySet {
  let entry = keySets.get(url)
  if (!entry) {
    entry = {
      keySet: jose.createRemoteJWKSet(new URL(url), {
        timeoutDuration: 5_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
      }),
      lastForcedReload: 0,
    }
    keySets.set(url, entry)
  }
  return entry
}

function isNoMatchingKey(err: unknown): boolean {
  return (err as {code?: string})?.code === "ERR_JWKS_NO_MATCHING_KEY"
}

/** Errors that mean the key set could not be fetched, rather than that the token is bad. */
function isFetchFailure(err: unknown): boolean {
  const code = (err as {code?: string})?.code
  if (code === "ERR_JWKS_TIMEOUT" || code === "ERR_JWKS_INVALID") return true
  // jose raises a plain JOSEError for a non-200 or unparseable key set response.
  if (code === "ERR_JOSE_GENERIC") return true
  // Anything that is not a jose error came from fetch itself (a network failure).
  return !(typeof code === "string" && code.startsWith("ERR_J"))
}

/**
 * Verify `token` against the key set at `url`. Refreshes the set once on an
 * unknown `kid`. Throws `KeySetUnavailableError` when the set cannot be
 * fetched; any other failure is jose's verification error.
 */
export async function verifyWithKeySet(
  token: string,
  url: string,
  options: jose.JWTVerifyOptions,
): Promise<jose.JWTVerifyResult> {
  const entry = cached(url)
  try {
    try {
      return await jose.jwtVerify(token, entry.keySet, options)
    } catch (err) {
      const now = Date.now()
      if (!isNoMatchingKey(err) || now - entry.lastForcedReload < FORCED_RELOAD_INTERVAL_MS) throw err
      entry.lastForcedReload = now
      await entry.keySet.reload()
      return await jose.jwtVerify(token, entry.keySet, options)
    }
  } catch (err) {
    if (isFetchFailure(err)) throw new KeySetUnavailableError(`identity provider key set unavailable: ${url}`)
    throw err
  }
}

/** Forget every cached key set (tests, and a changed configuration). */
export function resetKeySets(): void {
  keySets.clear()
}
