import {Schema} from "mongoose";
import {registerModel} from "./register-model";

/** Native framework results. Startup reconciles this model's indexes before creating them. */
const schema = new Schema({
  runId: {type: String, required: true, unique: true},
  requestId: {type: String, required: true},
  routineId: {type: String, required: true}, definitionRevision: {type: String, required: true},
  hostId: {type: String, required: true}, platform: {type: String, required: true}, laneId: {type: String, required: true},
  startedAt: {type: Date, required: true}, completedAt: {type: Date, required: true},
  summaryProjection: {type: Schema.Types.Mixed},
  payloadSha256: {type: String, required: true}, payload: {type: Schema.Types.Mixed, required: true},
  uploadsComplete: {type: Boolean, required: true}, outcome: {type: String, required: true},
}, {collection: "test_runs", timestamps: true, autoIndex: false});
schema.index({requestId: 1}, {unique: true, name: "test_runs_terminal_request",
  partialFilterExpression: {"payload.schemaVersion": 1}});
schema.index({routineId: 1, platform: 1, definitionRevision: 1, outcome: 1, uploadsComplete: 1, startedAt: -1, runId: -1});
schema.index({startedAt: -1, runId: -1});
// Native readers must be able to exhaust a short page without fetching retained legacy payloads.
export const TEST_RUN_NATIVE_HISTORY_INDEX = "test_runs_native_history";
schema.index({startedAt: -1, runId: -1}, {name: TEST_RUN_NATIVE_HISTORY_INDEX,
  partialFilterExpression: {"payload.schemaVersion": 1}});
schema.index({hostId: 1, laneId: 1, startedAt: -1, runId: -1});
export const TEST_RUN_COMPLETION_INDEX = "test_runs_completed_at";
schema.index({completedAt: -1, runId: -1}, {name: TEST_RUN_COMPLETION_INDEX});
export const TestRunModel = registerModel("TestRun", schema);

/** One-time index cutover; old documents are retained but never parsed by native readers. */
export async function reconcileTestRunIndexes(collection = TestRunModel.collection): Promise<void> {
  let indexes;
  try {indexes = await collection.listIndexes().toArray();}
  catch (error) {if ((error as {code?: number}).code === 26) return; throw error;}
  for (const index of indexes) {
    const oldRequest = Object.keys(index.key).length === 1 && index.key.requestId === 1
      && (index.name !== "test_runs_terminal_request" || !index.unique
        || JSON.stringify(index.partialFilterExpression) !== JSON.stringify({"payload.schemaVersion": 1}));
    const oldCompletion = index.name === TEST_RUN_COMPLETION_INDEX
      && JSON.stringify(index.key) !== JSON.stringify({completedAt: -1, runId: -1});
    if (!oldRequest && !oldCompletion) continue;
    try {await collection.dropIndex(index.name!);}
    catch (error) {if ((error as {code?: number}).code !== 27) throw error;}
  }
}

const assetSchema = new Schema({
  runId: { type: String, required: true },
  assetId: { type: String, required: true },
  storageKey: { type: String, required: true },
  sizeBytes: { type: Number, required: true },
  sha256: { type: String, required: true },
}, { collection: "test_assets", timestamps: true });
assetSchema.index({ runId: 1, assetId: 1 }, { unique: true });

export const TestAssetModel = registerModel("TestAsset", assetSchema);
