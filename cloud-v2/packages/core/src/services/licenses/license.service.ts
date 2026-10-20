/**
 * @fileoverview Licenses and their seats.
 *
 * A license is Core's copy of what billing (the Store's billing module) last wrote for it
 * (`applyLicenseWrite`): a quantity of one product for a term, held by a workspace or a person. Core never
 * changes a license's terms itself; it records who holds each seat of a workspace license, and ends a
 * license when its owner is deleted.
 *
 * **Writes are revisioned.** A write applies only when its revision is newer than the one Core has; an
 * equal one is a repeat and changes nothing, an older one is refused (`stale_revision`), and one for an
 * owner that is deleted or never existed is refused (`owner_not_found`), as is any write for a license that
 * ended with its owner. A workspace license is written in a transaction that also writes the workspace
 * document, so it conflicts with the workspace's deletion and never lands after it. A personal license is
 * one document and is written without a transaction, like an operator key; its audit event follows as a
 * separate write (`recordOrganizationEvent`), so personal licenses are not on the change feed.
 *
 * **The seat cap is a counter.** `seatsUsed` counts a workspace license's seats. Assigning one runs one
 * transaction: a conditional increment (`seatsUsed < quantity` and not ended), then the seat's insert.
 * Concurrent assignments write the same license document, so all but one meet a write conflict, which
 * `withTransaction` retries; a retry reads `seatsUsed` again. Only the increment matching nothing refuses
 * an assignment (`no_seats_available`), so a conflict is never a refusal. Releasing decrements it in the
 * same transaction as the seat's delete. A quantity lowered below `seatsUsed` frees no seat: the license
 * just takes no new one until enough are released. Every seat change also writes the workspace document,
 * as every membership change does, so an assignment conflicts with the end of its membership or the
 * demotion of whoever assigns it, and the retried one sees the other.
 *
 * **Seats end with their membership.** A seat belongs to one membership (`license_seats`): ending the
 * membership (`endMembership`: removal, leaving, account deletion) releases its seats inside that
 * transaction (`releaseSeatsForMembership`), and a rejoined member has a new membership and no seat.
 * Deleting a workspace ends its licenses and releases their seats inside the deletion's transaction
 * (`endLicensesForOwner`); deleting an account ends the person's own licenses before its `user.deleted`
 * tombstone.
 *
 * **Audit.** `license.written`, `license.ended`, `seat.assigned` and `seat.released` (with why: see
 * `SEAT_RELEASE_REASONS`), each with its actor. A workspace license's events are the workspace's
 * (`recordWorkspaceEvent`), so they are on the change feed; a personal license's are the organization's.
 */

import {
  capabilitiesForRole,
  type LicenseEndedReason,
  type LicenseFeature,
  type LicenseOwner,
  type LicenseSeatView,
  type LicenseView,
  type LicenseWrite,
  type LicenseWriteResponse,
  type SeatReleaseReason,
} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {withTransaction} from "../../connections/mongo.connection"
import {LicenseSeatModel, type LicenseSeatRow} from "../../models/license-seat.model"
import {LicenseModel, type LicenseRow} from "../../models/license.model"
import {UserModel} from "../../models/user.model"
import {WorkspaceMembershipModel, type WorkspaceMembershipEndedReason} from "../../models/workspace-membership.model"
import {WorkspaceModel} from "../../models/workspace.model"
import {isDeletedAccountId} from "../user.service"
import {recordOrganizationEvent, recordWorkspaceEvent, type WorkspaceAuditEventInput} from "../workspaces/audit.service"
import {fail} from "../workspaces/workspace-error"
import {
  actingRole,
  auditActor,
  isId,
  loadActiveWorkspace,
  touchWorkspace,
  type Actor,
  type MembershipRow,
} from "../workspaces/workspace.service"

/** Billing's license ids: ULIDs, in Crockford base32 as `ulid()` mints them. */
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/
/** An RFC 3339 instant in UTC; whether it exists on the calendar is checked separately. */
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$/
const MAX_TEXT_LENGTH = 200
const MAX_FEATURES = 50
const MAX_PACKAGES_PER_FEATURE = 50
const MAX_QUANTITY = 1_000_000

