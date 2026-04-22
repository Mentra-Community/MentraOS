// cloud/src/models/incident.model.ts
// Tracks bug report incidents for log aggregation and Linear integration
import mongoose, { Schema, Document } from "mongoose";
import type { IncidentSubmissionMode } from "../types/feedback.types";

export interface IncidentI extends Document {
  incidentId: string;
  userId: string;
  status: "processing" | "complete" | "partial" | "failed";
  submissionMode?: IncidentSubmissionMode;
  triggerArea?: string;
  triggerReason?: string;
  sourceAppletPackageName?: string;
  sourceAppletName?: string;
  summary?: string;
  linearIssueId?: string;
  linearIssueUrl?: string;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const IncidentSchema = new Schema<IncidentI>(
  {
    incidentId: {
      type: Schema.Types.String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: Schema.Types.String,
      required: true,
      index: true,
    },
    status: {
      type: Schema.Types.String,
      enum: ["processing", "complete", "partial", "failed"],
      default: "processing",
    },
    submissionMode: {
      type: Schema.Types.String,
      enum: ["USER_INITIATED", "AUTOMATIC"],
    },
    triggerArea: {
      type: Schema.Types.String,
    },
    triggerReason: {
      type: Schema.Types.String,
    },
    sourceAppletPackageName: {
      type: Schema.Types.String,
    },
    sourceAppletName: {
      type: Schema.Types.String,
    },
    summary: {
      type: Schema.Types.String,
    },
    linearIssueId: {
      type: Schema.Types.String,
    },
    linearIssueUrl: {
      type: Schema.Types.String,
    },
    errorMessage: {
      type: Schema.Types.String,
    },
  },
  {
    timestamps: true,
  },
);

// Index for efficient queries by userId and status
IncidentSchema.index({ userId: 1, createdAt: -1 });
IncidentSchema.index({ status: 1 });
IncidentSchema.index({ submissionMode: 1, createdAt: -1 });
IncidentSchema.index({ triggerArea: 1, createdAt: -1 });
IncidentSchema.index({ triggerReason: 1, createdAt: -1 });
IncidentSchema.index({ sourceAppletPackageName: 1, createdAt: -1 });

export const Incident =
  mongoose.models.Incident ||
  mongoose.model<IncidentI>("Incident", IncidentSchema);
