/**
 * @fileoverview Workspace credentials (`msk_`) and organization operator keys (`mak_`).
 *
 * A token is `<prefix>_<env>_<ulid>.<secret>`: `<ulid>` is the row's
 * `credentialId`, so a key can be found without its secret, and `<secret>` is 32
 * random bytes in base64url. Only the SHA-256 hex of `<secret>` is stored, and
 * the token is returned exactly once, by the call that creates it.
 *
 * Who a key acts for is decided on every validation, never cached:
 *  - `mak_`: allowed only while the creator's email is still an Organization
 *    Admin, so removing the address from the allowlist ends the key on the next
 *    request. Scopes are the operator scopes the key was created with, which
 *    never include workspace administration.
 *  - `msk_` issued by a service (the Store, for package keys): its own scopes,
 *    limited to its package names. It does not depend on anyone's membership.
 *  - `msk_` created by a member: its scopes intersected with what the creator's
 *    membership role grants now. Demoting the creator narrows the key, removing
 *    them ends it (the membership row ends, and removal also revokes the key),
 *    and rejoining is a new membership row, so it never revives the old key. A
 *    migrated creator who has not signed in yet is still an active membership,
 *    so their CI keys keep working.
 *
 * A workspace key also needs its workspace to be active: deletion revokes every
 * key, and a row written around it (a migration re-run, say) still never resolves.
 *
 * Mutations follow the shape of `workspace.service`: one transaction that
 * checks the actor, writes the workspace document (workspace credentials only;
 * `touchWorkspace`, which serializes them against every other mutation of that
 * workspace, such as the creator leaving, without bumping
 * `authorizationRevision`: a key does not change who holds which role, so it must
 * not invalidate someone's pending role change) and records the audit event as
 * its last write. Audit targets never carry the token or its hash.
 */

import {createHash, randomBytes, timingSafeEqual} from "node:crypto"

import {createLogger} from "@mentra/cloud-shared"
import {
  capabilitiesForRole,
  OPERATOR_KEY_SCOPES,
  type CorePrincipal,
  type CredentialView,
  type OrganizationCapability,
  type WorkspaceRole,
} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {ulid} from "ulid"
import {withTransaction} from "../../connections/mongo.connection"
import {AccessCredentialModel, type AccessCredentialRow} from "../../models/access-credential.model"
import {WorkspaceMembershipModel, type WorkspaceMembershipRow} from "../../models/workspace-membership.model"
import {WorkspaceModel} from "../../models/workspace.model"
import {recordWorkspaceEvent, type WorkspaceAuditEventInput} from "./audit.service"
import {credentialEnvironmentLabels, isOrganizationAdminEmail, organizationId} from "./organization"
import {fail} from "./workspace-error"
import {
  actingRole,
  auditActor,
  isId,
  loadActiveWorkspace,
  touchWorkspace,
  validateName,
  type Actor,
} from "./workspace.service"

const logger = createLogger("core").child({service: "credential.service"})

/** The prefixes of Core credentials: workspace credentials and organization operator keys. */
const TOKEN_PREFIXES = ["msk", "mak"] as const
/** `<prefix>_<env>_<ulid>.<secret>`. */
const TOKEN_PATTERN = new RegExp(
  `^(${TOKEN_PREFIXES.join("|")})_([a-z0-9]+)_([0-9A-HJKMNP-TV-Z]{26})\\.([A-Za-z0-9_-]{43})$`,
)
const PACKAGE_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/
const PACKAGE_NAME_MAX_LENGTH = 128
const PACKAGE_NAMES_MAX = 50
/** `lastUsedAt` is refreshed at most this often per credential. */
const LAST_USED_THROTTLE_MS = 60_000
const PUBLISH_SCOPE = "miniapps.publish"

export type ValidatedCredential = Extract<CorePrincipal, {kind: "credential"}>

type CredentialRow = AccessCredentialRow

// --- Creating --------------------------------------------------------------

