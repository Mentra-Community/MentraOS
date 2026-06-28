/**
 * @fileoverview `incidents` collection.
 *
 * Cloud V2 incidents are diagnostic cases, not feedback rows. The root record
 * captures why the case exists (`trigger`), what was observed (`report`), the
 * runtime snapshot (`context`), and typed evidence (`artifacts`).
 */

import { Schema, model, type InferSchemaType } from "mongoose";

const IncidentArtifactSchema = new Schema(
  {
    artifactId: { type: String, required: true },
    type: {
      type: String,
      enum: ["logs", "screenshot", "state_snapshot"],
      required: true,
    },
    source: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: null },
    filename: { type: String, default: null },
    contentType: { type: String, default: null },
    sizeBytes: { type: Number, default: null },
    /**
     * Temporary inline storage until cloud-core's storage-service is specced.
     * Kept behind the incident service so it can move to object storage without
     * changing the client/API contract.
     */
    dataBase64: { type: String, default: null },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const IncidentSchema = new Schema(
  {
    incidentId: { type: String, required: true, unique: true, index: true },
    mentraUserId: { type: String, required: true, index: true },
    trigger: { type: Schema.Types.Mixed, required: true },
    report: { type: Schema.Types.Mixed, required: true },
    context: { type: Schema.Types.Mixed, required: true },
    dedupeKey: { type: String, default: null, index: true },
    artifacts: { type: [IncidentArtifactSchema], default: [] },
    status: {
      type: String,
      enum: ["collecting", "ready", "closed"],
      default: "collecting",
      index: true,
    },
  },
  { timestamps: true, collection: "incidents" },
);

IncidentSchema.index({ mentraUserId: 1, createdAt: -1 });
IncidentSchema.index({ mentraUserId: 1, dedupeKey: 1, createdAt: -1 });

export type Incident = InferSchemaType<typeof IncidentSchema>;
export const IncidentModel = model("Incident", IncidentSchema);
