import mongoose, { Schema, Document } from 'mongoose';

/**
 * Interface for GalleryPhoto document
 */
export interface GalleryPhotoDocument extends Document {
  userId: string;        // User who owns the photo
  filename: string;      // Filename in storage
  photoUrl: string;      // URL to access the photo
  requestId: string;     // Original request ID that triggered the photo
  appId: string;         // App that requested the photo
  uploadDate: Date;      // When the photo was uploaded
  metadata?: {
    originalFilename?: string;
    size?: number;
    mimeType?: string;
    width?: number;
    height?: number;
    deviceInfo?: string;
  };
}

/**
 * Mongoose schema for GalleryPhoto
 */
const GalleryPhotoSchema = new Schema<GalleryPhotoDocument>({
  userId: {
    type: String,
    required: true,
    index: true
  },
  filename: {
    type: String,
    required: true
  },
  photoUrl: {
    type: String,
    required: true
  },
  requestId: {
    type: String,
    required: true
  },
  appId: {
    type: String,
    required: true
  },
  uploadDate: {
    type: Date,
    default: Date.now
  },
  metadata: {
    originalFilename: String,
    size: Number,
    mimeType: String,
    width: Number,
    height: Number,
    deviceInfo: String
  }
}, {
  timestamps: true
});

// Add methods or static functions
interface GalleryPhotoModel extends mongoose.Model<GalleryPhotoDocument> {
  findByUserId(userId: string): Promise<GalleryPhotoDocument[]>;
  findAndDeleteById(photoId: string, userId: string): Promise<boolean>;
}

/**
 * Get all photos for a user, sorted by upload date (most recent first)
 */
GalleryPhotoSchema.statics.findByUserId = async function(userId: string): Promise<GalleryPhotoDocument[]> {
  return this.find({ userId }).sort({ uploadDate: -1 });
};

/**
 * Delete a photo if it belongs to the specified user
 * Returns true if deleted, false if not found or not owned by user
 */
GalleryPhotoSchema.statics.findAndDeleteById = async function(photoId: string, userId: string): Promise<boolean> {
  const result = await this.deleteOne({ _id: photoId, userId });
  return result.deletedCount > 0;
};

// Export the model
export const GalleryPhoto = (mongoose.models.GalleryPhoto || mongoose.model<GalleryPhotoDocument, GalleryPhotoModel>(
  'GalleryPhoto', 
  GalleryPhotoSchema
)) as GalleryPhotoModel;