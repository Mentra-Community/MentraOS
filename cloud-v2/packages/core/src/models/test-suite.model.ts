import {Schema} from "mongoose";
import {registerModel} from "./register-model";
const schema = new Schema({
  suiteId: {type: String, required: true, unique: true},
  payload: {type: Schema.Types.Mixed, required: true},
  payloadSha256: {type: String, required: true},
  finishedAt: {type: String},
  completedResult: {type: Schema.Types.Mixed},
}, {collection: "test_suites", timestamps: true});
schema.index({"payload.members.requestId": 1});
schema.index({createdAt: -1});
export const TestSuiteModel = registerModel("TestSuite", schema);
