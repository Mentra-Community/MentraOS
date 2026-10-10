/**
 * @fileoverview `reports` collection.
 *
 * Cloud V2 reports are the single durable record for manual bug reports,
 * automatic runtime reports, and feature/general feedback. The root record
 * captures the report kind, user/system-authored payload, engine-collected
 * runtime context, and typed evidence artifacts.
 *
 * Artifact entries hold metadata only. Payloads (screenshot and MP4 video
 * bytes, serialized log bundles) live in blob storage, described by a `report_assets` row keyed
 * by the same `artifactId` (see report-asset.model.ts). Keeping payloads out of
 * this document caps its size well below Mongo's 16MB document limit and keeps
 * report queries cheap. This layout shipped before the collection ever reached
 * a deployed environment, so no inline-payload documents exist to migrate.
 */

import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";
import {REPORT_LOG_SOURCES} from '../services/report-log-collection';

const LogCollectionSourceSchema = new Schema({
  state: {type: String, enum: ['requested', 'received', 'unavailable', 'failed', 'timed-out'], required: true},
  requestedAt: {type: String, required: true}, deadlineAt: {type: String, required: true},
  reason: String, receivedAt: String, artifactId: String, entryCount: Number,
  leaseUntil: Date,
}, {_id: false});
const LogCollectionSchema = new Schema(Object.fromEntries(REPORT_LOG_SOURCES.map(source => [source, LogCollectionSourceSchema])), {_id: false});
const AutomationCorrelationSchema = new Schema({
  alertId: {type: String, required: true}, testRunId: {type: String, required: true},
}, {_id: false});

const ReportArtifactSchema = new Schema(
  {
    artifactId: { type: String, required: true },
    type: {
      type: String,
      enum: ["logs", "screenshot", "state_snapshot", "video"],
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
    automationCorrelation: {type: AutomationCorrelationSchema},
    // Native completion retries own notification delivery; no separate worker or queue.
    slackDelivery: { type: Schema.Types.Mixed },
    logCollection: {type: LogCollectionSchema},
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
// Nonunique on purpose: duplicate requests remain visible and recovery refuses
// ambiguous bindings instead of selecting an arbitrary report or account.
ReportSchema.index({'automationCorrelation.testRunId': 1, 'automationCorrelation.alertId': 1});
// Admin triage lists reports newest-first across all users.
ReportSchema.index({ createdAt: -1 });
ReportSchema.index({ "slackDelivery.nextAttemptAt": 1 });
ReportSchema.index({'logCollection.cloud.state': 1, createdAt: 1});
ReportSchema.index({'logCollection.miniapp_server.state': 1, createdAt: 1});

export type Report = InferSchemaType<typeof ReportSchema>;
export const ReportModel = registerModel("Report", ReportSchema);
