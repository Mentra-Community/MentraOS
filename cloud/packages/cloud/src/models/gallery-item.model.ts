// models/gallery-item.model.ts
// MongoDB model for gallery items (photos/videos synced from glasses)

import mongoose, { Schema, Document } from "mongoose";
import { StorageProviderType } from "../services/client/gallery/gallery.provider";

export interface GalleryItemI extends Document {
  _id: mongoose.Types.ObjectId;
  userId: string;
  type: "image" | "video";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageProvider: StorageProviderType;
  storageKey: string;
  thumbnailKey?: string; // Storage key for thumbnail (images only)
  status: "uploading" | "pending" | "synced" | "deleted";
  capturedAt: Date;
  uploadedAt?: Date;
  syncedAt?: Date;
  deletedAt?: Date;
  deviceId?: string;
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;
    gps?: { lat: number; lng: number };
  };
  createdAt: Date;
  updatedAt: Date;
}

const GalleryItemSchema = new Schema<GalleryItemI>(
  {
    userId: { type: String, required: true, index: true },
    type: { type: String, enum: ["image", "video"], required: true },
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    storageProvider: {
      type: String,
      enum: ["cloudflare-r2", "alibaba-oss"],
      required: true,
    },
    storageKey: { type: String, required: true, unique: true },
    thumbnailKey: { type: String }, // Storage key for thumbnail (images only)
    status: {
      type: String,
      enum: ["uploading", "pending", "synced", "deleted"],
      default: "uploading",
      index: true,
    },
    capturedAt: { type: Date, required: true },
    uploadedAt: { type: Date },
    syncedAt: { type: Date },
    deletedAt: { type: Date },
    deviceId: { type: String },
    metadata: {
      width: Number,
      height: Number,
      duration: Number,
      gps: {
        lat: Number,
        lng: Number,
      },
    },
  },
  { timestamps: true },
);

// Compound index for listing pending items
GalleryItemSchema.index({ userId: 1, status: 1, _id: -1 });

// TTL index: auto-delete synced/deleted records after 7 days
GalleryItemSchema.index(
  { syncedAt: 1 },
  {
    expireAfterSeconds: 7 * 24 * 60 * 60,
    partialFilterExpression: { status: "synced" },
  },
);

export const GalleryItem =
  (mongoose.models.GalleryItem as mongoose.Model<GalleryItemI>) ||
  mongoose.model<GalleryItemI>("GalleryItem", GalleryItemSchema);
