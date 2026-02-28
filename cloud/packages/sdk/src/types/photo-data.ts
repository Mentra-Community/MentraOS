/**
 * Photo data returned by requestPhoto()
 */
export interface PhotoData {
  /** The actual photo file as a Buffer */
  buffer: Buffer;
  /** MIME type of the photo (e.g., 'image/jpeg') */
  mimeType: string;
  /** Original filename from the camera */
  filename: string;
  /** Unique request ID that correlates to the original request */
  requestId: string;
  /** Size of the photo in bytes */
  size: number;
  /** Timestamp when the photo was captured */
  timestamp: Date;
}
