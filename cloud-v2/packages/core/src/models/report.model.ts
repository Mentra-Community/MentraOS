/**
 * @fileoverview `reports` collection.
 *
 * Cloud V2 reports are the single durable record for manual bug reports,
 * automatic runtime reports, and feature/general feedback. The root record
 * captures the report kind, user/system-authored payload, toolkit-collected
 * runtime context, and typed evidence artifacts.
 */

import { Schema, model, type InferSchemaType } from "mongoose";

const ReportArtifactSchema = new Schema(
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
    dataBase64: { type: String, default: null },
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

export type Report = InferSchemaType<typeof ReportSchema>;
export const ReportModel = model("Report", ReportSchema);
