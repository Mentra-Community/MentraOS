import { Schema } from "mongoose";
import { registerModel } from "./register-model";

// Latest reported observation per host guard. Separate from immutable results and
// CI claims: it is display metadata, never a claim, grant, lease or readiness verdict.
// Revisions are server-incremented compare-and-set values; no TTL or deletion path.
const schema = new Schema({
  hostId: { type: String, required: true },
  resourceKey: { type: String, required: true },
  revision: { type: Number, required: true },
  receivedAt: { type: Date, required: true },
  observation: { type: Schema.Types.Mixed, required: true },
  progress: { type: Schema.Types.Mixed },
  // Digest of the exact accepted request, so only that request can be replayed idempotently.
  requestSha256: { type: String, required: true },
}, { collection: "test_resource_observations", timestamps: true });
schema.index({ hostId: 1, resourceKey: 1 }, { unique: true });
schema.index({ receivedAt: -1, hostId: 1, resourceKey: 1 });

export const TestResourceObservationModel = registerModel("TestResourceObservation", schema);
