/**
 * @fileoverview Workspace audit trail and the change feed built on it.
 *
 * Every workspace mutation records one audit event in the same transaction as
 * the change itself, so the trail never disagrees with the data.
 *
 * Each event has two ids. `eventId` is a ULID (from one monotonic source per
 * process) and identifies the event. `seq` is its position in the change feed
 * and is the feed cursor. `seq` comes from a single counter document
 * incremented inside the recording transaction, so concurrent recorders
 * conflict on it: a transaction can only take `seq` N+1 after the one holding
 * N has committed (or aborted and rolled its increment back). Sequence order
 * is therefore commit order with no gaps, and a poller that has read up to
 * `seq` N can never later see an event with a lower `seq` appear. A
 * process-local ULID cannot promise that: two transactions can mint ids in one
 * order and commit in the other, or run in different Core processes.
 *
 * The cost is that audited mutations serialize on the counter. They are rare
 * admin operations, and every caller records its event as its last write so
 * the counter is held only briefly before commit.
 *
 * The change feed services read is this trail with organization-level events
 * (operator keys: `workspaceId` null) left out, except user-level tombstones
 * (`user.deleted`). Nothing is ever pruned, so a service can replay from the
 * beginning at any time. Each event's `requestId` is the id of the request that
 * caused it (`currentRequestId`), unless the caller supplies one.
 */

import {USER_DELETED_ACTION, type WorkspaceChangeEvent} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {monotonicFactory} from "ulid"
import {WORKSPACE_AUDIT_COUNTER_ID, WorkspaceAuditCounterModel} from "../../models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel, type WorkspaceAuditEventRow} from "../../models/workspace-audit-event.model"
import {currentRequestId} from "../request-context"
import {fail} from "./workspace-error"

const nextEventId = monotonicFactory()

const MAX_PAGE_SIZE = 500

/** Keys whose values are credential material, redacted from the change feed wherever they appear. */
const SECRET_KEY = /token|secret|hash|password/i

/**
 * What a caller supplies for an audit event: everything except what this
 * service stamps itself (`eventId`, `seq`, `occurredAt`) and what Mongoose
 * manages (`createdAt`, `updatedAt`). `requestId` may be omitted.
 */
export type WorkspaceAuditEventInput = Omit<
  WorkspaceAuditEventRow,
  "eventId" | "seq" | "occurredAt" | "createdAt" | "updatedAt" | "requestId"
> & {requestId?: string | null}

/**
 * Append an audit event inside the caller's transaction and return its
 * `eventId`. The ids and timestamp are assigned here, so a retried transaction
 * callback records a fresh event rather than reusing a rolled-back one.
 *
 * Call this as the last write of the transaction: it takes the feed's sequence
 * counter, and every other recorder waits (by retrying) until this
 * transaction ends.
 */
export async function recordWorkspaceEvent(session: ClientSession, event: WorkspaceAuditEventInput): Promise<string> {
  const seq = await nextSeq(session)
  const eventId = nextEventId()
  await WorkspaceAuditEventModel.create(
    [{...event, requestId: event.requestId ?? currentRequestId(), eventId, seq, occurredAt: new Date()}],
    {session},
  )
  return eventId
}

/**
 * Take the feed's next sequence number by incrementing the counter in the
 * caller's transaction. The first event ever recorded upserts the counter; if
 * another transaction creates it in the meantime, the server answers
 * the loser with a transient write conflict and `withTransaction` retries, so
 * that race needs no handling here.
 */
async function nextSeq(session: ClientSession): Promise<number> {
  const counter = await WorkspaceAuditCounterModel.findOneAndUpdate(
    {_id: WORKSPACE_AUDIT_COUNTER_ID},
    {$inc: {seq: 1}},
    {upsert: true, new: true, setDefaultsOnInsert: false, session},
  ).lean()
  return counter!.seq
}

/**
 * Feed events after the cursor, oldest first: every workspace-scoped event and every user-level
 * tombstone, never an organization-level one (operator keys stay in Core's own audit). `after` is
 * the `seq` of the last event already seen as a decimal string (`null` starts from the beginning);
 * `next` is the last event's `seq` as a decimal string when the page is full and there may be
 * more, otherwise null. Leaving events out means consecutive feed events can skip `seq` numbers.
 *
 * Each event carries its ids, `seq`, workspace, action, time, and `target`, `before` and `after`
 * with credential-looking keys removed at any depth, so the feed can be handed to another service.
 * The actor and the request id are not part of it.
 */
export async function listChanges(
  after: string | null,
  limit: number,
): Promise<{events: WorkspaceChangeEvent[]; next: string | null}> {
  const cursor = parseCursor(after)
  const size = clampPageSize(limit)
  const rows = await WorkspaceAuditEventModel.find({
    seq: {$gt: cursor},
    $or: [{workspaceId: {$type: "string"}}, {action: USER_DELETED_ACTION}],
  })
    .select({_id: 0, eventId: 1, seq: 1, workspaceId: 1, action: 1, occurredAt: 1, target: 1, before: 1, after: 1})
    .sort({seq: 1})
    .limit(size)
    .lean()
  const events = rows.map<WorkspaceChangeEvent>(row => ({
    eventId: row.eventId,
    seq: row.seq,
    workspaceId: row.workspaceId ?? null,
    action: row.action,
    occurredAt: row.occurredAt.toISOString(),
    target: redactSecrets(row.target ?? {}) as Record<string, unknown>,
    before: snapshot(row.before),
    after: snapshot(row.after),
  }))
  return {events, next: events.length === size ? String(events[events.length - 1]!.seq) : null}
}

/** A stored `before`/`after` snapshot for another service: null when absent, credential-looking keys removed. */
function snapshot(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (redactSecrets(value) as Record<string, unknown>) : null
}

function parseCursor(after: string | null): number {
  if (after === null) return 0
  const seq = typeof after === "string" && /^(0|[1-9]\d*)$/.test(after) ? Number(after) : NaN
  if (!Number.isSafeInteger(seq)) fail("invalid_request", "after must be a change sequence number")
  return seq
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

/** `value` with every credential-looking key (`token`, `secret`, `hash`, `password`) removed at any depth. */
export function redactSecrets(value: unknown): unknown {
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
