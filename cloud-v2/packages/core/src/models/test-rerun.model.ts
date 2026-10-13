import {Schema} from "mongoose";
import {registerModel} from "./register-model";
const schema = new Schema({
  rerunId: {type: String, required: true, unique: true},
  inputDigest: {type: String, required: true},
  previewDigest: {type: String, required: true},
  plan: {type: Schema.Types.Mixed, required: true, immutable: true},
  state: {type: String, enum: ["preview", "accepted"], required: true},
  acceptedAt: {type: String},
  // Set atomically for the entire batch at acceptance. One successor per predecessor.
  claimKeys: {type: [String], default: undefined},
}, {collection: "test_reruns", timestamps: true});
schema.index({claimKeys: 1}, {unique: true, sparse: true});
schema.index({"plan.members.rootKey": 1, state: 1, "plan.createdAt": -1});
schema.index({"plan.members.requestId": 1});
schema.index({"plan.parent.suiteId": 1, state: 1, acceptedAt: -1, rerunId: -1});
schema.index({"plan.parent.requestId": 1, state: 1});
export const TestRerunModel = registerModel("TestRerun", schema);
