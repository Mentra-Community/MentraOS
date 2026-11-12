/**
 * @fileoverview Licenses and their seats.
 *
 * A license is Core's copy of what billing (the Store's billing module) last wrote for it
 * (`applyLicenseWrite`): a quantity of one product for a term, held by a workspace, and only by a workspace
 * (a write naming any other owner is refused). Core never changes a license's terms itself; it records who
 * holds each of its seats, and ends a license when its workspace is deleted. A person has a license only
 * through a seat.
 *
 * **Writes are revisioned.** A write applies only when its revision is newer than the one Core has; an
 * equal one is a repeat and changes nothing, an older one is refused (`stale_revision`), and one for a
 * workspace that is deleted or never existed is refused (`owner_not_found`), as is any write for a license
 * that ended with its workspace. A license is written in a transaction that also writes the workspace
 * document, so it conflicts with the workspace's deletion and never lands after it.
 *
 * **The seat cap is a counter.** `seatsUsed` counts a license's seats. Assigning one runs one
 * transaction: a conditional increment (`seatsUsed + 1 <= quantity` and not ended), then the seat's
 * insert and its audit event. Concurrent assignments write the same license document, so all but one
 * meet a write conflict, which `withTransaction` retries; a retry reads `seatsUsed` again. Only the
 * increment matching nothing refuses an assignment (`no_seats_available`), so a conflict is never a
 * refusal. Releasing decrements it in the same transaction as the seat's delete. A quantity lowered below
 * `seatsUsed` frees no seat: the license just takes no new one until enough are released.
 *
 * **What serializes seat changes** is two writes, neither of which depends on timing. The increment
 * writes the license document, so it conflicts with every concurrent write of that license: another
 * assignment or release, a write from billing that changes its quantity, or its end. And a seat change
 * that succeeds records audit events, which take the one feed counter (`audit.service`), so it conflicts
 * with every other change recorded on the change feed, the end of the seat's membership and the demotion
 * of whoever assigns it among them. `withTransaction` retries whichever loses, and the retry sees the other. A seat
 * change also writes the workspace document (`touchWorkspace`), as every membership change does, and that
 * usually conflicts too. But it sets only `updatedAt`, and a write of the value the document already
 * holds changes nothing and conflicts with nothing, so nothing relies on it. A refusal records no event,
 * so it stands on its transaction's snapshot: when that touch happened to be such a no-op, a refusal can
 * miss a seat a concurrent release freed a moment before, and asking again assigns it.
 *
 * **Several seats at once** (`assignSeats`) are one transaction too, with every check of a single
 * assignment applied to each pair. Each license takes all of its new seats in one conditional increment
 * (`seatsUsed + n <= quantity`); if any license's matches nothing, the whole transaction is aborted and
 * the refusal lists every license that falls short, so a refused request assigns nothing. Its events are
 * recorded together (`recordWorkspaceEvents`) as the transaction's last two writes, after the answer is
 * read, as a single assignment's event is: the feed counter, held from its increment until the commit,
 * is held across one insert of every event and nothing else, however many seats there are.
 *
 * **Seats end with their membership.** A seat belongs to one membership (`license_seats`): ending the
 * membership (`endMembership`: removal, leaving, account deletion) releases its seats inside that
 * transaction (`releaseSeatsForMembership`), and a rejoined member has a new membership and no seat.
 * Deleting a workspace ends its licenses and releases their seats inside the deletion's transaction
 * (`endLicensesForOwner`). Deleting an account ends no license: the person's seats go with their memberships.
 * A write that carries `endedReason: "lapsed"` (billing: the subscription is cancelled and its term has run
 * out) ends its license in the write's own transaction: its seats are released (`license_ended`), `endedAt` is
 * set once, `license.ended` is recorded, and it gives its buyer and any request no seat. A repeat of that revision
 * changes nothing, and a newer write without it makes the license stand again.
 *
 * **The buyer's seat.** A write of a license may name the purchase's buyer (`assignTo`). Only
 * the write that creates the license honors it, inside its transaction (`assignBuyer`): one seat, through
 * the same conditional increment and insert as an assignment, for a buyer who is an active member and
 * holds no seat of an in-term license of the same product in the workspace. Repeats and later revisions
 * never assign, and two deliveries of the first write at once create one license, so it is given once.
 *
 * **A requested seat.** A write may also carry a person's request for one more seat for themselves
 * (`seatRequest`), which billing names from the write whose quantity reaches the request's until Core accepts
 * one. Core decides each request once, on the first applied write that carries an id the license hasn't
 * recorded (`seatRequests`): that write's own update records the id, whatever is decided, so a repeat, a
 * later revision still carrying it, and a delivery racing it (whose update conflicts with this one's, and
 * whose retry finds the newer revision or the id) never decide it again. It gives one seat (`assignRequested`)
 * only when that write raises the quantity to the request's (the quantity Core had, 0 for a new license, is
 * below it, and the write's is at least it), with the buyer's checks (`canGiveSeat`): an active member, who
 * holds no seat of this license and none of an in-term license of the product there, and a free seat through
 * the same conditional increment. Its `seat.assigned` follows `license.written` and the buyer's.
 *
 * **Audit.** `license.written`, `license.ended`, `seat.assigned` and `seat.released` (with why: see
 * `SEAT_RELEASE_REASONS`), each with its actor. They are the workspace's (`recordWorkspaceEvent`, and
 * `recordWorkspaceEvents` for a batch of seats), so they are on the change feed.
 */

