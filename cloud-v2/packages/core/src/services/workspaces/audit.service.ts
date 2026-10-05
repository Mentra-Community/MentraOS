/**
 * @fileoverview Workspace audit trail and the change feed built on it.
 *
 * Every workspace mutation records one audit event in the same transaction as
 * the change itself, so the trail never disagrees with the data. All event ids
 * come from one monotonic ULID source: ids issued by this process sort in
 * issue order, even inside the same millisecond, so `eventId` doubles as the
 * change-feed cursor.
 *
 * Ids from different Core processes, or from transactions that commit out of
 * order, can interleave. A consumer of {@link listChanges} that must not miss
 * an event should treat the cursor as "at least once from here" and re-read a
 * short overlap; the events themselves are idempotent facts.
 */

import type {WorkspaceChangeEvent} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {monotonicFactory} from "ulid"
import {WorkspaceAuditEventModel, type WorkspaceAuditEventRow} from "../../models/workspace-audit-event.model"

const nextEventId = monotonicFactory()

const MAX_PAGE_SIZE = 500

/** Keys whose values are credential material, redacted from the change feed wherever they appear. */
const SECRET_KEY = /token|secret|hash|password/i

/**
 * What a caller supplies for an audit event: everything except what this
 * service stamps itself (`eventId`, `occurredAt`) and what Mongoose manages
 * (`createdAt`, `updatedAt`). `requestId` may be omitted.
 */
export type WorkspaceAuditEventInput = Omit<
  WorkspaceAuditEventRow,
  "eventId" | "occurredAt" | "createdAt" | "updatedAt" | "requestId"
> & {requestId?: string | null}

/**
 * Append an audit event inside the caller's transaction and return its id.
 * The id and timestamp are assigned here, so a retried transaction callback
 * records a fresh event rather than reusing a rolled-back one.
 */
export async function recordWorkspaceEvent(session: ClientSession, event: WorkspaceAuditEventInput): Promise<string> {
  const eventId = nextEventId()
  await WorkspaceAuditEventModel.create(
    [{...event, requestId: event.requestId ?? null, eventId, occurredAt: new Date()}],
    {
      session,
    },
  )
  return eventId
}

/**
 * Events after `after` (exclusive), oldest first. `next` is the last event id
 * when the page is full and there may be more, otherwise null. Only ids, the
 * action, the time and `target` are returned, and credential-looking keys are
 * removed from `target`, so this feed can be handed to another service.
 */
export async function listChanges(
  after: string | null,
  limit: number,
): Promise<{events: WorkspaceChangeEvent[]; next: string | null}> {
  const size = clampPageSize(limit)
  const rows = await WorkspaceAuditEventModel.find(after ? {eventId: {$gt: after}} : {})
    .select({_id: 0, eventId: 1, organizationId: 1, workspaceId: 1, action: 1, occurredAt: 1, target: 1})
    .sort({eventId: 1})
    .limit(size)
    .lean()
  const events = rows.map<WorkspaceChangeEvent>(row => ({
    eventId: row.eventId,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId ?? null,
    action: row.action,
    occurredAt: row.occurredAt.toISOString(),
    target: redactSecrets(row.target ?? {}) as Record<string, unknown>,
  }))
  return {events, next: events.length === size ? events[events.length - 1]!.eventId : null}
}

/** One workspace's audit events, newest first, strictly older than `before` when given. */
export async function listWorkspaceAudit(
  workspaceId: string,
  opts: {limit: number; before?: string},
): Promise<WorkspaceAuditEventRow[]> {
  const filter: Record<string, unknown> = {workspaceId}
  if (opts.before) filter.eventId = {$lt: opts.before}
  return WorkspaceAuditEventModel.find(filter)
    .select({_id: 0, __v: 0})
    .sort({eventId: -1})
    .limit(clampPageSize(opts.limit))
    .lean<WorkspaceAuditEventRow[]>()
}

/** A page size of at least 1 and at most {@link MAX_PAGE_SIZE}; anything that is not a number counts as 1. */
export function clampPageSize(limit: number): number {
  const whole = Math.trunc(Number(limit))
  if (!Number.isFinite(whole) || whole < 1) return 1
  return Math.min(whole, MAX_PAGE_SIZE)
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SECRET_KEY.test(key))
        .map(([key, nested]) => [key, redactSecrets(nested)]),
    )
  }
  return value
}