/**
 * Create a workspace credential for the actor. The actor needs
 * `miniapps.credentials.create` in the workspace (Organization Admins and the
 * system act as owner) and an active membership of their own: the key is bound
 * to that membership, and a key with no creator and no service never validates.
 * The scope is `miniapps.publish`; `packageNames` optionally restricts it to
 * those packages.
 */
export async function createWorkspaceCredential(
  actor: Actor,
  workspaceId: string,
  input: {name: string; packageNames?: string[]; expiresAt?: Date | null},
): Promise<{credential: CredentialView; token: string}> {
  const name = validateName(input?.name)
  const packageNames = validatePackageNames(input?.packageNames ?? [])
  const expiresAt = validateExpiry(input?.expiresAt)
  if (!isId(workspaceId)) fail("not_found", "workspace not found")
  const env = issuingEnvironment()

  return withTransaction(async session => {
    const workspace = await loadActiveWorkspace(session, workspaceId)
    const role = await actingRole(session, actor, workspaceId)
    if (!role || !capabilitiesForRole(role).has("miniapps.credentials.create")) {
      fail("forbidden", "creating credentials requires the developer role")
    }
    const membership =
      actor.kind === "user" ? await findActiveMembership(session, workspaceId, actor.mentraUserId) : null
    if (actor.kind !== "user" || !membership) {
      fail("forbidden", "a workspace credential is tied to its creator's membership; join the workspace to create one")
    }
    if (!capabilitiesForRole(membership.role as WorkspaceRole).has(PUBLISH_SCOPE)) {
      fail("forbidden", "your role in this workspace cannot publish, so a credential from it would be unusable")
    }

    await touchWorkspace(session, workspaceId)
    const {row, token} = await insertCredential(session, {
      prefix: "msk",
      credentialKind: "workspace",
      organizationId: workspace.organizationId,
      workspaceId,
      name,
      env,
      scopes: [PUBLISH_SCOPE],
      packageNames,
      createdByMembershipId: membership.membershipId,
      createdByMentraUserId: actor.mentraUserId,
      createdByEmail: actor.email?.trim() || null,
      issuedByService: null,
      expiresAt,
    })
    await recordCreated(session, row, auditActor(actor))
    return {credential: toView(row), token}
  })
}

/**
 * Mint a package-restricted workspace credential on behalf of a trusted
 * service (the Store, for staff-issued package keys). The key belongs to the
 * service rather than to a member, so it does not depend on anyone's role;
 * `actorEmail` is the person who asked for it and is recorded for the audit
 * trail. `packageNames` must be non-empty.
 */
export async function mintServiceCredential(
  service: string,
  input: {workspaceId: string; name: string; packageNames: string[]; actorEmail: string},
): Promise<{credential: CredentialView; token: string}> {
  const issuer = typeof service === "string" ? service.trim() : ""
  if (!issuer) fail("invalid_request", "service is required")
  const name = validateName(input?.name)
  const packageNames = validatePackageNames(input?.packageNames)
  if (packageNames.length === 0) fail("invalid_request", "a service credential must name at least one package")
  const actorEmail = typeof input?.actorEmail === "string" ? input.actorEmail.trim() : ""
  if (!actorEmail) fail("invalid_request", "actorEmail is required")
  const workspaceId = input?.workspaceId
  if (!isId(workspaceId)) fail("not_found", "workspace not found")
  const env = issuingEnvironment()

  return withTransaction(async session => {
    const workspace = await loadActiveWorkspace(session, workspaceId)
    await touchWorkspace(session, workspaceId)
    const {row, token} = await insertCredential(session, {
      prefix: "msk",
      credentialKind: "workspace",
      organizationId: workspace.organizationId,
      workspaceId,
      name,
      env,
      scopes: [PUBLISH_SCOPE],
      packageNames,
      createdByMembershipId: null,
      createdByMentraUserId: null,
      createdByEmail: actorEmail,
      issuedByService: issuer,
      expiresAt: null,
    })
    await recordCreated(session, row, {kind: "service", service: issuer, email: actorEmail})
    return {credential: toView(row), token}
  })
}