import {
  capabilitiesForRole,
  LICENSE_WRITE_ENDED_REASONS,
  MAX_SEAT_ASSIGNMENTS,
  type LicenseEndedReason,
  type LicenseFeature,
  type LicenseOwner,
  type LicenseSeatView,
  type LicenseView,
  type LicenseWrite,
  type LicenseWriteResponse,
  type SeatAssignmentsRequest,
  type SeatReleaseReason,
  type SeatShortfall,
} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {withTransaction} from "../../connections/mongo.connection"
import {LicenseSeatModel, type LicenseSeatRow} from "../../models/license-seat.model"
import {LicenseModel, type LicenseRow} from "../../models/license.model"
import {WorkspaceMembershipModel, type WorkspaceMembershipEndedReason} from "../../models/workspace-membership.model"
import {WorkspaceModel} from "../../models/workspace.model"
import {
  recordWorkspaceEvent,
  recordWorkspaceEvents,
  type WorkspaceAuditEventInput,
} from "../workspaces/audit.service"
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
/** How many decided seat request ids a license keeps: a request is carried only until Core accepts it. */
const MAX_SEAT_REQUESTS = 20

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
 * fields. Anything malformed is `invalid_request` (400), saying what: an owner that is not a workspace among
 * them, and a term whose `paidThrough` is before its `validFrom`. `assignTo` is absent or `{mentraUserId}`,
 * `seatRequest` absent or `{requestId, mentraUserId, quantity}`, and `endedReason` absent or `lapsed`.
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
  const validFrom = instant(body.validFrom, "validFrom")
  const paidThrough = instant(body.paidThrough, "paidThrough")
  // A term of no length is a subscription cancelled as it started; one that ends before it starts is a bug.
  if (Date.parse(paidThrough) < Date.parse(validFrom)) invalid("paidThrough must not be before validFrom")
  const write: LicenseWrite = {licenseId, revision, owner, product, features, quantity, validFrom, paidThrough}
  if (body.assignTo !== undefined) {
    if (!isRecord(body.assignTo) || !isId(body.assignTo.mentraUserId)) {
      invalid('assignTo must be {"mentraUserId"}, a non-blank Core user ID')
    }
    write.assignTo = {mentraUserId: body.assignTo.mentraUserId}
  }
  if (body.seatRequest !== undefined) write.seatRequest = parseSeatRequest(body.seatRequest)
  if (body.endedReason !== undefined) {
    const reason = LICENSE_WRITE_ENDED_REASONS.find(known => known === body.endedReason)
    if (!reason) invalid(`endedReason must be one of: ${LICENSE_WRITE_ENDED_REASONS.join(", ")}`)
    write.endedReason = reason
  }
  return write
}

/**
 * A seat request: a non-blank `requestId` of at most {@link MAX_TEXT_LENGTH} characters, a non-blank
 * `mentraUserId`, and a whole `quantity` from 1 to {@link MAX_QUANTITY}, keeping only those.
 */
