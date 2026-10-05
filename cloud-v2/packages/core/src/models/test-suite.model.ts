import {Schema} from "mongoose";
import {registerModel} from "./register-model";
import {createLogger} from "@mentra/cloud-shared";
const logger = createLogger("core").child({component: "suite-timestamp-projection"});
const schema = new Schema({
  suiteId: {type: String, required: true, unique: true},
  payload: {type: Schema.Types.Mixed},
  payloadSha256: {type: String},
  nightlyPlan: {type: Schema.Types.Mixed, immutable: true},
  nightlyResult: {type: Schema.Types.Mixed},
  startedAt: {type: Date},
  finalizingAt: {type: String},
  finishedAt: {type: String},
  completedResult: {type: Schema.Types.Mixed},
}, {collection: "test_suites", timestamps: true});
schema.index({"payload.members.requestId": 1});
schema.index({createdAt: -1});
export const TEST_SUITE_HISTORY_INDEX = "test_suites_history";
schema.index({startedAt: -1, suiteId: -1}, {name: TEST_SUITE_HISTORY_INDEX});
export const TestSuiteModel = registerModel("TestSuite", schema);

/** Project the immutable payload timestamp without rewriting its plan or terminal verdict. */
export async function backfillTestSuiteStartedAt(collection = TestSuiteModel.collection,
  options: () => {maxTimeMS?: number} = () => ({})) {
  await collection.updateMany({startedAt: null, "payload.startedAt": {$type: "string"}},
    [{$set: {startedAt: {$convert: {input: "$payload.startedAt", to: "date", onError: null, onNull: null}}}}], options());
  const invalid = await collection.find({startedAt: null, "payload.members.1": {$exists: true},
    $expr: {$eq: [{$convert: {input: "$payload.startedAt", to: "date", onError: null, onNull: null}}, null]}}, options())
    .project({suiteId: 1}).limit(25).toArray();
  for (const row of invalid) logger.error({suiteId: row.suiteId}, "Suite payload timestamp cannot be projected for history");
}
