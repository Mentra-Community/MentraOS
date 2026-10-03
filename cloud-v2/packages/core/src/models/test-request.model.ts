import {Schema} from "mongoose";
import {registerModel} from "./register-model";

/** Cloud admission only. Resource ownership lives in the host controller. */
const schema = new Schema({
  requestId: {type: String, required: true, unique: true},
  inputSha256: {type: String, required: true, immutable: true},
  input: {type: Schema.Types.Mixed, required: true, immutable: true},
  hostId: {type: String, required: true, immutable: true},
  state: {type: String, required: true, enum: ["queued", "accepted", "running", "terminal"]},
  hostReceipt: {type: Schema.Types.Mixed},
  hostRejection: {type: Schema.Types.Mixed},
  hostCancellation: {type: Schema.Types.Mixed},
  cancellationAcknowledged: {type: Boolean},
  runId: {type: String},
  terminalStatus: {type: String},
}, {collection: "test_requests", timestamps: true});
schema.index({state: 1, createdAt: 1, requestId: 1});
schema.index({hostId: 1, state: 1});
schema.index({hostId: 1, "hostCancellation.requestedAt": 1, requestId: 1},
  {partialFilterExpression: {hostCancellation: {$exists: true}}});
export const TestRequestModel = registerModel("TestRequest", schema);
