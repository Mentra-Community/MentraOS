import {Schema} from "mongoose";
import {registerModel} from "./register-model";
const schema = new Schema({
  suiteId: {type: String, required: true, unique: true},
  payload: {type: Schema.Types.Mixed, required: true},
  payloadSha256: {type: String, required: true},
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
export async function backfillTestSuiteStartedAt(collection = TestSuiteModel.collection) {
  await collection.updateMany({startedAt: {$exists: false}, "payload.startedAt": {$type: "string"}},
    [{$set: {startedAt: {$convert: {input: "$payload.startedAt", to: "date", onError: null, onNull: null}}}}]);
}