/** Acting for a license's end when no person or service asked for it. */
const SYSTEM_ACTOR: Actor = {kind: "system"}

type JsonObject = Record<string, unknown>
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isWholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)

// --- Parsing a write ---------------------------------------------------------

function invalid(message: string): never {
  fail("invalid_request", message)
}

/**
 * The license write in `body`, for the license the path names (`licenseId`), with only the write's own
 * fields. Anything malformed is `invalid_request` (400), saying what: a personal license with a quantity
 * other than 1 among them, since its owner holds its one seat.
 */
export function parseLicenseWrite(body: unknown, licenseId: string): LicenseWrite {
  if (!isRecord(body)) invalid("a license write must be a JSON object")
  if (!ULID.test(licenseId)) invalid("licenseId must be a ULID")
  if (body.licenseId !== licenseId) invalid("licenseId must be the license the path names")
  const {revision, quantity} = body
  if (!isWholeNumber(revision) || revision < 1) invalid("revision must be a whole number above zero")
  const owner = parseOwner(body.owner)
  const product = text(body.product, "product")
  const features = parseFeatures(body.features)
  if (!isWholeNumber(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
    invalid(`quantity must be a whole number from 0 to ${MAX_QUANTITY}`)
  }
  if (owner.type === "person" && quantity !== 1)
    invalid("a personal license's quantity is 1: its owner holds its one seat")
  return {
    licenseId,
    revision,
    owner,
    product,
    features,
    quantity,
    validFrom: instant(body.validFrom, "validFrom"),
    paidThrough: instant(body.paidThrough, "paidThrough"),
  }
}

function parseOwner(value: unknown): LicenseOwner {
  if (isRecord(value)) {
    if (value.type === "workspace" && isId(value.workspaceId))
      return {type: "workspace", workspaceId: value.workspaceId}
    if (value.type === "person" && isId(value.mentraUserId)) return {type: "person", mentraUserId: value.mentraUserId}
  }
  invalid('owner must be {"type": "workspace", "workspaceId"} or {"type": "person", "mentraUserId"}')
}

function parseFeatures(value: unknown): LicenseFeature[] {
  if (!Array.isArray(value) || value.length > MAX_FEATURES)
    invalid(`features must be a list of at most ${MAX_FEATURES}`)
  return value.map((feature, index) => {
    if (!isRecord(feature)) invalid(`features[${index}] must be {key, packages}`)
    const packages = feature.packages
    if (!Array.isArray(packages) || packages.length > MAX_PACKAGES_PER_FEATURE) {
      invalid(`features[${index}].packages must be a list of at most ${MAX_PACKAGES_PER_FEATURE} package names`)
    }
    return {
      key: text(feature.key, `features[${index}].key`),
      packages: packages.map((name, at) => text(name, `features[${index}].packages[${at}]`)),
    }
  })
}

/** A non-empty string without surrounding whitespace, of at most {@link MAX_TEXT_LENGTH} characters. */
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > MAX_TEXT_LENGTH) {
    invalid(`${field} must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`)
  }
  return value
}

/** An RFC 3339 instant in UTC (`Z`) that exists on the calendar, as given. */
function instant(value: unknown, field: string): string {
  const parts = typeof value === "string" ? RFC3339_UTC.exec(value) : null
  if (parts) {
    const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
    // `Date.UTC` rolls an impossible date or time over (February 30th, 24:00) into another one.
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day &&
      date.getUTCHours() === hour &&
      date.getUTCMinutes() === minute &&
      date.getUTCSeconds() === second
    ) {
      return value as string
    }
  }
  invalid(`${field} must be an RFC 3339 time in UTC, such as 2026-10-01T00:00:00Z`)
}

// --- License writes ----------------------------------------------------------