function parseSeatRequest(value: unknown): NonNullable<LicenseWrite["seatRequest"]> {
  if (!isRecord(value)) invalid('seatRequest must be {"requestId", "mentraUserId", "quantity"}')
  const {requestId, mentraUserId, quantity} = value
  if (!isId(requestId) || requestId.length > MAX_TEXT_LENGTH) {
    invalid(`seatRequest.requestId must be a non-blank id of at most ${MAX_TEXT_LENGTH} characters`)
  }
  if (!isId(mentraUserId)) invalid("seatRequest.mentraUserId must be a non-blank Core user ID")
  if (!isWholeNumber(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    invalid(`seatRequest.quantity must be a whole number from 1 to ${MAX_QUANTITY}`)
  }
  return {requestId, mentraUserId, quantity}
}

/** A license's owner: a workspace, by a non-blank id. Any other owner, a person included, is refused. */
function parseOwner(value: unknown): LicenseOwner {
  if (isRecord(value) && value.type === "workspace" && isId(value.workspaceId)) {
    return {type: "workspace", workspaceId: value.workspaceId}
  }
  invalid('owner must be {"type": "workspace", "workspaceId"}')
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
 * `stale_revision` for an older revision (its details carry Core's), `owner_not_found` for a workspace that
 * is deleted or never existed or a license that ended with its workspace, and `invalid_request` for a write
 * that would change a license's owner.
 */
export async function applyLicenseWrite(write: LicenseWrite, actor: Actor): Promise<LicenseWriteResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await applyWorkspaceLicenseWrite(write, write.owner.workspaceId, actor)
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
    if (workspace.retiredLicenseIds?.includes(write.licenseId)) fail("owner_not_found", "the license was retired by an administrative reset")
    // Writing the workspace conflicts with its deletion, so a license never lands after the workspace is gone.
    await touchWorkspace(session, workspaceId)
    // A write that carries the ending frees the seats the license has, before it is saved ended.
    const freed = write.endedReason && !existing?.endedAt ? await freeSeatsOfLapsed(session, write, actor) : 0
    if (!(await saveLicense(session, existing, write)))
      throw new Error(`license ${write.licenseId} changed during its write`)
    // An ended license gives no seat: not to its buyer, and not to a person's request.
    const ending = write.endedReason !== undefined
    // Only the write that creates the license gives its buyer one: a repeat was answered above, and a later
    // revision finds the license.
    const buyer = existing || ending ? [] : await assignBuyer(session, write, workspaceId, actor)
    // A seat request is decided against the license as it was before this write (`existing`), as
    // `saveLicense` recorded it.
    const requested = ending ? [] : await assignRequested(session, existing, write, workspaceId, actor)
    // `license.written` first, then the buyer's `seat.assigned` and the request's, as the transaction's last writes.
    await recordWorkspaceEvents(session, [
      writtenEvent(existing, write, actor),
      ...(ending && !existing?.endedAt ? [lapsedEvent(write, actor, freed)] : []),
      ...buyer,
      ...requested,
    ])
    return {applied: true, revision: write.revision, ...(ending ? {ended: true as const} : {})}
  })
}

/**
 * Release every seat of the license `write` ends (`seat.released`, reason `license_ended`), in the write's
 * transaction, and answer how many there were.
 */
async function freeSeatsOfLapsed(session: ClientSession, write: LicenseWrite, actor: Actor): Promise<number> {
  const seats = await LicenseSeatModel.find({licenseId: write.licenseId}).session(session).lean<LicenseSeatRow[]>()
  if (seats.length > 0) await releaseSeats(session, seats, "license_ended", actor)
  return seats.length
}

/** `license.ended`: billing wrote that the license's subscription ended and its term ran out. */
function lapsedEvent(write: LicenseWrite, actor: Actor, releasedSeats: number): WorkspaceAuditEventInput {
  return {
    workspaceId: write.owner.workspaceId,
    action: "license.ended",
    actor: auditActor(actor),
    target: {licenseId: write.licenseId, product: write.product, owner: write.owner},
    before: {endedAt: null},
    after: {endedAt: new Date().toISOString(), reason: write.endedReason, releasedSeats},
  }
}

/**
 * Give the buyer billing names (`write.assignTo`) one seat of the license `write` has just created, in
 * that write's transaction, and return its `seat.assigned` event for the caller to record after
 * `license.written`. It gives none (an empty list) unless the license has a seat to give and the buyer may
 * have one ({@link canGiveSeat}). Its checks are serialized as an assignment's are: the events the write
 * records take the feed counter, so a concurrent end of the membership or assignment of another seat
 * conflicts with it, and the retry sees that change.
 */
