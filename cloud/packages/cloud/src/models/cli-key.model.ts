/**
 * CLI API Key Model
 *
 * Stores CLI authentication tokens for command-line tool access.
 * Each key belongs to a user and can be independently managed/revoked.
 */

import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * CLI API Key document interface
 */
export interface CLIKeyI extends Document {
  /** Unique key identifier (UUID v4) */
  keyId: string;

  /** Reference to user who owns this key */
  userId: Types.ObjectId;

  /** User email (denormalized for backward compatibility and queries) */
  email: string;

  /** User-friendly name for the key */
  name: string;

  /** SHA-256 hash of the JWT token (for revocation checks) */
  hashedToken: string;

  /** When the key was created */
  createdAt: Date;

  /** When the key was last updated */
  updatedAt: Date;

  /** Last time this key was used (optional tracking) */
  lastUsedAt?: Date;

  /** Optional expiration date */
  expiresAt?: Date;

  /** Whether key is active (false = revoked) */
  isActive: boolean;

  /** Optional metadata (e.g., IP address, user agent from creation) */
  metadata?: {
    createdFrom?: string;
    userAgent?: string;
  };
}

/**
 * CLI Key Schema
 */
const CLIKeySchema = new Schema<CLIKeyI>(
  {
    keyId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    hashedToken: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    lastUsedAt: {
      type: Date,
    },
    expiresAt: {
      type: Date,
      index: true,
    },
    isActive: {
      type: Boolean,
      required: true,
      default: true,
      index: true,
    },
    metadata: {
      createdFrom: String,
      userAgent: String,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        delete ret.hashedToken; // Never expose hashed token in JSON
        return ret;
      },
    },
  },
);

// Compound indexes for common queries
CLIKeySchema.index({ userId: 1, isActive: 1 });
CLIKeySchema.index({ email: 1, isActive: 1 });
CLIKeySchema.index({ userId: 1, createdAt: -1 });
CLIKeySchema.index({ email: 1, createdAt: -1 });
CLIKeySchema.index({ expiresAt: 1, isActive: 1 });

// Export model
export const CLIKey =
  mongoose.models.CLIKey || mongoose.model<CLIKeyI>("CLIKey", CLIKeySchema);

export default CLIKey;