/**
 * Create an organization operator key. Only an Organization Admin may, the
 * scopes must be a non-empty subset of {@link OPERATOR_KEY_SCOPES} (never
 * workspace administration), and the creator's email is recorded: the key works
 * only while that email stays on the admin allowlist.
 */
export async function createOperatorKey(
  actor: Actor & {kind: "user"},
  input: {name: string; scopes: OrganizationCapability[]; expiresAt?: Date | null},
): Promise<{credential: CredentialView; token: string}> {
  if (actor?.kind !== "user" || !actor.isOrganizationAdmin) {
    fail("forbidden", "only an organization admin can create an operator key")
  }
  const email = actor.email?.trim()
  if (!email) fail("invalid_request", "an operator key needs its creator's email address")
  const name = validateName(input?.name)
  const scopes = validateOperatorScopes(input?.scopes)
  const expiresAt = validateExpiry(input?.expiresAt)
  const env = issuingEnvironment()
  const organization = organizationId()

  return withTransaction(async session => {
    const {row, token} = await insertCredential(session, {
      prefix: "mak",
      credentialKind: "organization",
      organizationId: organization,
      workspaceId: null,
      name,
      env,
      scopes,
      packageNames: [],
      createdByMembershipId: null,
      createdByMentraUserId: actor.mentraUserId,
      createdByEmail: email,
      issuedByService: null,
      expiresAt,
    })
    await recordCreated(session, row, auditActor(actor))
    return {credential: toView(row), token}
  })
}

// --- Listing ---------------------------------------------------------------

/**
 * The workspace's live (not revoked) credentials, newest first (creation time, then id for a tie).
 * With `createdByMembershipId`, only the keys that membership created: a caller who may publish but
 * not revoke other people's keys sees their own keys only (publishing access is not directory
 * access). `null` there matches nothing, so a caller with no membership sees no keys.
 */
export async function listWorkspaceCredentials(
  workspaceId: string,
  opts: {createdByMembershipId?: string | null} = {},
): Promise<CredentialView[]> {
  if (!isId(workspaceId)) return []
  const filter: Record<string, unknown> = {workspaceId, credentialKind: "workspace", revokedAt: null}
  if ("createdByMembershipId" in opts) {
    if (!isId(opts.createdByMembershipId)) return []
    filter.createdByMembershipId = opts.createdByMembershipId
  }
  const rows = await AccessCredentialModel.find(filter).sort({createdAt: -1, _id: -1}).lean<CredentialRow[]>()
  return rows.map(toView)
}

/**
 * Which workspace a credential belongs to (`null` for an operator key), or null when there is no such
 * credential. A credential never moves, so a caller can check it against the route it arrived on
 * before handing it to `revokeCredential`, which decides by the credential's own workspace.
 */
export async function findCredentialOwner(
  credentialId: string,
): Promise<{credentialKind: "workspace" | "organization"; workspaceId: string | null} | null> {
  if (!isId(credentialId)) return null
  const row = await AccessCredentialModel.findOne({credentialId})
    .select({_id: 0, credentialKind: 1, workspaceId: 1})
    .lean<Pick<CredentialRow, "credentialKind" | "workspaceId">>()
  if (!row) return null
  return {credentialKind: row.credentialKind as "workspace" | "organization", workspaceId: row.workspaceId ?? null}
}

/** This organization's live (not revoked) operator keys, newest first (creation time, then id for a tie). */
export async function listOperatorKeys(): Promise<CredentialView[]> {
  const rows = await AccessCredentialModel.find({
    organizationId: organizationId(),
    credentialKind: "organization",
    revokedAt: null,
  })
    .sort({createdAt: -1, _id: -1})
    .lean<CredentialRow[]>()
  return rows.map(toView)
}

// --- Revoking --------------------------------------------------------------

