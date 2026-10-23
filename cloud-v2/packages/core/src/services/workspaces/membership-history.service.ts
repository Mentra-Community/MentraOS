/**
 * @fileoverview Membership interval history for Fleet.
 *
 * Fleet scopes what a workspace sees by when each person was a member. It keeps its own copy of those intervals,
 * built from this page-by-page read (bootstrap) and then kept current from the change feed (`GET /changes`).
 *
 * An interval is one membership generation (`workspace_memberships` row) of a known account:
 *  - it starts at `claimedAt` for a membership imported from the Store and taken up later, else at `startedAt`.
 *    A claimed row from before `claimedAt` was recorded has the time on its `membership.claimed` event;
 *  - it ends at `endedAt`, for `endedReason` (left, removed, the workspace deleted, the account deleted);
 *  - a membership with no account yet (imported, waiting for its person) is not an interval;
 *  - `membership.merged_duplicate` and `membership.replaced` act only on such memberships, so they end none;
 *  - `roles` is the row's `roleHistory` within the interval, so a role held before the claim is never counted.
 *
 * The read covers a lookback window (`CLOUD_CORE_FLEET_HISTORY_MAX_DAYS`, default 90): every interval that
 * overlaps `[now - lookback, now]`. An open interval older than the window is returned with its real start, so a
 * long-standing member is never dropped; one that ended before the window is not returned. Pages go in
 * membership-row order by an opaque cursor, which does not move when rows change between pages. `feedSeq` is read
 * before the rows, so applying the feed after it (idempotently, by `membershipId`) can only repeat what a page
 * already shows, never miss a change.
 */

import type {
  MembershipInterval,
  MembershipIntervalEndReason,
  MembershipIntervalsResponse,
  MembershipRoleInterval,
  WorkspaceRole,
} from "@mentra/workspace-contract"
import type {Types} from "mongoose"
import {WorkspaceAuditCounterModel, WORKSPACE_AUDIT_COUNTER_ID} from "../../models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../../models/workspace-audit-event.model"
import {WorkspaceMembershipModel, type WorkspaceMembershipRow} from "../../models/workspace-membership.model"
import {clampPageSize} from "./audit.service"
import {fail} from "./workspace-error"

export const DEFAULT_FLEET_HISTORY_MAX_DAYS = 90
const MAX_FLEET_HISTORY_MAX_DAYS = 3650
const DEFAULT_PAGE = 200
const DAY_MS = 86_400_000

const END_REASONS: ReadonlySet<string> = new Set<MembershipIntervalEndReason>([
  "left",
  "removed",
  "workspace_deleted",
  "account_deleted",
])

/**
 * `CLOUD_CORE_FLEET_HISTORY_MAX_DAYS`: how far back the interval history reaches. Unset is 90. A value that is
 * not a whole number of days between 1 and 3650 is a configuration error, not a silent default.
 */
export function fleetHistoryMaxDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CLOUD_CORE_FLEET_HISTORY_MAX_DAYS?.trim()
  if (!raw) return DEFAULT_FLEET_HISTORY_MAX_DAYS
  const days = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(days) || days > MAX_FLEET_HISTORY_MAX_DAYS) {
    throw new Error(`CLOUD_CORE_FLEET_HISTORY_MAX_DAYS must be a whole number of days from 1 to ${MAX_FLEET_HISTORY_MAX_DAYS}`)
  }
  return days
}

type Row = WorkspaceMembershipRow & {_id: Types.ObjectId}

/** An opaque cursor for the row after `id`. */
function encodeCursor(id: Types.ObjectId): string {
  return Buffer.from(`m:${id.toHexString()}`).toString("base64url")
}

function decodeCursor(after: string | null | undefined): string | null {
  if (after === null || after === undefined) return null
  const decoded = typeof after === "string" ? Buffer.from(after, "base64url").toString("utf8") : ""
  const match = /^m:([0-9a-f]{24})$/.exec(decoded)
  if (!match) fail("invalid_request", "after must be a cursor from a previous page")
  return match[1]!
}

/** The change feed's current position: the highest `seq` committed. */
async function feedHead(): Promise<number> {
  const counter = await WorkspaceAuditCounterModel.findById(WORKSPACE_AUDIT_COUNTER_ID).lean<{seq: number}>()
  return counter?.seq ?? 0
}