/**
 * Apply a license write from billing (`actor` is the service that sent it). Resolves with `applied:
 * true` and the new revision, or `applied: false` for a repeat of the revision Core has. Throws
 * `stale_revision` for an older revision (its details carry Core's), `owner_not_found` for an owner that
 * is deleted or never existed or a license that ended with its owner, and `invalid_request` for a write
 * that would change a license's owner.
 */
export async function applyLicenseWrite(write: LicenseWrite, actor: Actor): Promise<LicenseWriteResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return write.owner.type === "workspace"
        ? await applyWorkspaceLicenseWrite(write, write.owner.workspaceId, actor)
        : await applyPersonalLicenseWrite(write, write.owner.mentraUserId, actor)
    } catch (err) {
      // Two deliveries of a license's first write at once: the second insert meets the first's id. Its next
      // attempt finds the license and decides by revision like any other write.
      if (attempt === 0 && isDuplicateKeyError(err)) continue
      throw err
    }
  }
}

async function applyWorkspaceLicenseWrite(
  write: LicenseWrite,
  workspaceId: string,
  actor: Actor,
): Promise<LicenseWriteResponse> {
  return withTransaction(async (session) => {
    const existing = await LicenseModel.findById(write.licenseId).session(session).lean<LicenseRow>()
    const answer = decide(existing, write)
    if (answer) return answer
    const workspace = await WorkspaceModel.findOne({workspaceId}).session(session).lean()
    if (workspace?.status !== "active") fail("owner_not_found", "the workspace is deleted or does not exist")
    // Writing the workspace conflicts with its deletion, so a license never lands after the workspace is gone.
    await touchWorkspace(session, workspaceId)
    if (!(await saveLicense(session, existing, write)))
      throw new Error(`license ${write.licenseId} changed during its write`)
    await recordWorkspaceEvent(session, writtenEvent(existing, write, actor))
    return {applied: true, revision: write.revision}
  })
}

async function applyPersonalLicenseWrite(
  write: LicenseWrite,
  mentraUserId: string,
  actor: Actor,
): Promise<LicenseWriteResponse> {
  let existing: LicenseRow | null
  // Without a transaction, a write that lost a race with another write of the license decides again.
  for (;;) {
    existing = await LicenseModel.findById(write.licenseId).lean<LicenseRow>()
    const answer = decide(existing, write)
    if (answer) return answer
    if (!(await UserModel.exists({mentraUserId, supportTelemetryDeletedAt: null}))) {
      fail("owner_not_found", "the person's account is deleted or does not exist")
    }
    if (await saveLicense(null, existing, write)) break
  }
  const written = writtenEvent(existing, write, actor)
  // Account deletion marks the account before it ends the person's licenses (`account-deletion.service`).
  // A write that passed the check above just before the mark can land after the deletion ended them, so
  // look again: either this sees the mark and ends the license here, or the deletion ends it after this.
  if (await isDeletedAccountId(mentraUserId)) {
    const ended = await endLicenses(null, {_id: write.licenseId}, "account_deleted", SYSTEM_ACTOR)
    for (const event of [written, ...ended.organizationEvents]) await recordOrganizationEvent(event)
    fail("owner_not_found", "the person's account is deleted")
  }
  await recordOrganizationEvent(written)
  return {applied: true, revision: write.revision}
}

/** What a write does to the license Core has: null to apply it, or Core's answer when it applies nothing. */
function decide(existing: LicenseRow | null, write: LicenseWrite): LicenseWriteResponse | null {
  if (!existing) return null
  if (!sameOwner(ownerOf(existing.owner), write.owner)) invalid("a license's owner never changes")
  if (existing.endedAt) fail("owner_not_found", "the license ended with its owner")
  if (write.revision < existing.revision) {
    fail("stale_revision", `Core has revision ${existing.revision} of this license`, {revision: existing.revision})
  }
  if (write.revision === existing.revision) return {applied: false, revision: existing.revision}
  return null
}

/**
 * Insert the license, or update the one read as `existing` while it still has that revision. False when
 * it had changed (only possible outside a transaction).
 */