/**
 * Revoke a credential. A workspace key can be revoked by the member who created
 * it (while they still hold `miniapps.credentials.create`) or by anyone with
 * `workspace.credentials.revoke` in that workspace; an operator key only by an
 * Organization Admin. Revoking a revoked key changes nothing.
 */
export async function revokeCredential(actor: Actor, credentialId: string): Promise<void> {
  if (!isId(credentialId)) fail("not_found", "credential not found")
  await withTransaction(async session => {
    const row = await AccessCredentialModel.findOne({credentialId}).session(session).lean<CredentialRow>()
    if (!row) fail("not_found", "credential not found")

    if (row.credentialKind === "organization") {
      if (!(actor.kind === "system" || (actor.kind === "user" && actor.isOrganizationAdmin))) {
        fail("forbidden", "only an organization admin can revoke an operator key")
      }
      if (row.revokedAt) return
      await markRevoked(session, row, auditActor(actor))
      return
    }

    const workspaceId = row.workspaceId
    if (!workspaceId) fail("not_found", "credential not found")
    await loadActiveWorkspace(session, workspaceId)
    const role = await actingRole(session, actor, workspaceId)
    const capabilities = role ? capabilitiesForRole(role) : null
    let allowed = capabilities?.has("workspace.credentials.revoke") ?? false
    if (
      !allowed &&
      capabilities?.has("miniapps.credentials.create") &&
      actor.kind === "user" &&
      row.createdByMembershipId
    ) {
      const own = await findActiveMembership(session, workspaceId, actor.mentraUserId)
      allowed = own?.membershipId === row.createdByMembershipId
    }
    if (!allowed) fail("forbidden", "revoking this credential requires its creator or the admin role")
    if (row.revokedAt) return

    await touchWorkspace(session, workspaceId)
    await markRevoked(session, row, auditActor(actor))
  })
}

/**
 * Revoke one live credential inside the caller's transaction and record `credential.revoked` as
 * `actor`. A key that is already revoked changes nothing and records nothing. The caller has
 * already written the workspace document (for a workspace key) and checked who may do this.
 */
export async function markRevoked(
  session: ClientSession,
  row: CredentialRow,
  actor: WorkspaceAuditEventInput["actor"],
  now: Date = new Date(),
): Promise<void> {
  const revoked = await AccessCredentialModel.updateOne(
    {credentialId: row.credentialId, revokedAt: null},
    {$set: {revokedAt: now}},
    {session},
  )
  if (revoked.modifiedCount !== 1) return
  await recordWorkspaceEvent(session, {
    organizationId: row.organizationId,
    workspaceId: row.workspaceId ?? null,
    action: "credential.revoked",
    actor,
    target: auditTarget(row),
    before: {revokedAt: null},
    after: {revokedAt: now.toISOString()},
  })
}

// --- Validating ------------------------------------------------------------

/**
 * Whether a bearer token claims to be a Core credential (it starts `msk_` or `mak_`), valid or not. Such
 * a token is only ever checked as a credential, never offered to another identity provider; WorkOS
 * access tokens are JWTs and never start this way.
 */
export function isCredentialToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PREFIXES.some(prefix => token.startsWith(`${prefix}_`))
}

/**
 * Resolve a bearer token to the credential principal it currently stands for,
 * or null. In order: the token's format, its environment label, the row (not
 * revoked, not expired, same prefix and environment), the secret's hash, and
 * the effective scopes (see the file header). Anything wrong with the token is
 * null, never an error; only a database failure throws.
 */
