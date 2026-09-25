import { Schema } from "mongoose";
import { registerModel } from "./register-model";

// Separate from test_runs: recovery can publish several results for one request.
// No TTL index, deletion or reassignment path. Startup awaits the unique index.
const schema = new Schema({
  requestId: { type: String, required: true, unique: true },
  claim: { type: Schema.Types.Mixed, required: true },
  executionTokenSha256: { type: String, required: true },
  // Separate projection: old claim/settlement responses stay byte-shape compatible.
  progress: { type: Schema.Types.Mixed },
  // Admin follow-up closure is separate from the immutable worker settlement.
  followUpCancellation: { type: Schema.Types.Mixed },
  // Original-owner closure of a recovery-required claim; claim/settlement stay unchanged.
  closure: { type: Schema.Types.Mixed },
}, { collection: "test_run_claims", timestamps: true });

export const TestRunClaimModel = registerModel("TestRunClaim", schema);
