/**
 * @fileoverview Miniapp website clients: the websites registered to sign people in with Mentra
 * (`design_docs/cloud/auth/miniapp-website-sign-in/spec.md`).
 *
 * A website client is a third-party client of Core's sign-in server, bound to one package:
 *  - `browser`: a public client, for a single-page site with no server session;
 *  - `server`: a confidential client, whose server runs the code flow and keeps the tokens. Core allocates
 *    its secret and shows it once; only its SHA-256 is stored.
 *
 * The person consents on Mentra's sign-in page, and what the site receives is the person's miniapp token for
 * that package (`website-tokens.ts`), never a token for Core's own API.
 *
 * Two kinds of people register one:
 *  - **A developer, for a package on their own domain** (`registerOwnWebsite`). A package name belongs to
 *    the domain it is served from (the miniapp registry's domain rule), and a website's redirect URIs say
 *    where a person's sign-in is delivered. So a developer's website must redirect to the package's own
 *    domain: whoever controls that domain already serves the miniapp and receives the same tokens on the
 *    phone. The package must be in Core's registry and not archived, and its name on the consent screen is
 *    the one Core read from its `miniapp.json`. A development client redirects to the developer's own
 *    computer instead, and signs in nobody but them.
 *  - **An Organization Admin** (`createWebsiteClient`), for any package and any HTTPS address, with the
 *    name they give.
 *
 * Every write is in the admin audit log.
 */

import {createHash, randomBytes} from "node:crypto"

import {ulid} from "ulid"

import {isPackageNameAllowedForUrl, registrableDomain} from "@mentra/cloud-protocol"

import {AdminActionAuditLogModel} from "../../models/admin-action-audit-log.model"
import {MiniappRegistryArchiveRuleModel, MiniappRegistryEntryModel} from "../../models/miniapp-registry.model"
import {
  WEBSITE_CLIENT_ACCESS,
  WEBSITE_CLIENT_ENVIRONMENTS,
  WEBSITE_CLIENT_TYPES,
  WebsiteClientModel,
  type WebsiteClientAccess,
  type WebsiteClientEnvironment,
  type WebsiteClientType,
} from "../../models/website-client.model"
import {archivedUrls, type RegistryEntryRow} from "../registry/registry.service"

const CLIENT_ID_PREFIX = "mwc_"
/** A miniapp's package name: reverse-domain, lowercase. */
const PACKAGE_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])
const MAX_NAME_LENGTH = 80
const MAX_REDIRECT_URIS = 10
const MAX_ACCESS_WORKSPACES = 200
/** How many websites one developer may have registered at a time. */
export const MAX_WEBSITES_PER_DEVELOPER = 20

/** A website client as callers see it: never the secret's hash. */
export interface WebsiteClientView {
  clientId: string
  name: string
  type: WebsiteClientType
  environment: WebsiteClientEnvironment
  redirectUris: string[]
  packageName: string
  /** The developer who registered it and may change it; null for one an Organization Admin registered. */
  ownerUserId: string | null
  access: WebsiteClientAccess
  accessWorkspaceIds: string[]
  status: "active" | "disabled"
  /** The last four characters of a server client's secret; null for a browser client. */
  secretLast4: string | null
  createdAt: string
  updatedAt: string
}

export type WebsiteClientErrorCode =
  | "invalid"
  | "not_found"
  | "no_secret"
  /** The package is not in Core's registry: nobody has installed it yet. */
  | "not_in_registry"
  /** The package is archived. */
  | "archived"
  /** A redirect URI is not on the package's own domain. */
  | "domain_mismatch"
  | "too_many_websites"

/** A refused write, with a message fit to show whoever is registering the client. */
export class WebsiteClientError extends Error {
  constructor(
    readonly code: WebsiteClientErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "WebsiteClientError"
  }
}

function invalid(message: string): never {
  throw new WebsiteClientError("invalid", message)
}

/** Whether `value` is the ID of a website client, as Core allocates them. */
export function isWebsiteClientId(value: string): boolean {
  return value.startsWith(CLIENT_ID_PREFIX)
}

export function hashWebsiteClientSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

function newSecret(): {secret: string; secretHash: string; secretLast4: string} {
  const secret = `mws_${randomBytes(32).toString("base64url")}`
  return {secret, secretHash: hashWebsiteClientSecret(secret), secretLast4: secret.slice(-4)}
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
}

