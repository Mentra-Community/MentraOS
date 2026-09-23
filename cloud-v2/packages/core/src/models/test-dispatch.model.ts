import { Schema } from "mongoose";
import { registerModel } from "./register-model";

// Retain the send fence permanently. GitHub, not this collection, schedules jobs.
const schema = new Schema({
  dispatchId: { type: String, required: true, unique: true },
  inputSha256: { type: String, required: true },
  receipt: { type: Schema.Types.Mixed, required: true },
}, { collection: "test_dispatches", timestamps: true });
schema.index({ "receipt.createdAt": -1 });
export const TestDispatchModel = registerModel("TestDispatch", schema);
