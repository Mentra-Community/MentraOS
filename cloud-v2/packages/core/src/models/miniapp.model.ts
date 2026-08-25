import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

export const MINIAPP_STATUSES = ["active", "archived", "suspended"] as const;
export const MINIAPP_REVIEW_TIERS = ["community", "verified"] as const;

const StoreListingSchema = new Schema(
  {
    subtitle: { type: String, default: null },
    longDescription: { type: String, default: null },
    categories: { type: [String], default: [] },
    privacyPolicyUrl: { type: String, default: null },
    supportUrl: { type: String, default: null },
    websiteUrl: { type: String, default: null },
    reviewTier: { type: String, enum: MINIAPP_REVIEW_TIERS, default: "community" },
    featured: { type: Boolean, default: false },
    iconAssetId: { type: String, default: null },
    coverAssetId: { type: String, default: null },
    screenshotAssetIds: { type: [String], default: [] },
  },
  { _id: false },
);

const StoreListingOperationLeaseSchema = new Schema(
  {
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false },
);

const MiniAppSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    packageName: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    description: { type: String, default: null },
    /** Developer-editable draft. Copied to publishedStoreListing only after admin publication. */
    storeListing: { type: StoreListingSchema, default: () => ({}) },
    /** Immutable public snapshot from the latest publication decision. */
    publishedStoreListing: { type: StoreListingSchema, default: null },
    /** Immutable public snapshot paired with the active beta release. */
    publishedBetaStoreListing: { type: StoreListingSchema, default: null },
    /**
     * Short database-backed lease shared by submission and artwork deletion.
     * It prevents a frozen review snapshot from racing an object deletion,
     * including when the operations land on different Core processes.
     */
    storeListingOperationLease: { type: StoreListingOperationLeaseSchema, default: null },
    status: { type: String, enum: MINIAPP_STATUSES, default: "active", index: true },
    /** Active stable release. Kept under the original name for deployed-row compatibility. */
    activeReleaseId: { type: String, default: null },
    /** Active beta release, independently published from stable. */
    activeBetaReleaseId: { type: String, default: null },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: "miniapps" },
);

MiniAppSchema.index({ orgId: 1, packageName: 1 }, { unique: true });

export type MiniApp = InferSchemaType<typeof MiniAppSchema>;
export const MiniAppModel = registerModel("MiniApp", MiniAppSchema);
