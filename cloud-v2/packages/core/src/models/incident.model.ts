/**
 * @fileoverview `incidents` collection.
 *
 * Device-filed bug reports and feedback diagnostics. This is durable user data,
 * so it lives in cloud-core (Mongo) rather than runtime. Runtime may contribute
 * logs later, but core owns the incident record and user authorization.
 */

import { Schema, model, type InferSchemaType } from "mongoose";

const IncidentLogEntrySchema = new Schema(
  {
    timestamp: { type: Number, required: true },
    level: { type: String, required: true },
    message: { type: String, required: true },
    source: { type: String, default: null },
  },
  { _id: false },
);

const IncidentAttachmentSchema = new Schema(
  {
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    /**
     * Temporary inline storage until cloud-core's storage-service is specced.
     * Kept behind the incident service so it can move to object storage without
     * changing the client/API contract.
     */
    dataBase64: { type: String, required: true },
    uploadedAt: { type: Date, required: true },
  },
  { _id: false },
);

const IncidentSchema = new Schema(
  {
    incidentId: { type: String, required: true, unique: true, index: true },
    mentraUserId: { type: String, required: true, index: true },
    feedback: { type: Schema.Types.Mixed, required: true },
    phoneState: { type: Schema.Types.Mixed, default: null },
    phoneLogs: { type: [IncidentLogEntrySchema], default: [] },
    attachments: { type: [IncidentAttachmentSchema], default: [] },
    status: {
      type: String,
      enum: ["open", "processing", "closed"],
      default: "open",
      index: true,
    },
  },
  { timestamps: true, collection: "incidents" },
);

IncidentSchema.index({ mentraUserId: 1, createdAt: -1 });

export type Incident = InferSchemaType<typeof IncidentSchema>;
export const IncidentModel = model("Incident", IncidentSchema);

