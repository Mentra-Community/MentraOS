/**
 * @fileoverview Migrate the Store's developer orgs into Core workspaces.
 *
 * Usage:
 *
 *   bun packages/core/scripts/migrate-store-developer-orgs.ts \
 *     --source <mongo-url> --target <mongo-url> [--apply]
 *
 * The source is the Store database (`developer_orgs`, `developer_org_memberships`,
 * `developer_org_invitations`, `developer_org_api_keys`). It is only ever read.
 * The target is the Core database of the organization the Store belongs to.
 *
 * Without `--apply` this prints a JSON report and writes nothing. It reads the
 * target through a separate read-only connection (no models, no collection or
 * index creation) so the report can say what a re-run would change. With `--apply`
 * it imports one developer org at a time, each in one short transaction holding
 * the workspace, its memberships, invitations and credentials and one
 * `workspace.imported` audit event. Every row is an upsert keyed on a stable id
 * (workspace id = org id, `wm_<source _id hex>`, invitation id, key id) that only
 * sets fields on insert, so a re-run is safe: it never overwrites a change made in
 * Core since, never revives an ended membership or a revoked key, and records the
 * audit event only for a workspace it has just inserted.
 *
 * A re-run does carry one kind of change: access the Store has taken away since
 * the last run, because that can only reduce what a key or person may do.
 *  - A Store key that is now revoked, and still live in Core, is revoked in Core
 *    (`revokedCredentials`, one `credential.revoked` event each, as the system).
 *  - A Store membership that is gone or no longer active, whose Core membership is
 *    still unclaimed (nobody has signed in with it), is ended as `removed` and the
 *    keys it created are revoked, as `endMembership` does (`removedMemberships`,
 *    one `membership.removed` event each, as the system). The synthesized owner
 *    (`wm_owner_<orgId>`) counts as gone once the Store no longer gives that person
 *    access to the org at all.
 *  - A Store invitation that is no longer pending, and is still pending in Core, is
 *    revoked in Core (`revokedInvitations`, one `invitation.revoked` event each).
 *  - A claimed membership (the person has signed in) is never changed: drift on one
 *    is reported (`claimedMembershipDrift`) for an admin to act on in Core.
 * Run apply again immediately before the Store cutover so Core is current.
 *
 * Two things are reported instead of imported. An org whose Core workspace exists
 * but is not active (deleted in Core) is skipped whole (`skippedWorkspaces`). A
 * membership whose person already holds a different unclaimed membership in that
 * workspace (the pending-member unique index would refuse it) is skipped with the
 * keys bound to it (`pendingCollisions`); the rest of the org still imports.
 *
 * What is imported:
 *  - Memberships: `status: "active"` rows only. owner -> owner, admin -> admin,
 *    member -> developer. They keep the WorkOS user id as `pendingWorkosUserId`
 *    and are claimed by the person's first sign-in. A person with several active
 *    rows keeps the highest role. An org with no owner membership is given one
 *    from its `ownerUserId` (the recorded owner): a person with an active row is
 *    promoted to owner (`promotedOwners`), a person with no row at all gets a
 *    pending owner membership (`wm_owner_<orgId>`, `synthesizedOwners`), and a
 *    person whose rows are all inactive is not brought back. Any other org is
 *    reported as owner-less (`ownerlessOrgs`); an organization admin can recover it.
 *  - Invitations: pending and not yet expired. admin -> admin, member -> developer.
 *  - Credentials: every API key, revoked ones included, with their dates. A key
 *    with a `publishingPackage` is a Store-issued package key. Any other key is
 *    bound to its creator's membership; a key whose creator has none is reported
 *    (`keysWithoutCreator`) and skipped. A key that does not have the shape of a
 *    Core credential (ULID id, 64-character lowercase hex hash, lowercase
 *    alphanumeric env) could never validate, so it is reported (`malformedKeys`)
 *    and skipped too.
 *
 * Keys keep their `env` label, so the Core deployment must list every label in
 * `CLOUD_CORE_CREDENTIAL_ENVIRONMENTS` (the script prints the labels it found) or
 * those keys will not validate.
 *
 * Safety: `--apply` refuses unless both URLs are local (`mongodb://` on
 * 127.0.0.1, localhost or [::1], without credentials) or `--i-understand-remote` is
 * given. That flag is for the operator running the real cutover; development and
 * tests never use it.
 *
 * With `--apply` the command line plans the whole import from the source before it
 * connects to the target: connecting makes Mongoose create the collections and
 * indexes, so bad source data aborts without touching the target at all.
 *
 * The report goes to stdout and everything else to stderr, so stdout can be piped.
 */

import type {WorkspaceRole} from "@mentra/workspace-contract"
import mongoose, {type AnyBulkWriteOperation, type ClientSession, type Connection, type Model} from "mongoose"
import {withTransaction} from "../src/connections/mongo.connection"
import {AccessCredentialModel, type AccessCredentialRow} from "../src/models/access-credential.model"
import {WorkspaceAuditCounterModel} from "../src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../src/models/workspace-membership.model"
import {WorkspaceModel} from "../src/models/workspace.model"
import {recordWorkspaceEvent} from "../src/services/workspaces/audit.service"
import {markRevoked} from "../src/services/workspaces/credential.service"
import {
  bumpRevision,
  endMembership,
  touchWorkspace,
  type MembershipRow,
} from "../src/services/workspaces/workspace.service"

// --- Source schema ---------------------------------------------------------

const SOURCE = {
  orgs: "developer_orgs",
  memberships: "developer_org_memberships",
  invitations: "developer_org_invitations",
  keys: "developer_org_api_keys",
} as const

type SourceOrg = {
  orgId: string
  ownerUserId?: string | null
  displayName?: string
  createdAt?: Date
  updatedAt?: Date
}

type SourceMembership = {
  _id: unknown
  orgId: string
  userId: string
  role: string
  email?: string | null
  name?: string | null
  status?: string
  createdAt?: Date
  updatedAt?: Date
}

type SourceInvitation = {
  invitationId: string
  orgId: string
  email: string
  role: string
  tokenHash: string
  status: string
  invitedByUserId?: string | null
  expiresAt?: Date
  createdAt?: Date
}

