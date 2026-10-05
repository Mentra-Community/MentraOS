/**
 * @fileoverview `workspace_audit_events` collection. Append-only change feed for
 * workspace administration (membership, invitation and credential changes).
 *
 * `eventId` is a ULID and identifies the event. `seq` is the event's position in
 * the organization's change feed: it is issued inside the recording transaction
 * from a per-organization counter (see `workspace-audit-counter.model.ts`), so
 * it follows commit order and is the feed cursor. `workspaceId` is null for
 * organization-level events. `target`, `before` and `after` are free-form
 * snapshots whose shape depends on `action`.
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
    organizationId: {type: String, required: true},
    /** Position in the organization's change feed; unique per organization. */
    seq: {type: Number, required: true},
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

// The change feed: events of one organization in `seq` order.
WorkspaceAuditEventSchema.index({organizationId: 1, seq: 1}, {unique: true})
// One workspace's audit page, newest first.
WorkspaceAuditEventSchema.index({workspaceId: 1, eventId: -1})

export type WorkspaceAuditEventRow = InferSchemaType<typeof WorkspaceAuditEventSchema>
export const WorkspaceAuditEventModel = registerModel("WorkspaceAuditEvent", WorkspaceAuditEventSchema)
