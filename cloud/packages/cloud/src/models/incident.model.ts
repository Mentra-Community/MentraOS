// cloud/src/models/incident.model.ts
// Tracks bug report incidents for log aggregation and Linear integration
import mongoose, { Schema, Document } from "mongoose";

export interface IncidentI extends Document {
  incidentId: string;
  userId: string;
  status: "processing" | "complete" | "partial" | "failed";
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

export const Incident =
  mongoose.models.Incident ||
  mongoose.model<IncidentI>("Incident", IncidentSchema);