async function assignBuyer(
  session: ClientSession,
  write: LicenseWrite,
  workspaceId: string,
  actor: Actor,
): Promise<WorkspaceAuditEventInput[]> {
  const mentraUserId = write.assignTo?.mentraUserId
  if (!mentraUserId || write.quantity < 1) return []
  const holder = await canGiveSeat(session, write, workspaceId, mentraUserId)
  if (!holder) return []
  const license = await takeSeats(session, write.licenseId, 1)
  if (!license) return []
  return insertSeats(session, actor, workspaceId, license, [holder])
}

/**
 * Decide the seat request `write` carries, in that write's transaction, against the license as it was
 * before the write (`existing`, null for a new one), and return the `seat.assigned` event of the seat it
 * gave, if any, for the caller to record after `license.written`. A request whose id the license has
 * recorded was decided by an earlier write and gives nothing; `saveLicense` records a new one. It gives its
 * person one seat only when the write raises the quantity to the request's (the quantity Core had, 0 for a
 * new license, is below `seatRequest.quantity`, and the write's is at least that), the person may have one
 * ({@link canGiveSeat}), and a seat is free. Serialized as {@link assignBuyer} is.
 */
async function assignRequested(
  session: ClientSession,
  existing: LicenseRow | null,
  write: LicenseWrite,
  workspaceId: string,
  actor: Actor,
): Promise<WorkspaceAuditEventInput[]> {
  const request = undecidedRequest(existing, write)
  if (!request) return []
  const had = existing?.quantity ?? 0
  if (had >= request.quantity || write.quantity < request.quantity) return []
  const holder = await canGiveSeat(session, write, workspaceId, request.mentraUserId)
  if (!holder) return []
  const license = await takeSeats(session, write.licenseId, 1)
  if (!license) return []
  return insertSeats(session, actor, workspaceId, license, [holder])
}

/**
 * The membership of `mentraUserId` that may be given a seat of the license `write` names, or null: an active
 * membership of the workspace that holds no seat of this license, and none of an in-term (`validFrom` <= now
 * < `paidThrough`), not-ended license of the same product there.
 */
async function canGiveSeat(
  session: ClientSession,
  write: LicenseWrite,
  workspaceId: string,
  mentraUserId: string,
): Promise<SeatHolder | null> {
  const membership = await WorkspaceMembershipModel.findOne({workspaceId, mentraUserId, status: "active"})
    .session(session)
    .lean<MembershipRow>()
  if (!membership) return null
  const held = await LicenseSeatModel.find({workspaceId, membershipId: membership.membershipId})
    .select({_id: 0, licenseId: 1})
    .session(session)
    .lean<Array<Pick<LicenseSeatRow, "licenseId">>>()
  // A seat of this license, in its term or not: a member holds at most one per license.
  if (held.some((seat) => seat.licenseId === write.licenseId)) return null
  if (held.length > 0) {
    const now = new Date()
    const hasProduct = await LicenseModel.exists({
      _id: {$in: held.map((seat) => seat.licenseId)},
      product: write.product,
      endedAt: null,
      validFrom: {$lte: now},
      paidThrough: {$gt: now},
    }).session(session)
    if (hasProduct) return null
  }
  return {membershipId: membership.membershipId, mentraUserId, email: membership.email ?? null}
}

/** The seat request `write` carries when the license (`existing`, as before the write) hasn't decided it, or null. */
function undecidedRequest(
  existing: LicenseRow | null,
  write: LicenseWrite,
): NonNullable<LicenseWrite["seatRequest"]> | null {
  const request = write.seatRequest
  if (!request) return null
  return existing?.seatRequests?.includes(request.requestId) ? null : request
}

/** What a write does to the license Core has: null to apply it, or Core's answer when it applies nothing. */
function decide(existing: LicenseRow | null, write: LicenseWrite): LicenseWriteResponse | null {
  refuseUnwritable(existing, write)
  return byRevision(existing, write)
}

/**
 * Refuse a write that would change the license's owner (400), or one for a license that ended with its workspace
 * (404). A license that lapsed is writable: by revision, as any other.
 */
function refuseUnwritable(existing: LicenseRow | null, write: LicenseWrite): void {
  if (!existing) return
  if (!sameOwner(ownerOf(existing.owner), write.owner)) invalid("a license's owner never changes")
  // A lapsed license is billing's to write on: it is decided by revision like any other, and a newer write
  // without the ending makes it stand again. One that ended with its workspace takes no write.
  if (existing.endedAt && existing.endedReason !== "lapsed") fail("owner_not_found", "the license ended with its workspace")
}