/**
 * Redirect URIs: full, exact URLs with no fragment or credentials. Production takes HTTPS only; development
 * also takes loopback HTTP with a fixed port. A private LAN address is not loopback.
 */
function checkRedirectUris(value: unknown, environment: WebsiteClientEnvironment): string[] {
  if (!Array.isArray(value) || value.length === 0) invalid("redirectUris must be a non-empty list of URLs")
  if (value.length > MAX_REDIRECT_URIS) invalid(`at most ${MAX_REDIRECT_URIS} redirect URIs`)
  const uris: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) invalid("redirectUris must be a non-empty list of URLs")
    const uri = entry.trim()
    let url: URL
    try {
      url = new URL(uri)
    } catch {
      invalid(`"${uri}" is not a URL`)
    }
    if (url.hash || url.username || url.password) invalid(`"${uri}" must have no fragment or credentials`)
    if (url.protocol === "https:") {
      // HTTPS is always allowed.
    } else if (isLoopback(url)) {
      if (environment !== "development") invalid(`"${uri}": only a development client may redirect to this computer`)
      if (!url.port) invalid(`"${uri}" needs a fixed port`)
    } else {
      invalid(`"${uri}" must be an HTTPS URL`)
    }
    if (uris.includes(uri)) invalid(`"${uri}" is listed twice`)
    uris.push(uri)
  }
  return uris
}

function checkName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : ""
  if (!name || name.length > MAX_NAME_LENGTH) invalid(`name must be 1-${MAX_NAME_LENGTH} characters`)
  // Shown on the consent screen: a name is words, never markup or a line of its own making.
  if (/[\u0000-\u001f\u007f<>]/.test(name)) invalid("name must not contain control characters or angle brackets")
  return name
}

function checkAccess(access: unknown, workspaceIds: unknown): {access: WebsiteClientAccess; accessWorkspaceIds: string[]} {
  if (typeof access !== "string" || !(WEBSITE_CLIENT_ACCESS as readonly string[]).includes(access)) {
    invalid(`access must be one of ${WEBSITE_CLIENT_ACCESS.join(", ")}`)
  }
  if (access === "public") return {access: "public", accessWorkspaceIds: []}
  if (!Array.isArray(workspaceIds) || workspaceIds.length === 0 || workspaceIds.some(id => typeof id !== "string" || !id.trim())) {
    invalid("a private client lists the workspaces whose members may sign in (accessWorkspaceIds)")
  }
  if (workspaceIds.length > MAX_ACCESS_WORKSPACES) invalid(`at most ${MAX_ACCESS_WORKSPACES} workspaces`)
  return {access: "private", accessWorkspaceIds: [...new Set((workspaceIds as string[]).map(id => id.trim()))]}
}

type Stored = {
  clientId: string
  name: string
  type: WebsiteClientType
  environment: WebsiteClientEnvironment
  redirectUris: string[]
  packageName: string
  ownerUserId?: string | null
  access: WebsiteClientAccess
  accessWorkspaceIds?: string[]
  status: "active" | "disabled"
  secretHash?: string | null
  secretLast4?: string | null
  createdAt?: Date
  updatedAt?: Date
}

function view(row: Stored): WebsiteClientView {
  return {
    clientId: row.clientId,
    name: row.name,
    type: row.type,
    environment: row.environment,
    redirectUris: [...row.redirectUris],
    packageName: row.packageName,
    ownerUserId: row.ownerUserId ?? null,
    access: row.access,
    accessWorkspaceIds: [...(row.accessWorkspaceIds ?? [])],
    status: row.status,
    secretLast4: row.secretLast4 ?? null,
    createdAt: (row.createdAt ?? new Date(0)).toISOString(),
    updatedAt: (row.updatedAt ?? new Date(0)).toISOString(),
  }
}

async function audit(actor: string, action: string, clientId: string, metadata: Record<string, unknown>): Promise<void> {
  await AdminActionAuditLogModel.create({
    adminId: actor,
    action: `website_client.${action}`,
    targetType: "website_client",
    targetId: clientId,
    reason: null,
    metadata,
  })
}

export interface CreateWebsiteClientInput {
  name: unknown
  type: unknown
  environment: unknown
  redirectUris: unknown
  packageName: unknown
  access: unknown
  accessWorkspaceIds?: unknown
}

