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
export const MINIAPP_RELEASE_TRACKS = ["stable", "beta"] as const;

const StoreListingSubmissionLeaseSchema = new Schema(
  {
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false },
);

const MiniAppReleaseSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    miniAppId: { type: String, required: true, index: true },
    packageName: { type: String, required: true, index: true },
    version: { type: String, required: true },
    /** Distribution track is chosen at upload and immutable for this release. */
    releaseTrack: { type: String, enum: MINIAPP_RELEASE_TRACKS, default: "stable", index: true, immutable: true },
    status: { type: String, enum: RELEASE_STATUSES, default: "draft", index: true },
    manifest: { type: Schema.Types.Mixed, required: true },
    releaseBundleAssetId: { type: String, default: null },
    bundleSha256: { type: String, default: null },
    bundleSizeBytes: { type: Number, default: null },
    manifestSha256: { type: String, default: null },
    publisherKeyFingerprint: { type: String, default: null },
    publisherPublicKeyJwk: { type: Schema.Types.Mixed, default: null },
    contentSha256: { type: String, default: null },
    signedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    reviewedBy: { type: String, default: null },
    /** Set only by Mentra review. Private stable and closed-beta publication leaves this null. */
    publicStoreApprovedAt: { type: Date, default: null },
    reviewNotes: { type: String, default: null },
    /** Exact developer listing frozen when this release enters review. */
    submittedStoreListing: { type: Schema.Types.Mixed, default: null },
    /**
     * Short-lived claim that fences the cross-document transition from the
     * mutable app listing to this release's immutable review snapshot.
     */
    storeListingSubmissionLease: { type: StoreListingSubmissionLeaseSchema, default: null },
    /** Exact Store listing approved by an admin; publication never reads the mutable developer draft. */
    reviewedStoreListing: { type: Schema.Types.Mixed, default: null },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: "miniapp_releases" },
);

MiniAppReleaseSchema.index({ miniAppId: 1, version: 1 }, { unique: true });

export type MiniAppRelease = InferSchemaType<typeof MiniAppReleaseSchema>;
export const MiniAppReleaseModel = registerModel("MiniAppRelease", MiniAppReleaseSchema);
