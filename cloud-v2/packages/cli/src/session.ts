/**
 * @fileoverview The credentials a command acts with, refreshed when needed.
 *
 * A stored login whose access token expires within 60 seconds is refreshed
 * first. The sign-in server rotates refresh tokens and ends the grant when a
 * spent one is presented again, so two commands must never refresh the same
 * login at once: a refresh holds a lock (`file-lock.ts`), and a command that
 * waited for it reads the login again and uses the refreshed tokens. The rotated refresh
 * token is stored before the new access token is used. A refused refresh
 * token clears the login (`SessionExpiredError`).
 */

import {refreshLoginToken, SessionExpiredError} from "./api"
import type {CliTarget} from "./config"
import {withFileLock} from "./file-lock"
import {
  clearCredentials,
  isStoredLogin,
  loadCredentials,
  loadStoredLogin,
  refreshLockPath,
  saveCredentials,
  type CliCredentials,
  type CommandCredentials,
} from "./credentials"

/** Refresh when the access token has less than this left. */
export const REFRESH_MARGIN_MS = 60_000
/** A refresh lock its holder stopped touching this long ago was left by a command that died. */
const LOCK_STALE_MS = 30_000
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
  return withRefreshLock(target, async () => {
    // Another command may have refreshed (or cleared) the login while this one waited.
    const current = await loadStoredLogin(target)
    if (!current || !needsRefresh(current)) return current
    let refreshed: CliCredentials
    try {
      refreshed = await refreshLoginToken(current)
    } catch (error) {
      if (error instanceof SessionExpiredError) await clearCredentials(target)
      throw error
    }
    await saveCredentials(refreshed)
    return refreshed
  })
}

function withRefreshLock<T>(target: CliTarget, work: () => Promise<T>): Promise<T> {
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