function checkKind(input: {type: unknown; environment: unknown; packageName: unknown}) {
  if (typeof input.type !== "string" || !(WEBSITE_CLIENT_TYPES as readonly string[]).includes(input.type)) {
    invalid(`type must be one of ${WEBSITE_CLIENT_TYPES.join(", ")}`)
  }
  if (typeof input.environment !== "string" || !(WEBSITE_CLIENT_ENVIRONMENTS as readonly string[]).includes(input.environment)) {
    invalid(`environment must be one of ${WEBSITE_CLIENT_ENVIRONMENTS.join(", ")}`)
  }
  const packageName = typeof input.packageName === "string" ? input.packageName.trim() : ""
  if (!PACKAGE_NAME.test(packageName) || packageName.length > 128) invalid("packageName must be the miniapp's package name")
  return {type: input.type as WebsiteClientType, environment: input.environment as WebsiteClientEnvironment, packageName}
}

async function insert(
  fields: {
    name: string
    type: WebsiteClientType
    environment: WebsiteClientEnvironment
    redirectUris: string[]
    packageName: string
    ownerUserId: string | null
    access: WebsiteClientAccess
    accessWorkspaceIds: string[]
  },
  actor: string,
): Promise<{client: WebsiteClientView; secret: string | null}> {
  const secret = fields.type === "server" ? newSecret() : null
  const created = await WebsiteClientModel.create({
    clientId: `${CLIENT_ID_PREFIX}${ulid().toLowerCase()}`,
    ...fields,
    status: "active",
    secretHash: secret?.secretHash ?? null,
    secretLast4: secret?.secretLast4 ?? null,
    createdBy: actor,
    updatedBy: actor,
  })
  await audit(actor, "create", created.clientId, {
    packageName: fields.packageName,
    type: fields.type,
    environment: fields.environment,
    access: fields.access,
    by: fields.ownerUserId ? "developer" : "organization_admin",
  })
  return {client: view(created.toObject() as Stored), secret: secret?.secret ?? null}
}

/**
 * Register a website as an Organization Admin: for any package, at any HTTPS address, under the name given.
 * Returns the client and, for a server client, its secret: the only time the plaintext exists outside the site.
 */
export async function createWebsiteClient(
  input: CreateWebsiteClientInput,
  actor: string,
): Promise<{client: WebsiteClientView; secret: string | null}> {
  const kind = checkKind(input)
  const name = checkName(input.name)
  const redirectUris = checkRedirectUris(input.redirectUris, kind.environment)
  const access = checkAccess(input.access, input.accessWorkspaceIds)
  return insert({...kind, name, redirectUris, ownerUserId: null, ...access}, actor)
}

// --- A developer's own websites -------------------------------------------------------------------

/** The package as Core's registry knows it: its verified name when it has a live entry, or why it has none. */
async function registryPackage(packageName: string): Promise<{name: string | null} | "not_in_registry" | "archived"> {
  const rows = await MiniappRegistryEntryModel.find({packageName}).lean<RegistryEntryRow[]>()
  if (rows.length === 0) return "not_in_registry"
  if (await MiniappRegistryArchiveRuleModel.exists({kind: "package", value: packageName})) return "archived"
  const archived = await archivedUrls(rows)
  const live = rows.filter(row => !archived.has(row.url))
  if (live.length === 0) return "archived"
  // The name Core read from the miniapp's own `miniapp.json`; a private miniapp Core could not read has none.
  return {name: live.find(row => row.verification === "verified" && row.name)?.name ?? null}
}

/**
 * Whether a package is archived: a rule names it, or every URL Core knows for it is archived. A package Core
 * has never seen is not: an Organization Admin may register a website ahead of its first install.
 */
export async function packageIsArchived(packageName: string): Promise<boolean> {
  if (await MiniappRegistryArchiveRuleModel.exists({kind: "package", value: packageName})) return true
  const rows = await MiniappRegistryEntryModel.find({packageName}).lean<RegistryEntryRow[]>()
  if (rows.length === 0) return false
  const archived = await archivedUrls(rows)
  return rows.every(row => archived.has(row.url))
}

/**
 * A developer's redirect URIs. In production each must be an HTTPS address on the package's own domain (the
 * registry's domain rule: `com.example.notes` belongs to `example.com`). A development client's are on the
 * developer's own computer.
 */
