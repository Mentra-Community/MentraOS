/**
 * @fileoverview The CLI's stored sign-in, one per Core.
 *
 * A `mentra login` is stored in the OS keychain (`Bun.secrets`), or, where no
 * keychain is available, in a mode-0600 file under `MENTRA_CLI_HOME` (default
 * `~/.mentra/cli-v2`). A login belongs to the Core it was made for; selecting
 * another Core never forwards its tokens.
 *
 * A record without the fields of a login (for example one stored by an older
 * CLI) reads as signed out.
 */

import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs"
import {homedir} from "node:os"
import {join, resolve} from "node:path"

import {normalizeUrl} from "./config"

/** The keychain service the CLI's logins are kept under (its name since the first release). */
const SERVICE = "mentra-store-cli"

/** A `mentra login`, as stored. */
export interface CliCredentials {
  /** The Core access token. */
  token: string
  refreshToken: string
  /** When `token` expires (ISO 8601). */
  expiresAt: string
  /** The Core user: the ID token's `sub`. */
  mentraUserId: string
  email: string | null
  /** The sign-in server that issued the tokens. */
  issuer: string
  /** The CLI client they were issued to; a refresh uses the same one. */
  clientId: string
  /** The Core this login is for. */
  coreUrl: string
  storedAt: string
}

/** Where the CLI keeps files: `MENTRA_CLI_HOME`, default `~/.mentra/cli-v2`. */
export function cliHome(): string {
  const configured = process.env.MENTRA_CLI_HOME?.trim()
  return configured ? resolve(configured) : join(homedir(), ".mentra", "cli-v2")
}

/** Store `credentials` for their Core. Returns where they went. */
export async function saveCredentials(credentials: CliCredentials): Promise<"keychain" | "file"> {
  const coreUrl = normalizeUrl(credentials.coreUrl)
  // Every write is dated, so a read can tell the newer of a keychain and a file login apart.
  const payload = JSON.stringify({...credentials, storedAt: new Date().toISOString()})
  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      await Bun.secrets.set({service: SERVICE, name: credentialName(coreUrl), value: payload})
      // A file left from a time without a keychain must not outlive this login.
      rmSync(credentialsFile(coreUrl), {force: true})
      return "keychain"
    }
  } catch {
    // No usable keychain: fall through to the file, and try not to leave an older login there.
    if (typeof Bun !== "undefined" && Bun.secrets) {
      await Bun.secrets.delete({service: SERVICE, name: credentialName(coreUrl)}).catch(() => false)
    }
  }
  writeCredentialsFile(coreUrl, payload)
  return "file"
}

function writeCredentialsFile(coreUrl: string, payload: string): void {
  const path = credentialsFile(coreUrl)
  mkdirSync(cliHome(), {recursive: true, mode: 0o700})
  // Written whole and renamed into place, so a reader never sees a partial record.
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${payload}\n`, {mode: 0o600})
  renameSync(temporary, path)
}

/**
 * The login stored for `coreUrl`; null when there is none. When both the keychain and the
 * file hold one (a save fell back to the file while the keychain was unavailable), the more recently
 * stored wins.
 */
export async function loadStoredLogin(coreUrl: string): Promise<CliCredentials | null> {
  let fromKeychain: CliCredentials | null = null
  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      const value = await Bun.secrets.get({service: SERVICE, name: credentialName(coreUrl)})
      if (value) fromKeychain = storedLogin(value, coreUrl)
    }
  } catch {
    // Read the file alone.
  }
  let fromFile: CliCredentials | null = null
  let signedOutAt: number | null = null
  try {
    const path = credentialsFile(coreUrl)
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8")
      fromFile = storedLogin(value, coreUrl)
      signedOutAt = signOutTime(value)
    }
  } catch {
    // An unreadable file reads as signed out.
  }
  // A sign-out the keychain could not record: an older keychain login stays signed out.
  if (signedOutAt !== null && fromKeychain && Date.parse(fromKeychain.storedAt) <= signedOutAt) return null
  if (fromKeychain && fromFile) {
    // A keychain write removes the file, so a file beside a keychain login is the later write; a
    // keychain login dated later (written after the file by a CLI that could not remove it) wins.
    return Date.parse(fromKeychain.storedAt) > Date.parse(fromFile.storedAt) ? fromKeychain : fromFile
  }
  return fromKeychain ?? fromFile
}

/** Remove the login stored for `coreUrl`, from the keychain and the file. */
export async function clearCredentials(coreUrl: string): Promise<void> {
  let keychainCleared = true
  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      const name = credentialName(coreUrl)
      if (typeof Bun.secrets.delete === "function") await Bun.secrets.delete({service: SERVICE, name})
      else await Bun.secrets.set({service: SERVICE, name, value: ""})
    }
  } catch {
    keychainCleared = false
  }
  if (keychainCleared) {
    rmSync(credentialsFile(coreUrl), {force: true})
    return
  }
  // The keychain still holds a login: a dated sign-out in the file outranks it until the next sign-in.
  writeCredentialsFile(coreUrl, JSON.stringify({signedOutAt: new Date().toISOString()}))
}

/** When a sign-out record (written when the keychain could not delete) was made, or null. */
function signOutTime(value: string): number | null {
  try {
    const parsed = JSON.parse(value) as {signedOutAt?: unknown}
    const time = typeof parsed?.signedOutAt === "string" ? Date.parse(parsed.signedOutAt) : NaN
    return Number.isFinite(time) ? time : null
  } catch {
    return null
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** A stored record as a login for `coreUrl`, or null when it is not one. */
function storedLogin(value: string, coreUrl: string): CliCredentials | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(value) as Record<string, unknown>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const fields = ["token", "refreshToken", "expiresAt", "mentraUserId", "issuer", "clientId", "storedAt"] as const
  if (!fields.every(field => nonEmpty(parsed[field]))) return null
  const url = parsed.coreUrl
  if (!nonEmpty(url)) return null
  try {
    if (normalizeUrl(url) !== coreUrl) return null
  } catch {
    return null
  }
  return {...(parsed as unknown as CliCredentials), coreUrl}
}

function credentialKey(coreUrl: string): string {
  return Buffer.from(coreUrl).toString("base64url")
}

function credentialName(coreUrl: string): string {
  return `core-credentials:${credentialKey(coreUrl)}`
}

function credentialsFile(coreUrl: string): string {
  return join(cliHome(), `core-credentials-${credentialKey(coreUrl)}.json`)
}

/** The lock a refresh of the login for `coreUrl` holds, so two commands never spend one refresh token twice. */
export function refreshLockPath(coreUrl: string): string {
  return join(cliHome(), `core-refresh-${credentialKey(coreUrl)}.lock`)
}
