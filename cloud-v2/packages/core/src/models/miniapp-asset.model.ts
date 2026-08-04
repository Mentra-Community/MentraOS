import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

export const MINIAPP_ASSET_ROLES = [
  "release_bundle",
  "store_icon",
  "store_cover",
  "gallery_screenshot",
  "promo_video",
] as const;

const MiniAppAssetSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    miniAppId: { type: String, required: true, index: true },
    releaseId: { type: String, default: null, index: true },
    role: { type: String, enum: MINIAPP_ASSET_ROLES, required: true, index: true },
    storageKey: { type: String, required: true, unique: true },
    fileName: { type: String, required: true },
    contentType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    durationMs: { type: Number, default: null },
    sortOrder: { type: Number, default: null },
    createdBy: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "miniapp_assets" },
);

export type MiniAppAsset = InferSchemaType<typeof MiniAppAssetSchema>;
export const MiniAppAssetModel = registerModel("MiniAppAsset", MiniAppAssetSchema);