/**
 * By revision: null for a newer write (apply it), a no-op answer for a repeat, `stale_revision` for an older one.
 * A repeat that carries the ending for a license that has not ended is applied, though: a Core that predated the
 * ending stored the revision and dropped the field, and billing sends it again until it is answered `ended: true`.
 */
function byRevision(existing: LicenseRow | null, write: LicenseWrite): LicenseWriteResponse | null {
  if (!existing) return null
  if (write.revision < existing.revision) {
    fail("stale_revision", `Core has revision ${existing.revision} of this license`, {revision: existing.revision})
  }
  if (write.revision === existing.revision) {
    if (write.endedReason && !existing.endedAt) return null
    return {applied: false, revision: existing.revision, ...(write.endedReason && existing.endedAt ? {ended: true as const} : {})}
  }
  return null
}

/**
 * Insert the license, with no seat assigned, or update the one read as `existing` while it still has that
 * revision, recording the id of a seat request the write carries that the license hasn't decided
 * (`seatRequests`, the latest {@link MAX_SEAT_REQUESTS}). False when it had changed, which the transaction's
 * snapshot rules out.
 */
async function saveLicense(session: ClientSession, existing: LicenseRow | null, write: LicenseWrite): Promise<boolean> {
  const terms = {
    product: write.product,
    features: write.features,
    quantity: write.quantity,
    validFrom: new Date(write.validFrom),
    paidThrough: new Date(write.paidThrough),
    revision: write.revision,
  }
  const request = write.endedReason ? null : undecidedRequest(existing, write)
  // The ending a write carries (kept at the time it first ended); a write without it makes a lapsed license stand.
  const ending = write.endedReason
    ? {endedAt: existing?.endedAt ?? new Date(), endedReason: write.endedReason, ...(existing?.endedAt ? {} : {seatsUsed: 0})}
    : {endedAt: null, endedReason: null}
  if (!existing) {
    const requests = request ? {seatRequests: [request.requestId]} : {}
    await LicenseModel.create([{_id: write.licenseId, owner: write.owner, ...terms, seatsUsed: 0, ...ending, ...requests}], {
      session,
    })
    return true
  }
  const updated = await LicenseModel.updateOne(
    {_id: write.licenseId, revision: existing.revision, endedAt: existing.endedAt ?? null},
    {
      $set: {...terms, ...ending},
      ...(request ? {$push: {seatRequests: {$each: [request.requestId], $slice: -MAX_SEAT_REQUESTS}}} : {}),
    },
    {session},
  )
  return updated.matchedCount === 1
}

function writtenEvent(existing: LicenseRow | null, write: LicenseWrite, actor: Actor): WorkspaceAuditEventInput {
  return {
    workspaceId: write.owner.workspaceId,
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

/** One workspace's licenses, ended ones included, oldest first, each with its seats used but not who holds them. */
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
  // Sorted in process, not by the query: Cosmos DB's MongoDB API rejects a sort on a path with no index
  // (see `startup.migrations.ts`), and a workspace's seats are few enough to order here.
  const seats = (
    await LicenseSeatModel.find(seatsOf === "everyone" ? {workspaceId} : {workspaceId, membershipId: seatsOf})
      .session(session)
      .lean<LicenseSeatRow[]>()
  ).sort(bySeatAssignment)
  const licenseFilter =
    seatsOf === "everyone"
      ? ownerFilter({type: "workspace", workspaceId})!
      : {_id: {$in: seats.map((seat) => seat.licenseId)}}
  const licenses = await LicenseModel.find(licenseFilter).sort({_id: 1}).session(session).lean<LicenseRow[]>()
  return licenses
    .filter((license) => license.owner.workspaceId === workspaceId)
    .map((license) =>
      licenseView(
        license,
        seats.filter((seat) => seat.licenseId === license._id),
      ),
    )
}

/** Seats in the order they were assigned, then by membership: the order a workspace's licenses list them in. */
function bySeatAssignment(left: LicenseSeatRow, right: LicenseSeatRow): number {
  const assignedDelta = left.assignedAt.getTime() - right.assignedAt.getTime()
  if (assignedDelta !== 0) return assignedDelta
  return left.membershipId < right.membershipId ? -1 : left.membershipId > right.membershipId ? 1 : 0
}

/** The licenses `owner` holds, by the owner index; null for a blank id, which holds none. */
function ownerFilter(owner: LicenseOwner): Record<string, string> | null {
  return isId(owner.workspaceId) ? {"owner.type": "workspace", "owner.workspaceId": owner.workspaceId} : null
}

function ownerOf(owner: LicenseRow["owner"]): LicenseOwner {
  return {type: "workspace", workspaceId: owner.workspaceId ?? ""}
}

function sameOwner(a: LicenseOwner, b: LicenseOwner): boolean {
  return a.type === b.type && a.workspaceId === b.workspaceId
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

/** One seat to give: a license of the workspace, and the membership that gets it. */
export type SeatAssignment = SeatAssignmentsRequest["assignments"][number]

/** A membership that can hold a seat: an active one of the workspace, whose person has signed in. */
interface SeatHolder {
  membershipId: string
  mentraUserId: string
  email: string | null
}

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
    const [holder] = await loadSeatHolders(session, workspaceId, [membershipId])
    let events: WorkspaceAuditEventInput[] = []
    if (!(await LicenseSeatModel.exists({licenseId, membershipId}).session(session))) {
      await touchWorkspace(session, workspaceId)
      const taken = await takeSeats(session, licenseId, 1)
      if (!taken) fail("no_seats_available", "every license is assigned")
      events = await insertSeats(session, actor, workspaceId, taken, [holder!])
    }
    // The answer is read first, so the event's writes are the transaction's last: the feed counter is held
    // only from its increment to the commit.
    const answer = (await listWorkspaceLicenses(workspaceId, "everyone", session)).find(
      (view) => view.licenseId === licenseId,
    )!
    await recordWorkspaceEvents(session, events)
    return answer
  })
}

