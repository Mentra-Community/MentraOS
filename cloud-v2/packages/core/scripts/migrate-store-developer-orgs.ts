/**
 * @fileoverview Import the Store's developer organizations as Core workspaces.
 *
 * Usage:
 *
 *   bun packages/core/scripts/migrate-store-developer-orgs.ts \
 *     --source <mongo-url> --target <mongo-url> [--apply] [--i-understand-remote]
 *
 * The source is the Store database (`developer_orgs`, `developer_org_memberships`,
 * `developer_org_invitations`, `developer_org_api_keys`). It is only ever read.
 * The target is the Core database of the organization the Store belongs to.
 *
 * Without `--apply` this prints a JSON report and writes nothing. It reads the
 * target through a separate read-only connection (no models, no collection or
 * index creation) so the report can say what a re-run would change. With `--apply`
 * it imports one developer org at a time, each in one transaction holding the
 * workspace, its memberships, invitations and credentials and its audit event.
 * Every row is an upsert keyed on a stable id (workspace id = org id,
 * `wm_<source _id hex>`, invitation id, key id) that only sets fields on insert,
 * so a re-run is safe: it never overwrites a change made in Core since, never
 * revives an ended membership or a revoked key, and writes nothing (not even an
 * audit event) when it has nothing to add.
 *
 * A re-run does carry one kind of change: access the Store has taken away since
 * the last run, because that can only reduce what a key or person may do.
 *  - A Store key that is now revoked, and still live in Core, is revoked in Core
 *    (`revokedCredentials`, one `credential.revoked` event each, as the system).
 *  - A Store membership that is gone or no longer active, whose Core membership is
 *    still unclaimed (nobody has signed in with it), is ended as `removed` and the
 *    keys it created are revoked, as `endMembership` does (`removedMemberships`,
 *    one `membership.removed` event each, as the system). When the Store replaced
 *    it with another active membership of the same person (removed and re-added,
 *    or another of their rows now ranks first), the person keeps what they made:
 *    its live keys and pending invitations move to the replacement first, as a
 *    claim's merge does (`movedCredentialIds`, `replacedByMembershipId`, and a
 *    `membership.replaced` event). The synthesized owner
 *    (`wm_owner_<orgId>`) counts as gone once the Store no longer gives that person
 *    access to the org at all.
 *  - A Store invitation that is no longer pending, and is still pending in Core, is
 *    revoked in Core (`revokedInvitations`, one `invitation.revoked` event each). So
 *    is a pending one an earlier run imported when a newer Store invitation for the
 *    same email replaces it (Core keeps one pending invitation per email). A pending
 *    invitation made in Core is kept, and the Store's for that email is reported
 *    instead of imported (`invitationConflicts`).
 *  - A role the Store lowered, on a membership still unclaimed whose role Core has
 *    not changed since the import (its only role history entry), is lowered in Core
 *    (`demotedMemberships`, one `membership.role_changed` event each, as the system).
 *    Any other difference between the Store's role and Core's is reported and left
 *    alone (`roleDrift`): the person has signed in, Core changed the role, or the
 *    Store gives more than Core.
 *  - A claimed membership (the person has signed in) is never changed: drift on one
 *    is reported (`claimedMembershipDrift`) for an admin to act on in Core.
 *  - A run never leaves a workspace without an owner. When ending or lowering the
 *    unclaimed memberships the Store removed or demoted would leave none (no other active owner,
 *    claimed or pending, and no new owner imported by this run; a deleted
 *    account's owner membership does not count), every owner membership it
 *    would end or lower is kept instead and reported (`keptLastOwners`), for an
 *    Organization Admin to decide in Core. The next run ends it once Core has
 *    another owner.
 * Run apply again immediately before the Store cutover so Core is current.
 *
 * Some things are reported instead of imported. An org whose Core workspace exists
 * but is not active (deleted in Core) is skipped whole (`skippedWorkspaces`), and
 * nothing else in the report counts or names it. Core keeps at most one active
 * pending membership per WorkOS user per workspace: this script is the only
 * writer of pending memberships and checks it inside each org's transaction (a
 * unique index cannot be added to the collection on Azure Cosmos DB, which some
 * Private Clouds use). A membership whose person already holds a different
 * unclaimed membership in that workspace is skipped with the keys bound to it
 * (`pendingCollisions`); the rest of the org still imports.
 *
 * What is imported:
 *  - Memberships: `status: "active"` rows only. owner -> owner, admin -> admin,
 *    member -> developer. They keep the WorkOS user id as `pendingWorkosUserId`
 *    and the email for display, and are claimed by the person's first sign-in
 *    with that verified email (`membership-claim.service.ts`). Each starts its
 *    role history with that role, from the Store membership's creation time, at
 *    the workspace's revision (0 for a new workspace; a run that adds members to
 *    an existing workspace bumps its revision once, as joining does). A person
 *    with several active rows keeps the highest role. An org with no owner
 *    membership is given one from its `ownerUserId` (the recorded owner): a person
 *    with an active row is promoted to owner (`promotedOwners`), a person with no
 *    row at all gets a pending owner membership (`wm_owner_<orgId>`,
 *    `synthesizedOwners`), and a person whose rows are all inactive is not brought
 *    back. Any other org is reported as owner-less (`ownerlessOrgs`); an
 *    Organization Admin can recover it.
 *  - Invitations: pending and not yet expired, the newest per email. admin ->
 *    admin, member -> developer. Core records them on the system's authority: the
 *    import vouches for what the Store had pending, so each stays acceptable as it
 *    was in the Store. The inviter's membership, when imported, is linked
 *    (`invitedByMembershipId`), so ending that membership revokes the invitation.
 *  - Credentials: every API key, revoked ones included, with their dates. A key
 *    with a `publishingPackage` is a Store-issued package key. Any other key is
 *    bound to its creator's membership; a key whose creator has none is reported
 *    (`keysWithoutCreator`) and skipped. A key that does not have the shape of a
 *    Core credential (ULID id, 64-character lowercase hex hash, lowercase
 *    alphanumeric env) could never validate, so it is reported with the reason
 *    (`malformedKeys`: `malformed_id`, `malformed_hash` or `malformed_env`) and
 *    skipped too. Every key not imported is reported exactly once, in
 *    `malformedKeys`, `keysWithoutCreator` or a `pendingCollisions` entry, and
 *    `counts.skippedKeys` is how many that is. The report never carries a hash.
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
 * connects to the target, and then creates only the collections and indexes it
 * writes, so bad source data aborts without touching the target at all.
 *
 * The report goes to stdout and everything else to stderr, so stdout can be piped.
 */

