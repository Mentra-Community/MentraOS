/**
 * @fileoverview `workspace_audit_counters` collection. A single document
 * ({@link WORKSPACE_AUDIT_COUNTER_ID}) holding the last change-feed sequence
 * number issued.
 *
 * Every audit event takes its `seq` by incrementing this document inside the
 * transaction that records the event. Two such transactions conflict on the
 * document, so the second can only run after the first has committed or
 * aborted: sequence order is commit order, and an aborted transaction rolls
 * its increment back, so the committed sequence has no gaps. That is what lets
 * a poller use `seq` as a cursor without ever skipping a later-committed event.
 *
 * The counter has a fixed `_id`, so uniqueness (and therefore a safe upsert)
 * does not depend on a secondary index having been built.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

/** The `_id` of the one change-feed counter document. */
export const WORKSPACE_AUDIT_COUNTER_ID = "workspace_changes"

const WorkspaceAuditCounterSchema = new Schema(
  {
    _id: {type: String, required: true},
    seq: {type: Number, required: true, default: 0},
  },
  {collection: "workspace_audit_counters", versionKey: false},
)

export type WorkspaceAuditCounterRow = InferSchemaType<typeof WorkspaceAuditCounterSchema>
export const WorkspaceAuditCounterModel = registerModel("WorkspaceAuditCounter", WorkspaceAuditCounterSchema)
