/**
 * @fileoverview The clients of Core's sign-in server.
 *
 * Every client is registered in its environment's Core; dynamic client
 * registration is off. Today every client is first-party and comes from
 * `CLOUD_CORE_OIDC_CLIENTS`, a JSON array:
 *
 *   [{"clientId": "mentra-admin-prod", "kind": "admin_portal",
 *     "secretEnv": "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET",
 *     "redirectUris": ["https://admin.mentraglass.com/api/admin/auth/callback"]}, ...]
 *
 * - `kind`: `admin_portal`, `workspace_portal`, `console` (confidential
 *   clients that authenticate with `client_secret_post`) or `cli` (a public
 *   client with loopback redirects). At most one client of each kind.
 * - `secretEnv`: the variable holding a confidential client's secret, named
 *   `CLOUD_CORE_OIDC_<CLIENT>_CLIENT_SECRET` (at least 32 characters).
 *   Secrets never sit in the JSON itself.
 * - `redirectUris`: matched exactly.
 * - `postLogoutRedirectUris`: where a client may ask the sign-in server to send
 *   the browser after signing the person out (end-session's
 *   `post_logout_redirect_uri`), matched exactly. Optional: a confidential
 *   client without it registers the root (`<origin>/`) of each of its
 *   redirect URIs' origins, which is where the portals return after sign-out.
 *   A configured list, empty included, is used as it is. The CLI registers
 *   none unless configured.
 * - The Developer Console and the CLI get refresh tokens; the portals do not.
 *
 * `findClient` is the one lookup the provider and Core's token checks use. It
 * answers:
 *  - the configured first-party clients, which never see a consent screen;
 *  - the registered miniapp websites (`website-clients.service.ts`), which are
 *    third-party: the person consents, and their tokens are miniapp tokens for
 *    one package;
 *  - the sign-in site's own client (`ACCOUNT_CLIENT_ID`), which exists so a
 *    person can sign in to the site's Connected apps page. It needs no
 *    configuration, redirects only to that page, and no token issued to it is
 *    accepted anywhere.
 */

import {ConfigurationError, isDeployedEnvironment} from "../signin/config"
import {oidcIssuer} from "./config"
import {activeWebsiteClient, isWebsiteClientId} from "./website-clients.service"

export const CLIENT_KINDS = ["admin_portal", "workspace_portal", "console", "cli"] as const
export type ClientKind = (typeof CLIENT_KINDS)[number]

const DEFAULT_NAMES: Record<ClientKind, string> = {
  admin_portal: "Mentra admin portal",
  workspace_portal: "Mentra Portal",
  console: "Mentra Developer Console",
  cli: "Mentra CLI",
}

/** The sign-in site's own client, and the page it signs a person in to. */
export const ACCOUNT_CLIENT_ID = "mentra-account"
export const CONNECTIONS_PATH = "/connections"

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** Client secrets live in variables named `CLOUD_CORE_OIDC_<CLIENT>_CLIENT_SECRET`, which the configuration contract classifies. */
const ENV_NAME = /^CLOUD_CORE_OIDC_[A-Z0-9_]{1,64}_CLIENT_SECRET$/
const MIN_SECRET_LENGTH = 32
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/** What a registered miniapp website adds to a client. */
export interface WebsiteBinding {
  /** The one package it acts for: the audience of its tokens. */
  packageName: string
  access: "public" | "private"
  /** For a private client: the workspaces whose active members may sign in. */
  accessWorkspaceIds: string[]
  /** A developer's development client signs in nobody but that developer; null for every other client. */
  onlyUserId: string | null
  /** A server client's secret, as stored: its SHA-256. Core's relay hashes the presented secret before the provider compares. */
  secretHash: string | null
}

export interface OidcClient {
  clientId: string
  /** `website` for a registered miniapp website, `account` for the sign-in site's own client; a configured kind otherwise. */
  kind: ClientKind | "website" | "account"
  name: string
  /** First-party clients (every configured one, and the sign-in site's own) see no consent screen. A miniapp website is never one. */
  firstParty: boolean
  /** Set for a miniapp website, null for a first-party client. */
  website: WebsiteBinding | null
  /** Confidential clients authenticate with `client_secret_post`; the CLI is public. */
  confidential: boolean
  secretEnv: string | null
  redirectUris: string[]
  postLogoutRedirectUris: string[]
  grantTypes: string[]
}

let cached: {raw: string; clients: OidcClient[]} | null = null

