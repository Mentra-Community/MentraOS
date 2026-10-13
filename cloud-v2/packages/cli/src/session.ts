/**
 * @fileoverview The credentials a command acts with, refreshed when needed.
 *
 * A stored login whose access token expires within 60 seconds is refreshed
 * first. The sign-in server rotates refresh tokens and ends the grant when a
 * spent one is presented again, so two commands must never refresh the same
 * login at once: a refresh holds a lock file, and a command that waited for it
 * reads the login again and uses the refreshed tokens. The rotated refresh
 * token is stored before the new access token is used. A refused refresh
 * token clears the login (`SessionExpiredError`).
 */

import {mkdirSync, rmSync, statSync} from "node:fs"

import {refreshLoginToken, SessionExpiredError} from "./api"
import type {CliTarget} from "./config"
import {
  cliHome,
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
/** A lock older than this was left by a command that died; it is taken over. */
const LOCK_STALE_MS = 30_000
/** How long a command waits for another one's refresh. */
const LOCK_WAIT_MS = 20_000

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

async function withRefreshLock<T>(target: CliTarget, work: () => Promise<T>): Promise<T> {
  mkdirSync(cliHome(), {recursive: true, mode: 0o700})
  const lock = refreshLockPath(target)
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if ((error as {code?: string})?.code !== "EEXIST") throw error
      let stale = false
      try {
        stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS
      } catch {
        // Released meanwhile: try again.
      }
      if (stale) {
        rmSync(lock, {recursive: true, force: true})
        continue
      }
      if (Date.now() > deadline) throw new Error("Another mentra command is refreshing this sign-in. Try again in a moment.")
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  try {
    return await work()
  } finally {
    rmSync(lock, {recursive: true, force: true})
  }
}
