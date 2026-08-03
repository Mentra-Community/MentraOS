/**
 * @fileoverview `reports` collection.
 *
 * Cloud V2 reports are the single durable record for manual bug reports,
 * automatic runtime reports, and feature/general feedback. The root record
 * captures the report kind, user/system-authored payload, engine-collected
 * runtime context, and typed evidence artifacts.
 *
 * Artifact entries hold metadata only. Payloads (screenshot bytes, serialized
 * log bundles) live in blob storage, described by a `report_assets` row keyed
 * by the same `artifactId` (see report-asset.model.ts). Keeping payloads out of
 * this document caps its size well below Mongo's 16MB document limit and keeps
 * report queries cheap. This layout shipped before the collection ever reached
 * a deployed environment, so no inline-payload documents exist to migrate.
 */

import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

const ReportArtifactSchema = new Schema(
  {
    artifactId: { type: String, required: true },
    type: {
      type: String,
      enum: ["logs", "screenshot", "state_snapshot"],
      required: true,
    },
    source: { type: String, required: true },
    filename: { type: String, default: null },
    contentType: { type: String, default: null },
    sizeBytes: { type: Number, default: null },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const ReportSchema = new Schema(
  {
    reportId: { type: String, required: true, unique: true, index: true },
    mentraUserId: { type: String, required: true, index: true },
    kind: {
      type: String,
      enum: ["bug", "feedback", "automatic"],
      required: true,
      index: true,
    },
    trigger: { type: Schema.Types.Mixed, default: null },
    report: { type: Schema.Types.Mixed, default: null },
    feedback: { type: Schema.Types.Mixed, default: null },
    context: { type: Schema.Types.Mixed, required: true },
    artifacts: { type: [ReportArtifactSchema], default: [] },
    status: {
      type: String,
      enum: ["collecting", "ready", "closed"],
      default: "collecting",
      index: true,
    },
  },
  { timestamps: true, collection: "reports" },
);

ReportSchema.index({ mentraUserId: 1, createdAt: -1 });
// Admin triage lists reports newest-first across all users.
ReportSchema.index({ createdAt: -1 });

export type Report = InferSchemaType<typeof ReportSchema>;
export const ReportModel = registerModel("Report", ReportSchema);