import {roleAtLeast, type WorkspaceRole} from "@mentra/workspace-contract"
import mongoose, {type AnyBulkWriteOperation, type ClientSession, type Connection, type Model} from "mongoose"
import {withTransaction} from "../src/connections/mongo.connection"
import {AccessCredentialModel, type AccessCredentialRow} from "../src/models/access-credential.model"
import {UserModel} from "../src/models/user.model"
import {WorkspaceAuditEventModel} from "../src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../src/models/workspace-membership.model"
import {WorkspaceModel, type WorkspaceRow} from "../src/models/workspace.model"
import {recordWorkspaceEvent} from "../src/services/workspaces/audit.service"
import {markRevoked} from "../src/services/workspaces/credential.service"
import {repointCredentials, repointInvitations} from "../src/services/workspaces/membership-claim.service"
import {
  bumpRevision,
  endMembership,
  roleEntry,
  touchWorkspace,
  type MembershipRow,
} from "../src/services/workspaces/workspace.service"
import {databaseKey, isLocalMongoUrl, splitMongoUrl} from "./mongo-url"

export {isLocalMongoUrl} from "./mongo-url"

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
  keyId?: unknown
  orgId: string
  name?: unknown
  env?: unknown
  hash?: unknown
  last4?: unknown
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

/** The Core collections this script writes: created, with their indexes, before an apply. */
const TARGET_MODELS = [
  WorkspaceModel,
  WorkspaceMembershipModel,
  WorkspaceInvitationModel,
  AccessCredentialModel,
  WorkspaceAuditEventModel,
] as unknown as Array<Pick<Model<unknown>, "createCollection" | "createIndexes">>

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

/** Why a key could never validate as a Core credential: the first of its parts that is wrong. */
export type MalformedKeyReason = "malformed_id" | "malformed_hash" | "malformed_env"

export type MigrationReport = {
  mode: "dry-run" | "apply"
  /**
   * What the run imports (rows an earlier run imported count again) in the orgs it does not skip.
   * With the target compared, memberships and credentials a `pendingCollisions` entry skips are left
   * out. `skippedKeys` is every Store key of those orgs that is not imported, each reported once:
   * in `malformedKeys`, `keysWithoutCreator` or a `pendingCollisions` entry.
   */
  counts: {orgs: number; memberships: number; invitations: number; credentials: number; skippedKeys: number}
  /** Keys bound to a creator who has no membership in the org: not imported. */
  keysWithoutCreator: Array<{orgId: string; keyId: string; name: string}>
  /** Keys whose id, hash or env could never validate as a Core credential: not imported. `keyId` is null when absent. */
  malformedKeys: Array<{orgId: string; keyId: string | null; name: string | null; reason: MalformedKeyReason}>
  /** Orgs imported with no owner, for an Organization Admin to recover. */
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
  /**
   * Unclaimed imported memberships ended because their Store membership is gone. When the Store
   * replaced it with another membership of the same person, its live keys move to that one
   * (`movedCredentialIds`); otherwise they are revoked with it (`revokedCredentialIds`).
   */
  removedMemberships: Array<{
    orgId: string
    membershipId: string
    replacedByMembershipId: string | null
    movedCredentialIds: string[]
    revokedCredentialIds: string[]
  }>
  /** Unclaimed imported memberships whose role the Store lowered since the last run: lowered in Core. */
  demotedMemberships: Array<{orgId: string; membershipId: string; fromRole: string; toRole: string}>
  /**
   * Memberships whose Store role differs from Core's and that a run leaves alone, for an Organization
   * Admin: the person has signed in (`claimed`), Core changed the role since the import
   * (`changed_in_core`), or the Store gives more than Core (`raised_in_store`; a run only carries
   * reductions).
   */
  roleDrift: Array<{orgId: string; membershipId: string; coreRole: string; storeRole: string; reason: RoleDriftReason}>
  /**
   * Store invitations not imported because Core already has a pending invitation for that email that
   * did not come from the Store (made in Core since): the one in Core is kept.
   */
  invitationConflicts: Array<{orgId: string; invitationId: string; keptInvitationId: string}>
  /**
   * Pending Core invitations revoked because their Store invitation is no longer pending, or because a
   * newer Store invitation for the same email replaces them.
   */
  revokedInvitations: Array<{orgId: string; invitationId: string}>
  /** Claimed (signed-in) memberships whose Store membership is gone: reported, never changed. */
  claimedMembershipDrift: Array<{orgId: string; membershipId: string; mentraUserId: string}>
  /** Memberships not imported because the person already holds another unclaimed one there, with their skipped keys. */
  pendingCollisions: Array<{orgId: string; membershipId: string; userId: string; skippedCredentialIds: string[]}>
  /**
   * Unclaimed owner memberships whose Store membership is gone, kept because ending them would leave the
   * workspace without an owner. An Organization Admin decides in Core.
   */
  keptLastOwners: Array<{orgId: string; membershipId: string; userId: string}>
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

/** What the source alone says about an org, recorded in the report unless the org is skipped. */
type OrgFindings = {
  keysWithoutCreator: MigrationReport["keysWithoutCreator"]
  malformedKeys: MigrationReport["malformedKeys"]
  duplicateMemberships: MigrationReport["duplicateMemberships"]
  owner: "present" | "promoted" | "synthesized" | "missing"
}

type OrgPlan = {
  orgId: string
  name: string
  createdAt: Date
  updatedAt: Date
  memberships: PlannedMembership[]
  invitations: PlannedInvitation[]
  credentials: PlannedCredential[]
  findings: OrgFindings
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
 * a different connection. The plan comes from the source alone; the re-run lists
 * compare it with the target (read inside each org's transaction for an apply, or
 * through `target` for a dry run), so a dry run given a target and an apply of the
 * same data report the same thing.
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
    demotedMemberships: [],
    roleDrift: [],
    revokedInvitations: [],
    invitationConflicts: [],
    claimedMembershipDrift: [],
    pendingCollisions: [],
    keptLastOwners: [],
  }

  const plans = [...orgs]
    .sort((a, b) => compareStrings(a.orgId, b.orgId))
    .map(org => planOrg(org, rows, now, log))

  if (apply) {
    // Only now, with the whole source validated, does anything touch the target.
    await prepareTarget(source)
    for (const plan of plans) recordOrg(report, plan, await importOrg(plan, log))
  } else if (options.target) {
    const db = options.target.db
    if (!db) throw new MigrationError("the target connection is not open")
    for (const plan of plans) recordOrg(report, plan, reconcile(plan, await readTargetState(db, plan)))
  } else {
    for (const plan of plans) recordOrg(report, plan, null)
  }

  const labels = [
    ...new Set(
      plans
        .filter(plan => !report.skippedWorkspaces.some(skipped => skipped.orgId === plan.orgId))
        .flatMap(plan => plan.credentials.map(credential => credential.env)),
    ),
  ].sort()
  if (labels.length > 0) {
    log(
      `imported keys carry environment labels ${labels.join(", ")}; the Core deployment must list each in ` +
        "CLOUD_CORE_CREDENTIAL_ENVIRONMENTS or those keys will not validate",
    )
  }
  return report
}

