import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

export const RELEASE_STATUSES = [
  "draft",
  "submitted",
  "in_review",
  "accepted",
  "rejected",
  "published",
  "suspended",
] as const;

const MiniAppReleaseSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    miniAppId: { type: String, required: true, index: true },
    packageName: { type: String, required: true, index: true },
    version: { type: String, required: true },
    status: { type: String, enum: RELEASE_STATUSES, default: "draft", index: true },
    manifest: { type: Schema.Types.Mixed, required: true },
    releaseBundleAssetId: { type: String, default: null },
    bundleSha256: { type: String, default: null },
    bundleSizeBytes: { type: Number, default: null },
    manifestSha256: { type: String, default: null },
    signedBundlePayload: { type: Schema.Types.Mixed, default: null },
    signingKeyId: { type: String, default: null },
    bundleSignature: { type: String, default: null },
    signedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    reviewedBy: { type: String, default: null },
    reviewNotes: { type: String, default: null },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: "miniapp_releases" },
);

MiniAppReleaseSchema.index({ miniAppId: 1, version: 1 }, { unique: true });

export type MiniAppRelease = InferSchemaType<typeof MiniAppReleaseSchema>;
export const MiniAppReleaseModel = registerModel("MiniAppRelease", MiniAppReleaseSchema);