function ownRedirectUris(value: unknown, environment: WebsiteClientEnvironment, packageName: string): string[] {
  const uris = checkRedirectUris(value, environment)
  for (const uri of uris) {
    const url = new URL(uri)
    if (environment === "development") {
      if (!isLoopback(url)) invalid(`"${uri}": a development website redirects to this computer (http://127.0.0.1 or localhost, with a port)`)
    } else if (!isPackageNameAllowedForUrl(packageName, uri)) {
      throw new WebsiteClientError(
        "domain_mismatch",
        `"${uri}" is not on ${packageName}'s domain. A website signs people in for a miniapp only from the domain the miniapp's name belongs to${
          registrableDomain(url.hostname) ? `, and ${registrableDomain(url.hostname)} is not it` : ""
        }.`,
      )
    }
  }
  return uris
}

/** The consent screen's name for a developer's website: the miniapp's own, never one they typed. */
function ownName(found: {name: string | null}, packageName: string, environment: WebsiteClientEnvironment): string {
  const name = checkName(found.name ?? packageName)
  return environment === "development" ? checkName(`${name} (development)`.slice(0, MAX_NAME_LENGTH)) : name
}

export interface OwnWebsiteInput {
  type: unknown
  environment: unknown
  redirectUris: unknown
  packageName: unknown
}

/**
 * Register a website as its developer: for a package in Core's registry, redirecting to that package's own
 * domain. Anyone signed in to Mentra may sign in there; a development client signs in only its developer.
 */
export async function registerOwnWebsite(
  owner: {mentraUserId: string; label: string},
  input: OwnWebsiteInput,
): Promise<{client: WebsiteClientView; secret: string | null}> {
  const kind = checkKind(input)
  const redirectUris = ownRedirectUris(input.redirectUris, kind.environment, kind.packageName)
  const found = await registryPackage(kind.packageName)
  if (found === "not_in_registry") {
    throw new WebsiteClientError("not_in_registry", "Mentra doesn't know this miniapp yet. Install it once in the Mentra App from its URL, then register its website.")
  }
  if (found === "archived") throw new WebsiteClientError("archived", "This miniapp is archived, so no website can sign people in for it.")
  if ((await WebsiteClientModel.countDocuments({ownerUserId: owner.mentraUserId})) >= MAX_WEBSITES_PER_DEVELOPER) {
    throw new WebsiteClientError("too_many_websites", `You can register at most ${MAX_WEBSITES_PER_DEVELOPER} websites. Remove one you no longer use.`)
  }
  return insert(
    {
      ...kind,
      name: ownName(found, kind.packageName, kind.environment),
      redirectUris,
      ownerUserId: owner.mentraUserId,
      access: "public",
      accessWorkspaceIds: [],
    },
    owner.label,
  )
}

/** A developer's own client, or `not_found`: another person's is not found, whatever its ID. */
async function ownClient(ownerUserId: string, clientId: string): Promise<Stored> {
  const row = await WebsiteClientModel.findOne({clientId, ownerUserId}).lean<Stored>()
  if (!row) throw new WebsiteClientError("not_found", "no such website")
  return row
}

/** Change a developer's own website: its redirect URIs, by the same rule as at registration, or its status. */
export async function updateOwnWebsite(
  owner: {mentraUserId: string; label: string},
  clientId: string,
  input: {redirectUris?: unknown; status?: unknown},
): Promise<WebsiteClientView> {
  const existing = await ownClient(owner.mentraUserId, clientId)
  const changes: UpdateWebsiteClientInput = {status: input.status}
  if (input.redirectUris !== undefined) changes.redirectUris = ownRedirectUris(input.redirectUris, existing.environment, existing.packageName)
  // Its name follows the miniapp's, should that have changed since.
  const found = await registryPackage(existing.packageName)
  if (typeof found === "object") changes.name = ownName(found, existing.packageName, existing.environment)
  return updateWebsiteClient(clientId, changes, owner.label)
}

export async function regenerateOwnWebsiteSecret(
  owner: {mentraUserId: string; label: string},
  clientId: string,
): Promise<{client: WebsiteClientView; secret: string}> {
  await ownClient(owner.mentraUserId, clientId)
  return regenerateWebsiteClientSecret(clientId, owner.label)
}

export async function deleteOwnWebsite(owner: {mentraUserId: string; label: string}, clientId: string): Promise<void> {
  await ownClient(owner.mentraUserId, clientId)
  await deleteWebsiteClient(clientId, owner.label)
}

export interface UpdateWebsiteClientInput {
  name?: unknown
  redirectUris?: unknown
  access?: unknown
  accessWorkspaceIds?: unknown
  status?: unknown
}

