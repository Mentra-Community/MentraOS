/**
 * @fileoverview Bounded membership history for the Fleet integration: which membership generation
 * and role a person had in a workspace, and when.
 *
 * Every membership row is one generation (`startedAt` to `endedAt`), and its `roleHistory` lists
 * the roles held during it. An entry lasts from its `from` until the next entry's `from`, and the
 * last one until `endedAt` (or is still held), so the intervals of one generation never overlap
 * and leave no gap. All intervals are half-open: a role that changes at time T is the new role at T.
 *
 * Reads are bounded by a lookback, `CLOUD_CORE_FLEET_HISTORY_MAX_DAYS` (a positive integer, default
 * 90, read on use): a request about a time before now minus that many days is refused with
 * `history_window_exceeded`. A generation or role that began before the window and was still in
 * effect at its start is returned whole, with its real start time; anything that ended at or before
 * the window's start is left out. Whole rather than clipped, so an answer does not depend on when it
 * was asked and `from` is always the time the role really took effect.
 *
 * Only claimed rows (`mentraUserId` set) can match: a migrated membership still waiting for its
 * first sign-in belongs to nobody here.
 */

import {createLogger} from "@mentra/cloud-shared"
import type {
  MembershipAsOfQuery,
  MembershipAsOfResult,
  MembershipAtTime,
  MembershipEndedReason,
  MembershipGeneration,
  MembershipRoleInterval,
  WorkspaceRole,
} from "@mentra/workspace-contract"
import {WorkspaceMembershipModel, type WorkspaceMembershipRow} from "../../models/workspace-membership.model"
import {fail} from "./workspace-error"

const logger = createLogger("core").child({service: "membership-history.service"})

const DEFAULT_MAX_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000
/** How far ahead of Core's clock an asked-about time may be: the service signature's clock skew. */
const MAX_FUTURE_SKEW_MS = 60_000
/** An ISO 8601 date and time with a time zone, e.g. `2026-10-08T12:00:00.000Z` or `2026-10-08T14:00+02:00`. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

const reportedValues = new Set<string>()

/** `CLOUD_CORE_FLEET_HISTORY_MAX_DAYS`, or the default of 90 when it is unset or not a positive integer. */
export function historyMaxDays(): number {
  const raw = process.env.CLOUD_CORE_FLEET_HISTORY_MAX_DAYS?.trim()
  if (!raw) return DEFAULT_MAX_DAYS
  const value = Number(raw)
  if (/^\d+$/.test(raw) && Number.isSafeInteger(value) && value > 0) return value
  if (!reportedValues.has(raw)) {
    reportedValues.add(raw)
    logger.warn(
      {variable: "CLOUD_CORE_FLEET_HISTORY_MAX_DAYS"},
      `CLOUD_CORE_FLEET_HISTORY_MAX_DAYS is not a positive integer; using the default of ${DEFAULT_MAX_DAYS}`,
    )
  }
  return DEFAULT_MAX_DAYS
}

/** The earliest time a history read may ask about, `now` minus the configured lookback. */
export function historyWindowStart(now: Date): Date {
  return new Date(now.getTime() - historyMaxDays() * DAY_MS)
}

/**
 * Whether `service` may read the membership history of `workspaceId`. Every workspace, for now. The
 * spec limits historical reads to the service's configured workspace scope, but where that scope
 * is configured is an open decision (the covered workspaces live in Fleet's license, which Core
 * does not see). A restriction belongs here: every history and as-of read passes through it.
 */
export function historyScopeAllows(_service: string, _workspaceId: string): boolean {
  return true
}

/**
 * A time a history request asks about: an ISO 8601 date and time with a time zone, not more than a
 * minute ahead of Core's clock (`invalid_request` otherwise) and not before the window
 * (`history_window_exceeded`).
 */
export function parseHistoryTime(value: unknown, field: string, now: Date, windowStart: Date): Date {
  const time = typeof value === "string" && ISO_TIME.test(value) ? new Date(value) : null
  if (!time || Number.isNaN(time.getTime())) {
    fail("invalid_request", `${field} must be an ISO 8601 date and time with a time zone`)
  }
  if (time.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) fail("invalid_request", `${field} is in the future`)
  if (time.getTime() < windowStart.getTime()) {
    fail(
      "history_window_exceeded",
      `${field} is before ${windowStart.toISOString()}, the start of the ${historyMaxDays()}-day membership history Core keeps for Fleet`,
    )
  }
  return time
}

