import {Schema} from "mongoose";
import {registerModel} from "./register-model";

/** Native framework results only. No legacy payload reader or migration fallback. */
const schema = new Schema({
  runId: {type: String, required: true, unique: true},
  requestId: {type: String, required: true, unique: true},
  routineId: {type: String, required: true}, definitionRevision: {type: String, required: true},
  platform: {type: String, required: true}, laneId: {type: String, required: true},
  startedAt: {type: Date, required: true}, completedAt: {type: Date, required: true},
  payloadSha256: {type: String, required: true}, payload: {type: Schema.Types.Mixed, required: true},
  uploadsComplete: {type: Boolean, required: true}, outcome: {type: String, required: true},
}, {collection: "test_runs", timestamps: true});
schema.index({routineId: 1, platform: 1, definitionRevision: 1, outcome: 1, uploadsComplete: 1, startedAt: -1, runId: -1});
schema.index({startedAt: -1, runId: -1});
export const TEST_RUN_COMPLETION_INDEX = "test_runs_completed_at";
schema.index({completedAt: -1, runId: -1}, {name: TEST_RUN_COMPLETION_INDEX});
export const TestRunModel = registerModel("TestRun", schema);

const assetSchema = new Schema({
  runId: { type: String, required: true },
  assetId: { type: String, required: true },
  storageKey: { type: String, required: true },
  sizeBytes: { type: Number, required: true },
  sha256: { type: String, required: true },
}, { collection: "test_assets", timestamps: true });
assetSchema.index({ runId: 1, assetId: 1 }, { unique: true });

export const TestAssetModel = registerModel("TestAsset", assetSchema);
