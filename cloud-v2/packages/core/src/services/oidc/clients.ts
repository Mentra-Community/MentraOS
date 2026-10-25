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
 * `findClient` is the one lookup the provider and Core's token checks use. A
 * later client source (miniapp websites, registered by the Store) plugs in
 * there; first-party clients never see a consent screen.
 */

import {ConfigurationError, isDeployedEnvironment} from "../signin/config"

export const CLIENT_KINDS = ["admin_portal", "workspace_portal", "console", "cli"] as const
export type ClientKind = (typeof CLIENT_KINDS)[number]

const DEFAULT_NAMES: Record<ClientKind, string> = {
  admin_portal: "Mentra admin portal",
  workspace_portal: "Mentra Portal",
  console: "Mentra Developer Console",
  cli: "Mentra CLI",
}

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** Client secrets live in variables named `CLOUD_CORE_OIDC_<CLIENT>_CLIENT_SECRET`, which the configuration contract classifies. */
const ENV_NAME = /^CLOUD_CORE_OIDC_[A-Z0-9_]{1,64}_CLIENT_SECRET$/
const MIN_SECRET_LENGTH = 32
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

export interface OidcClient {
  clientId: string
  kind: ClientKind
  name: string
  /** Every client from configuration is first-party: no consent screen. */
  firstParty: boolean
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
      if (kinds.has(client.kind)) fail(`at most one client of kind ${client.kind}`)
      ids.add(client.clientId)
      kinds.add(client.kind)
    }
  }
  cached = {raw, clients}
  return clients
}

/** A confidential client's secret, read from the variable it names at use time; null when unset. */
export function clientSecret(client: OidcClient): string | null {
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
  const client = configuredClients().find(entry => entry.clientId === clientId) ?? null
  if (!client) return null
  if (client.confidential && !clientSecret(client)) return null
  return client
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
