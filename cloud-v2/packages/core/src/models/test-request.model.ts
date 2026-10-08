import {Schema} from "mongoose";
import {registerModel} from "./register-model";

/** Cloud admission only. Resource ownership lives in the host controller. */
function executableInputRequired(this: {state?: string; preparationCancellation?: unknown; preparationRejection?: unknown; fleetSelection?: unknown; fleetCancellation?: unknown}) {
  return !this.fleetCancellation && !['preparing', 'awaiting-source', 'awaiting-runner'].includes(this.state ?? '') && !this.preparationCancellation && !this.preparationRejection;
}
const schema = new Schema({
  requestId: {type: String, required: true, unique: true},
  inputSha256: {type: String, required: executableInputRequired, immutable: true},
  input: {type: Schema.Types.Mixed, required: executableInputRequired, immutable: true},
  dispatchIntent: {type: Schema.Types.Mixed, immutable: true},
  dispatchIntentSha256: {type: String, immutable: true},
  preparation: {type: Schema.Types.Mixed},
  preparationCancellation: {type: Schema.Types.Mixed},
  preparationRejection: {type: Schema.Types.Mixed},
  preparationCheckedAt: {type: Date},
  hostId: {type: String, required: function(this: {fleetSelection?: unknown}) {return !this.fleetSelection;}, immutable: true},
  fleetSelection: {type: Schema.Types.Mixed, immutable: true},
  fleetSelectionSha256: {type: String, immutable: true},
  fleetPreparation: {type: Schema.Types.Mixed, immutable: true},
  fleetInputSha256: {type: String, immutable: true},
  fleetDeadline: {type: Date, immutable: true},
  fleetTarget: {type: Schema.Types.Mixed, immutable: true},
  fleetBinding: {type: Schema.Types.Mixed, immutable: true},
  fleetCancellation: {type: Schema.Types.Mixed},
  fleetDispatch: {type: Schema.Types.Mixed},
  dispatchCompletion: {type: Schema.Types.Mixed, immutable: true},
  fleetActionsCancellation: {type: Schema.Types.Mixed},
  fleetActions: {type: [Schema.Types.Mixed], default: undefined},
  state: {type: String, required: true, enum: ["awaiting-source", "awaiting-runner", "preparing", "queued", "accepted", "running", "terminal"]},
  hostReceipt: {type: Schema.Types.Mixed},
  hostRejection: {type: Schema.Types.Mixed},
  hostCancellation: {type: Schema.Types.Mixed},
  cancellationAcknowledged: {type: Boolean},
  runId: {type: String},
  terminalStatus: {type: String},
  catalogEligible: {type: Boolean},
}, {collection: "test_requests", timestamps: true});
schema.index({state: 1, createdAt: 1, requestId: 1});
schema.index({hostId: 1, state: 1});
schema.index({hostId: 1, state: 1, preparationCheckedAt: 1, createdAt: 1, requestId: 1});
schema.index({hostId: 1, "hostCancellation.requestedAt": 1, requestId: 1},
  {partialFilterExpression: {hostCancellation: {$exists: true}}});
export const TestRequestModel = registerModel("TestRequest", schema);