/** The claim time of each membership claimed before `claimedAt` was recorded, from its `membership.claimed` event. */
async function claimTimes(rows: Row[]): Promise<Map<string, Date>> {
  const ids = rows
    .filter(row => !row.claimedAt && row.pendingWorkosUserId !== undefined)
    .map(row => row.membershipId)
  const times = new Map<string, Date>()
  if (ids.length === 0) return times
  const events = await WorkspaceAuditEventModel.find({action: "membership.claimed", "target.membershipId": {$in: ids}})
    .select({target: 1, occurredAt: 1})
    .sort({seq: 1})
    .lean<Array<{target?: {membershipId?: string}; occurredAt: Date}>>()
  for (const event of events) {
    const id = event.target?.membershipId
    if (id && !times.has(id)) times.set(id, event.occurredAt)
  }
  return times
}

/**
 * The row's `roleHistory` cut to the interval `[start, end]`: each entry from when it took effect (or `start`) until
 * the next one's `from`, the last until `end`. Role intervals that ended before the window are left out, but the
 * last one (which reaches the interval's end) never is, so the list is never empty.
 */
function roleIntervals(row: Row, start: Date, end: Date | null, windowStart: Date): MembershipRoleInterval[] {
  const at = (time: Date) => Math.min(Math.max(time.getTime(), start.getTime()), end?.getTime() ?? Infinity)
  const entries = [...(row.roleHistory ?? [])].sort((a, b) => a.from.getTime() - b.from.getTime())
  const roles: MembershipRoleInterval[] = []
  entries.forEach((entry, index) => {
    const next = entries[index + 1]
    const from = at(entry.from)
    const to = next ? at(next.from) : end ? end.getTime() : null
    const last = !next
    if (!last && (to! <= from || to! < windowStart.getTime())) return
    roles.push({
      role: entry.role as WorkspaceRole,
      start: new Date(from).toISOString(),
      end: to === null ? null : new Date(to).toISOString(),
    })
  })
  if (roles.length === 0) {
    roles.push({role: row.role as WorkspaceRole, start: start.toISOString(), end: end ? end.toISOString() : null})
  }
  return roles
}

function toInterval(row: Row, claimed: Map<string, Date>, windowStart: Date): MembershipInterval {
  const begun = row.claimedAt ?? claimed.get(row.membershipId) ?? row.startedAt
  const ended = row.status === "ended" ? (row.endedAt ?? null) : null
  // A row ended with no time, or before its claim, is an interval of no length at its end, never a negative one.
  const start = ended && ended.getTime() < begun.getTime() ? ended : begun
  const reason = row.endedReason && END_REASONS.has(row.endedReason) ? row.endedReason : "removed"
  return {
    membershipId: row.membershipId,
    workspaceId: row.workspaceId,
    mentraUserId: row.mentraUserId as string,
    role: row.role as MembershipInterval["role"],
    start: start.toISOString(),
    end: ended ? ended.toISOString() : null,
    endReason: ended ? (reason as MembershipIntervalEndReason) : null,
    roles: roleIntervals(row, start, ended, windowStart),
  }
}

/** One page of interval history. See the file header. `now` is for tests. */
export async function listMembershipIntervals(opts: {
  after?: string | null
  limit?: number | undefined
  now?: Date
}): Promise<MembershipIntervalsResponse> {
  const cursor = decodeCursor(opts.after)
  const size = opts.limit === undefined ? DEFAULT_PAGE : clampPageSize(opts.limit)
  const lookbackDays = fleetHistoryMaxDays()
  const windowStart = new Date((opts.now ?? new Date()).getTime() - lookbackDays * DAY_MS)
  const feedSeq = await feedHead()

  const filter: Record<string, unknown> = {
    // A membership with no account yet is no interval.
    mentraUserId: {$type: "string"},
    $or: [{status: "active"}, {endedAt: {$gte: windowStart}}],
  }
  if (cursor) filter._id = {$gt: cursor}
  const rows = await WorkspaceMembershipModel.find(filter).sort({_id: 1}).limit(size).lean<Row[]>()
  const claimed = await claimTimes(rows)
  return {
    lookbackDays,
    windowStart: windowStart.toISOString(),
    feedSeq,
    intervals: rows.map(row => toInterval(row, claimed, windowStart)),
    next: rows.length === size ? encodeCursor(rows[rows.length - 1]!._id) : null,
  }
}
