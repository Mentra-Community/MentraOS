import { Schema } from "mongoose";
import { registerModel } from "./register-model";

export const TEST_RUN_COMPLETION_INDEX = "test_runs_completed_at";
const schema = new Schema({
  runId: { type: String, required: true, unique: true },
  requestId: { type: String, required: true, index: true },
  startedAt: { type: Date, required: true },
  // Server-derived from validated payload.finishedAt. Null marks an unparseable legacy value.
  completedAt: { type: Date },
  completionProjectionVersion: { type: Number, enum: [1] },
  payloadSha256: { type: String, required: true },
  payload: { type: Schema.Types.Mixed, required: true },
  // Server-owned upload projection; the source payload and its digest never change.
  uploadsComplete: { type: Boolean, required: true },
  outcome: { type: String, required: true },
  // Canonical occurrences and the delivery outbox share the accepted metadata
  // insert. This is not an analysis execution queue; the dev-agent owns that.
  failureOccurrences: { type: [Schema.Types.Mixed], default: undefined },
  // Validated recovery ancestry and references to existing occurrences, never another delivery outbox.
  recoveryLineage: { type: Schema.Types.Mixed },
  // Admin-reviewed provenance corrections of existing occurrences (at most one each), with
  // their own delivery receipts. They never replace the payload, its digest or an occurrence.
  provenanceCorrections: { type: [Schema.Types.Mixed], default: undefined },
  // Bounded reviewed diagnostic additions; original payload, source, outcome and assets remain immutable.
  evidenceSupplements: { type: [Schema.Types.Mixed], default: undefined },
}, { collection: "test_runs", timestamps: true });
schema.index({ startedAt: -1, runId: -1 });
schema.index({ completionProjectionVersion: 1, completedAt: -1, runId: -1 }, { name: TEST_RUN_COMPLETION_INDEX });
schema.index({ "payload.prNumber": 1, startedAt: -1 });
schema.index({ "payload.channel": 1, startedAt: -1 });
schema.index({ outcome: 1, startedAt: -1 });
// runId is already unique; occurrence IDs are derived from it and validated
// phase/step pairs. Empty arrays on passing runs need no unique multikey index.
schema.index({ "failureOccurrences.occurrenceId": 1 }, { sparse: true });
schema.index({ "recoveryLineage.inheritedFailures.occurrenceId": 1 }, { sparse: true });
schema.index({ "failureOccurrences.delivery.state": 1, startedAt: 1 });
schema.index({ "provenanceCorrections.delivery.state": 1 }, { sparse: true });
schema.index({ "evidenceSupplements.delivery.state": 1 }, { sparse: true });

const assetSchema = new Schema({
  runId: { type: String, required: true },
  assetId: { type: String, required: true },
  storageKey: { type: String, required: true },
  sizeBytes: { type: Number, required: true },
  sha256: { type: String, required: true },
}, { collection: "test_assets", timestamps: true });
assetSchema.index({ runId: 1, assetId: 1 }, { unique: true });

export const TestRunModel = registerModel("TestRun", schema);
export const TestAssetModel = registerModel("TestAsset", assetSchema);