type SourceApiKey = {
  keyId: string
  orgId: string
  name?: string
  env: string
  hash: string
  last4: string
  createdByUserId?: string | null
  publishingPackage?: string | null
  lastUsedAt?: Date | null
  revokedAt?: Date | null
  createdAt?: Date
}

type SourceRole = "owner" | "admin" | "member"

const MEMBERSHIP_ROLES: Record<SourceRole, WorkspaceRole> = {owner: "owner", admin: "admin", member: "developer"}
const INVITATION_ROLES: Record<Exclude<SourceRole, "owner">, WorkspaceRole> = {admin: "admin", member: "developer"}
/** Higher wins when one person has several active rows in an org. */
const ROLE_RANK: Record<SourceRole, number> = {member: 0, admin: 1, owner: 2}

/** The parts of a credential token (`msk_<env>_<ulid>.<secret>`), as `validateCredentialToken` reads them. */
const KEY_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/
const KEY_HASH_PATTERN = /^[0-9a-f]{64}$/
const KEY_ENV_PATTERN = /^[a-z0-9]+$/

const PUBLISH_SCOPE = "miniapps.publish"
const STORE_SERVICE = "store"
/** A Core membership id made from a Store membership row's ObjectId (`wm_<24 hex>`). */
const SOURCE_ROW_MEMBERSHIP_ID = /^wm_[0-9a-f]{24}$/
const SYSTEM_ACTOR = {kind: "system"} as const

/** The Core collections this script writes, initialised (collections and indexes) before an apply. */
const TARGET_MODELS = [
  WorkspaceModel,
  WorkspaceMembershipModel,
  WorkspaceInvitationModel,
  AccessCredentialModel,
  WorkspaceAuditEventModel,
  WorkspaceAuditCounterModel,
]

// --- Errors and report -----------------------------------------------------

/** The migration cannot run, or stopped, for a reason the operator has to act on. */
export class MigrationError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options)
    this.name = "MigrationError"
  }
}

/** The command line is wrong or unsafe. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export type MigrationReport = {
  mode: "dry-run" | "apply"
  /** `skippedKeys` is every key not imported: `keysWithoutCreator` plus `malformedKeys`. */
  counts: {orgs: number; memberships: number; invitations: number; credentials: number; skippedKeys: number}
  /** Keys bound to a creator who has no membership in the org: not imported. */
  keysWithoutCreator: Array<{orgId: string; keyId: string; name: string}>
  /** Keys whose id, hash or env could never validate as a Core credential: not imported. */
  malformedKeys: Array<{orgId: string; keyId: string}>
  /** Orgs imported with no owner, for an organization admin to recover. */
  ownerlessOrgs: string[]
  /** Orgs whose creator pointer became a pending owner membership. */
  synthesizedOwners: string[]
  /** Orgs whose recorded owner already had a lower-role membership, promoted to owner. */
  promotedOwners: string[]
  /** People with several active rows in one org (the highest role was kept). */
  duplicateMemberships: Array<{orgId: string; userId: string}>
  /**
   * Whether the target was read: always for an apply, and for a dry run given a target. The lists
   * below compare the source with the target, so they are empty when it was not.
   */
  targetCompared: boolean
  /** Orgs whose Core workspace exists but is not active (deleted in Core): nothing imported or changed. */
  skippedWorkspaces: Array<{orgId: string; status: string}>
  /** Live Core credentials revoked because their Store key is revoked. */
  revokedCredentials: Array<{orgId: string; credentialId: string}>
  /** Unclaimed migrated memberships ended because their Store membership is gone, with the keys they took along. */
  removedMemberships: Array<{orgId: string; membershipId: string; revokedCredentialIds: string[]}>
  /** Pending Core invitations revoked because their Store invitation is no longer pending. */
  revokedInvitations: Array<{orgId: string; invitationId: string}>
  /** Claimed (signed-in) memberships whose Store membership is gone: reported, never changed. */
  claimedMembershipDrift: Array<{orgId: string; membershipId: string; mentraUserId: string}>
  /** Memberships not imported because the person already holds another unclaimed one there, with their skipped keys. */
  pendingCollisions: Array<{orgId: string; membershipId: string; userId: string; skippedCredentialIds: string[]}>
}

export type MigrationOptions = {
  /** The Store database. Only read. */
  source: Connection
  /**
   * A dry run only: a read-only connection to the target (Core) database, so the report says what
   * an apply would change there. Never written to. An apply uses the default mongoose connection.
   */
  target?: Connection
  apply: boolean
  /** The instant "now" for expiry checks and missing dates; tests pin it. */
  now?: Date
  /** Progress and warnings (stderr in the command line). */
  log?: (message: string) => void
}

// --- Plan ------------------------------------------------------------------

type PlannedMembership = {
  membershipId: string
  sourceUserId: string
  role: WorkspaceRole
  email: string | null
  name: string | null
  startedAt: Date
  createdAt: Date
  updatedAt: Date
}

type PlannedInvitation = {
  invitationId: string
  email: string
  role: WorkspaceRole
  tokenHash: string
  invitedByMembershipId: string | null
  expiresAt: Date
  createdAt: Date
}

