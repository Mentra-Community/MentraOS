/**
 * @fileoverview The workspace audit trail.
 *
 * Every workspace mutation records one audit event in the same transaction as
 * the change itself, so the trail never disagrees with the data. Operator-key
 * events are recorded with `workspaceId` null. An operator key is one document,
 * so its changes are written without a transaction (some databases a Private
 * Cloud uses cannot run one across collections) and their audit event follows
 * as a separate write (`recordOrganizationEvent`).
 *
 * `eventId` is a ULID from one monotonic source per process and identifies the
 * event; a workspace's audit page reads newest first by it. Each event's
 * `requestId` is the id of the request that caused it (`currentRequestId`),
 * unless the caller supplies one. Records never carry a secret: credentials are
 * identified by id and name, never by token or hash.
 */

import {createLogger} from "@mentra/cloud-shared"
import type {ClientSession} from "mongoose"
import {monotonicFactory} from "ulid"
import {WorkspaceAuditEventModel, type WorkspaceAuditEventRow} from "../../models/workspace-audit-event.model"
import {currentRequestId} from "../request-context"

const logger = createLogger("core").child({service: "workspace-audit"})

const nextEventId = monotonicFactory()

const MAX_PAGE_SIZE = 500

/** Keys whose values are credential material, redacted from every snapshot shown outside this service. */
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
 * Append an audit event inside the caller's transaction (or, with `session`
 * null, on its own) and return its `eventId`. The id and timestamp are assigned
 * here, so a retried transaction callback records a fresh event rather than
 * reusing a rolled-back one.
 */
export async function recordWorkspaceEvent(
  session: ClientSession | null,
  event: WorkspaceAuditEventInput,
): Promise<string> {
  const eventId = nextEventId()
  await WorkspaceAuditEventModel.create(
    [{...event, requestId: event.requestId ?? currentRequestId(), eventId, occurredAt: new Date()}],
    session ? {session} : {},
  )
  return eventId
}

/**
 * Record the audit event of an organization-level change already written on its own (an operator
 * key). A failure is logged, never thrown: the change has happened, and reporting it as failed would
 * invite a retry that repeats it.
 */
export async function recordOrganizationEvent(event: WorkspaceAuditEventInput): Promise<void> {
  try {
    await recordWorkspaceEvent(null, event)
  } catch (err) {
    logger.error({err, action: event.action, target: redactSecrets(event.target ?? null)}, "could not record an audit event")
  }
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