async function saveLicense(
  session: ClientSession | null,
  existing: LicenseRow | null,
  write: LicenseWrite,
): Promise<boolean> {
  const terms = {
    product: write.product,
    features: write.features,
    quantity: write.quantity,
    validFrom: new Date(write.validFrom),
    paidThrough: new Date(write.paidThrough),
    revision: write.revision,
  }
  if (!existing) {
    await LicenseModel.create(
      [{_id: write.licenseId, owner: write.owner, ...terms, seatsUsed: write.owner.type === "person" ? 1 : 0}],
      session ? {session} : {},
    )
    return true
  }
  const updated = await LicenseModel.updateOne(
    {_id: write.licenseId, revision: existing.revision, endedAt: null},
    {$set: terms},
    session ? {session} : {},
  )
  return updated.matchedCount === 1
}

function writtenEvent(existing: LicenseRow | null, write: LicenseWrite, actor: Actor): WorkspaceAuditEventInput {
  return {
    workspaceId: write.owner.type === "workspace" ? write.owner.workspaceId : null,
    action: "license.written",
    actor: auditActor(actor),
    target: {licenseId: write.licenseId, product: write.product, owner: write.owner},
    before: existing ? terms(licenseView(existing)) : null,
    after: terms(write),
  }
}

/** A license's terms as its audit events record them. */
function terms(license: Omit<LicenseWrite, "licenseId" | "owner">): Record<string, unknown> {
  return {
    revision: license.revision,
    product: license.product,
    features: license.features,
    quantity: license.quantity,
    validFrom: license.validFrom,
    paidThrough: license.paidThrough,
  }
}

// --- Reads -------------------------------------------------------------------

/** One owner's licenses, ended ones included, oldest first, each with its seats used but not who holds them. */
export async function listLicenses(owner: LicenseOwner): Promise<LicenseView[]> {
  const filter = ownerFilter(owner)
  if (!filter) return []
  const rows = await LicenseModel.find(filter).sort({_id: 1}).lean<LicenseRow[]>()
  return rows.map((row) => licenseView(row))
}

/**
 * A workspace's licenses with their seats, oldest first. `seatsOf: "everyone"` is every license and every
 * seat (`workspace.licenses.read`); a membership id is only the licenses that membership holds a seat in,
 * each with only that seat; null (no membership) is nothing.
 */
export async function listWorkspaceLicenses(
  workspaceId: string,
  seatsOf: "everyone" | string | null,
  session: ClientSession | null = null,
): Promise<LicenseView[]> {
  if (!isId(workspaceId) || seatsOf === null) return []
  const seats = await LicenseSeatModel.find(
    seatsOf === "everyone" ? {workspaceId} : {workspaceId, membershipId: seatsOf},
  )
    .sort({assignedAt: 1, membershipId: 1})
    .session(session)
    .lean<LicenseSeatRow[]>()
  const licenseFilter =
    seatsOf === "everyone"
      ? ownerFilter({type: "workspace", workspaceId})!
      : {_id: {$in: seats.map((seat) => seat.licenseId)}}
  const licenses = await LicenseModel.find(licenseFilter).sort({_id: 1}).session(session).lean<LicenseRow[]>()
  return licenses
    .filter((license) => license.owner.type === "workspace" && license.owner.workspaceId === workspaceId)
    .map((license) =>
      licenseView(
        license,
        seats.filter((seat) => seat.licenseId === license._id),
      ),
    )
}

function ownerFilter(owner: LicenseOwner): Record<string, string> | null {
  if (owner.type === "workspace") {
    return isId(owner.workspaceId) ? {"owner.type": "workspace", "owner.workspaceId": owner.workspaceId} : null
  }
  return isId(owner.mentraUserId) ? {"owner.type": "person", "owner.mentraUserId": owner.mentraUserId} : null
}

