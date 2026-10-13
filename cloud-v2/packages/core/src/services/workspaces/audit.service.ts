/**
 * @fileoverview The workspace audit trail and the change feed built on it.
 *
 * Every workspace mutation records one audit event in the same transaction as
 * the change itself, so the trail never disagrees with the data. Operator-key
 * events are recorded with `workspaceId` null. An operator key is one document,
 * so its changes are written without a transaction (some databases a Private
 * Cloud uses cannot run one across collections) and their audit event follows
 * as a separate write (`recordOrganizationEvent`).
 *
 * Each event has two ids. `eventId` is a ULID (from one monotonic source per
 * process) and identifies the event; a workspace's audit page reads newest first
 * by it. `seq` is its position in the change feed and is the feed cursor. `seq`
 * comes from a single counter document incremented inside the recording
 * transaction, so concurrent recorders conflict on it: a transaction can only
 * take `seq` N+1 after the one holding N has committed (or aborted and rolled its
 * increment back). Sequence order is therefore commit order with no gaps, and a
 * poller that has read up to `seq` N can never later see an event with a lower
 * `seq` appear. A process-local ULID cannot promise that: two transactions can
 * mint ids in one order and commit in the other, or run in different Core
 * processes. The cost is that audited mutations serialize on the counter: it is
 * held from the transaction's first event until it commits or aborts, and other
 * recorders retry meanwhile. They are rare admin operations; a transaction that
 * records several events (ending many memberships, an import) holds the counter
 * for the rest of its run, so a caller should record its first event as late in
 * its transaction as it can.
 *
 * The change feed services read (`listChanges`) is this trail's events that have
 * a `seq`: workspace-scoped events and user-level tombstones (`user.deleted`).
 * Organization-level events have no `seq`, and neither do events recorded before
 * the feed existed: a range read of `seq` never matches a document without one,
 * so they cannot appear in the feed or disturb its paging. Nothing is pruned, so
 * a service can replay the whole feed at any time. Each event's `requestId`
 * is the id of the request that caused it (`currentRequestId`), unless the caller
 * supplies one. Records never carry a secret: credentials are identified by id
 * and name, never by token or hash.
 */

import {createLogger} from "@mentra/cloud-shared"
import {USER_DELETED_ACTION, type WorkspaceChangeEvent} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {monotonicFactory} from "ulid"
import {WORKSPACE_AUDIT_COUNTER_ID, WorkspaceAuditCounterModel} from "../../models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel, type WorkspaceAuditEventRow} from "../../models/workspace-audit-event.model"
import {currentRequestId} from "../request-context"
import {fail} from "./workspace-error"

const logger = createLogger("core").child({service: "workspace-audit"})

const nextEventId = monotonicFactory()

const MAX_PAGE_SIZE = 500

/** The change feed's page size when the caller names none. */
const DEFAULT_CHANGES_LIMIT = 100

/** Keys whose values are credential material, redacted from every snapshot shown outside this service. */
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
 * Append an audit event inside the caller's transaction and return its `eventId`. The ids and
 * timestamp are assigned here, so a retried transaction callback records a fresh event rather than
 * reusing a rolled-back one.
 *
 * This takes the feed's sequence counter and holds it until the transaction ends; every other
 * recorder retries meanwhile. Record the first event as late in the transaction as you can.
 */
export async function recordWorkspaceEvent(session: ClientSession, event: WorkspaceAuditEventInput): Promise<string> {
  return appendEvent(session, event, await nextSeq(session))
}

/**
 * Record the audit event of an organization-level change already written on its own (an operator
 * key). It takes no `seq` and is not in the change feed. A failure is logged, never thrown: the
 * change has happened, and reporting it as failed would invite a retry that repeats it.
 */
export async function recordOrganizationEvent(event: WorkspaceAuditEventInput): Promise<void> {
  try {
    await appendEvent(null, event, undefined)
  } catch (err) {
    logger.error({err, action: event.action, target: redactSecrets(event.target ?? null)}, "could not record an audit event")
  }
}