/**
 * The pairs of a bulk assignment's body (`SeatAssignmentsRequest`), in order, each with only its
 * `licenseId` and `membershipId`: 1 to {@link MAX_SEAT_ASSIGNMENTS} of them, each id a non-blank string.
 * Anything else is `invalid_request` (400), saying what. A repeated pair is not malformed: `assignSeats`
 * counts it once.
 */
export function parseSeatAssignments(body: unknown): SeatAssignment[] {
  if (!isRecord(body) || !Array.isArray(body.assignments)) {
    invalid("assignments must be a list of {licenseId, membershipId}")
  }
  const assignments: unknown[] = body.assignments
  requireAssignmentCount(assignments.length)
  return assignments.map((assignment, index) => {
    if (!isRecord(assignment) || !isId(assignment.licenseId) || !isId(assignment.membershipId)) {
      invalid(`assignments[${index}] must be {licenseId, membershipId}, each a non-blank string`)
    }
    return {licenseId: assignment.licenseId, membershipId: assignment.membershipId}
  })
}

function requireAssignmentCount(count: number): void {
  if (count < 1 || count > MAX_SEAT_ASSIGNMENTS) invalid(`assignments must have 1 to ${MAX_SEAT_ASSIGNMENTS} pairs`)
}

/**
 * Give out several seats of the workspace's licenses at once, all of them or none, and resolve with every
 * license `assignments` names, each with every seat, oldest first. Each pair is checked and refused as
 * `assignSeat` checks one. A repeated pair counts once, and a pair whose membership already holds that
 * license's seat is skipped and takes none. When any license has fewer seats free than its new pairs
 * need, nothing is assigned and the refusal is `no_seats_available` with `licenses`: a
 * {@link SeatShortfall} for each license that falls short, in the order the pairs first name them. Takes
 * 1 to {@link MAX_SEAT_ASSIGNMENTS} pairs (`invalid_request` otherwise).
 */
