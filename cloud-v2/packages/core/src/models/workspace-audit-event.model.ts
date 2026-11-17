/**
 * @fileoverview `workspace_audit_events` collection. Append-only audit trail of
 * workspace administration (workspace, membership, invitation and credential
 * changes) and of operator keys, and the source of the change feed services read.
 *
 * `eventId` is a ULID from one monotonic source per process and identifies the
 * event; a workspace's audit page reads newest first by it. `seq` is the event's
 * position in the change feed: it is issued inside the recording transaction from
 * the single feed counter (see `workspace-audit-counter.model.ts`), so it follows
 * commit order and is the feed cursor. Organization-level events (operator keys,
 * `workspaceId` null) are written without a transaction and have no `seq`, and
 * neither does any event recorded before the feed existed. `target`, `before` and
 * `after` are free-form snapshots whose shape depends on `action`, and never carry
 * a secret.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const WORKSPACE_AUDIT_ACTOR_KINDS = ["user", "credential", "service", "system"] as const
export type WorkspaceAuditActorKind = (typeof WORKSPACE_AUDIT_ACTOR_KINDS)[number]

const ActorSchema = new Schema(
  {
    kind: {type: String, enum: WORKSPACE_AUDIT_ACTOR_KINDS, required: true},
    mentraUserId: {type: String},
    credentialId: {type: String},
    service: {type: String},
    email: {type: String},
  },
  {_id: false},
)

const WorkspaceAuditEventSchema = new Schema(
  {
    eventId: {type: String, required: true, unique: true},
    /** Position in the change feed. Absent on organization-level and pre-feed events. */
    seq: {type: Number},
    workspaceId: {type: String, default: null},
    /** e.g. `"workspace.created"`, `"membership.role_changed"`, `"credential.revoked"`. */
    action: {type: String, required: true},
    actor: {type: ActorSchema, required: true},
    target: {type: Schema.Types.Mixed},
    before: {type: Schema.Types.Mixed},
    after: {type: Schema.Types.Mixed},
    requestId: {type: String, default: null},
    occurredAt: {type: Date, required: true},
  },
  {timestamps: true, collection: "workspace_audit_events"},
)

// One workspace's audit page, newest first.
WorkspaceAuditEventSchema.index({workspaceId: 1, eventId: -1})
// The change feed: events in `seq` order, one event per number. Events without a `seq` are not in the
// index and fall outside every range read of it. Earlier releases built it plain under the same name;
// the startup migrations replace that one (`replacePlainSeqIndex`).
export const SEQ_INDEX = {
  key: {seq: 1},
  options: {name: "seq_1", unique: true, partialFilterExpression: {seq: {$exists: true}}},
} as const
WorkspaceAuditEventSchema.index(SEQ_INDEX.key, SEQ_INDEX.options)

export type WorkspaceAuditEventRow = InferSchemaType<typeof WorkspaceAuditEventSchema>
export const WorkspaceAuditEventModel = registerModel("WorkspaceAuditEvent", WorkspaceAuditEventSchema)