export async function validateCredentialToken(token: string): Promise<ValidatedCredential | null> {
  if (typeof token !== "string") return null
  const match = TOKEN_PATTERN.exec(token)
  if (!match) return null
  const prefix = match[1] as "msk" | "mak"
  const env = match[2]!
  const credentialId = match[3]!
  const secret = match[4]!
  if (!credentialEnvironmentLabels().includes(env)) return null

  const row = await AccessCredentialModel.findOne({credentialId}).lean<CredentialRow>()
  if (!row || row.revokedAt) return null
  // The hash covers only the secret, so the prefix has to be bound to the row too, or a workspace key
  // could be presented as an operator key.
  if (row.prefix !== prefix || row.env !== env) return null
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null
  if (!secretMatches(row.hash, secret)) return null

  const grant = await effectiveGrant(row)
  if (!grant) return null

  touchLastUsed(row)
  return {
    kind: "credential",
    organizationId: row.organizationId,
    credentialId: row.credentialId,
    credentialKind: row.credentialKind as ValidatedCredential["credentialKind"],
    workspaceId: row.workspaceId ?? null,
    scopes: grant.scopes,
    packageNames: grant.packageNames,
    label: row.name || `credential:${row.credentialId}`,
  }
}

/** What the credential may do right now, or null when it may do nothing. */
async function effectiveGrant(row: CredentialRow): Promise<{scopes: string[]; packageNames: string[]} | null> {
  if (row.prefix === "mak") {
    if (row.credentialKind !== "organization") return null
    // Checked on every call: an operator key is only as good as its creator's admin status today.
    if (!isOrganizationAdminEmail(row.createdByEmail ?? null, true)) return null
    return {scopes: [...row.scopes], packageNames: []}
  }

  if (row.credentialKind !== "workspace" || !row.workspaceId) return null
  // A deleted workspace's keys were revoked with it; one written around that must not resolve either.
  if (!(await WorkspaceModel.exists({workspaceId: row.workspaceId, status: "active"}))) return null
  if (row.issuedByService) {
    // Minted with at least one package; a service key without any would be unrestricted.
    if (row.packageNames.length === 0) return null
    return {scopes: [...row.scopes], packageNames: [...row.packageNames]}
  }
  if (row.createdByMembershipId) {
    const membership = await WorkspaceMembershipModel.findOne({
      membershipId: row.createdByMembershipId,
      status: "active",
    }).lean<WorkspaceMembershipRow>()
    if (!membership || membership.workspaceId !== row.workspaceId) return null
    const granted = capabilitiesForRole(membership.role as WorkspaceRole) as ReadonlySet<string>
    const scopes = row.scopes.filter(scope => granted.has(scope))
    if (scopes.length === 0) return null
    return {scopes, packageNames: [...row.packageNames]}
  }
  // A migrated key whose creator was not found: nothing to stand on.
  return null
}