/**
 * Change a client's name, redirect URIs, access or status. Its type, environment, package and workspace are
 * fixed: a different one is a different client. Disabling takes effect at once: no new sign-in, no refresh.
 */
export async function updateWebsiteClient(clientId: string, input: UpdateWebsiteClientInput, actor: string): Promise<WebsiteClientView> {
  const existing = await WebsiteClientModel.findOne({clientId}).lean<Stored>()
  if (!existing) throw new WebsiteClientError("not_found", "no such website")
  const set: Record<string, unknown> = {updatedBy: actor}
  if (input.name !== undefined) set.name = checkName(input.name)
  if (input.redirectUris !== undefined) set.redirectUris = checkRedirectUris(input.redirectUris, existing.environment)
  if (input.access !== undefined) Object.assign(set, checkAccess(input.access, input.accessWorkspaceIds))
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "disabled") invalid("status must be active or disabled")
    set.status = input.status
  }
  const updated = await WebsiteClientModel.findOneAndUpdate({clientId}, {$set: set}, {new: true}).lean<Stored>()
  if (!updated) throw new WebsiteClientError("not_found", "no such website")
  await audit(actor, "update", clientId, {changed: Object.keys(set).filter(key => key !== "updatedBy")})
  return view(updated)
}

/** Replace a server client's secret. The old one stops working at once. */
export async function regenerateWebsiteClientSecret(clientId: string, actor: string): Promise<{client: WebsiteClientView; secret: string}> {
  const existing = await WebsiteClientModel.findOne({clientId}).lean<Stored>()
  if (!existing) throw new WebsiteClientError("not_found", "no such website")
  if (existing.type !== "server") throw new WebsiteClientError("no_secret", "a browser client has no secret")
  const secret = newSecret()
  const updated = await WebsiteClientModel.findOneAndUpdate(
    {clientId},
    {$set: {secretHash: secret.secretHash, secretLast4: secret.secretLast4, updatedBy: actor}},
    {new: true},
  ).lean<Stored>()
  if (!updated) throw new WebsiteClientError("not_found", "no such website")
  await audit(actor, "regenerate_secret", clientId, {})
  return {client: view(updated), secret: secret.secret}
}

/** Remove a client. Its grants and refresh tokens die with it: the next refresh finds no client. */
export async function deleteWebsiteClient(clientId: string, actor: string): Promise<void> {
  const removed = await WebsiteClientModel.findOneAndDelete({clientId}).lean<Stored>()
  if (!removed) throw new WebsiteClientError("not_found", "no such website")
  await audit(actor, "delete", clientId, {packageName: removed.packageName})
}

export async function getWebsiteClient(clientId: string): Promise<WebsiteClientView | null> {
  const row = await WebsiteClientModel.findOne({clientId}).lean<Stored>()
  return row ? view(row) : null
}

/** The names of these clients, disabled ones included; a client that no longer exists has none. */
export async function websiteClientNames(clientIds: string[]): Promise<Map<string, string>> {
  if (clientIds.length === 0) return new Map()
  const rows = await WebsiteClientModel.find({clientId: {$in: clientIds}}).select({clientId: 1, name: 1}).lean<Array<{clientId: string; name: string}>>()
  return new Map(rows.map(row => [row.clientId, row.name]))
}

/** A deployment's clients, or one developer's, newest first. */
export async function listWebsiteClients(filter: {ownerUserId?: string} = {}): Promise<WebsiteClientView[]> {
  const query: Record<string, unknown> = {}
  if (filter.ownerUserId !== undefined) query.ownerUserId = filter.ownerUserId
  const rows = await WebsiteClientModel.find(query).sort({createdAt: -1}).limit(500).lean<Stored[]>()
  return rows.map(view)
}

/**
 * What the sign-in server needs of an active client: the stored row with its secret hash. Null for an
 * unknown or disabled client, which can then neither start a sign-in nor refresh.
 */
export async function activeWebsiteClient(clientId: string): Promise<(WebsiteClientView & {secretHash: string | null}) | null> {
  if (!isWebsiteClientId(clientId)) return null
  const row = await WebsiteClientModel.findOne({clientId, status: "active"}).lean<Stored>()
  if (!row) return null
  // A server client without a secret could not authenticate: treat it as no client at all.
  if (row.type === "server" && !row.secretHash) return null
  return {...view(row), secretHash: row.secretHash ?? null}
}