export async function assignSeats(
  actor: Actor,
  workspaceId: string,
  assignments: SeatAssignment[],
): Promise<LicenseView[]> {
  requireAssignmentCount(assignments.length)
  // Each license's memberships, licenses in the order the pairs first name them, each pair once.
  const wanted = new Map<string, Set<string>>()
  for (const {licenseId, membershipId} of assignments) {
    const memberships = wanted.get(licenseId) ?? new Set<string>()
    memberships.add(membershipId)
    wanted.set(licenseId, memberships)
  }
  const membershipIds = [...new Set(assignments.map((assignment) => assignment.membershipId))]
  return withTransaction(async (session) => {
    await loadActiveWorkspace(session, workspaceId)
    await requireSeatManager(session, actor, workspaceId)
    const licenses = new Map<string, LicenseRow>()
    for (const licenseId of wanted.keys()) {
      licenses.set(licenseId, await loadWorkspaceLicense(session, workspaceId, licenseId))
    }
    const holders = new Map(
      (await loadSeatHolders(session, workspaceId, membershipIds)).map((holder) => [holder.membershipId, holder]),
    )
    const held = await LicenseSeatModel.find({licenseId: {$in: [...wanted.keys()]}, membershipId: {$in: membershipIds}})
      .select({_id: 0, licenseId: 1, membershipId: 1})
      .session(session)
      .lean<Array<Pick<LicenseSeatRow, "licenseId" | "membershipId">>>()
    const isHeld = new Set(held.map((seat) => pairKey(seat.licenseId, seat.membershipId)))
    const fresh = [...wanted]
      .map(([licenseId, ids]) => ({
        licenseId,
        holders: [...ids].filter((id) => !isHeld.has(pairKey(licenseId, id))).map((id) => holders.get(id)!),
      }))
      .filter((entry) => entry.holders.length > 0)
    // Every new seat's event, recorded in one batch as the transaction's last writes (below).
    const events: WorkspaceAuditEventInput[] = []
    if (fresh.length > 0) {
      await touchWorkspace(session, workspaceId)
      const taken: Array<{license: LicenseRow; holders: SeatHolder[]}> = []
      const short: SeatShortfall[] = []
      for (const entry of fresh) {
        const license = await takeSeats(session, entry.licenseId, entry.holders.length)
        if (license) {
          taken.push({license, holders: entry.holders})
          continue
        }
        // As this transaction's snapshot has it, before anything was taken. A refusal records no event, so it
        // can miss a release committed since that snapshot (see "What serializes seat changes" above).
        const {quantity, seatsUsed} = licenses.get(entry.licenseId)!
        short.push({licenseId: entry.licenseId, needed: entry.holders.length, free: Math.max(0, quantity - seatsUsed)})
      }
      // Failing aborts the transaction, the increments that did match included.
      if (short.length > 0) {
        fail("no_seats_available", "too few licenses are available for these assignments; nothing was assigned", {
          licenses: short,
        })
      }
      for (const entry of taken) {
        events.push(...(await insertSeats(session, actor, workspaceId, entry.license, entry.holders)))
      }
    }
    // The answer is read first, so the events' two writes are the transaction's last: the feed counter is held
    // only from its increment to the commit.
    const answer = (await listWorkspaceLicenses(workspaceId, "everyone", session)).filter((view) =>
      wanted.has(view.licenseId),
    )
    await recordWorkspaceEvents(session, events)
    return answer
  })
}

function pairKey(licenseId: string, membershipId: string): string {
  return JSON.stringify([licenseId, membershipId])
}

/**
 * The memberships `membershipIds` name, in that order, as seat holders. Refused as a single assignment's
 * membership is: one that is not an active membership of this workspace is `not_found`, and one still
 * waiting for its person's first sign-in is `invalid_request`.
 */
async function loadSeatHolders(
  session: ClientSession,
  workspaceId: string,
  membershipIds: string[],
): Promise<SeatHolder[]> {
  const ids = membershipIds.filter(isId)
  const rows =
    ids.length > 0
      ? await WorkspaceMembershipModel.find({membershipId: {$in: ids}, workspaceId, status: "active"})
          .session(session)
          .lean<MembershipRow[]>()
      : []
  const byId = new Map(rows.map((row) => [row.membershipId, row]))
  return membershipIds.map((membershipId) => {
    const membership = byId.get(membershipId)
    if (!membership) fail("not_found", "membership not found")
    if (!isId(membership.mentraUserId)) {
      invalid("this membership waits for its person's first sign-in and cannot hold a license yet")
    }
    return {membershipId, mentraUserId: membership.mentraUserId, email: membership.email ?? null}
  })
}

/**
 * Count `count` more seats of the license if it has that many free and has not ended. Resolves with the
 * license as that left it, or null when it matched nothing.
 */
async function takeSeats(session: ClientSession, licenseId: string, count: number): Promise<LicenseRow | null> {
  return LicenseModel.findOneAndUpdate(
    {_id: licenseId, endedAt: null, $expr: {$lte: [{$add: ["$seatsUsed", count]}, "$quantity"]}},
    {$inc: {seatsUsed: count}},
    {new: true, session},
  )
    .lean<LicenseRow>()
    .exec()
}

