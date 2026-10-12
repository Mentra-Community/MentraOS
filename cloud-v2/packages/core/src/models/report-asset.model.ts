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
    // Several reports can reference the same immutable test-run blob.
    storageKey: { type: String, required: true },
    fileName: { type: String, default: null },
    contentType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    // Shared native evidence remains owned by the test run; it is not copied.
    sourceTestRunId: { type: String },
    sourceTestAssetId: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "report_assets" },
);

// getReport orders attachments by createdAt. Cosmos DB's MongoDB API rejects
// a sort on an unindexed path, even when reportId itself is indexed.
ReportAssetSchema.index({ createdAt: 1 });

export type ReportAsset = InferSchemaType<typeof ReportAssetSchema>;
export const ReportAssetModel = registerModel("ReportAsset", ReportAssetSchema);

/** Remove the former payload-ownership constraint before serving shared references. */
export async function reconcileReportAssetIndexes(collection = ReportAssetModel.collection): Promise<void> {
  let indexes;
  try {indexes = await collection.listIndexes().toArray();}
  catch (error) {if ((error as {code?: number}).code === 26) return; throw error;}
  for (const index of indexes) {
    if (!index.unique || Object.keys(index.key).length !== 1 || index.key.storageKey !== 1) continue;
    try {await collection.dropIndex(index.name!);}
    catch (error) {if ((error as {code?: number}).code !== 27) throw error;}
  }
}
