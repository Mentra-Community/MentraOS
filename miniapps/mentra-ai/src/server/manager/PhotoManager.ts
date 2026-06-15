import type { User } from "../session/User";
import { PHOTO_SETTINGS } from "../constants/config";

export interface StoredPhoto {
  requestId: string;
  buffer: Buffer;
  timestamp: Date;
  userId: string;
  mimeType: string;
  filename: string;
  size: number;
}

interface SSEWriter {
  write: (data: string) => void;
  userId: string;
  close: () => void;
}

/**
 * PhotoManager — captures, stores, and broadcasts photos for a single user.
 *
 * Features:
 * - Captures photos from glasses camera
 * - Stores current + previous photos for context
 * - Broadcasts to SSE clients
 */
export class PhotoManager {
  private photos: Map<string, StoredPhoto> = new Map();
  private sseClients: Set<SSEWriter> = new Set();

  // Current and previous photos for context
  private currentPhoto: StoredPhoto | null = null;
  private previousPhotos: StoredPhoto[] = [];

  constructor(private user: User) {}

  /**
   * Capture a photo from the glasses and store + broadcast it
   * Also rotates previous photos for context
   */
  async takePhoto(): Promise<StoredPhoto | null> {
    const session = this.user.appSession;
    if (!session) {
      console.warn("No active glasses session for photo capture");
      return null;
    }

    try {
      const photo = await session.camera.requestPhoto({ sound: false });

      const stored: StoredPhoto = {
        requestId: photo.requestId,
        buffer: photo.buffer,
        timestamp: photo.timestamp,
        userId: this.user.userId,
        mimeType: photo.mimeType,
        filename: photo.filename,
        size: photo.size,
      };

      // Rotate photos for context
      this.rotatePhotos(stored);

      // Store in map for API access
      this.photos.set(photo.requestId, stored);

      // Broadcast to SSE clients
      this.broadcastPhoto(stored);

      console.log(
        `📸 Photo captured for ${this.user.userId} (${photo.size} bytes)`,
      );

      return stored;
    } catch (error) {
      console.error(`Failed to capture photo for ${this.user.userId}:`, error);
      return null;
    }
  }

  /**
   * Rotate photos: current becomes previous, new becomes current
   */
  private rotatePhotos(newPhoto: StoredPhoto): void {
    // Move current to previous (if exists)
    if (this.currentPhoto) {
      this.previousPhotos.push(this.currentPhoto);
      // Keep only the configured number of previous photos
      if (this.previousPhotos.length > PHOTO_SETTINGS.previousPhotosToKeep) {
        this.previousPhotos = this.previousPhotos.slice(-PHOTO_SETTINGS.previousPhotosToKeep);
      }
    }
    // Set new as current
    this.currentPhoto = newPhoto;
  }

  /**
   * Get the current (most recent) photo
   */
  getCurrentPhoto(): StoredPhoto | null {
    return this.currentPhoto;
  }

  /**
   * Get previous photos for context (max 2)
   */
  getPreviousPhotos(): StoredPhoto[] {
    return [...this.previousPhotos];
  }

  /**
   * Get all photos for agent context (current + previous)
   * Returns array of Buffers suitable for Mastra/AI SDK
   */
  getPhotosForContext(): Buffer[] {
    const photos: Buffer[] = [];

    // Add current photo first
    if (this.currentPhoto) {
      photos.push(this.currentPhoto.buffer);
    }

    // Add previous photos
    for (const photo of this.previousPhotos) {
      photos.push(photo.buffer);
    }

    return photos;
  }

  /**
   * Clear current photo context (after query processed)
   */
  clearCurrentContext(): void {
    // Don't clear - photos persist for follow-up context
    // Only cleared on destroy()
  }

  /** Push a photo to all connected SSE clients */
  broadcastPhoto(photo: StoredPhoto): void {
    const base64Data = photo.buffer.toString("base64");
    const payload = JSON.stringify({
      requestId: photo.requestId,
      timestamp: photo.timestamp.getTime(),
      mimeType: photo.mimeType,
      filename: photo.filename,
      size: photo.size,
      userId: photo.userId,
      base64: base64Data,
      dataUrl: `data:${photo.mimeType};base64,${base64Data}`,
    });

    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  getPhoto(requestId: string): StoredPhoto | undefined {
    return this.photos.get(requestId);
  }

  /** All photos for this user, sorted newest-first */
  getAll(): StoredPhoto[] {
    return Array.from(this.photos.values()).sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );
  }

  /** The full photos map (used by SSE to send history on connect) */
  getAllMap(): Map<string, StoredPhoto> {
    return this.photos;
  }

  removeAll(): void {
    this.photos.clear();
  }

  addSSEClient(client: SSEWriter): void {
    this.sseClients.add(client);
  }

  removeSSEClient(client: SSEWriter): void {
    this.sseClients.delete(client);
  }

  /** Tear down — clear photos and SSE clients */
  destroy(): void {
    this.photos.clear();
    this.sseClients.clear();
  }
}