/**
 * Insert a seat of `license` for each of `holders`, in the caller's transaction, and return the
 * `seat.assigned` event of each, in that order, for the caller to record (`recordWorkspaceEvents`).
 * `license` is as its conditional increment (`takeSeats`) left it, with these seats counted, so each
 * event's `seatsUsed` counts the seats in use once that seat was given.
 */
async function insertSeats(
  session: ClientSession,
  actor: Actor,
  workspaceId: string,
  license: LicenseRow,
  holders: SeatHolder[],
): Promise<WorkspaceAuditEventInput[]> {
  const assignedAt = new Date()
  const assignedBy = actor.kind === "user" ? actor.mentraUserId : null
  await LicenseSeatModel.insertMany(
    holders.map((holder) => ({
      licenseId: license._id,
      workspaceId,
      membershipId: holder.membershipId,
      mentraUserId: holder.mentraUserId,
      assignedAt,
      assignedBy,
    })),
    {session},
  )
  const seatsUsedBefore = license.seatsUsed - holders.length
  return holders.map((holder, index) => ({
    workspaceId,
    action: "seat.assigned",
    actor: auditActor(actor),
    target: seatTarget(
      {licenseId: license._id, membershipId: holder.membershipId, mentraUserId: holder.mentraUserId},
      holder.email,
    ),
    before: null,
    after: {assignedAt: assignedAt.toISOString(), seatsUsed: seatsUsedBefore + index + 1, quantity: license.quantity},
  }))
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
  if (!license || license.owner.workspaceId !== workspaceId) fail("license_not_found", "license not found")
  if (license.endedAt && options.ended !== "allowed") fail("license_ended", "this license has ended")
  return license
}

/** Seat changes need `workspace.licenses.assign` (Admins and Owners, and Organization Admins), whoever is asking. */
async function requireSeatManager(session: ClientSession, actor: Actor, workspaceId: string): Promise<void> {
  const role = await actingRole(session, actor, workspaceId)
  if (!role || !capabilitiesForRole(role).has("workspace.licenses.assign")) {
    fail("forbidden", "assigning licenses requires the admin role")
  }
}

/**
 * Delete `seats`, give each back to its license's count and record `seat.released` for each, in one
 * batch, in the caller's transaction. `emails` are the members' display addresses, when the caller has
 * them.
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
  await recordWorkspaceEvents(
    session,
    seats.map((seat) => ({
      workspaceId: seat.workspaceId,
      action: "seat.released",
      actor: auditActor(actor),
      target: seatTarget(seat, known.get(seat.membershipId) ?? null),
      before: {assignedAt: seat.assignedAt.toISOString()},
      after: {reason},
    })),
  )
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
 * End every license the workspace `owner` holds that has not ended, because it is being deleted (`reason`),
 * inside the deletion's transaction: release their seats (`seat.released`, reason `workspace_deleted`),
 * set `endedAt` and record `license.ended`. Resolves with the licenses it ended.
 */
export async function endLicensesForOwner(
  session: ClientSession,
  owner: LicenseOwner,
  reason: Extract<LicenseEndedReason, "workspace_deleted" | "admin_reset">,
  actor: Actor,
): Promise<string[]> {
  const filter = ownerFilter(owner)
  if (!filter) return []
  const licenses = await LicenseModel.find({...filter, endedAt: null})
    .sort({_id: 1})
    .session(session)
    .lean<LicenseRow[]>()
  const endedLicenseIds: string[] = []
  for (const license of licenses) {
    const seats = await LicenseSeatModel.find({licenseId: license._id}).session(session).lean<LicenseSeatRow[]>()
    if (seats.length > 0) await releaseSeats(session, seats, reason, actor)
    const endedAt = new Date()
    const ended = await LicenseModel.updateOne(
      {_id: license._id, endedAt: null},
      {$set: {endedAt, endedReason: reason, seatsUsed: 0}},
      {session},
    )
    if (ended.modifiedCount !== 1) continue
    endedLicenseIds.push(license._id)
    await recordWorkspaceEvent(session, {
      workspaceId: owner.workspaceId,
      action: "license.ended",
      actor: auditActor(actor),
      target: {licenseId: license._id, product: license.product, owner: ownerOf(license.owner)},
      before: {endedAt: null},
      after: {endedAt: endedAt.toISOString(), reason, releasedSeats: seats.length},
    })
  }
  return endedLicenseIds
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as {code?: unknown}).code === 11000
}
