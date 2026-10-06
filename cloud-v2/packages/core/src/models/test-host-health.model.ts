import { Schema } from "mongoose";
import { registerModel } from "./register-model";

// Separate from lane ownership and immutable routine results. No execution/cleanup authority.
const sample = new Schema({
  hostId: { type: String, required: true }, sampleId: { type: String, required: true },
  sampledAt: { type: Date, required: true }, receivedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true }, digest: { type: String, required: true },
  payload: { type: Schema.Types.Mixed, required: true },
}, { collection: "test_host_samples" });
sample.index({ hostId: 1, sampleId: 1 }, { unique: true });
sample.index({ hostId: 1, sampledAt: -1, sampleId: -1 }, { name: "host_sample_history" });
sample.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const TestHostSampleModel = registerModel("TestHostSample", sample);

// Keep each host's last observation after history expiry so an absent host does not disappear as healthy.
const latest = new Schema({
  hostId: { type: String, required: true }, sampledAt: { type: Date, required: true },
  sampleId: { type: String, required: true }, receivedAt: { type: Date, required: true },
  payload: { type: Schema.Types.Mixed, required: true },
}, { collection: "test_host_latest" });
latest.index({ hostId: 1 }, { unique: true });
export const TestHostLatestModel = registerModel("TestHostLatest", latest);
