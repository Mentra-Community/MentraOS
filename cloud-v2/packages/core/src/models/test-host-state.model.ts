import {Schema} from "mongoose";
import {registerModel} from "./register-model";

const schema = new Schema({hostId: {type: String, required: true}, incarnation: {type: String, required: true},
  sequence: {type: Number, required: true}, observedAt: {type: Date, required: true},
  snapshot: {type: Schema.Types.Mixed, required: true}}, {collection: "test_host_state"});
schema.index({hostId: 1}, {unique: true});
export const TestHostStateModel = registerModel("TestHostState", schema);