function ownerOf(owner: LicenseRow["owner"]): LicenseOwner {
  return owner.type === "workspace"
    ? {type: "workspace", workspaceId: owner.workspaceId ?? ""}
    : {type: "person", mentraUserId: owner.mentraUserId ?? ""}
}

function sameOwner(a: LicenseOwner, b: LicenseOwner): boolean {
  if (a.type === "workspace") return b.type === "workspace" && a.workspaceId === b.workspaceId
  return b.type === "person" && a.mentraUserId === b.mentraUserId
}

function licenseView(row: LicenseRow, seats?: LicenseSeatRow[]): LicenseView {
  return {
    licenseId: row._id,
    revision: row.revision,
    owner: ownerOf(row.owner),
    product: row.product,
    features: row.features.map((feature) => ({key: feature.key, packages: [...feature.packages]})),
    quantity: row.quantity,
    validFrom: row.validFrom.toISOString(),
    paidThrough: row.paidThrough.toISOString(),
    seatsUsed: row.seatsUsed,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    ...(seats ? {seats: seats.map(seatView)} : {}),
  }
}

function seatView(seat: LicenseSeatRow): LicenseSeatView {
  return {membershipId: seat.membershipId, mentraUserId: seat.mentraUserId, assignedAt: seat.assignedAt.toISOString()}
}

// --- Seats -------------------------------------------------------------------

/**
 * Give `membershipId` a seat of the workspace's license `licenseId`, and resolve with the license, every
 * seat included. A member holds at most one seat per license: assigning one they hold changes nothing.
 * Refused: without `workspace.licenses.assign` (`forbidden`); a license that is not this workspace's
 * (`license_not_found`) or has ended (`license_ended`); a membership that is not an active one of this
 * workspace (`not_found`) or still waits for its person (`invalid_request`); and no free seat
 * (`no_seats_available`), which is the only way concurrent assignments refuse each other.
 */
export async function assignSeat(
  actor: Actor,
  workspaceId: string,
  licenseId: string,
  membershipId: string,
): Promise<LicenseView> {
  return withTransaction(async (session) => {
    await loadActiveWorkspace(session, workspaceId)
    await requireSeatManager(session, actor, workspaceId)
    await loadWorkspaceLicense(session, workspaceId, licenseId)
    const membership = isId(membershipId)
      ? await WorkspaceMembershipModel.findOne({membershipId, workspaceId, status: "active"})
          .session(session)
          .lean<MembershipRow>()
      : null
    if (!membership) fail("not_found", "membership not found")
    if (!isId(membership.mentraUserId)) {
      invalid("this membership waits for its person's first sign-in and cannot hold a seat yet")
    }
    if (!(await LicenseSeatModel.exists({licenseId, membershipId}).session(session))) {
      await touchWorkspace(session, workspaceId)
      const taken = await LicenseModel.findOneAndUpdate(
        {_id: licenseId, endedAt: null, $expr: {$lt: ["$seatsUsed", "$quantity"]}},
        {$inc: {seatsUsed: 1}},
        {new: true, session},
      ).lean<LicenseRow>()
      if (!taken) fail("no_seats_available", "every seat of this license is assigned")
      const assignedAt = new Date()
      await LicenseSeatModel.create(
        [
          {
            licenseId,
            workspaceId,
            membershipId,
            mentraUserId: membership.mentraUserId,
            assignedAt,
            assignedBy: actor.kind === "user" ? actor.mentraUserId : null,
          },
        ],
        {session},
      )
      await recordWorkspaceEvent(session, {
        workspaceId,
        action: "seat.assigned",
        actor: auditActor(actor),
        target: seatTarget({licenseId, membershipId, mentraUserId: membership.mentraUserId}, membership.email ?? null),
        before: null,
        after: {assignedAt: assignedAt.toISOString(), seatsUsed: taken.seatsUsed, quantity: taken.quantity},
      })
    }
    return (await listWorkspaceLicenses(workspaceId, "everyone", session)).find((view) => view.licenseId === licenseId)!
  })
}

