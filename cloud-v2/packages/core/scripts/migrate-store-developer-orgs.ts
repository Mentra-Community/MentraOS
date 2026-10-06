/**
 * @fileoverview Migrate the Store's developer orgs into Core workspaces.
 *
 * Usage:
 *
 *   bun packages/core/scripts/migrate-store-developer-orgs.ts \
 *     --source <mongo-url> --target <mongo-url> --organization-id <id> [--apply]
 *
 * The source is the Store database (`developer_orgs`, `developer_org_memberships`,
 * `developer_org_invitations`, `developer_org_api_keys`). It is only ever read.
 * The target is the Core database. Every row written carries `--organization-id`,
 * which must equal `CLOUD_CORE_ORGANIZATION_ID` when that is set, because the
 * change feed only serves the deployment's own organization.
 *
 * Without `--apply` this prints a JSON report and writes nothing. It does not even
 * connect to the target, so there is nothing for it to write to. With `--apply`
 * it imports one developer org at a time, each in one short transaction holding
 * the workspace, its memberships, invitations and credentials and one
 * `workspace.imported` audit event. Every row is an upsert keyed on a stable id
 * (workspace id = org id, `wm_<source _id hex>`, invitation id, key id) that only
 * sets fields on insert, so a re-run is safe: it never overwrites a change made in
 * Core since, never revives an ended membership or a revoked key, and records the
 * audit event only for a workspace it has just inserted.
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
import {AccessCredentialModel} from "../src/models/access-credential.model"
import {WorkspaceAuditCounterModel} from "../src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../src/models/workspace-membership.model"
import {WorkspaceModel} from "../src/models/workspace.model"
import {recordWorkspaceEvent} from "../src/services/workspaces/audit.service"
import {ORGANIZATION_ID_PATTERN} from "../src/services/workspaces/organization"

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
  organizationId: string
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
}

export type MigrationOptions = {
  /** The Store database. Only read. */
  source: Connection
  organizationId: string
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
}

type SourceRows = {
  memberships: Map<string, SourceMembership[]>
  invitations: Map<string, SourceInvitation[]>
  keys: Map<string, SourceApiKey[]>
}

/**
 * Check `value` as an organization id for the migration: the same pattern as
 * `organizationId()`, and equal to `CLOUD_CORE_ORGANIZATION_ID` when that is set
 * (the change feed only serves the deployment's own organization).
 */
export function resolveMigrationOrganizationId(value: string): string {
  if (typeof value !== "string" || !ORGANIZATION_ID_PATTERN.test(value)) {
    throw new MigrationError(`--organization-id must match ${ORGANIZATION_ID_PATTERN}`)
  }
  const configured = process.env.CLOUD_CORE_ORGANIZATION_ID?.trim()
  if (configured && configured !== value) {
    throw new MigrationError(
      `--organization-id "${value}" differs from CLOUD_CORE_ORGANIZATION_ID "${configured}"; ` +
        "the change feed only serves the deployment's own organization",
    )
  }
  return value
}

/**
 * Plan (and with `apply`, perform) the import. The target is the default
 * mongoose connection, because that is where Core's models live; `source` must be
 * a different connection. The returned report is computed from the source alone,
 * so a dry run and an apply report the same thing.
 */
export async function migrateStoreDeveloperOrgs(options: MigrationOptions): Promise<MigrationReport> {
  const organization = resolveMigrationOrganizationId(options.organizationId)
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
    organizationId: organization,
    counts: {orgs: 0, memberships: 0, invitations: 0, credentials: 0, skippedKeys: 0},
    keysWithoutCreator: [],
    malformedKeys: [],
    ownerlessOrgs: [],
    synthesizedOwners: [],
    promotedOwners: [],
    duplicateMemberships: [],
  }

  const plans = [...orgs]
    .sort((a, b) => compareStrings(a.orgId, b.orgId))
    .map(org => planOrg(org, rows, now, report, log))

  if (apply) {
    // Only now, with the whole source validated, does anything touch the target.
    await prepareTarget(source)
    for (const plan of plans) await importOrg(plan, organization, log)
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
  }
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