/**
 * Record a change-feed event without a transaction, for the one writer that must still work on a
 * database that is known to be unable to run one (the `user.deleted` tombstone of a person who
 * belongs to no workspace; see `isTransactionsUnsupportedError`). Never use it for a transient
 * failure on a database that can run transactions: its `seq` is unique and increasing but, unlike
 * {@link recordWorkspaceEvent}'s, not guaranteed to follow commit order. A transaction could take
 * the next number and commit between this counter increment and this insert, and a poller would
 * pass the number whose event is not written yet. A database that cannot run transactions has no
 * other feed writer (workspace writes need them), so only two tombstones written within
 * milliseconds of each other can meet that.
 */
export async function recordFeedEventWithoutTransaction(event: WorkspaceAuditEventInput): Promise<string> {
  return appendEvent(null, event, await nextSeq(null))
}

async function appendEvent(
  session: ClientSession | null,
  event: WorkspaceAuditEventInput,
  seq: number | undefined,
): Promise<string> {
  const eventId = nextEventId()
  await WorkspaceAuditEventModel.create(
    [
      {
        ...event,
        requestId: event.requestId ?? currentRequestId(),
        eventId,
        ...(seq === undefined ? {} : {seq}),
        occurredAt: new Date(),
      },
    ],
    session ? {session} : {},
  )
  return eventId
}

/**
 * Take the feed's next sequence number by incrementing the counter, in the caller's transaction when
 * there is one. The first event ever recorded upserts the counter; if another transaction creates it
 * in the meantime, the server answers the loser with a transient write conflict and
 * `withTransaction` retries, so that race needs no handling here.
 */
async function nextSeq(session: ClientSession | null): Promise<number> {
  const counter = await WorkspaceAuditCounterModel.findOneAndUpdate(
    {_id: WORKSPACE_AUDIT_COUNTER_ID},
    {$inc: {seq: 1}},
    {upsert: true, new: true, setDefaultsOnInsert: false, ...(session ? {session} : {})},
  ).lean()
  return counter!.seq
}

/**
 * Feed events after the cursor, oldest first: every workspace-scoped event and every user-level
 * tombstone, never an organization-level one (operator keys stay in Core's own audit). `after` is
 * the `seq` of the last event already seen as a decimal string (`null` or omitted starts from the
 * beginning); `limit` is clamped to between 1 and 500 and defaults to 100. `next` is the last
 * event's `seq` as a decimal string when the page is full and there may be more, otherwise null.
 * Leaving events out means consecutive feed events can skip `seq` numbers.
 *
 * Each event carries its ids, `seq`, workspace, action, time, and `target`, `before` and `after`
 * (null when it has none) with credential-looking keys removed at any depth, so the feed can be
 * handed to another service. The actor and the request id are not part of it.
 *
 * An event without a `seq` (organization-level, or recorded before the feed existed) is never
 * matched by the range `seq > cursor`, whatever the cursor.
 */
export async function listChanges(opts: {
  after?: string | null
  limit?: number | undefined
}): Promise<{events: WorkspaceChangeEvent[]; next: string | null}> {
  const cursor = parseCursor(opts.after ?? null)
  const size = opts.limit === undefined ? DEFAULT_CHANGES_LIMIT : clampPageSize(opts.limit)
  const rows = await WorkspaceAuditEventModel.find({
    seq: {$gt: cursor},
    $or: [{workspaceId: {$type: "string"}}, {action: USER_DELETED_ACTION}],
  })
    .select({_id: 0, eventId: 1, seq: 1, workspaceId: 1, action: 1, occurredAt: 1, target: 1, before: 1, after: 1})
    .sort({seq: 1})
    .limit(size)
    .lean<Array<WorkspaceAuditEventRow & {seq: number}>>()
  const events = rows.map<WorkspaceChangeEvent>(row => ({
    eventId: row.eventId,
    seq: row.seq,
    workspaceId: row.workspaceId ?? null,
    action: row.action,
    occurredAt: row.occurredAt.toISOString(),
    target: snapshot(row.target),
    before: snapshot(row.before),
    after: snapshot(row.after),
  }))
  return {events, next: events.length === size ? String(events[events.length - 1]!.seq) : null}
}

/** A stored `target`/`before`/`after` snapshot for another service: null when absent, credential-looking keys removed. */
function snapshot(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (redactSecrets(value) as Record<string, unknown>)
    : null
}

/** `after` as a sequence number: a decimal string without sign, fraction or leading zero. */
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