/**
 * Take the seat of `licenseId` that `membershipId` holds (`unassigned`). Resolves whether there was one:
 * releasing a seat nobody holds changes nothing. Refused as `assignSeat` is, without the membership checks.
 */
export async function releaseSeat(
  actor: Actor,
  workspaceId: string,
  licenseId: string,
  membershipId: string,
): Promise<{released: boolean}> {
  return withTransaction(async (session) => {
    await loadActiveWorkspace(session, workspaceId)
    await requireSeatManager(session, actor, workspaceId)
    await loadWorkspaceLicense(session, workspaceId, licenseId, {ended: "allowed"})
    const seat = isId(membershipId)
      ? await LicenseSeatModel.findOne({licenseId, membershipId}).session(session).lean<LicenseSeatRow>()
      : null
    if (!seat) return {released: false}
    await touchWorkspace(session, workspaceId)
    await releaseSeats(session, [seat], "unassigned", actor)
    return {released: true}
  })
}

/**
 * Release every seat `membership` holds, inside the transaction that ends it (`endMembership`), and
 * resolve with the licenses they were in. `reason` is why (`seatReleaseReasonFor`).
 */
export async function releaseSeatsForMembership(
  session: ClientSession,
  membership: Pick<MembershipRow, "membershipId" | "workspaceId" | "email">,
  reason: SeatReleaseReason,
  actor: Actor,
): Promise<string[]> {
  const seats = await LicenseSeatModel.find({
    workspaceId: membership.workspaceId,
    membershipId: membership.membershipId,
  })
    .session(session)
    .lean<LicenseSeatRow[]>()
  if (seats.length === 0) return []
  await releaseSeats(session, seats, reason, actor, new Map([[membership.membershipId, membership.email ?? null]]))
  return seats.map((seat) => seat.licenseId)
}

/** Why a membership's seats are released when it ends. */
export function seatReleaseReasonFor(
  endedReason: Exclude<WorkspaceMembershipEndedReason, "workspace_deleted">,
): SeatReleaseReason {
  switch (endedReason) {
    case "removed":
      return "member_removed"
    case "left":
      return "member_left"
    case "account_deleted":
      return "account_deleted"
  }
}

/** The workspace's license `licenseId`, or `license_not_found`; an ended one is `license_ended` unless allowed. */
async function loadWorkspaceLicense(
  session: ClientSession,
  workspaceId: string,
  licenseId: string,
  options: {ended?: "allowed"} = {},
): Promise<LicenseRow> {
  const license = isId(licenseId) ? await LicenseModel.findById(licenseId).session(session).lean<LicenseRow>() : null
  if (license?.owner.type !== "workspace" || license.owner.workspaceId !== workspaceId) {
    fail("license_not_found", "license not found")
  }
  if (license.endedAt && options.ended !== "allowed") fail("license_ended", "this license has ended")
  return license
}

/** Seat changes need `workspace.licenses.assign` (Admins and Owners, and Organization Admins), whoever is asking. */
async function requireSeatManager(session: ClientSession, actor: Actor, workspaceId: string): Promise<void> {
  const role = await actingRole(session, actor, workspaceId)
  if (!role || !capabilitiesForRole(role).has("workspace.licenses.assign")) {
    fail("forbidden", "assigning seats requires the admin role")
  }
}

/**
 * Delete `seats`, give each back to its license's count and record `seat.released` for each, in the
 * caller's transaction. `emails` are the members' display addresses, when the caller has them.
 */
