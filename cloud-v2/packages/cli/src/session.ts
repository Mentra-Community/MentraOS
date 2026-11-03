/**
 * @fileoverview The credentials a command acts with, refreshed when needed.
 *
 * A stored login whose access token expires within 60 seconds is refreshed
 * first. The sign-in server rotates refresh tokens and ends the grant when a
 * spent one is presented again, so two commands must never refresh the same
 * login at once: a refresh holds a lock (`file-lock.ts`), and a command that
 * waited for it reads the login again and uses the refreshed tokens. A command
 * paused long enough to lose the lock does not spend the refresh token, and a
 * refresh stores its result only over the login it started from. Every
 * other change to a stored login (a new sign-in, signing out) takes the same
 * lock and starts from the login as stored then, so none undoes a refresh and
 * no refresh brings back a login that was replaced or signed out. The rotated
 * refresh token is stored before the new access token is used. A refused
 * refresh token clears the login (`SessionExpiredError`).
 *
 * Core can refuse an access token before it expires: it refuses every token
 * of a person whose sign-ins were revoked ("log out everywhere" in the Mentra
 * App, a deleted account). A Core request answered 401 then refreshes the
 * login at once (`renewRefusedLogin`) and is retried once, so a login whose
 * grant has ended says so at its next request instead of at its next
 * scheduled refresh.
 */

import {refreshLoginToken, revokeLogin, SessionExpiredError} from "./api"
import {normalizeUrl} from "./config"
import {withFileLock, type FileLease} from "./file-lock"
import {
  clearCredentials,
  loadStoredLogin,
  refreshLockPath,
  saveCredentials,
  type CliCredentials,
} from "./credentials"

/** Refresh when the access token has less than this left. */
export const REFRESH_MARGIN_MS = 60_000
/** A refresh lock its holder stopped touching this long ago was left by a command that died. */
const LOCK_STALE_MS = 30_000
const LOST_LOCK = "Another mentra command took over refreshing this sign-in. Try again in a moment."
/** How long a command waits for another one's refresh: longer than its two 15-second requests. */
const LOCK_WAIT_MS = 45_000

export function needsRefresh(credentials: CliCredentials, now = Date.now()): boolean {
  const expiresAt = Date.parse(credentials.expiresAt)
  return !Number.isFinite(expiresAt) || expiresAt - now < REFRESH_MARGIN_MS
}

/**
 * The login stored for the Core at `target`, refreshed when it is about to
 * expire. Null when signed out. Throws `SessionExpiredError` (after clearing
 * the login) when the refresh token is refused.
 */
export async function loadFreshCredentials(target: string): Promise<CliCredentials | null> {
  const credentials = await loadStoredLogin(target)
  if (!credentials || !needsRefresh(credentials)) return credentials
  return withRefreshLock(target, async lease => {
    // Another command may have refreshed (or cleared) the login while this one waited.
    const current = await loadStoredLogin(target)
    if (!current || !needsRefresh(current)) return current
    return refreshUnderLock(target, current, lease)
  })
}

/**
 * After Core refused `refusedToken`, an access token of `mentraUserId`'s stored login for `target`
 * (401): the login to retry with. When the stored login already carries another token (another command,
 * or an earlier request of this one, refreshed it meanwhile) it is used as stored. Otherwise it is
 * refreshed now, although it has not expired: a refused refresh token clears it (`SessionExpiredError`).
 * Null when there is nothing to retry with: signed out, or another person's login is stored now.
 */
export function renewRefusedLogin(
  target: string,
  mentraUserId: string,
  refusedToken: string,
): Promise<CliCredentials | null> {
  return withRefreshLock(target, async lease => {
    const current = await loadStoredLogin(target)
    if (!current || current.mentraUserId !== mentraUserId) return null
    if (current.token !== refusedToken) return current
    const renewed = await refreshUnderLock(target, current, lease)
    return renewed && renewed.mentraUserId === mentraUserId ? renewed : null
  })
}

/**
 * Refresh `current`, the login as stored when this command took the refresh lock, and store the result
 * over it. Returns the login to use: the refreshed one, or whatever another command stored meanwhile.
 */
async function refreshUnderLock(target: string, current: CliCredentials, lease: FileLease): Promise<CliCredentials | null> {
  // Paused past the lock's stale age, this command may have lost it: never spend the refresh token then.
  if (!lease.held()) throw new Error(LOST_LOCK)
  let refreshed: CliCredentials
  try {
    refreshed = await refreshLoginToken(current)
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      // Cleared only if it is still the login that was refused: a command that took the lock
      // meanwhile and stored another keeps it.
      const stored = await loadStoredLogin(target)
      if (stored && stored.refreshToken !== current.refreshToken) return stored
      if (stored) await clearCredentials(target)
    }
    throw error
  }
  // Stored only over the login this refresh started from. A command that took the lock meanwhile
  // keeps what it stored, and a login it signed out stays signed out; these tokens, which nothing
  // will use, are revoked.
  const stored = await loadStoredLogin(target)
  if (!stored || stored.refreshToken !== current.refreshToken) {
    await revokeLogin(refreshed).catch(() => undefined)
    return stored
  }
  await saveCredentials(refreshed)
  return refreshed
}

/** Store a new sign-in, replacing its Core's login once no refresh of that login is running. */
export function storeLogin(credentials: CliCredentials): Promise<"keychain" | "file"> {
  return withRefreshLock(normalizeUrl(credentials.coreUrl), () => saveCredentials(credentials))
}

/**
 * Sign out of the Core at `target`: once no refresh is running, revoke the stored login's refresh token
 * at the sign-in server and delete the login, even when the server cannot be reached.
 */
export function signOut(target: string): Promise<{signedIn: boolean; confirmed: boolean}> {
  return withRefreshLock(target, async lease => {
    const stored = await loadStoredLogin(target)
    let confirmed = false
    try {
      if (stored) confirmed = (await revokeLogin(stored)).confirmed
    } finally {
      // Deleted only while this command still holds the lock and the login is the one it revoked: a
      // command that took over while this one was paused may have stored another sign-in.
      const now = await loadStoredLogin(target)
      if (lease.held() && (now?.refreshToken ?? null) === (stored?.refreshToken ?? null)) await clearCredentials(target)
    }
    return {signedIn: stored !== null, confirmed}
  })
}

function withRefreshLock<T>(target: string, work: (lease: FileLease) => Promise<T>): Promise<T> {
  return withFileLock(
    refreshLockPath(target),
    {
      staleMs: LOCK_STALE_MS,
      waitMs: LOCK_WAIT_MS,
      busyMessage: "Another mentra command is refreshing this sign-in. Try again in a moment.",
    },
    work,
  )
}