// --- Apply -----------------------------------------------------------------

/** What one org's import inserted; a re-run inserts nothing. */
type ImportResult = {workspace: boolean; memberships: number; invitations: number; credentials: number}

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
 * Import one org in one transaction. Everything is an upsert that only sets
 * fields on insert, and the audit event is the last write and is recorded only
 * when this run inserted the workspace.
 */
async function importOrg(plan: OrgPlan, organization: string, log: (message: string) => void): Promise<void> {
  const {orgId} = plan
  let result: ImportResult
  try {
    result = await withTransaction(async session => {
      const workspace = await WorkspaceModel.bulkWrite(
        [
          insertOnly(
            {workspaceId: orgId},
            {
              organizationId: organization,
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
        plan.memberships.map(membership =>
          insertOnly(
            {membershipId: membership.membershipId},
            {
              organizationId: organization,
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
              organizationId: organization,
              workspaceId: orgId,
              email: invitation.email,
              role: invitation.role,
              tokenHash: invitation.tokenHash,
              status: "pending",
              invitedByMembershipId: invitation.invitedByMembershipId,
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
        plan.credentials.map(credential =>
          insertOnly(
            {credentialId: credential.credentialId},
            {
              prefix: "msk",
              credentialKind: "workspace",
              organizationId: organization,
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
          organizationId: organization,
          workspaceId: orgId,
          action: "workspace.imported",
          actor: {kind: "system"},
          target: {workspaceId: orgId},
          after: {name: plan.name, memberships, invitations, credentials},
        })
      }
      return {workspace: inserted, memberships, invitations, credentials}
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new MigrationError(`importing ${orgId} failed and was rolled back: ${reason}`, {cause: err})
  }

  log(
    result.workspace
      ? `${orgId}: imported (${result.memberships} memberships, ${result.invitations} invitations, ${result.credentials} credentials)`
      : `${orgId}: already imported (${result.memberships} memberships, ${result.invitations} invitations, ` +
          `${result.credentials} credentials added since)`,
  )
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

/** Open the source connection. Read-only by use: nothing here ever writes, and no model is attached to it. */
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
  organizationId: string
  apply: boolean
  allowRemote: boolean
}

const USAGE = `Usage: bun packages/core/scripts/migrate-store-developer-orgs.ts \\
  --source <mongo-url> --target <mongo-url> --organization-id <id> [--apply]

Without --apply the script prints a JSON report and writes nothing.
--apply refuses unless both URLs are local; --i-understand-remote lifts that and is for the operator only.`

const VALUE_FLAGS = {"--source": "source", "--target": "target", "--organization-id": "organizationId"} as const
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
  const {source, target, organizationId} = values as Record<(typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS], string>

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
            "127.0.0.1, localhost or ::1 without credentials. Operators can pass --i-understand-remote.",
        )
      }
    }
  }
  return {source, target, organizationId, apply, allowRemote}
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
  let organizationId: string
  try {
    options = parseArgs(argv)
    organizationId = resolveMigrationOrganizationId(options.organizationId)
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
  try {
    source = await openSourceConnection(options.source)
    // Plan from the source alone first. A dry run stops here and never connects to the target. For an
    // apply this validates the whole source before the target is touched: connecting makes Mongoose
    // create the collections and indexes, which bad source data must not leave behind.
    let report = await migrateStoreDeveloperOrgs({
      source,
      organizationId,
      apply: false,
      log: options.apply ? () => {} : message => console.error(message),
    })
    if (options.apply) {
      await mongoose.connect(options.target, {serverSelectionTimeoutMS: 10_000})
      report = await migrateStoreDeveloperOrgs({
        source,
        organizationId,
        apply: true,
        log: message => console.error(message),
      })
    }
    console.log(JSON.stringify(report, null, 2))
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  } finally {
    await source?.close()
    await mongoose.disconnect()
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2))
}