async function releaseSeats(
  session: ClientSession,
  seats: LicenseSeatRow[],
  reason: SeatReleaseReason,
  actor: Actor,
  emails?: Map<string, string | null>,
): Promise<void> {
  const known =
    emails ??
    new Map(
      (
        await WorkspaceMembershipModel.find({membershipId: {$in: seats.map((seat) => seat.membershipId)}})
          .select({_id: 0, membershipId: 1, email: 1})
          .session(session)
          .lean<Array<{membershipId: string; email?: string | null}>>()
      ).map((row) => [row.membershipId, row.email ?? null]),
    )
  for (const seat of seats) {
    await LicenseSeatModel.deleteOne({licenseId: seat.licenseId, membershipId: seat.membershipId}, {session})
    await LicenseModel.updateOne({_id: seat.licenseId, seatsUsed: {$gt: 0}}, {$inc: {seatsUsed: -1}}, {session})
  }
  for (const seat of seats) {
    await recordWorkspaceEvent(session, {
      workspaceId: seat.workspaceId,
      action: "seat.released",
      actor: auditActor(actor),
      target: seatTarget(seat, known.get(seat.membershipId) ?? null),
      before: {assignedAt: seat.assignedAt.toISOString()},
      after: {reason},
    })
  }
}

/** A seat event's target: the license and the member, by membership, Core user and display address. */
function seatTarget(
  seat: Pick<LicenseSeatRow, "licenseId" | "membershipId" | "mentraUserId">,
  email: string | null,
): Record<string, unknown> {
  return {licenseId: seat.licenseId, membershipId: seat.membershipId, mentraUserId: seat.mentraUserId, email}
}

// --- Ending ------------------------------------------------------------------

/**
 * End every license `owner` holds that has not ended, because the owner is being deleted (`reason`),
 * inside the deletion's transaction: release their seats (`seat.released`, reason `workspace_deleted` for
 * a deleted workspace's, `license_ended` otherwise) and set `endedAt`. A workspace's `license.ended`
 * events are recorded in the transaction. A person's are returned for the caller to record with
 * `recordOrganizationEvent` once it commits, as the organization's events are.
 */
export async function endLicensesForOwner(
  session: ClientSession,
  owner: LicenseOwner,
  reason: LicenseEndedReason,
  actor: Actor,
): Promise<{endedLicenseIds: string[]; organizationEvents: WorkspaceAuditEventInput[]}> {
  const filter = ownerFilter(owner)
  if (!filter) return {endedLicenseIds: [], organizationEvents: []}
  return endLicenses(session, filter, reason, actor)
}

async function endLicenses(
  session: ClientSession | null,
  filter: Record<string, unknown>,
  reason: LicenseEndedReason,
  actor: Actor,
): Promise<{endedLicenseIds: string[]; organizationEvents: WorkspaceAuditEventInput[]}> {
  const licenses = await LicenseModel.find({...filter, endedAt: null})
    .sort({_id: 1})
    .session(session)
    .lean<LicenseRow[]>()
  const seatReason: SeatReleaseReason = reason === "workspace_deleted" ? "workspace_deleted" : "license_ended"
  const endedLicenseIds: string[] = []
  const organizationEvents: WorkspaceAuditEventInput[] = []
  for (const license of licenses) {
    // A personal license has no seat documents: the only seats are a workspace license's, ended in a transaction.
    const seats = session
      ? await LicenseSeatModel.find({licenseId: license._id}).session(session).lean<LicenseSeatRow[]>()
      : []
    if (session && seats.length > 0) await releaseSeats(session, seats, seatReason, actor)
    const endedAt = new Date()
    const ended = await LicenseModel.updateOne(
      {_id: license._id, endedAt: null},
      {$set: {endedAt, endedReason: reason, seatsUsed: 0}},
      session ? {session} : {},
    )
    if (ended.modifiedCount !== 1) continue
    endedLicenseIds.push(license._id)
    const owner = ownerOf(license.owner)
    const event: WorkspaceAuditEventInput = {
      workspaceId: owner.type === "workspace" ? owner.workspaceId : null,
      action: "license.ended",
      actor: auditActor(actor),
      target: {licenseId: license._id, product: license.product, owner},
      before: {endedAt: null},
      after: {endedAt: endedAt.toISOString(), reason, releasedSeats: seats.length},
    }
    if (owner.type === "workspace" && session) await recordWorkspaceEvent(session, event)
    else organizationEvents.push(event)
  }
  return {endedLicenseIds, organizationEvents}
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as {code?: unknown}).code === 11000
}