function fail(message: string): never {
  throw new ConfigurationError(`CLOUD_CORE_OIDC_CLIENTS: ${message}`)
}

function stringArray(value: unknown, label: string, required: boolean): string[] {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || (required && value.length === 0) || value.some(entry => typeof entry !== "string" || !entry.trim())) {
    fail(`${label} must be ${required ? "a non-empty" : "an"} array of URLs`)
  }
  return value.map(entry => entry.trim())
}

function checkUri(uri: string, label: string, loopbackOnly: boolean): void {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    fail(`${label} "${uri}" is not a URL`)
  }
  if (url.hash || url.username || url.password) fail(`${label} "${uri}" must have no fragment or credentials`)
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
  if (loopbackOnly) {
    if (!loopback) fail(`${label} "${uri}" must be a loopback http URL`)
    return
  }
  if (url.protocol === "https:") return
  if (loopback && !isDeployedEnvironment()) return
  fail(`${label} "${uri}" must be an HTTPS URL`)
}

/** The root (`<origin>/`) of each URI's origin, once each, in order. */
function originRoots(uris: string[]): string[] {
  return [...new Set(uris.map(uri => `${new URL(uri).origin}/`))]
}

function parseClient(value: unknown, index: number): OidcClient {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`entry ${index} must be an object`)
  const entry = value as Record<string, unknown>
  const clientId = typeof entry.clientId === "string" ? entry.clientId.trim() : ""
  if (!CLIENT_ID.test(clientId)) fail(`entry ${index} clientId must be 1-64 letters, digits, "_" or "-"`)
  // That prefix is the registered websites': a configured client must never answer for one.
  if (isWebsiteClientId(clientId)) fail(`entry ${index} clientId must not start with "mwc_"`)
  if (clientId === ACCOUNT_CLIENT_ID) fail(`entry ${index} clientId "${ACCOUNT_CLIENT_ID}" is the sign-in site's own`)
  const label = `client "${clientId}"`
  const kind = entry.kind
  if (typeof kind !== "string" || !(CLIENT_KINDS as readonly string[]).includes(kind)) {
    fail(`${label} kind must be one of ${CLIENT_KINDS.join(", ")}`)
  }
  const clientKind = kind as ClientKind
  const confidential = clientKind !== "cli"
  const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : DEFAULT_NAMES[clientKind]

  let secretEnv: string | null = null
  if (confidential) {
    if (typeof entry.secretEnv !== "string" || !ENV_NAME.test(entry.secretEnv)) fail(`${label} secretEnv must name a CLOUD_CORE_OIDC_<CLIENT>_CLIENT_SECRET variable`)
    secretEnv = entry.secretEnv
  } else if (entry.secretEnv !== undefined) {
    fail(`${label} is a public client and takes no secretEnv`)
  }

  const redirectUris = stringArray(entry.redirectUris, `${label} redirectUris`, true)
  for (const uri of redirectUris) checkUri(uri, `${label} redirect URI`, clientKind === "cli")
  const postLogoutRedirectUris =
    entry.postLogoutRedirectUris === undefined && confidential
      ? originRoots(redirectUris)
      : stringArray(entry.postLogoutRedirectUris, `${label} postLogoutRedirectUris`, false)
  for (const uri of postLogoutRedirectUris) checkUri(uri, `${label} post-logout redirect URI`, false)

  return {
    clientId,
    kind: clientKind,
    name,
    firstParty: true,
    website: null,
    confidential,
    secretEnv,
    redirectUris,
    postLogoutRedirectUris,
    grantTypes: clientKind === "console" || clientKind === "cli" ? ["authorization_code", "refresh_token"] : ["authorization_code"],
  }
}

/** The configured first-party clients. Throws ConfigurationError, naming the problem, for a malformed list. */
export function configuredClients(): OidcClient[] {
  const raw = (process.env.CLOUD_CORE_OIDC_CLIENTS ?? "").trim()
  if (cached?.raw === raw) return cached.clients
  let clients: OidcClient[] = []
  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      fail("must be a JSON array")
    }
    if (!Array.isArray(parsed)) fail("must be a JSON array")
    clients = parsed.map(parseClient)
    const ids = new Set<string>()
    const kinds = new Set<ClientKind>()
    for (const client of clients) {
      if (ids.has(client.clientId)) fail(`client "${client.clientId}" is listed twice`)
      // Configured clients are always of a configured kind.
      const kind = client.kind as ClientKind
      if (kinds.has(kind)) fail(`at most one client of kind ${kind}`)
      ids.add(client.clientId)
      kinds.add(kind)
    }
  }
  cached = {raw, clients}
  return clients
}

