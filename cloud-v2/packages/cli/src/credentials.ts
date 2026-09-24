import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {homedir} from "node:os"
import {join} from "node:path"
import {getConfig, normalizeUrl} from "./config"

const SERVICE = "mentra-store-cli"
const MENTRA_DIR = join(homedir(), ".mentra")
const CREDS_DIR = join(MENTRA_DIR, "cli-v2")
const SIGNING_KEY_SERVICE = "mentra-cli-v2-signing"

export type CliJwk = Record<string, unknown> & {
  kty?: string
  crv?: string
  x?: string
  d?: string
}

export interface CliCredentials {
  token: string
  refreshToken?: string
  workosUserId: string
  email: string
  organizationId?: string | null
  developerOrgId?: string | null
  authenticationMethod?: string
  storeUrl: string
  storedAt: string
  expiresAt?: string
}

export interface CliSigningKey {
  storeUrl: string
  signingKeyId: string
  publicKeyJwk: CliJwk
  privateKeyJwk: CliJwk
  createdAt: string
}

export async function saveCredentials(credentials: CliCredentials): Promise<"keychain" | "file"> {
  const payload = JSON.stringify(credentials)
  const name = credentialName(credentials.storeUrl)

  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      await Bun.secrets.set({
        service: SERVICE,
        name,
        value: payload,
      })
      return "keychain"
    }
  } catch {
    // Fall through to file storage.
  }

  mkdirSync(CREDS_DIR, {recursive: true})
  writeFileSync(credentialsFile(credentials.storeUrl), `${payload}\n`, {mode: 0o600})
  return "file"
}

/** Login sessions belong to one Store. Selecting another Store never forwards a saved token. */
export async function loadCredentials(storeUrl = getConfig().storeUrl): Promise<CliCredentials | null> {
  const targetStoreUrl = normalizeUrl(storeUrl)
  if (process.env.MENTRA_CLI_TOKEN) {
    return {
      token: process.env.MENTRA_CLI_TOKEN,
      workosUserId: process.env.MENTRA_CLI_WORKOS_USER_ID || "unknown",
      email: process.env.MENTRA_CLI_EMAIL || "unknown",
      organizationId: process.env.MENTRA_CLI_ORGANIZATION_ID,
      developerOrgId: process.env.MENTRA_CLI_DEVELOPER_ORG_ID,
      storeUrl: targetStoreUrl,
      storedAt: new Date().toISOString(),
    }
  }
  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      const value = await Bun.secrets.get({service: SERVICE, name: credentialName(targetStoreUrl)})
      if (value) return matchingCredentials(value, targetStoreUrl)
    }
  } catch {
    // Fall through to file storage.
  }
  try {
    const path = credentialsFile(targetStoreUrl)
    if (existsSync(path)) return matchingCredentials(readFileSync(path, "utf8"), targetStoreUrl)
  } catch {
    // Treat corrupt credentials as logged out.
  }
  return null
}

export async function clearCredentials(storeUrl = getConfig().storeUrl): Promise<void> {
  const targetStoreUrl = normalizeUrl(storeUrl)
  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      await Bun.secrets.set({service: SERVICE, name: credentialName(targetStoreUrl), value: ""})
    }
  } catch {
    // Remove the file fallback even if the keychain is unavailable.
  }
  const path = credentialsFile(targetStoreUrl)
  if (existsSync(path)) rmSync(path)
}

function matchingCredentials(value: string, storeUrl: string): CliCredentials | null {
  const credentials = JSON.parse(value) as CliCredentials
  return credentials.storeUrl && normalizeUrl(credentials.storeUrl) === storeUrl && credentials.token
    ? {...credentials, storeUrl}
    : null
}

export async function saveSigningKey(key: CliSigningKey): Promise<"keychain" | "file"> {
  const payload = JSON.stringify(key)
  const name = credentialName(key.storeUrl)

  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      await Bun.secrets.set({
        service: SIGNING_KEY_SERVICE,
        name,
        value: payload,
      })
      return "keychain"
    }
  } catch {
    // Fall through to file storage.
  }

  mkdirSync(CREDS_DIR, {recursive: true})
  writeFileSync(signingKeyFile(key.storeUrl), `${payload}\n`, {mode: 0o600})
  return "file"
}

export async function loadSigningKey(storeUrl: string): Promise<CliSigningKey | null> {
  const targetStoreUrl = normalizeUrl(storeUrl)
  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      const value = await Bun.secrets.get({
        service: SIGNING_KEY_SERVICE,
        name: credentialName(targetStoreUrl),
      })
      if (value) return JSON.parse(value) as CliSigningKey
    }
  } catch {
    // Fall through.
  }

  try {
    const path = signingKeyFile(targetStoreUrl)
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as CliSigningKey
  } catch {
    // Treat corrupt key storage as missing.
  }

  return null
}

function credentialName(storeUrl: string): string {
  return `credentials:${credentialKey(storeUrl)}`
}

function credentialsFile(storeUrl: string): string {
  return join(CREDS_DIR, `store-credentials-${credentialKey(storeUrl)}.json`)
}

function signingKeyFile(storeUrl: string): string {
  return join(CREDS_DIR, `signing-key-${credentialKey(storeUrl)}.json`)
}

function credentialKey(storeUrl: string): string {
  return Buffer.from(normalizeUrl(storeUrl)).toString("base64url")
}