function secretMatches(storedHash: string, secret: string): boolean {
  const expected = Buffer.from(storedHash, "hex")
  const actual = Buffer.from(sha256Hex(secret), "hex")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/**
 * Record that the key was used, at most once a minute. Fire-and-forget and
 * outside any transaction: authentication never waits on it and a failed write
 * only logs. `timestamps: false` keeps `updatedAt` meaning "the key changed".
 *
 * The throttle is part of the write's filter, not just a check on the row read
 * earlier, so two requests that both saw a stale `lastUsedAt` cannot both write:
 * the second finds a use within the last minute and matches nothing.
 */
function touchLastUsed(row: CredentialRow): void {
  const now = Date.now()
  if (row.lastUsedAt && now - row.lastUsedAt.getTime() <= LAST_USED_THROTTLE_MS) return
  const cutoff = new Date(now - LAST_USED_THROTTLE_MS)
  void (async () => {
    try {
      await AccessCredentialModel.updateOne(
        // `lastUsedAt: null` also matches a row that never had the field.
        {credentialId: row.credentialId, $or: [{lastUsedAt: null}, {lastUsedAt: {$lt: cutoff}}]},
        {$set: {lastUsedAt: new Date(now)}},
        {timestamps: false},
      )
    } catch (err) {
      logger.warn({err, credentialId: row.credentialId}, "could not record credential last use")
    }
  })()
}

// --- Helpers ---------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** The label new tokens carry: the first environment this organization issues for. */
function issuingEnvironment(): string {
  return credentialEnvironmentLabels()[0]!
}

type NewCredential = Pick<
  AccessCredentialRow,
  | "prefix"
  | "credentialKind"
  | "organizationId"
  | "workspaceId"
  | "name"
  | "env"
  | "scopes"
  | "packageNames"
  | "createdByMembershipId"
  | "createdByMentraUserId"
  | "createdByEmail"
  | "issuedByService"
  | "expiresAt"
>

/** Generate the id and secret, insert the row inside the transaction and return it with the token. */
async function insertCredential(
  session: ClientSession,
  fields: NewCredential,
): Promise<{row: CredentialRow; token: string}> {
  const credentialId = ulid()
  const secret = randomBytes(32).toString("base64url")
  const [doc] = await AccessCredentialModel.create(
    [{...fields, credentialId, hash: sha256Hex(secret), last4: secret.slice(-4)}],
    {session},
  )
  return {
    row: doc!.toObject() as CredentialRow,
    token: `${fields.prefix}_${fields.env}_${credentialId}.${secret}`,
  }
}

async function recordCreated(
  session: ClientSession,
  row: CredentialRow,
  actor: WorkspaceAuditEventInput["actor"],
): Promise<void> {
  await recordWorkspaceEvent(session, {
    organizationId: row.organizationId,
    workspaceId: row.workspaceId ?? null,
    action: "credential.created",
    actor,
    target: auditTarget(row),
    after: {
      scopes: row.scopes,
      packageNames: row.packageNames,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      createdByMembershipId: row.createdByMembershipId ?? null,
      issuedByService: row.issuedByService ?? null,
    },
  })
}

/** Identifies the credential without any of its secret material. */
function auditTarget(row: CredentialRow): Record<string, unknown> {
  return {
    credentialId: row.credentialId,
    prefix: row.prefix,
    credentialKind: row.credentialKind,
    workspaceId: row.workspaceId ?? null,
    name: row.name,
  }
}

function toView(row: CredentialRow): CredentialView {
  return {
    credentialId: row.credentialId,
    prefix: row.prefix as CredentialView["prefix"],
    name: row.name,
    display: `${row.prefix}_${row.env}_…${row.last4}`,
    workspaceId: row.workspaceId ?? null,
    scopes: [...row.scopes],
    packageNames: [...row.packageNames],
    createdByEmail: row.createdByEmail ?? null,
    issuedByService: row.issuedByService ?? null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}

async function findActiveMembership(
  session: ClientSession,
  workspaceId: string,
  mentraUserId: string,
): Promise<WorkspaceMembershipRow | null> {
  if (!isId(mentraUserId)) return null
  return WorkspaceMembershipModel.findOne({workspaceId, mentraUserId, status: "active"})
    .session(session)
    .lean<WorkspaceMembershipRow>()
}

/** Package identifiers, deduplicated in order of first appearance. */
function validatePackageNames(value: unknown): string[] {
  if (!Array.isArray(value)) fail("invalid_request", "packageNames must be an array of package names")
  if (value.length > PACKAGE_NAMES_MAX)
    fail("invalid_request", `at most ${PACKAGE_NAMES_MAX} package names are allowed`)
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME_PATTERN.test(entry)) {
      fail("invalid_request", "each package name must be a package identifier such as com.example.app")
    }
  }
  return [...new Set(value as string[])]
}

/** An expiry, when given, must be a real date in the future. */
function validateExpiry(value: unknown): Date | null {
  if (value === undefined || value === null) return null
  if (!(value instanceof Date) || Number.isNaN(value.getTime()) || value.getTime() <= Date.now()) {
    fail("invalid_request", "expiresAt must be a date in the future")
  }
  return value
}

function validateOperatorScopes(value: unknown): OrganizationCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("invalid_request", "scopes must be a non-empty list of operator scopes")
  }
  const allowed: readonly string[] = OPERATOR_KEY_SCOPES
  for (const scope of value) {
    if (typeof scope !== "string" || !allowed.includes(scope)) {
      fail("invalid_request", `operator key scopes must be among ${OPERATOR_KEY_SCOPES.join(", ")}`)
    }
  }
  return [...new Set(value as OrganizationCapability[])]
}
