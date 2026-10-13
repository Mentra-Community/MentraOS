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
 * other change to a stored login (a new sign-in, selecting a workspace, signing
 * out) takes the same lock and starts from the login as stored then, so none
 * undoes a refresh and no refresh brings back a login that was replaced or
 * signed out. The rotated refresh
 * token is stored before the new access token is used. A refused refresh
 * token clears the login (`SessionExpiredError`).
 */

import {refreshLoginToken, revokeLogin, SessionExpiredError} from "./api"
import type {CliTarget} from "./config"
import {withFileLock, type FileLease} from "./file-lock"
import {
  clearCredentials,
  isStoredLogin,
  loadCredentials,
  loadStoredLogin,
  refreshLockPath,
  saveCredentials,
  targetOf,
  type CliCredentials,
  type CommandCredentials,
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
 * What a command acts with against `target`: `MENTRA_CLI_TOKEN`, or the
 * stored login, refreshed when it is about to expire. Null when signed out.
 * Throws `SessionExpiredError` (after clearing the login) when the refresh
 * token is refused.
 */
export async function loadFreshCredentials(target: CliTarget): Promise<CommandCredentials | null> {
  const credentials = await loadCredentials(target)
  if (!credentials || !isStoredLogin(credentials) || !needsRefresh(credentials)) return credentials
  return withRefreshLock(target, async lease => {
    // Another command may have refreshed (or cleared) the login while this one waited.
    const current = await loadStoredLogin(target)
    if (!current || !needsRefresh(current)) return current
    // Paused past the lock's stale age, this command may have lost it: never spend the refresh token then.
    if (!lease.held()) throw new Error(LOST_LOCK)
    let refreshed: CliCredentials
    try {
      refreshed = await refreshLoginToken(current)
    } catch (error) {
      if (error instanceof SessionExpiredError) await clearCredentials(target)
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
  })
}

/** Store a new sign-in, replacing its target's login once no refresh of that login is running. */
export function storeLogin(credentials: CliCredentials): Promise<"keychain" | "file"> {
  return withRefreshLock(targetOf(credentials), () => saveCredentials(credentials))
}

/**
 * Select `workspaceId`, which was checked for `chosenFor`'s person, on `target`'s login as it is
 * stored now, keeping whatever tokens a refresh rotated meanwhile. Null, changing nothing, when signed
 * out or when another person's login has replaced it since (the workspace was not checked for them).
 */
export function selectWorkspace(
  target: CliTarget,
  workspaceId: string,
  chosenFor: {mentraUserId: string},
): Promise<"keychain" | "file" | null> {
  return withRefreshLock(target, async () => {
    const current = await loadStoredLogin(target)
    if (!current || current.mentraUserId !== chosenFor.mentraUserId) return null
    return saveCredentials({...current, workspaceId})
  })
}

/**
 * Sign out of `target`: once no refresh is running, revoke the stored login's refresh token at the
 * sign-in server and delete the login, even when the server cannot be reached.
 */
export function signOut(target: CliTarget): Promise<{signedIn: boolean; confirmed: boolean}> {
  return withRefreshLock(target, async () => {
    const stored = await loadStoredLogin(target)
    let confirmed = false
    try {
      if (stored) confirmed = (await revokeLogin(stored)).confirmed
    } finally {
      await clearCredentials(target)
    }
    return {signedIn: stored !== null, confirmed}
  })
}

function withRefreshLock<T>(target: CliTarget, work: (lease: FileLease) => Promise<T>): Promise<T> {
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