/** Everything the import needs from one org, derived from the source rows alone. */
function planOrg(org: SourceOrg, rows: SourceRows, now: Date, log: (m: string) => void): OrgPlan {
  const orgId = requireString(org.orgId, "developer org orgId")
  const createdAt = asDate(org.createdAt) ?? now
  const findings: OrgFindings = {keysWithoutCreator: [], malformedKeys: [], duplicateMemberships: [], owner: "present"}
  const memberships = planMemberships(org, rows.memberships.get(orgId) ?? [], now, findings)

  const membershipByUser = new Map(memberships.map(membership => [membership.sourceUserId, membership]))
  const invitations = planInvitations(orgId, rows.invitations.get(orgId) ?? [], membershipByUser, now, log)
  const credentials = planCredentials(orgId, rows.keys.get(orgId) ?? [], membershipByUser, now, findings)

  return {
    orgId,
    name: typeof org.displayName === "string" && org.displayName.trim() ? org.displayName.trim() : orgId,
    createdAt,
    updatedAt: asDate(org.updatedAt) ?? createdAt,
    memberships,
    invitations,
    credentials,
    findings,
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
  findings: OrgFindings,
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
    if (ranked.length > 1) findings.duplicateMemberships.push({orgId, userId})
  }

  const planned = kept.map<PlannedMembership>(({row, role}) => {
    const createdAt = asDate(row.createdAt) ?? now
    return {
      membershipId: `wm_${String(row._id)}`,
      sourceUserId: row.userId,
      role: MEMBERSHIP_ROLES[role],
      email: stringOrNull(row.email),
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
      findings.owner = "promoted"
    } else if (ownerUserId && !sourceRows.some(row => row.userId === ownerUserId)) {
      const createdAt = asDate(org.createdAt) ?? now
      planned.push({
        membershipId: `wm_owner_${orgId}`,
        sourceUserId: ownerUserId,
        role: "owner",
        email: null,
        startedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      })
      findings.owner = "synthesized"
    } else {
      // No recorded owner, or the person it names only has inactive rows (they were removed, and
      // bringing them back as owner would be wrong).
      findings.owner = "missing"
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
  findings: OrgFindings,
): PlannedCredential[] {
  const planned: PlannedCredential[] = []
  for (const row of sourceRows) {
    const name = typeof row.name === "string" && row.name.trim() ? row.name : null
    const reason = malformedReason(row)
    if (reason) {
      // Checked first: a malformed key is reported as malformed only, whoever created it.
      findings.malformedKeys.push({orgId, keyId: typeof row.keyId === "string" ? row.keyId : null, name, reason})
      continue
    }
    const keyId = row.keyId as string
    const creator = stringOrNull(row.createdByUserId)
    const packageName = stringOrNull(row.publishingPackage)
    const member = packageName || !creator ? undefined : membershipByUser.get(creator)

    // A key that is neither a Store package key nor tied to a known member would never validate.
    if (!packageName && !member) {
      findings.keysWithoutCreator.push({orgId, keyId, name: name ?? keyId})
      continue
    }

    const createdAt = asDate(row.createdAt) ?? now
    const revokedAt = asDate(row.revokedAt)
    planned.push({
      credentialId: keyId,
      name: name ?? keyId,
      env: row.env as string,
      hash: row.hash as string,
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
 * Why the key's id, hash or env is not what a Core token is made of (`msk_<env>_<ulid>.<secret>`,
 * hash = SHA-256 hex of the secret), or null when they all are. Such a key could never validate,
 * whoever created it.
 */
function malformedReason(row: SourceApiKey): MalformedKeyReason | null {
  if (typeof row.keyId !== "string" || !KEY_ID_PATTERN.test(row.keyId)) return "malformed_id"
  if (typeof row.hash !== "string" || !KEY_HASH_PATTERN.test(row.hash)) return "malformed_hash"
  if (typeof row.env !== "string" || !KEY_ENV_PATTERN.test(row.env)) return "malformed_env"
  return null
}

// --- Compare with the target ------------------------------------------------

type TargetMembership = {
  membershipId: string
  mentraUserId: string | null
  pendingWorkosUserId: string | null
  role: string
  /** Whether Core changed the role since the membership was imported. */
  roleChangedInCore: boolean
}

type RoleDriftReason = "claimed" | "changed_in_core" | "raised_in_store"

/** What the target holds for one org, read before anything is written. */
type TargetState = {
  /** The Core workspace's status, or null when it does not exist yet. */
  workspaceStatus: string | null
  /** The workspace's active memberships. */
  memberships: TargetMembership[]
  /** Core users among the active owners whose account is deleted: no owner for the last-owner rule. */
  deletedOwnerUserIds: Set<string>
  /** The workspace's live (not revoked) credentials. */
  liveCredentials: Array<{credentialId: string; createdByMembershipId: string | null}>
  /** The workspace's pending invitations. */
  pendingInvitationIds: string[]
  /** The email of each pending invitation, lowercased, by invitation id. */
  pendingInvitationEmails: Map<string, string>
  /** Planned membership, invitation and credential ids that already exist in Core, in any state. */
  existingMembershipIds: Set<string>
  existingInvitationIds: Set<string>
  existingCredentialIds: Set<string>
}

/** What a run does to one org beyond inserting what is missing. */
type Reconciliation = {
  /** Set when the Core workspace exists but is not active: the org is skipped whole. */
  skippedStatus: string | null
  revokeCredentials: Array<{credentialId: string; revokedAt: Date}>
  endMemberships: Array<{
    membershipId: string
    replacedByMembershipId: string | null
    movedCredentialIds: string[]
    revokedCredentialIds: string[]
  }>
  revokeInvitationIds: string[]
  demotions: Array<{membershipId: string; fromRole: WorkspaceRole; toRole: WorkspaceRole}>
  roleDrift: Array<{membershipId: string; coreRole: string; storeRole: string; reason: RoleDriftReason}>
  claimedDrift: Array<{membershipId: string; mentraUserId: string}>
  collisions: Array<{membershipId: string; userId: string; skippedCredentialIds: string[]}>
  invitationConflicts: Array<{invitationId: string; keptInvitationId: string}>
  keptLastOwners: Array<{membershipId: string; userId: string}>
  /** What this run inserts (absent from Core and not skipped). */
  insert: {memberships: PlannedMembership[]; invitations: PlannedInvitation[]; credentials: PlannedCredential[]}
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
  const [workspace, memberships, credentials, invitations, existingMemberships, existingInvitations, existingCredentials] =
    await Promise.all([
      collection(WorkspaceModel).findOne({workspaceId}, {...options, projection: {status: 1}}),
      collection(WorkspaceMembershipModel)
        .find(
          {workspaceId, status: "active"},
          {...options, projection: {membershipId: 1, mentraUserId: 1, pendingWorkosUserId: 1, role: 1, roleHistory: 1}},
        )
        .toArray(),
      collection(AccessCredentialModel)
        .find({workspaceId, revokedAt: null}, {...options, projection: {credentialId: 1, createdByMembershipId: 1}})
        .toArray(),
      collection(WorkspaceInvitationModel)
        .find({workspaceId, status: "pending"}, {...options, projection: {invitationId: 1, email: 1}})
        .toArray(),
      collection(WorkspaceMembershipModel)
        .find(
          {membershipId: {$in: plan.memberships.map(membership => membership.membershipId)}},
          {...options, projection: {membershipId: 1}},
        )
        .toArray(),
      collection(WorkspaceInvitationModel)
        .find(
          {invitationId: {$in: plan.invitations.map(invitation => invitation.invitationId)}},
          {...options, projection: {invitationId: 1}},
        )
        .toArray(),
      collection(AccessCredentialModel)
        .find(
          {credentialId: {$in: plan.credentials.map(credential => credential.credentialId)}},
          {...options, projection: {credentialId: 1}},
        )
        .toArray(),
    ])
  const active = memberships.map(row => ({
    membershipId: String(row.membershipId),
    mentraUserId: stringOrNull(row.mentraUserId),
    pendingWorkosUserId: stringOrNull(row.pendingWorkosUserId),
    role: String(row.role),
    // An imported membership starts with one role history entry; anything else is Core's doing.
    roleChangedInCore: !(Array.isArray(row.roleHistory) && row.roleHistory.length === 1 && row.roleHistory[0]?.role === row.role),
  }))
  const ownerUserIds = active.flatMap(row => (row.role === "owner" && row.mentraUserId ? [row.mentraUserId] : []))
  const deletedOwners = ownerUserIds.length
    ? await collection(UserModel)
        .find(
          {mentraUserId: {$in: ownerUserIds}, supportTelemetryDeletedAt: {$ne: null}},
          {...options, projection: {mentraUserId: 1}},
        )
        .toArray()
    : []
  return {
    workspaceStatus: workspace ? String(workspace.status) : null,
    memberships: active,
    deletedOwnerUserIds: new Set(deletedOwners.map(row => String(row.mentraUserId))),
    liveCredentials: credentials.map(row => ({
      credentialId: String(row.credentialId),
      createdByMembershipId: stringOrNull(row.createdByMembershipId),
    })),
    pendingInvitationIds: invitations.map(row => String(row.invitationId)),
    pendingInvitationEmails: new Map(invitations.map(row => [String(row.invitationId), String(row.email ?? "").trim().toLowerCase()])),
    existingMembershipIds: new Set(existingMemberships.map(row => String(row.membershipId))),
    existingInvitationIds: new Set(existingInvitations.map(row => String(row.invitationId))),
    existingCredentialIds: new Set(existingCredentials.map(row => String(row.credentialId))),
  }
}

/**
 * Decide, from the plan and what the target holds, what this run changes (see the file header).
 * Pure, so a dry run and an apply decide the same way.
 */
function reconcile(plan: OrgPlan, target: TargetState): Reconciliation {
  const result: Reconciliation = {
    skippedStatus: null,
    revokeCredentials: [],
    endMemberships: [],
    revokeInvitationIds: [],
    demotions: [],
    roleDrift: [],
    claimedDrift: [],
    collisions: [],
    invitationConflicts: [],
    keptLastOwners: [],
    insert: {memberships: [], invitations: [], credentials: []},
  }
  if (target.workspaceStatus !== null && target.workspaceStatus !== "active") {
    return {...result, skippedStatus: target.workspaceStatus}
  }

  let remaining = target.memberships
  let ending: TargetMembership[] = []
  let endingCredentials: (membershipId: string) => string[] = () => []
  // Removals only apply to a workspace an earlier run imported.
  if (target.workspaceStatus === "active") {
    const ownerId = `wm_owner_${plan.orgId}`
    const plannedIds = new Set(plan.memberships.map(membership => membership.membershipId))
    const plannedUsers = new Set(plan.memberships.map(membership => membership.sourceUserId))
    /** A membership this script made from a Store row or from the org's recorded owner. */
    const fromSource = (id: string) =>
      id === ownerId || plan.source.membershipActive.has(id) || SOURCE_ROW_MEMBERSHIP_ID.test(id)
    /** Whether the Store still gives this membership's person access through it. */
    const stillGranted = (membership: TargetMembership) =>
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

    const toEnd: TargetMembership[] = []
    remaining = []
    for (const membership of [...target.memberships].sort((a, b) => compareStrings(a.membershipId, b.membershipId))) {
      if (!fromSource(membership.membershipId) || stillGranted(membership)) {
        remaining.push(membership)
      } else if (membership.mentraUserId) {
        // The person has signed in: the membership is theirs in Core now, so only report it.
        result.claimedDrift.push({membershipId: membership.membershipId, mentraUserId: membership.mentraUserId})
        remaining.push(membership)
      } else if (membership.pendingWorkosUserId) {
        toEnd.push(membership)
      } else {
        remaining.push(membership)
      }
    }

    // Roles: a role the Store lowered on a membership nobody has claimed, and Core has not changed since
    // the import, is lowered in Core; any other difference is reported and left alone.
    const plannedById = new Map(plan.memberships.map(membership => [membership.membershipId, membership]))
    for (const membership of remaining) {
      const planned = plannedById.get(membership.membershipId)
      if (!planned || planned.role === membership.role) continue
      const lowered = !roleAtLeast(planned.role, membership.role as WorkspaceRole)
      const reason: RoleDriftReason | null = membership.mentraUserId
        ? "claimed"
        : membership.roleChangedInCore
          ? "changed_in_core"
          : lowered
            ? null
            : "raised_in_store"
      if (reason) {
        result.roleDrift.push({membershipId: membership.membershipId, coreRole: membership.role, storeRole: planned.role, reason})
      } else {
        result.demotions.push({membershipId: membership.membershipId, fromRole: membership.role as WorkspaceRole, toRole: planned.role})
      }
    }
    const roleAfter = (membership: TargetMembership) =>
      result.demotions.find(demotion => demotion.membershipId === membership.membershipId)?.toRole ?? membership.role

    // Never leave the workspace without an owner: count who would still hold it after this run.
    const ownerDemotions = result.demotions.filter(demotion => demotion.fromRole === "owner")
    if (toEnd.some(membership => membership.role === "owner") || ownerDemotions.length > 0) {
      const pendingAfter = pendingUsersOf(remaining)
      const liveOwners =
        remaining.filter(
          membership =>
            roleAfter(membership) === "owner" &&
            !(membership.mentraUserId && target.deletedOwnerUserIds.has(membership.mentraUserId)),
        ).length +
        plan.memberships.filter(
          membership =>
            membership.role === "owner" &&
            !target.existingMembershipIds.has(membership.membershipId) &&
            !pendingAfter.has(membership.sourceUserId),
        ).length
      if (liveOwners === 0) {
        for (const membership of toEnd.filter(candidate => candidate.role === "owner")) {
          result.keptLastOwners.push({membershipId: membership.membershipId, userId: membership.pendingWorkosUserId!})
          remaining.push(membership)
        }
        for (const demotion of ownerDemotions) {
          const membership = remaining.find(candidate => candidate.membershipId === demotion.membershipId)!
          result.keptLastOwners.push({membershipId: demotion.membershipId, userId: membership.pendingWorkosUserId!})
        }
        result.demotions = result.demotions.filter(demotion => demotion.fromRole !== "owner")
      }
    }
    result.demotions.sort((a, b) => compareStrings(a.membershipId, b.membershipId))
    result.keptLastOwners.sort((a, b) => compareStrings(a.membershipId, b.membershipId))
    const kept = new Set(result.keptLastOwners.map(entry => entry.membershipId))
    ending = toEnd.filter(membership => !kept.has(membership.membershipId))
    endingCredentials = (membershipId: string) =>
      target.liveCredentials
        .filter(credential => credential.createdByMembershipId === membershipId && !alreadyRevoked.has(credential.credentialId))
        .map(credential => credential.credentialId)
        .sort(compareStrings)

    result.revokeInvitationIds = target.pendingInvitationIds
      .filter(id => {
        const status = plan.source.invitationStatus.get(id)
        return status !== undefined && status !== "pending"
      })
      .sort(compareStrings)
  }

  // One active pending membership per WorkOS user per workspace: a new membership for someone who
  // already holds an unclaimed one is reported and left out, with the keys bound to it.
  const pendingUsers = pendingUsersOf(remaining)
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

  const skippedMemberships = new Set(result.collisions.map(collision => collision.membershipId))
  const skippedCredentials = new Set(result.collisions.flatMap(collision => collision.skippedCredentialIds))
  result.insert = {
    memberships: plan.memberships.filter(
      membership => !skippedMemberships.has(membership.membershipId) && !target.existingMembershipIds.has(membership.membershipId),
    ),
    invitations: [] as PlannedInvitation[],
    credentials: plan.credentials.filter(
      credential => !skippedCredentials.has(credential.credentialId) && !target.existingCredentialIds.has(credential.credentialId),
    ),
  }

  // Core keeps one pending invitation per email per workspace. A new Store invitation replaces a pending
  // one an earlier run imported for the same email (the Store's newest wins); one made in Core is kept.
  const revoking = new Set(result.revokeInvitationIds)
  for (const invitation of plan.invitations) {
    if (target.existingInvitationIds.has(invitation.invitationId)) continue
    const pendingForEmail = [...target.pendingInvitationEmails].find(
      ([id, email]) => email === invitation.email && id !== invitation.invitationId && !revoking.has(id),
    )?.[0]
    if (pendingForEmail && !plan.source.invitationStatus.has(pendingForEmail)) {
      result.invitationConflicts.push({invitationId: invitation.invitationId, keptInvitationId: pendingForEmail})
      continue
    }
    if (pendingForEmail) {
      result.revokeInvitationIds.push(pendingForEmail)
      revoking.add(pendingForEmail)
    }
    result.insert.invitations.push(invitation)
  }
  result.revokeInvitationIds.sort(compareStrings)

  // A membership the Store replaced with another one of the same person (removed and re-added, or
  // another of their rows now ranks first) hands its live keys and pending invitations to that one,
  // as a claim's merge does, when it is active once this run is done. Otherwise they end with it.
  const activeAfter = new Set([
    ...remaining.map(membership => membership.membershipId),
    ...result.insert.memberships.map(membership => membership.membershipId),
  ])
  result.endMemberships = ending.map(membership => {
    const replacement = plan.memberships.find(
      planned =>
        planned.sourceUserId === membership.pendingWorkosUserId &&
        planned.membershipId !== membership.membershipId &&
        activeAfter.has(planned.membershipId),
    )
    const credentialIds = endingCredentials(membership.membershipId)
    return {
      membershipId: membership.membershipId,
      replacedByMembershipId: replacement?.membershipId ?? null,
      movedCredentialIds: replacement ? credentialIds : [],
      revokedCredentialIds: replacement ? [] : credentialIds,
    }
  })
  return result
}

/** The WorkOS users holding an unclaimed membership among `memberships`. */
function pendingUsersOf(memberships: TargetMembership[]): Set<string> {
  return new Set(
    memberships.flatMap(membership =>
      !membership.mentraUserId && membership.pendingWorkosUserId ? [membership.pendingWorkosUserId] : [],
    ),
  )
}

/**
 * Record one org in the report: a skipped workspace as that alone, any other org with its counts,
 * its findings from the source and, when the target was compared, what the run changes.
 */
function recordOrg(report: MigrationReport, plan: OrgPlan, result: Reconciliation | null): void {
  const {orgId, findings} = plan
  if (result?.skippedStatus) {
    report.skippedWorkspaces.push({orgId, status: result.skippedStatus})
    return
  }
  const collisions = result?.collisions ?? []
  const skippedMemberships = new Set(collisions.map(collision => collision.membershipId))
  const skippedCredentials = new Set(collisions.flatMap(collision => collision.skippedCredentialIds))

  report.counts.orgs += 1
  report.counts.memberships += plan.memberships.filter(membership => !skippedMemberships.has(membership.membershipId)).length
  const conflicted = new Set((result?.invitationConflicts ?? []).map(conflict => conflict.invitationId))
  report.counts.invitations += plan.invitations.filter(invitation => !conflicted.has(invitation.invitationId)).length
  report.counts.credentials += plan.credentials.filter(credential => !skippedCredentials.has(credential.credentialId)).length
  report.counts.skippedKeys += findings.malformedKeys.length + findings.keysWithoutCreator.length + skippedCredentials.size

  report.keysWithoutCreator.push(...findings.keysWithoutCreator)
  report.malformedKeys.push(...findings.malformedKeys)
  report.duplicateMemberships.push(...findings.duplicateMemberships)
  if (findings.owner === "promoted") report.promotedOwners.push(orgId)
  if (findings.owner === "synthesized") report.synthesizedOwners.push(orgId)
  if (findings.owner === "missing") report.ownerlessOrgs.push(orgId)

  if (!result) return
  for (const {credentialId} of result.revokeCredentials) report.revokedCredentials.push({orgId, credentialId})
  for (const entry of result.endMemberships) report.removedMemberships.push({orgId, ...entry})
  for (const entry of result.demotions) report.demotedMemberships.push({orgId, ...entry})
  for (const entry of result.roleDrift) report.roleDrift.push({orgId, ...entry})
  for (const invitationId of result.revokeInvitationIds) report.revokedInvitations.push({orgId, invitationId})
  for (const entry of result.claimedDrift) report.claimedMembershipDrift.push({orgId, ...entry})
  for (const entry of collisions) report.pendingCollisions.push({orgId, ...entry})
  for (const entry of result.invitationConflicts) report.invitationConflicts.push({orgId, ...entry})
  for (const entry of result.keptLastOwners) report.keptLastOwners.push({orgId, ...entry})
}

// --- Apply -----------------------------------------------------------------

/**
 * The default mongoose connection must be the target, and a different database from the source.
 * Creates the collections this script writes and their indexes first: creating them inside a
 * transaction races with their build.
 */
async function prepareTarget(source: Connection): Promise<void> {
  const target = mongoose.connection
  if (target.readyState !== 1) {
    throw new MigrationError("--apply needs the default mongoose connection connected to the target database")
  }
  if (source === target) throw new MigrationError("the source and the target are the same database")
  const [sourceIdentity, targetIdentity] = [await databaseIdentity(source), await databaseIdentity(target)]
  if (!sourceIdentity || !targetIdentity) {
    // Without a stable identity two routers of one cluster would look different: refuse rather than risk it.
    throw new MigrationError(
      `cannot tell whether the source and the target are different databases: the ${sourceIdentity ? "target" : "source"} ` +
        "did not identify its replica set, cluster or server (a sharded cluster needs config.version readable); nothing was written",
    )
  }
  if (sourceIdentity === targetIdentity) throw new MigrationError("the source and the target are the same database")
  for (const model of TARGET_MODELS) {
    await model.createCollection()
    await model.createIndexes()
  }
}

/**
 * Import one org in one transaction. It reads what Core holds, decides with `reconcile`, and writes
 * the workspace document first, as every Core mutation does: a run that adds or ends memberships of
 * an existing workspace bumps `authorizationRevision` once, and one that only revokes keys or
 * invitations or adds invitations or keys touches it. That also serializes it with any other change
 * to the workspace, the claim at first sign-in included. Removals follow, then inserts (upserts that
 * only set fields on insert), and a `workspace.imported` audit event last when anything was inserted.
 */
async function importOrg(plan: OrgPlan, log: (message: string) => void): Promise<Reconciliation> {
  const {orgId} = plan
  let inserted: {workspace: boolean; memberships: number; invitations: number; credentials: number}
  let reconciliation: Reconciliation
  try {
    ;({reconciliation, inserted} = await withTransaction(async session => {
      const target = await readTargetState(mongoose.connection.db!, plan, session)
      const decided = reconcile(plan, target)
      const nothing = {workspace: false, memberships: 0, invitations: 0, credentials: 0}
      if (decided.skippedStatus !== null) return {reconciliation: decided, inserted: nothing}

      const {insert} = decided
      let workspace: WorkspaceRow | null = null
      const createWorkspace = target.workspaceStatus === null
      if (createWorkspace) {
        await WorkspaceModel.bulkWrite(
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
      } else if (decided.endMemberships.length > 0 || decided.demotions.length > 0 || insert.memberships.length > 0) {
        workspace = await bumpRevision(session, orgId, undefined)
      } else if (
        decided.revokeCredentials.length + decided.revokeInvitationIds.length + insert.invitations.length + insert.credentials.length >
        0
      ) {
        await touchWorkspace(session, orgId)
      } else {
        return {reconciliation: decided, inserted: nothing}
      }
      await applyRemovals(session, orgId, decided, workspace)

      // A membership imported now starts its role history at the workspace's revision: 0 for a
      // workspace this run creates, or the one this run's bump produced.
      const revision = workspace?.authorizationRevision ?? 0
      const skippedMemberships = new Set(decided.collisions.map(collision => collision.membershipId))
      const memberships = await bulkInsertOnly(
        WorkspaceMembershipModel,
        insert.memberships.map(membership =>
          insertOnly(
            {membershipId: membership.membershipId},
            {
              workspaceId: orgId,
              mentraUserId: null,
              pendingWorkosUserId: membership.sourceUserId,
              email: membership.email,
              role: membership.role,
              roleHistory: [roleEntry(membership.role, membership.startedAt, revision)],
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
        insert.invitations.map(invitation =>
          insertOnly(
            {invitationId: invitation.invitationId},
            {
              workspaceId: orgId,
              email: invitation.email,
              role: invitation.role,
              tokenHash: invitation.tokenHash,
              status: "pending",
              invitedByAuthority: "system",
              invitedByMembershipId:
                invitation.invitedByMembershipId && !skippedMemberships.has(invitation.invitedByMembershipId)
                  ? invitation.invitedByMembershipId
                  : null,
              invitedByMentraUserId: null,
              invitedByEmail: null,
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
        insert.credentials.map(credential =>
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

      if (createWorkspace || memberships + invitations + credentials > 0) {
        await recordWorkspaceEvent(session, {
          workspaceId: orgId,
          action: "workspace.imported",
          actor: SYSTEM_ACTOR,
          target: {workspaceId: orgId},
          after: {name: plan.name, created: createWorkspace, memberships, invitations, credentials},
        })
      }
      return {reconciliation: decided, inserted: {workspace: createWorkspace, memberships, invitations, credentials}}
    }))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new MigrationError(`importing ${orgId} failed and was rolled back: ${reason}`, {cause: err})
  }

  if (reconciliation.skippedStatus !== null) {
    log(`${orgId}: skipped, its Core workspace is ${reconciliation.skippedStatus}`)
    return reconciliation
  }
  log(
    inserted.workspace
      ? `${orgId}: imported (${inserted.memberships} memberships, ${inserted.invitations} invitations, ${inserted.credentials} credentials)`
      : `${orgId}: already imported (${inserted.memberships} memberships, ${inserted.invitations} invitations, ` +
          `${inserted.credentials} credentials added since)`,
  )
  const removals = [
    reconciliation.revokeCredentials.length && `${reconciliation.revokeCredentials.length} key(s) revoked`,
    reconciliation.endMemberships.length && `${reconciliation.endMemberships.length} membership(s) removed`,
    reconciliation.demotions.length && `${reconciliation.demotions.length} role(s) lowered`,
    reconciliation.revokeInvitationIds.length && `${reconciliation.revokeInvitationIds.length} invitation(s) revoked`,
  ].filter(Boolean)
  if (removals.length > 0) log(`${orgId}: carried from the Store: ${removals.join(", ")}`)
  if (reconciliation.claimedDrift.length > 0) {
    log(`${orgId}: ${reconciliation.claimedDrift.length} signed-in membership(s) no longer in the Store were left as they are`)
  }
  if (reconciliation.roleDrift.length > 0) {
    log(`${orgId}: ${reconciliation.roleDrift.length} role(s) differ from the Store and were left as they are`)
  }
  if (reconciliation.collisions.length > 0) {
    log(`${orgId}: ${reconciliation.collisions.length} membership(s) skipped: the person already has an unclaimed one`)
  }
  if (reconciliation.keptLastOwners.length > 0) {
    log(`${orgId}: ${reconciliation.keptLastOwners.length} owner membership(s) the Store removed were kept: the workspace has no other owner`)
  }
  return reconciliation
}

/**
 * Carry the Store's access removals into Core inside the org's transaction, as the system: revoke
 * keys, end unclaimed memberships (with the keys they created, unless they move to a replacement),
 * lower roles and revoke invitations, recording an audit event for each. The caller has already
 * written the workspace document; `workspace` is the bumped row when memberships end or change role.
 */
async function applyRemovals(
  session: ClientSession,
  workspaceId: string,
  reconciliation: Reconciliation,
  workspace: WorkspaceRow | null,
): Promise<void> {
  for (const {credentialId, revokedAt} of reconciliation.revokeCredentials) {
    const row = await AccessCredentialModel.findOne({credentialId, workspaceId, revokedAt: null})
      .session(session)
      .lean<AccessCredentialRow>()
    if (row) await markRevoked(session, row, SYSTEM_ACTOR, revokedAt)
  }

  for (const {membershipId, replacedByMembershipId} of reconciliation.endMemberships) {
    const membership = await WorkspaceMembershipModel.findOne({membershipId, workspaceId, status: "active"})
      .session(session)
      .lean<MembershipRow>()
    if (!membership) continue
    if (replacedByMembershipId) {
      // The replacement is inserted later in this transaction, if it is new.
      const repointedCredentialIds = await repointCredentials(session, membership, replacedByMembershipId)
      const repointedInvitationIds = await repointInvitations(session, membership, replacedByMembershipId)
      await recordWorkspaceEvent(session, {
        workspaceId,
        action: "membership.replaced",
        actor: SYSTEM_ACTOR,
        target: {membershipId, mentraUserId: null, email: membership.email ?? null},
        after: {replacedByMembershipId, repointedCredentialIds, repointedInvitationIds},
      })
    }
    await endMembership(session, {
      workspace: workspace!,
      actor: SYSTEM_ACTOR,
      membership,
      reason: "removed",
      action: "membership.removed",
    })
  }

  for (const {membershipId, fromRole, toRole} of reconciliation.demotions) {
    const changed = await WorkspaceMembershipModel.findOneAndUpdate(
      {membershipId, workspaceId, status: "active", role: fromRole, mentraUserId: null},
      {$set: {role: toRole}, $push: {roleHistory: roleEntry(toRole, new Date(), workspace!.authorizationRevision)}},
      {session},
    ).lean<MembershipRow>()
    if (!changed) continue
    await recordWorkspaceEvent(session, {
      workspaceId,
      action: "membership.role_changed",
      actor: SYSTEM_ACTOR,
      target: {membershipId, mentraUserId: null, email: changed.email ?? null},
      before: {role: fromRole},
      after: {role: toRole},
    })
  }

  for (const invitationId of reconciliation.revokeInvitationIds) {
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
      target: {invitationId, email: invitation.email},
      before: {status: "pending", role: invitation.role},
      after: {status: "revoked"},
    })
  }
}

/**
 * Which database `connection` reached, as the server sees it, so two spellings of one host (or two
 * members of one replica set) compare equal: its replica set (name and members), a sharded cluster's
 * id (from `config.version`), or a standalone server's process; and the database name. Null when the
 * server gives none of these, for example a sharded cluster whose `config.version` cannot be read:
 * a router's own process id would not identify the cluster.
 */
export async function databaseIdentity(connection: Connection): Promise<string | null> {
  const admin = connection.db!.admin()
  type Hello = {setName?: string; hosts?: string[]; msg?: string; topologyVersion?: {processId?: unknown}}
  const hello = (await admin.command({hello: 1}).catch(() => admin.command({isMaster: 1}))) as Hello
  let server: string
  if (hello.setName) {
    server = `replica-set ${hello.setName} ${[...(hello.hosts ?? [])].map(host => host.toLowerCase()).sort().join(",")}`
  } else if (hello.msg === "isdbgrid") {
    const version = await connection
      .getClient()
      .db("config")
      .collection("version")
      .findOne({}, {projection: {clusterId: 1}})
      .catch(() => null)
    if (!version?.clusterId) return null
    server = `cluster ${String(version.clusterId)}`
  } else {
    if (!hello.topologyVersion?.processId) return null
    server = `process ${String(hello.topologyVersion.processId)}`
  }
  return `${server}/${connection.name}`
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

async function readAll<T>(source: Connection, collection: string): Promise<T[]> {
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
  --source <mongo-url> --target <mongo-url> [--apply] [--i-understand-remote]

Without --apply the script prints a JSON report and writes nothing; it reads the target to report what
a re-run would change (revocations and removals carried from the Store, drift, skipped workspaces).
--apply refuses unless both URLs are local; --i-understand-remote lifts that and is for the operator only.`

const VALUE_FLAGS = {"--source": "source", "--target": "target"} as const

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
      // touched at all.
      await migrateStoreDeveloperOrgs({source, apply: false})
      // No automatic collections or indexes: `prepareTarget` creates exactly those this script writes.
      await mongoose.connect(options.target, {serverSelectionTimeoutMS: 10_000, autoIndex: false, autoCreate: false})
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
