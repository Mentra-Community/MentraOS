/**
 * @fileoverview The CLI's stored sign-in, one per target.
 *
 * A `mentra login` is stored in the OS keychain (`Bun.secrets`), or, where no
 * keychain is available, in a mode-0600 file under `MENTRA_CLI_HOME` (default
 * `~/.mentra/cli-v2`). A login belongs to the Store (or, in Core mode, the
 * Core) it was made for; selecting another target never forwards its tokens.
 *
 * `MENTRA_CLI_TOKEN` replaces the stored login for every command, for
 * automation with a workspace key (`msk_…`); `MENTRA_CLI_WORKSPACE_ID`
 * optionally selects its workspace.
 *
 * A record without the fields of a login (for example one stored by an older
 * CLI) reads as signed out.
 */

import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs"
import {homedir} from "node:os"
import {join, resolve} from "node:path"

import {normalizeUrl, type CliTarget} from "./config"

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
  /** The Store this login is for. Absent in Core mode. */
  storeUrl?: string
  /** The Core this login is for, in Core mode. Absent against a Store. */
  coreUrl?: string
  /** The workspace the CLI acts in: sent as `x-mentra-workspace-id`. */
  workspaceId?: string | null
  storedAt: string
}

/** `MENTRA_CLI_TOKEN`, which replaces the stored login. */
export interface TokenCredentials {
  fromEnvironment: true
  token: string
  storeUrl?: string
  coreUrl?: string
  workspaceId?: string | null
}

/** What a command acts with. */
export type CommandCredentials = CliCredentials | TokenCredentials

export function isStoredLogin(credentials: CommandCredentials): credentials is CliCredentials {
  return !("fromEnvironment" in credentials)
}

/** The target a login was made for. */
export function targetOf(credentials: {storeUrl?: string; coreUrl?: string}): CliTarget {
  if (credentials.coreUrl) return {kind: "core", url: normalizeUrl(credentials.coreUrl)}
  if (credentials.storeUrl) return {kind: "store", url: normalizeUrl(credentials.storeUrl)}
  throw new Error("These credentials name no Store or Core")
}

/** The fields that name `target` on credentials. */
export function targetFields(target: CliTarget): {storeUrl: string} | {coreUrl: string} {
  return target.kind === "store" ? {storeUrl: target.url} : {coreUrl: target.url}
}

/** Where the CLI keeps files: `MENTRA_CLI_HOME`, default `~/.mentra/cli-v2`. */
export function cliHome(): string {
  const configured = process.env.MENTRA_CLI_HOME?.trim()
  return configured ? resolve(configured) : join(homedir(), ".mentra", "cli-v2")
}

/** Store `credentials` for their target. Returns where they went. */
export async function saveCredentials(credentials: CliCredentials): Promise<"keychain" | "file"> {
  const target = targetOf(credentials)
  // Every write is dated, so a read can tell the newer of a keychain and a file login apart.
  const payload = JSON.stringify({...credentials, storedAt: new Date().toISOString()})
  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      await Bun.secrets.set({service: SERVICE, name: credentialName(target), value: payload})
      // A file left from a time without a keychain must not outlive this login.
      rmSync(credentialsFile(target), {force: true})
      return "keychain"
    }
  } catch {
    // No usable keychain: fall through to the file, and try not to leave an older login there.
    if (typeof Bun !== "undefined" && Bun.secrets) {
      await Bun.secrets.delete({service: SERVICE, name: credentialName(target)}).catch(() => false)
    }
  }
  writeCredentialsFile(target, payload)
  return "file"
}

function writeCredentialsFile(target: CliTarget, payload: string): void {
  const path = credentialsFile(target)
  mkdirSync(cliHome(), {recursive: true, mode: 0o700})
  // Written whole and renamed into place, so a reader never sees a partial record.
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${payload}\n`, {mode: 0o600})
  renameSync(temporary, path)
}

/** What a command acts with against `target`: `MENTRA_CLI_TOKEN` when set, else the stored login. */
export async function loadCredentials(target: CliTarget): Promise<CommandCredentials | null> {
  const token = process.env.MENTRA_CLI_TOKEN?.trim()
  if (token) {
    return {
      fromEnvironment: true,
      token,
      ...targetFields(target),
      workspaceId: process.env.MENTRA_CLI_WORKSPACE_ID?.trim() || undefined,
    }
  }
  return loadStoredLogin(target)
}

/**
 * The login stored for `target`, ignoring `MENTRA_CLI_TOKEN`; null when there is none. When both the
 * keychain and the file hold one (a save fell back to the file while the keychain was unavailable),
 * the more recently stored wins.
 */
export async function loadStoredLogin(target: CliTarget): Promise<CliCredentials | null> {
  let fromKeychain: CliCredentials | null = null
  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      const value = await Bun.secrets.get({service: SERVICE, name: credentialName(target)})
      if (value) fromKeychain = storedLogin(value, target)
    }
  } catch {
    // Read the file alone.
  }
  let fromFile: CliCredentials | null = null
  let signedOutAt: number | null = null
  try {
    const path = credentialsFile(target)
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8")
      fromFile = storedLogin(value, target)
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

/** Remove the login stored for `target`, from the keychain and the file. */
export async function clearCredentials(target: CliTarget): Promise<void> {
  let keychainCleared = true
  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      const name = credentialName(target)
      if (typeof Bun.secrets.delete === "function") await Bun.secrets.delete({service: SERVICE, name})
      else await Bun.secrets.set({service: SERVICE, name, value: ""})
    }
  } catch {
    keychainCleared = false
  }
  if (keychainCleared) {
    rmSync(credentialsFile(target), {force: true})
    return
  }
  // The keychain still holds a login: a dated sign-out in the file outranks it until the next sign-in.
  writeCredentialsFile(target, JSON.stringify({signedOutAt: new Date().toISOString()}))
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

/** A stored record as a login for `target`, or null when it is not one. */
function storedLogin(value: string, target: CliTarget): CliCredentials | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(value) as Record<string, unknown>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const fields = ["token", "refreshToken", "expiresAt", "mentraUserId", "issuer", "clientId", "storedAt"] as const
  if (!fields.every(field => nonEmpty(parsed[field]))) return null
  const url = target.kind === "store" ? parsed.storeUrl : parsed.coreUrl
  const other = target.kind === "store" ? parsed.coreUrl : parsed.storeUrl
  if (!nonEmpty(url) || other !== undefined) return null
  try {
    if (normalizeUrl(url) !== target.url) return null
  } catch {
    return null
  }
  return {...(parsed as unknown as CliCredentials), ...targetFields(target)}
}

function credentialKey(target: CliTarget): string {
  return Buffer.from(target.url).toString("base64url")
}

function credentialName(target: CliTarget): string {
  return target.kind === "store" ? `credentials:${credentialKey(target)}` : `core-credentials:${credentialKey(target)}`
}

function credentialsFile(target: CliTarget): string {
  return join(cliHome(), `${target.kind}-credentials-${credentialKey(target)}.json`)
}

/** The lock a refresh of `target`'s login holds, so two commands never spend one refresh token twice. */
export function refreshLockPath(target: CliTarget): string {
  return join(cliHome(), `${target.kind}-refresh-${credentialKey(target)}.lock`)
}