/** A confidential client's secret, read from the variable it names at use time; null when unset. */
export function clientSecret(client: OidcClient): string | null {
  // A website's secret is known only as its hash; the relay hashes what the site presents (`api/oidc/oidc.api.ts`).
  if (client.website) return client.website.secretHash
  if (!client.secretEnv) return null
  const value = (process.env[client.secretEnv] ?? "").trim()
  return value || null
}

/**
 * The client with this ID, or null for an unknown one. This is the one place
 * clients are looked up; a confidential client whose secret is missing is
 * treated as unknown, so it can neither sign in nor have its tokens accepted.
 */
export async function findClient(clientId: string): Promise<OidcClient | null> {
  if (clientId === ACCOUNT_CLIENT_ID) return accountClient()
  const client = configuredClients().find(entry => entry.clientId === clientId) ?? null
  if (!client) return findWebsiteClient(clientId)
  if (client.confidential && !clientSecret(client)) return null
  return client
}

/**
 * The sign-in site's own client: a public client whose one redirect is the site's Connected apps page. The
 * page never redeems the code, and a token issued to this client is refused everywhere
 * (`core-access-token.ts`): signing in through it only starts the person's session at the sign-in server.
 */
function accountClient(): OidcClient | null {
  const issuer = oidcIssuer()
  if (!issuer) return null
  return {
    clientId: ACCOUNT_CLIENT_ID,
    kind: "account",
    name: "Mentra account",
    firstParty: true,
    website: null,
    confidential: false,
    secretEnv: null,
    redirectUris: [`${issuer}${CONNECTIONS_PATH}`],
    postLogoutRedirectUris: [],
    grantTypes: ["authorization_code"],
  }
}

/** A registered, active miniapp website as a client; null for anything else. A disabled website is no client. */
async function findWebsiteClient(clientId: string): Promise<OidcClient | null> {
  const website = await activeWebsiteClient(clientId)
  if (!website) return null
  return {
    clientId: website.clientId,
    kind: "website",
    name: website.name,
    firstParty: false,
    website: {
      packageName: website.packageName,
      access: website.access,
      accessWorkspaceIds: website.accessWorkspaceIds,
      onlyUserId: website.environment === "development" ? website.ownerUserId : null,
      secretHash: website.secretHash,
    },
    confidential: website.type === "server",
    secretEnv: null,
    redirectUris: website.redirectUris,
    // A site signs the person out of itself; it is not sent back from the sign-in server's sign-out.
    postLogoutRedirectUris: [],
    grantTypes: ["authorization_code", "refresh_token"],
  }
}

/** The configured client of a kind (for example the admin portal's), or null. */
export function clientOfKind(kind: ClientKind): OidcClient | null {
  return configuredClients().find(client => client.kind === kind) ?? null
}

/** The client as `oidc-provider` client metadata. */
export function providerClientMetadata(client: OidcClient): Record<string, unknown> {
  const secret = clientSecret(client)
  return {
    client_id: client.clientId,
    client_name: client.name,
    ...(client.confidential ? {client_secret: secret, token_endpoint_auth_method: "client_secret_post"} : {token_endpoint_auth_method: "none"}),
    // A website's development client stays a web application, so the provider matches its loopback redirect
    // exactly, port included; for a native one it would ignore the port.
    application_type: client.kind === "cli" ? "native" : "web",
    redirect_uris: client.redirectUris,
    post_logout_redirect_uris: client.postLogoutRedirectUris,
    grant_types: client.grantTypes,
    response_types: ["code"],
    id_token_signed_response_alg: "EdDSA",
  }
}

/**
 * Refuse a client list that is malformed or names a missing or short secret.
 * Runs at startup when the provider is on.
 */
export function assertClientConfiguration(): void {
  for (const client of configuredClients()) {
    if (!client.confidential) continue
    const secret = clientSecret(client)
    if (!secret) fail(`client "${client.clientId}" secretEnv names ${client.secretEnv}, which is not set`)
    if (secret.length < MIN_SECRET_LENGTH) {
      fail(`client "${client.clientId}" secret (${client.secretEnv}) must be at least ${MIN_SECRET_LENGTH} characters`)
    }
  }
}
