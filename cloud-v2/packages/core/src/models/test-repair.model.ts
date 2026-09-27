import { Schema } from "mongoose";
import { registerModel } from "./register-model";

// Retain the send fence permanently. The owned private executor, not this collection, runs repairs.
const schema = new Schema({
  repairId: { type: String, required: true, unique: true },
  inputSha256: { type: String, required: true },
  receipt: { type: Schema.Types.Mixed, required: true },
}, { collection: "test_repairs", timestamps: true });
export const TestRepairModel = registerModel("TestRepair", schema);