/**
 * The person's generations in the workspace that were in effect at or after `since`, oldest first,
 * with the roles held during each that were in effect at or after `since`. The caller has checked
 * `since` against the window.
 */
export async function listMembershipHistory(
  workspaceId: string,
  mentraUserId: string,
  since: Date,
): Promise<MembershipGeneration[]> {
  const rows = await WorkspaceMembershipModel.find({
    workspaceId,
    mentraUserId,
    $or: [{endedAt: null}, {endedAt: {$gt: since}}],
  })
    .sort({startedAt: 1, _id: 1})
    .lean<WorkspaceMembershipRow[]>()
  return rows.map(row => {
    const roles = roleIntervals(row).filter(interval => interval.to === null || interval.to > since)
    return {...generationFields(row), roles: roles.map(serializeInterval)}
  })
}

/**
 * For each query, the generation and role its person had in its workspace at its time, or null, in
 * the order asked. Every query's `at` is already parsed and checked against the window.
 */
export async function membershipsAsOf(
  queries: Array<Required<Pick<MembershipAsOfQuery, "workspaceId" | "mentraUserId">> & {at: Date}>,
): Promise<MembershipAsOfResult[]> {
  if (queries.length === 0) return []
  const pairs = new Map<string, {workspaceId: string; mentraUserId: string}>()
  for (const {workspaceId, mentraUserId} of queries) {
    pairs.set(pairKey(workspaceId, mentraUserId), {workspaceId, mentraUserId})
  }
  const rows = await WorkspaceMembershipModel.find({$or: [...pairs.values()]})
    .sort({startedAt: 1, _id: 1})
    .lean<WorkspaceMembershipRow[]>()
  const byPair = new Map<string, WorkspaceMembershipRow[]>()
  for (const row of rows) {
    const key = pairKey(row.workspaceId, row.mentraUserId ?? "")
    const list = byPair.get(key)
    if (list) list.push(row)
    else byPair.set(key, [row])
  }
  return queries.map(({workspaceId, mentraUserId, at}) => ({
    workspaceId,
    mentraUserId,
    at: at.toISOString(),
    membership: inEffectAt(byPair.get(pairKey(workspaceId, mentraUserId)) ?? [], at),
  }))
}

// --- Helpers ---------------------------------------------------------------

type Interval = {role: WorkspaceRole; from: Date; to: Date | null; authorizationRevision: number}

/** The row's role intervals, oldest first: each lasts until the next one starts, the last until `endedAt`. */
function roleIntervals(row: WorkspaceMembershipRow): Interval[] {
  const entries = row.roleHistory ?? []
  return entries.map((entry, index) => ({
    role: entry.role as WorkspaceRole,
    from: entry.from,
    to: entries[index + 1]?.from ?? row.endedAt ?? null,
    authorizationRevision: entry.authorizationRevision,
  }))
}

/**
 * The generation in effect at `at` among one person's rows in one workspace, with the role held then.
 * Generations do not overlap; should two ever both cover `at`, the one that started later answers.
 */
function inEffectAt(rows: WorkspaceMembershipRow[], at: Date): MembershipAtTime | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!
    if (row.startedAt > at || (row.endedAt && row.endedAt <= at)) continue
    const intervals = roleIntervals(row)
    for (let entry = intervals.length - 1; entry >= 0; entry--) {
      const interval = intervals[entry]!
      if (interval.from <= at) return {...generationFields(row), role: serializeInterval(interval)}
    }
  }
  return null
}

function generationFields(row: WorkspaceMembershipRow): Omit<MembershipGeneration, "roles"> {
  return {
    membershipId: row.membershipId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    endedReason: (row.endedReason ?? null) as MembershipEndedReason | null,
  }
}

function serializeInterval(interval: Interval): MembershipRoleInterval {
  return {
    role: interval.role,
    from: interval.from.toISOString(),
    to: interval.to ? interval.to.toISOString() : null,
    authorizationRevision: interval.authorizationRevision,
  }
}

const pairKey = (workspaceId: string, mentraUserId: string) => JSON.stringify([workspaceId, mentraUserId])
