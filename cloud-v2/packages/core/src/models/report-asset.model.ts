/**
 * @fileoverview `report_assets` collection.
 *
 * One row per stored report artifact payload (screenshot bytes, serialized log
 * bundles). Follows the MiniAppAsset pattern: the payload itself lives in blob
 * storage under `storageKey` (see services/storage) and Mongo keeps only the
 * metadata row, so `reports` documents stay small no matter how many artifacts
 * a report collects. `artifactId` joins the row to the artifact entry embedded
 * in the owning report document.
 */

import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

const ReportAssetSchema = new Schema(
  {
    artifactId: { type: String, required: true, unique: true },
    reportId: { type: String, required: true, index: true },
    mentraUserId: { type: String, required: true, index: true },
    storageKey: { type: String, required: true, unique: true },
    fileName: { type: String, default: null },
    contentType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    sha256: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "report_assets" },
);

export type ReportAsset = InferSchemaType<typeof ReportAssetSchema>;
export const ReportAssetModel = registerModel("ReportAsset", ReportAssetSchema);
