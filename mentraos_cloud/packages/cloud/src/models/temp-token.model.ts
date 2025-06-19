import mongoose, { Schema, Document } from 'mongoose';

export interface ITempToken extends Document {
  token: string;
  userId: string;
  packageName: string;
  createdAt: Date;
  used: boolean;
}

const TempTokenSchema: Schema = new Schema({
  token: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  packageName: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now, expires: '60s' }, // TTL index for automatic cleanup after 60 seconds
  used: { type: Boolean, default: false },
});

export const TempToken = mongoose.models.TempToken || mongoose.model<ITempToken>('TempToken', TempTokenSchema); 