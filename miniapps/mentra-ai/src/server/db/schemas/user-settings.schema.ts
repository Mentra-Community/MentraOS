/**
 * User Settings Schema
 *
 * Stores per-user preferences and settings.
 */

import mongoose, { Schema, Document } from 'mongoose';

/**
 * User settings document
 */
export interface IUserSettings extends Document {
  userId: string;
  theme: 'light' | 'dark';
  chatHistoryEnabled: boolean;
  /** Selected model key (see MODEL_OPTIONS in constants/config). */
  model: string;
  createdAt: Date;
  updatedAt: Date;
}

const UserSettingsSchema = new Schema<IUserSettings>({
  userId: { type: String, required: true, unique: true, index: true },
  theme: { type: String, enum: ['light', 'dark'], default: 'dark' },
  chatHistoryEnabled: { type: Boolean, default: false },
  model: { type: String, default: 'flashLite' },
}, { timestamps: true });

export const UserSettings = mongoose.model<IUserSettings>('UserSettings', UserSettingsSchema);