type PlannedCredential = {
  credentialId: string
  name: string
  env: string
  hash: string
  last4: string
  packageNames: string[]
  createdByMembershipId: string | null
  createdByEmail: string | null
  issuedByService: string | null
  lastUsedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

type OrgPlan = {
  orgId: string
  name: string
  createdAt: Date
  updatedAt: Date
  memberships: PlannedMembership[]
  invitations: PlannedInvitation[]
  credentials: PlannedCredential[]
  /** What a re-run compares with Core, from every source row of the org (inactive ones too). */
  source: {
    /** Core membership ids of the org's Store membership rows, and whether each row is active. */
    membershipActive: Map<string, boolean>
    /** Store keys of the org that are revoked, by key id, with when. */
    revokedKeys: Map<string, Date>
    /** Store invitation statuses of the org, by invitation id. */
    invitationStatus: Map<string, string>
  }
}

type SourceRows = {
  memberships: Map<string, SourceMembership[]>
  invitations: Map<string, SourceInvitation[]>
  keys: Map<string, SourceApiKey[]>
}

/**
 * Plan (and with `apply`, perform) the import. The target is the default
 * mongoose connection, because that is where Core's models live; `source` must be
 * a different connection. The counts and source findings are computed from the
 * source alone; the re-run lists compare it with the target (read inside each
 * org's transaction for an apply, or through `target` for a dry run), so a dry
 * run given a target and an apply of the same data report the same thing.
 */
export async function migrateStoreDeveloperOrgs(options: MigrationOptions): Promise<MigrationReport> {
  const now = options.now ?? new Date()
  const log = options.log ?? (() => {})
  const {source, apply} = options

  const [orgs, memberships, invitations, keys] = await Promise.all([
    readAll<SourceOrg>(source, SOURCE.orgs),
    readAll<SourceMembership>(source, SOURCE.memberships),
    readAll<SourceInvitation>(source, SOURCE.invitations),
    readAll<SourceApiKey>(source, SOURCE.keys),
  ])
  const rows: SourceRows = {
    memberships: groupByOrg(memberships),
    invitations: groupByOrg(invitations),
    keys: groupByOrg(keys),
  }
  warnAboutOrphans(orgs, {memberships, invitations, keys}, log)

  const report: MigrationReport = {
    mode: apply ? "apply" : "dry-run",
    counts: {orgs: 0, memberships: 0, invitations: 0, credentials: 0, skippedKeys: 0},
    keysWithoutCreator: [],
    malformedKeys: [],
    ownerlessOrgs: [],
    synthesizedOwners: [],
    promotedOwners: [],
    duplicateMemberships: [],
    targetCompared: apply || options.target !== undefined,
    skippedWorkspaces: [],
    revokedCredentials: [],
    removedMemberships: [],
    revokedInvitations: [],
    claimedMembershipDrift: [],
    pendingCollisions: [],
  }

  const plans = [...orgs]
    .sort((a, b) => compareStrings(a.orgId, b.orgId))
    .map(org => planOrg(org, rows, now, report, log))

  if (apply) {
    // Only now, with the whole source validated, does anything touch the target.
    await prepareTarget(source)
    for (const plan of plans) recordReconciliation(report, plan.orgId, await importOrg(plan, log))
  } else if (options.target) {
    const db = options.target.db
    if (!db) throw new MigrationError("the target connection is not open")
    for (const plan of plans) {
      recordReconciliation(report, plan.orgId, reconcile(plan, await readTargetState(db, plan)))
    }
  }

  const labels = [...new Set(plans.flatMap(plan => plan.credentials.map(credential => credential.env)))].sort()
  if (labels.length > 0) {
    log(
      `migrated keys carry environment labels ${labels.join(", ")}; the Core deployment must list each in ` +
        "CLOUD_CORE_CREDENTIAL_ENVIRONMENTS or those keys will not validate",
    )
  }
  return report
}

/** Everything the migration needs from one org, derived from the source rows alone. */
function planOrg(
  org: SourceOrg,
  rows: SourceRows,
  now: Date,
  report: MigrationReport,
  log: (m: string) => void,
): OrgPlan {
  const orgId = requireString(org.orgId, "developer org orgId")
  const createdAt = asDate(org.createdAt) ?? now
  const memberships = planMemberships(org, rows.memberships.get(orgId) ?? [], now, report)

  const membershipByUser = new Map(memberships.map(membership => [membership.sourceUserId, membership]))
  const invitations = planInvitations(orgId, rows.invitations.get(orgId) ?? [], membershipByUser, now, log)
  const credentials = planCredentials(orgId, rows.keys.get(orgId) ?? [], membershipByUser, now, report)

  report.counts.orgs += 1
  report.counts.memberships += memberships.length
  report.counts.invitations += invitations.length
  report.counts.credentials += credentials.length
  report.counts.skippedKeys = report.keysWithoutCreator.length + report.malformedKeys.length

  return {
    orgId,
    name: typeof org.displayName === "string" && org.displayName.trim() ? org.displayName.trim() : orgId,
    createdAt,
    updatedAt: asDate(org.updatedAt) ?? createdAt,
    memberships,
    invitations,
    credentials,
    source: sourceState(orgId, rows),
  }
}

/** The org's source rows as a re-run compares them with Core. */
function sourceState(orgId: string, rows: SourceRows): OrgPlan["source"] {
  const membershipActive = new Map<string, boolean>()
  for (const row of rows.memberships.get(orgId) ?? []) {
    membershipActive.set(`wm_${String(row._id)}`, (row.status ?? "active") === "active")
  }
  const revokedKeys = new Map<string, Date>()
  for (const row of rows.keys.get(orgId) ?? []) {
    const revokedAt = asDate(row.revokedAt)
    if (typeof row.keyId === "string" && revokedAt) revokedKeys.set(row.keyId, revokedAt)
  }
  const invitationStatus = new Map<string, string>()
  for (const row of rows.invitations.get(orgId) ?? []) {
    if (typeof row.invitationId === "string") invitationStatus.set(row.invitationId, String(row.status))
  }
  return {membershipActive, revokedKeys, invitationStatus}
}

function planMemberships(
  org: SourceOrg,
  sourceRows: SourceMembership[],
  now: Date,
  report: MigrationReport,
): PlannedMembership[] {
  const orgId = org.orgId
  const active = sourceRows.filter(row => (row.status ?? "active") === "active")

  const byUser = new Map<string, SourceMembership[]>()
  for (const row of active) {
    const userId = requireString(row.userId, `membership userId in ${orgId}`)
    byUser.set(userId, [...(byUser.get(userId) ?? []), row])
  }

  const kept: Array<{row: SourceMembership; role: SourceRole}> = []
  for (const [userId, candidates] of byUser) {
    const ranked = candidates
      .map(row => ({
        row,
        role: sourceRole(row.role, ["owner", "admin", "member"], `membership of ${userId} in ${orgId}`),
      }))
      .sort(
        (a, b) =>
          ROLE_RANK[b.role] - ROLE_RANK[a.role] ||
          (asDate(a.row.createdAt)?.getTime() ?? Infinity) - (asDate(b.row.createdAt)?.getTime() ?? Infinity) ||
          compareStrings(String(a.row._id), String(b.row._id)),
      )
    kept.push(ranked[0]!)
    if (ranked.length > 1) report.duplicateMemberships.push({orgId, userId})
  }

  const planned = kept.map<PlannedMembership>(({row, role}) => {
    const createdAt = asDate(row.createdAt) ?? now
    return {
      membershipId: `wm_${String(row._id)}`,
      sourceUserId: row.userId,
      role: MEMBERSHIP_ROLES[role],
      email: stringOrNull(row.email),
      name: stringOrNull(row.name),
      startedAt: createdAt,
      createdAt,
      updatedAt: asDate(row.updatedAt) ?? createdAt,
    }
  })

  if (!kept.some(entry => entry.role === "owner")) {
    // The recorded owner (`ownerUserId`) is the only evidence of who should own the org.
    const ownerUserId = stringOrNull(org.ownerUserId)
    const recorded = ownerUserId ? planned.find(membership => membership.sourceUserId === ownerUserId) : undefined
    if (recorded) {
      // They are an active member with a lower role: the org has no owner, so they become it.
      recorded.role = "owner"
      report.promotedOwners.push(orgId)
    } else if (ownerUserId && !sourceRows.some(row => row.userId === ownerUserId)) {
      const createdAt = asDate(org.createdAt) ?? now
      planned.push({
        membershipId: `wm_owner_${orgId}`,
        sourceUserId: ownerUserId,
        role: "owner",
        email: null,
        name: null,
        startedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      })
      report.synthesizedOwners.push(orgId)
    } else {
      // No recorded owner, or the person it names only has inactive rows (they were removed, and
      // bringing them back as owner would be wrong).
      report.ownerlessOrgs.push(orgId)
    }
  }
  return planned
}

function planInvitations(
  orgId: string,
  sourceRows: SourceInvitation[],
  membershipByUser: Map<string, PlannedMembership>,
  now: Date,
  log: (message: string) => void,
): PlannedInvitation[] {
  const live = sourceRows.filter(row => {
    const expiresAt = asDate(row.expiresAt)
    return row.status === "pending" && expiresAt !== null && expiresAt.getTime() > now.getTime()
  })

  // At most one pending invitation per email per workspace: keep the newest.
  const newestByEmail = new Map<string, SourceInvitation>()
  for (const row of live) {
    const email = requireString(row.email, `invitation email in ${orgId}`).trim().toLowerCase()
    const current = newestByEmail.get(email)
    if (!current || isNewerInvitation(row, current)) newestByEmail.set(email, row)
  }
  if (newestByEmail.size < live.length) {
    log(`${orgId}: ${live.length - newestByEmail.size} older pending invitation(s) for the same email were skipped`)
  }

  return [...newestByEmail].map<PlannedInvitation>(([email, row]) => {
    const role = sourceRole(row.role, ["admin", "member"], `invitation ${row.invitationId} in ${orgId}`)
    const createdAt = asDate(row.createdAt) ?? now
    const inviter = stringOrNull(row.invitedByUserId)
    return {
      invitationId: requireString(row.invitationId, `invitationId in ${orgId}`),
      email,
      role: INVITATION_ROLES[role as Exclude<SourceRole, "owner">],
      tokenHash: requireString(row.tokenHash, `tokenHash of invitation ${row.invitationId}`),
      invitedByMembershipId: (inviter && membershipByUser.get(inviter)?.membershipId) || null,
      expiresAt: asDate(row.expiresAt)!,
      createdAt,
    }
  })
}

function planCredentials(
  orgId: string,
  sourceRows: SourceApiKey[],
  membershipByUser: Map<string, PlannedMembership>,
  now: Date,
  report: MigrationReport,
): PlannedCredential[] {
  const planned: PlannedCredential[] = []
  for (const row of sourceRows) {
    if (!hasCredentialShape(row)) {
      report.malformedKeys.push({orgId, keyId: typeof row.keyId === "string" ? row.keyId : ""})
      continue
    }
    const keyId = row.keyId
    const creator = stringOrNull(row.createdByUserId)
    const packageName = stringOrNull(row.publishingPackage)
    const member = packageName || !creator ? undefined : membershipByUser.get(creator)

    // A key that is neither a Store package key nor tied to a known member would never validate.
    if (!packageName && !member) {
      report.keysWithoutCreator.push({orgId, keyId, name: typeof row.name === "string" ? row.name : keyId})
      continue
    }

    const createdAt = asDate(row.createdAt) ?? now
    const revokedAt = asDate(row.revokedAt)
    planned.push({
      credentialId: keyId,
      name: typeof row.name === "string" && row.name.trim() ? row.name : keyId,
      env: row.env,
      hash: row.hash,
      last4: requireString(row.last4, `last4 of key ${keyId}`),
      packageNames: packageName ? [packageName] : [],
      createdByMembershipId: member?.membershipId ?? null,
      // A Store package key records the staff email that issued it; a member's key shows their email.
      createdByEmail: packageName ? creator : (member?.email ?? null),
      issuedByService: packageName ? STORE_SERVICE : null,
      lastUsedAt: asDate(row.lastUsedAt),
      revokedAt,
      createdAt,
      updatedAt: revokedAt ?? createdAt,
    })
  }
  return planned
}

/**
 * Whether the key's id, hash and env are what a Core token is made of
 * (`msk_<env>_<ulid>.<secret>`, hash = SHA-256 hex of the secret). A key that is
 * not could never validate, whoever created it.
 */
function hasCredentialShape(row: SourceApiKey): boolean {
  return (
    typeof row.keyId === "string" &&
    KEY_ID_PATTERN.test(row.keyId) &&
    typeof row.hash === "string" &&
    KEY_HASH_PATTERN.test(row.hash) &&
    typeof row.env === "string" &&
    KEY_ENV_PATTERN.test(row.env)
  )
}

// --- Compare with the target ------------------------------------------------

/** What the target holds for one org, read before anything is written. */
type TargetState = {
  /** The Core workspace's status, or null when it does not exist yet. */
  workspaceStatus: string | null
  /** The workspace's active memberships. */
  memberships: Array<{membershipId: string; mentraUserId: string | null; pendingWorkosUserId: string | null}>
  /** The workspace's live (not revoked) credentials. */
  liveCredentials: Array<{credentialId: string; createdByMembershipId: string | null}>
  /** The workspace's pending invitations. */
  pendingInvitationIds: string[]
  /** Planned membership and credential ids that already exist in Core, in any state. */
  existingMembershipIds: Set<string>
  existingCredentialIds: Set<string>
}

/** What a run does to one org beyond inserting what is missing. */
type Reconciliation = {
  /** Set when the Core workspace exists but is not active: the org is skipped whole. */
  skippedStatus: string | null
  revokeCredentials: Array<{credentialId: string; revokedAt: Date}>
  endMemberships: Array<{membershipId: string; revokedCredentialIds: string[]}>
  revokeInvitationIds: string[]
  claimedDrift: Array<{membershipId: string; mentraUserId: string}>
  collisions: Array<{membershipId: string; userId: string; skippedCredentialIds: string[]}>
}

/** Read what the target holds for `plan`'s org: raw documents, so a read-only connection works too. */
async function readTargetState(
  db: NonNullable<Connection["db"]>,
  plan: OrgPlan,
  session?: ClientSession,
): Promise<TargetState> {
  const options = session ? {session} : {}
  const collection = (model: {collection: {collectionName: string}}) => db.collection(model.collection.collectionName)
  const workspaceId = plan.orgId
  const [workspace, memberships, credentials, invitations, existingMemberships, existingCredentials] =
    await Promise.all([
      collection(WorkspaceModel).findOne({workspaceId}, {...options, projection: {status: 1}}),
      collection(WorkspaceMembershipModel)
        .find(
          {workspaceId, status: "active"},
          {...options, projection: {membershipId: 1, mentraUserId: 1, pendingWorkosUserId: 1}},
        )
        .toArray(),
      collection(AccessCredentialModel)
        .find({workspaceId, revokedAt: null}, {...options, projection: {credentialId: 1, createdByMembershipId: 1}})
        .toArray(),
      collection(WorkspaceInvitationModel)
        .find({workspaceId, status: "pending"}, {...options, projection: {invitationId: 1}})
        .toArray(),
      collection(WorkspaceMembershipModel)
        .find(
          {membershipId: {$in: plan.memberships.map(membership => membership.membershipId)}},
          {...options, projection: {membershipId: 1}},
        )
        .toArray(),
      collection(AccessCredentialModel)
        .find(
          {credentialId: {$in: plan.credentials.map(credential => credential.credentialId)}},
          {...options, projection: {credentialId: 1}},
        )
        .toArray(),
    ])
  return {
    workspaceStatus: workspace ? String(workspace.status) : null,
    memberships: memberships.map(row => ({
      membershipId: String(row.membershipId),
      mentraUserId: stringOrNull(row.mentraUserId),
      pendingWorkosUserId: stringOrNull(row.pendingWorkosUserId),
    })),
    liveCredentials: credentials.map(row => ({
      credentialId: String(row.credentialId),
      createdByMembershipId: stringOrNull(row.createdByMembershipId),
    })),
    pendingInvitationIds: invitations.map(row => String(row.invitationId)),
    existingMembershipIds: new Set(existingMemberships.map(row => String(row.membershipId))),
    existingCredentialIds: new Set(existingCredentials.map(row => String(row.credentialId))),
  }
}

/**
 * Decide, from the plan and what the target holds, what this run changes besides inserting what is
 * missing (see the file header). Pure, so a dry run and an apply decide the same way.
 */
function reconcile(plan: OrgPlan, target: TargetState): Reconciliation {
  const result: Reconciliation = {
    skippedStatus: null,
    revokeCredentials: [],
    endMemberships: [],
    revokeInvitationIds: [],
    claimedDrift: [],
    collisions: [],
  }
  if (target.workspaceStatus !== null && target.workspaceStatus !== "active") {
    return {...result, skippedStatus: target.workspaceStatus}
  }

  let remaining = target.memberships
  // Removals only apply to a workspace an earlier run imported.
  if (target.workspaceStatus === "active") {
    const ownerId = `wm_owner_${plan.orgId}`
    const plannedIds = new Set(plan.memberships.map(membership => membership.membershipId))
    const plannedUsers = new Set(plan.memberships.map(membership => membership.sourceUserId))
    /** A membership this script made from a Store row or from the org's recorded owner. */
    const fromSource = (id: string) =>
      id === ownerId || plan.source.membershipActive.has(id) || SOURCE_ROW_MEMBERSHIP_ID.test(id)
    /** Whether the Store still gives this membership's person access through it. */
    const stillGranted = (membership: TargetState["memberships"][number]) =>
      plannedIds.has(membership.membershipId) ||
      (membership.membershipId === ownerId
        ? membership.pendingWorkosUserId !== null && plannedUsers.has(membership.pendingWorkosUserId)
        : plan.source.membershipActive.get(membership.membershipId) === true)

    result.revokeCredentials = target.liveCredentials
      .filter(credential => plan.source.revokedKeys.has(credential.credentialId))
      .map(credential => ({
        credentialId: credential.credentialId,
        revokedAt: plan.source.revokedKeys.get(credential.credentialId)!,
      }))
      .sort((a, b) => compareStrings(a.credentialId, b.credentialId))
    const alreadyRevoked = new Set(result.revokeCredentials.map(credential => credential.credentialId))

    remaining = []
    for (const membership of [...target.memberships].sort((a, b) => compareStrings(a.membershipId, b.membershipId))) {
      if (!fromSource(membership.membershipId) || stillGranted(membership)) {
        remaining.push(membership)
      } else if (membership.mentraUserId) {
        // The person has signed in: the membership is theirs in Core now, so only report it.
        result.claimedDrift.push({membershipId: membership.membershipId, mentraUserId: membership.mentraUserId})
        remaining.push(membership)
      } else if (membership.pendingWorkosUserId) {
        result.endMemberships.push({
          membershipId: membership.membershipId,
          revokedCredentialIds: target.liveCredentials
            .filter(
              credential =>
                credential.createdByMembershipId === membership.membershipId &&
                !alreadyRevoked.has(credential.credentialId),
            )
            .map(credential => credential.credentialId)
            .sort(compareStrings),
        })
      } else {
        remaining.push(membership)
      }
    }

    result.revokeInvitationIds = target.pendingInvitationIds
      .filter(id => {
        const status = plan.source.invitationStatus.get(id)
        return status !== undefined && status !== "pending"
      })
      .sort(compareStrings)
  }

  // A new membership for someone who already holds an unclaimed one would break the pending-member
  // unique index and abort the org, so it is reported and left out with the keys bound to it.
  const pendingUsers = new Set(
    remaining.flatMap(membership =>
      !membership.mentraUserId && membership.pendingWorkosUserId ? [membership.pendingWorkosUserId] : [],
    ),
  )
  for (const membership of [...plan.memberships].sort((a, b) => compareStrings(a.membershipId, b.membershipId))) {
    if (target.existingMembershipIds.has(membership.membershipId) || !pendingUsers.has(membership.sourceUserId)) continue
    result.collisions.push({
      membershipId: membership.membershipId,
      userId: membership.sourceUserId,
      skippedCredentialIds: plan.credentials
        .filter(
          credential =>
            credential.createdByMembershipId === membership.membershipId &&
            !target.existingCredentialIds.has(credential.credentialId),
        )
        .map(credential => credential.credentialId)
        .sort(compareStrings),
    })
  }
  return result
}

function recordReconciliation(report: MigrationReport, orgId: string, result: Reconciliation): void {
  if (result.skippedStatus !== null) report.skippedWorkspaces.push({orgId, status: result.skippedStatus})
  for (const {credentialId} of result.revokeCredentials) report.revokedCredentials.push({orgId, credentialId})
  for (const entry of result.endMemberships) report.removedMemberships.push({orgId, ...entry})
  for (const invitationId of result.revokeInvitationIds) report.revokedInvitations.push({orgId, invitationId})
  for (const entry of result.claimedDrift) report.claimedMembershipDrift.push({orgId, ...entry})
  for (const entry of result.collisions) report.pendingCollisions.push({orgId, ...entry})
}

// --- Apply -----------------------------------------------------------------

/** What one org's import inserted; a re-run inserts nothing. */
type ImportResult = {
  skipped: boolean
  workspace: boolean
  memberships: number
  invitations: number
  credentials: number
  reconciliation: Reconciliation
}

/** The default mongoose connection must be the target, and a different database from the source. */
async function prepareTarget(source: Connection): Promise<void> {
  const target = mongoose.connection
  if (target.readyState !== 1) {
    throw new MigrationError("--apply needs the default mongoose connection connected to the target database")
  }
  if (
    source === target ||
    (source.host === target.host && source.port === target.port && source.name === target.name)
  ) {
    throw new MigrationError("the source and the target are the same database")
  }
  // Collections and indexes first: creating them inside a transaction races with their background build.
  await Promise.all(TARGET_MODELS.map(model => model.init()))
}

/**
 * Import one org in one transaction. It first compares the org with what Core
 * holds and carries access removals (see the file header), then inserts what is
 * missing: everything is an upsert that only sets fields on insert. The
 * `workspace.imported` audit event is the last write and is recorded only when
 * this run inserted the workspace. Returns what it decided, for the report.
 */
async function importOrg(plan: OrgPlan, log: (message: string) => void): Promise<Reconciliation> {
  const {orgId} = plan
  let result: ImportResult
  try {
    result = await withTransaction(async session => {
      const reconciliation = reconcile(plan, await readTargetState(mongoose.connection.db!, plan, session))
      if (reconciliation.skippedStatus !== null) {
        return {skipped: true, workspace: false, memberships: 0, invitations: 0, credentials: 0, reconciliation}
      }
      await applyRemovals(session, orgId, reconciliation)

      const skippedMemberships = new Set(reconciliation.collisions.map(collision => collision.membershipId))
      const skippedCredentials = new Set(reconciliation.collisions.flatMap(collision => collision.skippedCredentialIds))
      const workspace = await WorkspaceModel.bulkWrite(
        [
          insertOnly(
            {workspaceId: orgId},
            {
              name: plan.name,
              status: "active",
              authorizationRevision: 0,
              createdByMentraUserId: null,
              deletedAt: null,
              createdAt: plan.createdAt,
              updatedAt: plan.updatedAt,
            },
          ),
        ],
        {session},
      )
      const inserted = workspace.upsertedCount === 1

      const memberships = await bulkInsertOnly(
        WorkspaceMembershipModel,
        plan.memberships
          .filter(membership => !skippedMemberships.has(membership.membershipId))
          .map(membership =>
            insertOnly(
              {membershipId: membership.membershipId},
              {
                workspaceId: orgId,
                mentraUserId: null,
                pendingWorkosUserId: membership.sourceUserId,
                email: membership.email,
                name: membership.name,
                role: membership.role,
                status: "active",
                startedAt: membership.startedAt,
                endedAt: null,
                endedReason: null,
                createdAt: membership.createdAt,
                updatedAt: membership.updatedAt,
              },
            ),
          ),
        session,
      )
      const invitations = await bulkInsertOnly(
        WorkspaceInvitationModel,
        plan.invitations.map(invitation =>
          insertOnly(
            {invitationId: invitation.invitationId},
            {
              workspaceId: orgId,
              email: invitation.email,
              role: invitation.role,
              tokenHash: invitation.tokenHash,
              status: "pending",
              invitedByMembershipId:
                invitation.invitedByMembershipId && !skippedMemberships.has(invitation.invitedByMembershipId)
                  ? invitation.invitedByMembershipId
                  : null,
              expiresAt: invitation.expiresAt,
              acceptedMembershipId: null,
              createdAt: invitation.createdAt,
              updatedAt: invitation.createdAt,
            },
          ),
        ),
        session,
      )
      const credentials = await bulkInsertOnly(
        AccessCredentialModel,
        plan.credentials
          .filter(credential => !skippedCredentials.has(credential.credentialId))
          .map(credential =>
            insertOnly(
              {credentialId: credential.credentialId},
              {
                prefix: "msk",
                credentialKind: "workspace",
                workspaceId: orgId,
                name: credential.name,
                env: credential.env,
                hash: credential.hash,
                last4: credential.last4,
                scopes: [PUBLISH_SCOPE],
                packageNames: credential.packageNames,
                createdByMembershipId: credential.createdByMembershipId,
                createdByMentraUserId: null,
                createdByEmail: credential.createdByEmail,
                issuedByService: credential.issuedByService,
                expiresAt: null,
                lastUsedAt: credential.lastUsedAt,
                revokedAt: credential.revokedAt,
                createdAt: credential.createdAt,
                updatedAt: credential.updatedAt,
              },
            ),
          ),
        session,
      )

      if (inserted) {
        await recordWorkspaceEvent(session, {
          workspaceId: orgId,
          action: "workspace.imported",
          actor: SYSTEM_ACTOR,
          target: {workspaceId: orgId},
          after: {name: plan.name, memberships, invitations, credentials},
        })
      }
      return {skipped: false, workspace: inserted, memberships, invitations, credentials, reconciliation}
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new MigrationError(`importing ${orgId} failed and was rolled back: ${reason}`, {cause: err})
  }

  const {reconciliation} = result
  if (result.skipped) {
    log(`${orgId}: skipped, its Core workspace is ${reconciliation.skippedStatus}`)
    return reconciliation
  }
  log(
    result.workspace
      ? `${orgId}: imported (${result.memberships} memberships, ${result.invitations} invitations, ${result.credentials} credentials)`
      : `${orgId}: already imported (${result.memberships} memberships, ${result.invitations} invitations, ` +
          `${result.credentials} credentials added since)`,
  )
  const removals = [
    reconciliation.revokeCredentials.length && `${reconciliation.revokeCredentials.length} key(s) revoked`,
    reconciliation.endMemberships.length && `${reconciliation.endMemberships.length} membership(s) removed`,
    reconciliation.revokeInvitationIds.length && `${reconciliation.revokeInvitationIds.length} invitation(s) revoked`,
  ].filter(Boolean)
  if (removals.length > 0) log(`${orgId}: carried from the Store: ${removals.join(", ")}`)
  if (reconciliation.claimedDrift.length > 0) {
    log(`${orgId}: ${reconciliation.claimedDrift.length} signed-in membership(s) no longer in the Store were left as they are`)
  }
  if (reconciliation.collisions.length > 0) {
    log(`${orgId}: ${reconciliation.collisions.length} membership(s) skipped: the person already has an unclaimed one`)
  }
  return reconciliation
}

/**
 * Carry the Store's access removals into Core inside the org's transaction, as the system: revoke
 * keys, end unclaimed memberships (with the keys they created) and revoke invitations, recording an
 * audit event for each. The workspace document is written first, as every Core mutation does:
 * ending memberships bumps `authorizationRevision`; revoking keys or invitations only touches it.
 */
async function applyRemovals(session: ClientSession, workspaceId: string, reconciliation: Reconciliation): Promise<void> {
  const {revokeCredentials, endMemberships, revokeInvitationIds} = reconciliation
  if (revokeCredentials.length + endMemberships.length + revokeInvitationIds.length === 0) return

  const workspace =
    endMemberships.length > 0 ? await bumpRevision(session, workspaceId, undefined) : null
  if (!workspace) await touchWorkspace(session, workspaceId)

  for (const {credentialId, revokedAt} of revokeCredentials) {
    const row = await AccessCredentialModel.findOne({credentialId, workspaceId, revokedAt: null})
      .session(session)
      .lean<AccessCredentialRow>()
    if (row) await markRevoked(session, row, SYSTEM_ACTOR, revokedAt)
  }

  for (const {membershipId} of endMemberships) {
    const membership = await WorkspaceMembershipModel.findOne({membershipId, workspaceId, status: "active"})
      .session(session)
      .lean<MembershipRow>()
    if (!membership) continue
    await endMembership(session, {
      workspace: workspace!,
      actor: SYSTEM_ACTOR,
      membership,
      reason: "removed",
      action: "membership.removed",
    })
  }

  for (const invitationId of revokeInvitationIds) {
    const invitation = await WorkspaceInvitationModel.findOneAndUpdate(
      {invitationId, workspaceId, status: "pending"},
      {$set: {status: "revoked"}},
      {session},
    ).lean()
    if (!invitation) continue
    await recordWorkspaceEvent(session, {
      workspaceId,
      action: "invitation.revoked",
      actor: SYSTEM_ACTOR,
      target: {invitationId},
      before: {status: "pending", role: invitation.role},
      after: {status: "revoked"},
    })
  }
}

/** An upsert on `filter` that sets `fields` only when the row is inserted, leaving existing rows untouched. */
function insertOnly(filter: Record<string, string>, fields: Record<string, unknown>): AnyBulkWriteOperation {
  return {
    updateOne: {
      filter,
      update: {$setOnInsert: fields},
      upsert: true,
      // The dates are explicit: the Store's creation times carry over, and a re-run must not touch `updatedAt`.
      timestamps: false,
    },
  }
}

/** How many rows `operations` inserted (the rest already existed). */
async function bulkInsertOnly(
  model: Pick<Model<any>, "bulkWrite">,
  operations: AnyBulkWriteOperation[],
  session: ClientSession,
): Promise<number> {
  if (operations.length === 0) return 0
  return (await model.bulkWrite(operations, {session})).upsertedCount
}

// --- Source reading --------------------------------------------------------

/**
 * Open a read-only connection: the source, or the target for a dry run. Read-only by use: nothing
 * here ever writes, no model is attached to it, and it never creates a collection or an index.
 */
export async function openSourceConnection(url: string): Promise<Connection> {
  return mongoose
    .createConnection(url, {serverSelectionTimeoutMS: 10_000, autoIndex: false, autoCreate: false})
    .asPromise()
}

async function readAll<T extends {orgId?: string}>(source: Connection, collection: string): Promise<T[]> {
  return (await source.db!.collection(collection).find({}).sort({_id: 1}).toArray()) as unknown as T[]
}

function groupByOrg<T extends {orgId: string}>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) grouped.set(row.orgId, [...(grouped.get(row.orgId) ?? []), row])
  return grouped
}

function warnAboutOrphans(
  orgs: SourceOrg[],
  rows: {memberships: SourceMembership[]; invitations: SourceInvitation[]; keys: SourceApiKey[]},
  log: (message: string) => void,
): void {
  const known = new Set(orgs.map(org => org.orgId))
  for (const [label, list] of Object.entries(rows)) {
    const orphans = (list as Array<{orgId: string}>).filter(row => !known.has(row.orgId)).length
    if (orphans > 0) log(`${orphans} source ${label} reference an org that does not exist and were ignored`)
  }
}

function sourceRole(value: unknown, allowed: readonly SourceRole[], context: string): SourceRole {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as SourceRole
  throw new MigrationError(`unexpected role ${JSON.stringify(value)} for ${context}`)
}

function requireString(value: unknown, what: string): string {
  if (typeof value === "string" && value.trim()) return value
  throw new MigrationError(`source row has no ${what}`)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function asDate(value: unknown): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isNewerInvitation(candidate: SourceInvitation, current: SourceInvitation): boolean {
  const a = asDate(candidate.createdAt)?.getTime() ?? 0
  const b = asDate(current.createdAt)?.getTime() ?? 0
  return a !== b ? a > b : compareStrings(String(candidate.invitationId), String(current.invitationId)) > 0
}

// --- Command line ----------------------------------------------------------

export type CliOptions = {
  source: string
  target: string
  apply: boolean
  allowRemote: boolean
}

const USAGE = `Usage: bun packages/core/scripts/migrate-store-developer-orgs.ts \\
  --source <mongo-url> --target <mongo-url> [--apply]

Without --apply the script prints a JSON report and writes nothing; it reads the target to report what
a re-run would change (revocations and removals carried from the Store, drift, skipped workspaces).
--apply refuses unless both URLs are local; --i-understand-remote lifts that and is for the operator only.`

const VALUE_FLAGS = {"--source": "source", "--target": "target"} as const
/** Exactly a loopback host, with an optional all-digit port: nothing else may follow the host or port. */
const LOCAL_HOST_PATTERN = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/

type MongoUrlParts = {scheme: string; credentials: boolean; hosts: string[]; database: string}

/** Split a connection string, accepting the multi-host form `new URL` cannot parse. Null when it is not one. */
function splitMongoUrl(value: string): MongoUrlParts | null {
  const match = /^(mongodb(?:\+srv)?):\/\/(?:([^@/?#]*)@)?([^/?#]+)(?:\/([^?#]*))?(?:\?[^#]*)?$/.exec(value)
  if (!match) return null
  return {
    scheme: match[1]!,
    credentials: match[2] !== undefined,
    hosts: match[3]!.split(",").map(host => host.toLowerCase()),
    database: match[4] ?? "",
  }
}

/** `mongodb://` on `127.0.0.1`, `localhost` or `[::1]` only (every listed host, optionally with a numeric port), no credentials. */
export function isLocalMongoUrl(value: string): boolean {
  const parts = splitMongoUrl(value)
  if (!parts || parts.scheme !== "mongodb" || parts.credentials) return false
  return parts.hosts.every(host => LOCAL_HOST_PATTERN.test(host))
}

/** Parse the command line, refusing anything unsafe before any connection is opened. */
export function parseArgs(argv: string[]): CliOptions {
  const values: Partial<Record<(typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS], string>> = {}
  let apply = false
  let allowRemote = false

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    const equals = token.indexOf("=")
    const flag = token.startsWith("--") && equals !== -1 ? token.slice(0, equals) : token
    const inline = token.startsWith("--") && equals !== -1 ? token.slice(equals + 1) : undefined

    if (flag in VALUE_FLAGS) {
      const key = VALUE_FLAGS[flag as keyof typeof VALUE_FLAGS]
      const value = inline ?? argv[++i]
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        throw new UsageError(`${flag} needs a value`)
      }
      if (values[key] !== undefined) throw new UsageError(`${flag} was given more than once`)
      values[key] = value
    } else if ((flag === "--apply" || flag === "--i-understand-remote") && inline === undefined) {
      if (flag === "--apply") apply = true
      else allowRemote = true
    } else {
      throw new UsageError(`unknown argument ${token}`)
    }
  }

  for (const [flag, key] of Object.entries(VALUE_FLAGS)) {
    if (values[key] === undefined) throw new UsageError(`${flag} is required`)
  }
  const {source, target} = values as Record<(typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS], string>

  const sourceParts = splitMongoUrl(source)
  const targetParts = splitMongoUrl(target)
  if (!sourceParts) throw new UsageError("--source must be a mongodb:// or mongodb+srv:// URL")
  if (!targetParts) throw new UsageError("--target must be a mongodb:// or mongodb+srv:// URL")
  if (databaseKey(sourceParts) === databaseKey(targetParts)) {
    throw new UsageError("--source and --target are the same database")
  }

  if (apply && !allowRemote) {
    for (const [flag, url, parts] of [
      ["--source", source, sourceParts],
      ["--target", target, targetParts],
    ] as const) {
      if (!isLocalMongoUrl(url)) {
        throw new UsageError(
          `--apply refuses a non-local ${flag} (${parts.hosts.join(",")}): both URLs must be mongodb:// on ` +
            "127.0.0.1, localhost or [::1] without credentials. Operators can pass --i-understand-remote.",
        )
      }
    }
  }
  return {source, target, apply, allowRemote}
}

function databaseKey(parts: MongoUrlParts): string {
  return `${parts.hosts.join(",")}/${parts.database}`
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.error(USAGE)
    return
  }

  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (err) {
    console.error(`error: ${(err as Error).message}`)
    if (err instanceof UsageError) console.error(`\n${USAGE}`)
    process.exitCode = 2
    return
  }

  if (options.apply && options.allowRemote) {
    console.error("warning: --i-understand-remote is set; --apply may write to a non-local database")
  }

  let source: Connection | undefined
  let readOnlyTarget: Connection | undefined
  try {
    source = await openSourceConnection(options.source)
    let report: MigrationReport
    if (options.apply) {
      // Plan from the source alone first: this validates the whole source before the target is
      // touched, because connecting makes Mongoose create the collections and indexes, which bad
      // source data must not leave behind.
      await migrateStoreDeveloperOrgs({source, apply: false})
      await mongoose.connect(options.target, {serverSelectionTimeoutMS: 10_000})
      report = await migrateStoreDeveloperOrgs({
        source,
        apply: true,
        log: message => console.error(message),
      })
    } else {
      // A dry run reads the target through its own read-only connection and never writes to it.
      readOnlyTarget = await openSourceConnection(options.target)
      report = await migrateStoreDeveloperOrgs({
        source,
        target: readOnlyTarget,
        apply: false,
        log: message => console.error(message),
      })
    }
    console.log(JSON.stringify(report, null, 2))
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  } finally {
    await source?.close()
    await readOnlyTarget?.close()
    await mongoose.disconnect()
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2))
}
